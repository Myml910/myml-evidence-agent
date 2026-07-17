const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { assertStorageConfigSafe, storageConfig } = require('../config/storageConfig');
const { EvidenceReplicationJournal, normalizeReplicationErrorCode } = require('./replicationJournal');
const { S3ReplicationTarget } = require('./s3ReplicationTarget');
const { loadStorageCredentialsSync } = require('./storageCredentials');
const {
  createError,
  locateStorageSource,
  resolveOperationFile,
  validateSourceMappings,
} = require('./storagePath');

const REPLICATION_MODES = new Set(['disabled', 'filesystem-to-s3']);

function inferContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }[extension] || 'application/octet-stream';
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashDescriptor(fd, size) {
  const digest = crypto.createHash('sha256');
  const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, size)));
  let offset = 0;
  while (offset < size) {
    const length = Math.min(chunk.length, size - offset);
    const bytesRead = fs.readSync(fd, chunk, 0, length, offset);
    if (bytesRead <= 0) throw createError('REPLICATION_LOCAL_READ_INCOMPLETE');
    digest.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return digest.digest('hex');
}

function sanitizedErrorCode(error) {
  return normalizeReplicationErrorCode(error?.code || error?.name || 'UNKNOWN');
}

class EvidenceReplicationWorker {
  constructor(options = {}) {
    this.sources = options.sources;
    this.target = options.target;
    this.journal = options.journal;
    this.concurrency = Number(options.concurrency ?? 2);
    this.batchSize = Number(options.batchSize ?? 20);
    this.maxAttempts = Number(options.maxAttempts ?? 8);
    this.baseRetryMs = Number(options.baseRetryMs ?? 5000);
    this.maxRetryMs = Number(options.maxRetryMs ?? 300000);
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.runningPromise = null;

    if (!this.target || !this.journal) throw createError('REPLICATION_WORKER_DEPENDENCY_REQUIRED');
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 8) {
      throw createError('REPLICATION_WORKER_CONCURRENCY_INVALID');
    }
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1000) {
      throw createError('REPLICATION_WORKER_BATCH_SIZE_INVALID');
    }
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 100) {
      throw createError('REPLICATION_WORKER_MAX_ATTEMPTS_INVALID');
    }
  }

  currentDate() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw createError('REPLICATION_WORKER_CLOCK_INVALID');
    return date;
  }

  retryDate(attempt) {
    const delay = Math.min(this.maxRetryMs, this.baseRetryMs * (2 ** Math.max(0, attempt - 1)));
    return new Date(this.currentDate().getTime() + delay);
  }

  openVerifiedFile(operation) {
    const filePath = resolveOperationFile(operation, this.sources);
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== operation.size) {
        throw createError('REPLICATION_LOCAL_SIZE_CHANGED');
      }
      if (hashDescriptor(fd, stat.size) !== operation.sha256) {
        throw createError('REPLICATION_LOCAL_CONTENT_CHANGED');
      }
      return { fd, filePath };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  async replicatePut(operation) {
    const descriptor = this.openVerifiedFile(operation);
    try {
      const existing = await this.target.findObject(operation.objectKey);
      if (
        existing &&
        Number(existing.size) === operation.size &&
        String(existing.sha256 || '').toLowerCase() === operation.sha256
      ) {
        return 'already-matched';
      }

      const saved = await this.target.putObject(operation, descriptor);
      if (Number(saved.size) !== operation.size || saved.sha256 !== operation.sha256) {
        throw createError('REPLICATION_SECONDARY_WRITE_MISMATCH');
      }
      const verified = await this.target.headObject(operation.objectKey);
      if (
        Number(verified.size) !== operation.size ||
        String(verified.sha256 || '').toLowerCase() !== operation.sha256
      ) {
        throw createError('REPLICATION_SECONDARY_VERIFY_MISMATCH');
      }
      return 'uploaded';
    } finally {
      fs.closeSync(descriptor.fd);
    }
  }

  async process(operation, result) {
    const attempting = this.journal.markAttemptSync(operation);
    if (!attempting) {
      result.superseded += 1;
      return;
    }

    try {
      const outcome = attempting.operation === 'delete'
        ? await this.target.deleteObject(attempting.objectKey).then(() => 'deleted')
        : await this.replicatePut(attempting);
      if (!this.journal.markCompletedSync(attempting)) {
        result.superseded += 1;
        return;
      }
      result.completed += 1;
      if (outcome === 'already-matched') result.alreadyMatched += 1;
      if (outcome === 'uploaded') result.uploaded += 1;
      if (outcome === 'deleted') result.deleted += 1;
    } catch (error) {
      const failed = this.journal.markFailureSync(attempting, {
        errorCode: sanitizedErrorCode(error),
        maxAttempts: this.maxAttempts,
        nextAttemptAt: this.retryDate(attempting.attempts).toISOString(),
      });
      if (!failed) result.superseded += 1;
      else if (failed.status === 'dead') result.dead += 1;
      else result.retried += 1;
    }
  }

  runOnce() {
    if (this.runningPromise) return this.runningPromise;
    this.runningPromise = this.runBatch().finally(() => {
      this.runningPromise = null;
    });
    return this.runningPromise;
  }

  async runBatch() {
    const pending = this.journal.listPendingSync({
      limit: this.batchSize,
      now: this.currentDate(),
    });
    const result = {
      selected: pending.length,
      completed: 0,
      uploaded: 0,
      alreadyMatched: 0,
      deleted: 0,
      retried: 0,
      dead: 0,
      superseded: 0,
    };
    let cursor = 0;
    const run = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= pending.length) return;
        await this.process(pending[index], result);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(this.concurrency, Math.max(1, pending.length)) },
      () => run(),
    ));
    return result;
  }
}

