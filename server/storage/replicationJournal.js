const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createError, normalizeStorageKey } = require('./storagePath');

const PENDING_STATUSES = new Set(['queued', 'attempting', 'retry']);
const VALID_STATUSES = new Set([...PENDING_STATUSES, 'dead']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function normalizeErrorCode(value) {
  return String(value || 'UNKNOWN')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 64) || 'UNKNOWN';
}

function operationFileName(objectKey) {
  return `${crypto.createHash('sha256').update(objectKey).digest('hex')}.json`;
}

function clone(value) {
  return value ? { ...value } : null;
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateOperation(value, expectedFileName = '') {
  if (!value || value.schemaVersion !== 1 || !['put', 'delete'].includes(value.operation)) {
    throw createError('REPLICATION_JOURNAL_RECORD_INVALID');
  }
  if (!/^rep-[a-f0-9-]{16,}$/i.test(String(value.id || ''))) {
    throw createError('REPLICATION_JOURNAL_ID_INVALID');
  }
  const objectKey = normalizeStorageKey(value.objectKey);
  if (objectKey !== value.objectKey) throw createError('REPLICATION_JOURNAL_KEY_INVALID');
  if (expectedFileName && operationFileName(objectKey) !== expectedFileName) {
    throw createError('REPLICATION_JOURNAL_FILENAME_INVALID');
  }
  if (!VALID_STATUSES.has(value.status)) throw createError('REPLICATION_JOURNAL_STATUS_INVALID');
  if (!validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)) {
    throw createError('REPLICATION_JOURNAL_TIMESTAMP_INVALID');
  }
  if (!Number.isInteger(value.attempts) || value.attempts < 0) {
    throw createError('REPLICATION_JOURNAL_ATTEMPTS_INVALID');
  }
  if (value.status === 'retry' && !validTimestamp(value.nextAttemptAt)) {
    throw createError('REPLICATION_JOURNAL_RETRY_TIMESTAMP_INVALID');
  }
  if (value.operation === 'put') {
    if (!value.source || !value.relativePath) throw createError('REPLICATION_JOURNAL_SOURCE_INVALID');
    normalizeStorageKey(value.relativePath);
    if (!Number.isSafeInteger(value.size) || value.size < 0) {
      throw createError('REPLICATION_JOURNAL_SIZE_INVALID');
    }
    if (!SHA256_PATTERN.test(String(value.sha256 || '').toLowerCase())) {
      throw createError('REPLICATION_JOURNAL_SHA256_INVALID');
    }
  }
  return value;
}

