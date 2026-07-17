const path = require('path');
const { EVIDENCE_DATA_DIR, EVIDENCE_RUNTIME_DIR } = require('./dataPaths');

const WINDOWS_CREDENTIALS_FILE = 'C:\\ProgramData\\MYML-Canvas\\storage.credentials.json';
const LINUX_CREDENTIALS_FILE = '/etc/myml-canvas/storage.credentials.json';
const WINDOWS_JOURNAL_DIR = 'C:\\ProgramData\\MYML-Evidence-Agent\\storage-replication';
const LINUX_JOURNAL_DIR = '/opt/1panel/MYML-CANVAS/data/storage-replication/evidence-journal';

const FORBIDDEN_SECRET_KEYS = new Set([
  'accesskey',
  'accesskeyid',
  'apikey',
  'authorization',
  'password',
  'secret',
  'secretaccesskey',
  'secretkey',
  'token',
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function assertStorageConfigSafe(config) {
  const visit = (value, trail = []) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (FORBIDDEN_SECRET_KEYS.has(normalized)) {
        throw new Error(`Tracked storage config must not contain secret field: ${[...trail, key].join('.')}`);
      }
      visit(child, [...trail, key]);
    }
  };

  visit(config);
  return config;
}

const storageConfig = deepFreeze(assertStorageConfigSafe({
  version: 1,
  activeDriver: 'filesystem',
  s3: {
    endpoint: 'http://172.50.0.68:15017',
    region: 'us-east-1',
    bucket: 'myml-canvas-media',
    forcePathStyle: true,
    maxAttempts: 3,
    multipartQueueSize: 2,
    multipartPartSizeBytes: 8 * 1024 * 1024,
    credentialsFile: process.platform === 'win32'
      ? WINDOWS_CREDENTIALS_FILE
      : LINUX_CREDENTIALS_FILE,
    publicRead: false,
  },
  replication: {
    mode: 'disabled',
    journalDir: process.platform === 'win32'
      ? WINDOWS_JOURNAL_DIR
      : LINUX_JOURNAL_DIR,
    concurrency: 2,
    batchSize: 20,
    pollIntervalMs: 5000,
    maxAttempts: 8,
    baseRetryMs: 5000,
    maxRetryMs: 300000,
    mirrorDeletes: false,
  },
  sources: [
    {
      name: 'evidence-runtime',
      rootDir: EVIDENCE_RUNTIME_DIR,
      keyPrefix: 'production/evidence/runtime',
    },
    {
      name: 'evidence-static',
      rootDir: EVIDENCE_DATA_DIR,
      keyPrefix: 'production/evidence/static',
    },
  ],
  migration: {
    mode: 'historical-backfill-verified',
    hashAlgorithm: 'sha256',
  },
}));

function getStorageCredentialsFile(config = storageConfig) {
  return path.resolve(config.s3.credentialsFile);
}

module.exports = {
  assertStorageConfigSafe,
  getStorageCredentialsFile,
  storageConfig,
};
