const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertStorageConfigSafe,
  storageConfig,
} = require('../config/storageConfig');
const { EvidenceReplicationJournal } = require('../storage/replicationJournal');
const {
  EvidenceStorageRuntime,
} = require('../storage/evidenceStorageRuntime');
const { createS3Client } = require('../storage/s3ReplicationTarget');
const {
  loadStorageCredentialsSync,
  validateStorageCredentials,
} = require('../storage/storageCredentials');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readDescriptor(fd, size) {
  const output = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, output, offset, size - offset, offset);
    if (count <= 0) throw new Error('FAKE_TARGET_READ_INCOMPLETE');
    offset += count;
  }
  return output;
}

class FakeReplicationTarget {
  constructor() {
    this.objects = new Map();
    this.puts = [];
    this.putAttempts = 0;
    this.failNextPuts = 0;
    this.deletes = [];
  }

  async findObject(objectKey) {
    return this.objects.has(objectKey) ? { ...this.objects.get(objectKey) } : null;
  }

  async headObject(objectKey) {
    const value = await this.findObject(objectKey);
    if (!value) {
      const error = new Error('Not found');
      error.name = 'NotFound';
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    }
    return value;
  }

  async putObject(operation, descriptor) {
    this.putAttempts += 1;
    if (this.failNextPuts > 0) {
      this.failNextPuts -= 1;
      const error = new Error('Simulated transient upload failure.');
      error.code = 'ECONNRESET';
      throw error;
    }
    const body = readDescriptor(descriptor.fd, operation.size);
    assert.equal(sha256(body), operation.sha256);
    const stored = {
      objectKey: operation.objectKey,
      size: body.length,
      sha256: operation.sha256,
      body,
      versionId: `version-${this.puts.length + 1}`,
    };
    this.puts.push(stored);
    this.objects.set(operation.objectKey, stored);
    return { ...stored };
  }

  async deleteObject(objectKey) {
    this.deletes.push(objectKey);
    this.objects.delete(objectKey);
    return { objectKey, deleted: true };
  }

  destroy() {}
}