class EvidenceStorageRuntime {
  constructor(config = storageConfig, options = {}) {
    assertStorageConfigSafe(config);
    const mode = String(config?.replication?.mode || 'disabled');
    if (!REPLICATION_MODES.has(mode)) throw createError('EVIDENCE_REPLICATION_MODE_INVALID');
    if (config.activeDriver !== 'filesystem') {
      throw createError('EVIDENCE_REPLICATION_REQUIRES_FILESYSTEM_PRIMARY');
    }
    this.config = config;
    this.mode = mode;
    this.credentialsLoader = options.credentialsLoader || loadStorageCredentialsSync;
    this.journal = options.journal || null;
    this.target = options.target || null;
    this.worker = options.worker || null;
    this.sources = null;
    this.initialized = false;
    this.workerStarted = false;
    this.stopping = false;
    this.workerTimer = null;
    this.workerPromise = null;
  }

  initializeSync() {
    if (this.initialized) return this;
    if (this.mode === 'disabled') {
      this.initialized = true;
      return this;
    }

    this.sources = validateSourceMappings(this.config.sources);
    for (const source of this.sources) {
      const stat = fs.lstatSync(source.rootDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw createError('EVIDENCE_STORAGE_SOURCE_ROOT_INVALID');
      }
    }
    this.journal = this.journal || new EvidenceReplicationJournal({
      journalDir: this.config.replication.journalDir,
    });
    this.journal.initializeSync();
    if (!this.target) {
      const credentials = this.credentialsLoader({ filePath: this.config.s3.credentialsFile });
      this.target = new S3ReplicationTarget({ config: this.config.s3, credentials });
    }
    this.worker = this.worker || new EvidenceReplicationWorker({
      sources: this.sources,
      target: this.target,
      journal: this.journal,
      concurrency: this.config.replication.concurrency,
      batchSize: this.config.replication.batchSize,
      maxAttempts: this.config.replication.maxAttempts,
      baseRetryMs: this.config.replication.baseRetryMs,
      maxRetryMs: this.config.replication.maxRetryMs,
    });
    this.initialized = true;
    return this;
  }

  startWorker() {
    this.initializeSync();
    if (!this.worker || this.workerStarted) return;
    this.workerStarted = true;
    this.stopping = false;
    this.scheduleWorker(0);
  }