function syncDirectory(dirPath) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(dirPath, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeOperationAtomic(filePath, operation) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(operation)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
    syncDirectory(path.dirname(filePath));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

class EvidenceReplicationJournal {
  constructor(options = {}) {
    if (!options.journalDir) throw createError('REPLICATION_JOURNAL_PATH_REQUIRED');
    this.journalDir = path.resolve(options.journalDir);
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.idFactory = typeof options.idFactory === 'function'
      ? options.idFactory
      : () => `rep-${crypto.randomUUID()}`;
    this.operations = new Map();
    this.initialized = false;
  }

  timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw createError('REPLICATION_JOURNAL_CLOCK_INVALID');
    return date.toISOString();
  }

  initializeSync() {
    if (this.initialized) return this;
    fs.mkdirSync(this.journalDir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.journalDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw createError('REPLICATION_JOURNAL_DIRECTORY_INVALID');
    }
    fs.chmodSync(this.journalDir, 0o700);

    for (const entry of fs.readdirSync(this.journalDir, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw createError('REPLICATION_JOURNAL_ENTRY_INVALID');
      }
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(this.journalDir, entry.name), 'utf8'));
      } catch (error) {
        if (error instanceof SyntaxError) throw createError('REPLICATION_JOURNAL_JSON_INVALID');
        throw error;
      }
      validateOperation(parsed, entry.name);
      this.operations.set(parsed.objectKey, parsed);
    }
    this.initialized = true;
    return this;
  }

  operationPath(objectKey) {
    return path.join(this.journalDir, operationFileName(objectKey));
  }

  writeSync(operation) {
    validateOperation(operation);
    writeOperationAtomic(this.operationPath(operation.objectKey), operation);
    this.operations.set(operation.objectKey, operation);
    return clone(operation);
  }

  enqueuePutSync(values = {}) {
    this.initializeSync();
    const now = this.timestamp();
    const operation = {
      schemaVersion: 1,
      id: this.idFactory(),
      operation: 'put',
      objectKey: normalizeStorageKey(values.objectKey),
      source: String(values.source || ''),
      relativePath: normalizeStorageKey(values.relativePath),
      size: Number(values.size),
      sha256: String(values.sha256 || '').toLowerCase(),
      contentType: String(values.contentType || 'application/octet-stream'),
      status: 'queued',
      attempts: 0,
      nextAttemptAt: null,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    };
    return this.writeSync(operation);
  }

  enqueueDeleteSync(values = {}) {
    this.initializeSync();
    const now = this.timestamp();
    const operation = {
      schemaVersion: 1,
      id: this.idFactory(),
      operation: 'delete',
      objectKey: normalizeStorageKey(values.objectKey),
      source: null,
      relativePath: null,
      size: 0,
      sha256: null,
      contentType: null,
      status: 'queued',
      attempts: 0,
      nextAttemptAt: null,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    };
    return this.writeSync(operation);
  }

  listPendingSync(options = {}) {
    this.initializeSync();
    const limit = Number(options.limit ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw createError('REPLICATION_JOURNAL_PENDING_LIMIT_INVALID');
    }
    const now = options.now instanceof Date ? options.now : new Date(options.now || this.now());
    if (!Number.isFinite(now.getTime())) throw createError('REPLICATION_JOURNAL_CLOCK_INVALID');
    return [...this.operations.values()]
      .filter((operation) => PENDING_STATUSES.has(operation.status))
      .filter((operation) => operation.status !== 'retry' || Date.parse(operation.nextAttemptAt) <= now.getTime())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  updateIfCurrentSync(operation, update) {
    this.initializeSync();
    const current = this.operations.get(operation.objectKey);
    if (!current || current.id !== operation.id) return null;
    return this.writeSync({ ...current, ...update, updatedAt: this.timestamp() });
  }

  markAttemptSync(operation) {
    const current = this.operations.get(operation.objectKey);
    if (!current || current.id !== operation.id || !PENDING_STATUSES.has(current.status)) return null;
    return this.updateIfCurrentSync(operation, {
      status: 'attempting',
      attempts: current.attempts + 1,
      nextAttemptAt: null,
      errorCode: null,
    });
  }

  markCompletedSync(operation) {
    const current = this.operations.get(operation.objectKey);
    if (!current || current.id !== operation.id) return false;
    const filePath = this.operationPath(operation.objectKey);
    fs.unlinkSync(filePath);
    this.operations.delete(operation.objectKey);
    syncDirectory(this.journalDir);
    return true;
  }

  markFailureSync(operation, options = {}) {
    const current = this.operations.get(operation.objectKey);
    if (!current || current.id !== operation.id) return null;
    const maxAttempts = Number(options.maxAttempts);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw createError('REPLICATION_JOURNAL_MAX_ATTEMPTS_INVALID');
    }
    const terminal = current.attempts >= maxAttempts;
    return this.updateIfCurrentSync(operation, {
      status: terminal ? 'dead' : 'retry',
      nextAttemptAt: terminal ? null : String(options.nextAttemptAt || ''),
      errorCode: normalizeErrorCode(options.errorCode),
    });
  }

  getSummarySync() {
    this.initializeSync();
    const byStatus = {};
    for (const operation of this.operations.values()) {
      byStatus[operation.status] = (byStatus[operation.status] || 0) + 1;
    }
    return {
      total: this.operations.size,
      active: [...this.operations.values()].filter((operation) => PENDING_STATUSES.has(operation.status)).length,
      byStatus,
    };
  }
}

module.exports = {
  EvidenceReplicationJournal,
  normalizeReplicationErrorCode: normalizeErrorCode,
};