function testConfig(tempRoot, overrides = {}) {
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const staticRoot = path.join(tempRoot, 'static');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(staticRoot, { recursive: true });
  return {
    version: 1,
    activeDriver: 'filesystem',
    s3: {
      endpoint: 'http://127.0.0.1:15017',
      region: 'us-east-1',
      bucket: 'test-bucket',
      forcePathStyle: true,
      maxAttempts: 1,
      multipartQueueSize: 1,
      multipartPartSizeBytes: 8 * 1024 * 1024,
      credentialsFile: path.join(tempRoot, 'unused-credentials.json'),
      publicRead: false,
    },
    replication: {
      mode: 'filesystem-to-s3',
      journalDir: path.join(tempRoot, 'journal'),
      concurrency: 2,
      batchSize: 20,
      pollIntervalMs: 60 * 1000,
      maxAttempts: 3,
      baseRetryMs: 10,
      maxRetryMs: 100,
      mirrorDeletes: false,
      ...overrides.replication,
    },
    sources: [
      {
        name: 'evidence-runtime',
        rootDir: runtimeRoot,
        keyPrefix: 'production/evidence/runtime',
      },
      {
        name: 'evidence-static',
        rootDir: staticRoot,
        keyPrefix: 'production/evidence/static',
      },
    ],
    migration: { mode: 'historical-backfill-verified', hashAlgorithm: 'sha256' },
  };
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myml-evidence-storage-'));
  try {
    assert.equal(storageConfig.activeDriver, 'filesystem');
    assert.equal(storageConfig.replication.mode, 'filesystem-to-s3');
    assert.equal(storageConfig.replication.mirrorDeletes, false);
    assert.equal(storageConfig.migration.mode, 'historical-backfill-verified');
    assert.equal(storageConfig.s3.endpoint, 'http://172.50.0.68:15017');
    assert.equal(storageConfig.s3.bucket, 'myml-canvas-media');
    assert.deepEqual(
      storageConfig.sources.map((source) => source.keyPrefix),
      ['production/evidence/runtime', 'production/evidence/static'],
    );
    assert.equal(Object.isFrozen(storageConfig), true);
    assert.equal(Object.isFrozen(storageConfig.s3), true);
    assert.throws(
      () => assertStorageConfigSafe({ secretAccessKey: 'must-not-be-tracked' }),
      /must not contain secret field/,
    );

    const credentialsPath = path.join(tempRoot, 'storage.credentials.json');
    fs.writeFileSync(credentialsPath, `${JSON.stringify({
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-access-key-value',
    })}\n`, { mode: 0o600 });
    const credentials = loadStorageCredentialsSync({ filePath: credentialsPath });
    assert.equal(Object.isFrozen(credentials), true);
    assert.throws(
      () => validateStorageCredentials({
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-access-key-value',
        password: 'unexpected',
      }),
      (error) => error.code === 'STORAGE_CREDENTIALS_INVALID',
    );
    const s3Client = createS3Client({
      config: testConfig(tempRoot).s3,
      credentials,
    });
    const sdkCredentials = await s3Client.config.credentials();
    assert.equal(Object.isFrozen(sdkCredentials), false);
    sdkCredentials.$source = { test: 'mutable-copy' };
    s3Client.destroy();

    const target = new FakeReplicationTarget();
    const config = testConfig(tempRoot);
    const runtime = new EvidenceStorageRuntime(config, { target }).initializeSync();

    const runFile = path.join(config.sources[0].rootDir, 'project-runs.json');
    const first = Buffer.from('{"version":1}\n');
    fs.writeFileSync(runFile, first);
    const queued = runtime.commitFileSync(runFile, {
      body: first,
      contentType: 'application/json',
    });
    assert.equal(queued.queued, true);
    assert.equal(queued.objectKey, 'production/evidence/runtime/project-runs.json');
    assert.equal(runtime.getSummarySync().active, 1);

    const firstBatch = await runtime.worker.runOnce();
    assert.equal(firstBatch.uploaded, 1);
    assert.equal(firstBatch.completed, 1);
    assert.equal(runtime.getSummarySync().active, 0);
    assert.deepEqual(target.objects.get(queued.objectKey).body, first);

    const second = Buffer.from('{"version":2}\n');
    const third = Buffer.from('{"version":3}\n');
    fs.writeFileSync(runFile, second);
    runtime.commitFileSync(runFile, { body: second, contentType: 'application/json' });
    fs.writeFileSync(runFile, third);
    const latest = runtime.commitFileSync(runFile, { body: third, contentType: 'application/json' });
    assert.equal(runtime.getSummarySync().total, 1);
    const overwriteBatch = await runtime.worker.runOnce();
    assert.equal(overwriteBatch.uploaded, 1);
    assert.deepEqual(target.objects.get(latest.objectKey).body, third);
    assert.equal(target.puts.length, 2);

    const staticFile = path.join(config.sources[1].rootDir, 'category-images', 'sample.png');
    const image = Buffer.from('image bytes');
    fs.mkdirSync(path.dirname(staticFile), { recursive: true });
    fs.writeFileSync(staticFile, image);
    const staticQueued = runtime.commitFileSync(staticFile, { body: image, contentType: 'image/png' });
    assert.equal(staticQueued.objectKey, 'production/evidence/static/category-images/sample.png');
    await runtime.worker.runOnce();
    assert.deepEqual(target.objects.get(staticQueued.objectKey).body, image);

    const putsBeforeMatchedCheck = target.puts.length;
    runtime.commitFileSync(staticFile, { body: image, contentType: 'image/png' });
    const matchedBatch = await runtime.worker.runOnce();
    assert.equal(matchedBatch.alreadyMatched, 1);
    assert.equal(matchedBatch.uploaded, 0);
    assert.equal(target.puts.length, putsBeforeMatchedCheck);

    const retryFile = path.join(config.sources[0].rootDir, 'retry.json');
    const retryBody = Buffer.from('{"retry":true}\n');
    fs.writeFileSync(retryFile, retryBody);
    target.failNextPuts = 1;
    runtime.commitFileSync(retryFile, {
      body: retryBody,
      contentType: 'application/json',
    });
    const failedBatch = await runtime.worker.runOnce();
    assert.equal(failedBatch.retried, 1);
    assert.equal(runtime.getSummarySync().byStatus.retry, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const retriedBatch = await runtime.worker.runOnce();
    assert.equal(retriedBatch.uploaded, 1);
    assert.equal(runtime.getSummarySync().active, 0);
    assert.deepEqual(target.objects.get(
      'production/evidence/runtime/retry.json',
    ).body, retryBody);

    fs.unlinkSync(staticFile);
    assert.deepEqual(runtime.recordDeleteSync(staticFile), {
      queued: false,
      deleteMirroringEnabled: false,
    });
    assert.equal(target.deletes.length, 0);

    const recoveryFile = path.join(config.sources[0].rootDir, 'project-run-assets', 'recovery.png');
    const recoveryBody = Buffer.from('recover after restart');
    fs.mkdirSync(path.dirname(recoveryFile), { recursive: true });
    fs.writeFileSync(recoveryFile, recoveryBody);
    runtime.commitFileSync(recoveryFile, { body: recoveryBody, contentType: 'image/png' });
    assert.equal(runtime.getSummarySync().active, 1);

    const recoveredJournal = new EvidenceReplicationJournal({
      journalDir: config.replication.journalDir,
    }).initializeSync();
    const recoveredRuntime = new EvidenceStorageRuntime(config, {
      journal: recoveredJournal,
      target,
    }).initializeSync();
    assert.equal(recoveredRuntime.getSummarySync().active, 1);
    const recoveryBatch = await recoveredRuntime.worker.runOnce();
    assert.equal(recoveryBatch.uploaded, 1);
    assert.equal(recoveredRuntime.getSummarySync().active, 0);

    let credentialsLoaded = false;
    const disabledRoot = path.join(tempRoot, 'disabled');
    const disabledConfig = testConfig(disabledRoot, {
      replication: { mode: 'disabled' },
    });
    const disabled = new EvidenceStorageRuntime(disabledConfig, {
      credentialsLoader: () => {
        credentialsLoaded = true;
        throw new Error('Disabled mode must not load credentials.');
      },
    }).initializeSync();
    const disabledFile = path.join(disabledConfig.sources[0].rootDir, 'disabled.json');
    fs.writeFileSync(disabledFile, '{}');
    assert.deepEqual(disabled.commitFileSync(disabledFile), { queued: false });
    assert.equal(credentialsLoaded, false);
    assert.equal(fs.existsSync(disabledConfig.replication.journalDir), false);

    const ambiguousConfig = testConfig(path.join(tempRoot, 'ambiguous'));
    ambiguousConfig.sources[1].rootDir = ambiguousConfig.sources[0].rootDir;
    assert.throws(
      () => new EvidenceStorageRuntime(ambiguousConfig, { target }).initializeSync(),
      (error) => error.code === 'EVIDENCE_STORAGE_SOURCE_ROOT_AMBIGUOUS',
    );

    await runtime.stop();
    await recoveredRuntime.stop();
    await disabled.stop();
    console.log('[test:evidence-storage] Evidence storage runtime tests passed.');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