  scheduleWorker(delayMs) {
    if (this.stopping || !this.worker || this.workerTimer) return;
    this.workerTimer = setTimeout(() => {
      this.workerTimer = null;
      this.workerPromise = this.worker.runOnce()
        .then((result) => {
          if (result.selected > 0) {
            console.log('[EvidenceStorageReplication] batch', {
              selected: result.selected,
              completed: result.completed,
              retried: result.retried,
              dead: result.dead,
            });
          }
        })
        .catch((error) => {
          console.error('[EvidenceStorageReplication] worker failed', {
            code: sanitizedErrorCode(error),
          });
        })
        .finally(() => {
          this.workerPromise = null;
          this.scheduleWorker(this.config.replication.pollIntervalMs);
        });
    }, delayMs);
    this.workerTimer.unref?.();
  }

  wakeWorker() {
    if (!this.workerStarted || this.stopping) return;
    if (this.workerTimer) {
      clearTimeout(this.workerTimer);
      this.workerTimer = null;
    }
    if (!this.workerPromise) this.scheduleWorker(0);
  }

  commitFileSync(filePath, options = {}) {
    this.initializeSync();
    if (this.mode === 'disabled') return { queued: false };
    const located = locateStorageSource(filePath, this.sources);
    const stat = fs.statSync(located.filePath);
    let sha256;
    if (options.body !== undefined) {
      const body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
      if (body.length !== stat.size) throw createError('EVIDENCE_STORAGE_COMMIT_SIZE_MISMATCH');
      sha256 = hashBuffer(body);
    } else {
      const fd = fs.openSync(located.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        sha256 = hashDescriptor(fd, stat.size);
      } finally {
        fs.closeSync(fd);
      }
    }
    const operation = this.journal.enqueuePutSync({
      ...located,
      size: stat.size,
      sha256,
      contentType: options.contentType || inferContentType(filePath),
    });
    this.wakeWorker();
    return { queued: true, operationId: operation.id, objectKey: operation.objectKey };
  }

  recordDeleteSync(filePath) {
    this.initializeSync();
    if (this.mode === 'disabled' || this.config.replication.mirrorDeletes !== true) {
      return { queued: false, deleteMirroringEnabled: false };
    }
    const located = locateStorageSource(filePath, this.sources, { requireExisting: false });
    const operation = this.journal.enqueueDeleteSync({ objectKey: located.objectKey });
    this.wakeWorker();
    return { queued: true, operationId: operation.id, objectKey: operation.objectKey };
  }

  getSummarySync() {
    this.initializeSync();
    if (!this.journal) return { enabled: false, active: 0, byStatus: {} };
    return { enabled: true, ...this.journal.getSummarySync() };
  }

  async stop() {
    this.stopping = true;
    this.workerStarted = false;
    if (this.workerTimer) {
      clearTimeout(this.workerTimer);
      this.workerTimer = null;
    }
    await this.workerPromise;
    this.target?.destroy?.();
  }
}

let activeRuntime = null;

function initializeEvidenceStorage(config = storageConfig, options = {}) {
  if (!activeRuntime) {
    activeRuntime = new EvidenceStorageRuntime(config, options).initializeSync();
    activeRuntime.startWorker();
  }
  return activeRuntime;
}

function getRuntime() {
  return activeRuntime || initializeEvidenceStorage();
}

function commitEvidenceFileSync(filePath, options = {}) {
  return getRuntime().commitFileSync(filePath, options);
}

function recordEvidenceDeleteSync(filePath) {
  return getRuntime().recordDeleteSync(filePath);
}

function getEvidenceStorageSummarySync() {
  return getRuntime().getSummarySync();
}

async function shutdownEvidenceStorage() {
  if (!activeRuntime) return;
  const runtime = activeRuntime;
  activeRuntime = null;
  await runtime.stop();
}

function setEvidenceStorageRuntimeForTests(runtime) {
  activeRuntime = runtime;
}

module.exports = {
  EvidenceReplicationWorker,
  EvidenceStorageRuntime,
  commitEvidenceFileSync,
  getEvidenceStorageSummarySync,
  initializeEvidenceStorage,
  recordEvidenceDeleteSync,
  setEvidenceStorageRuntimeForTests,
  shutdownEvidenceStorage,
};
