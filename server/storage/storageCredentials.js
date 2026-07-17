const fs = require('fs');
const path = require('path');

const MAX_CREDENTIAL_FILE_BYTES = 16 * 1024;
const PLACEHOLDER_PATTERN = /(change[-_*]?this|example|placeholder|replace[-_*]?me|your[-_*]?(access|secret|key))/i;
const ALLOWED_FIELDS = new Set(['accessKeyId', 'secretAccessKey', 'sessionToken']);

function credentialsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireCredential(value, field, minimumLength) {
  if (typeof value !== 'string') {
    throw credentialsError('STORAGE_CREDENTIALS_INVALID', `Storage credentials field is missing or invalid: ${field}`);
  }
  const normalized = value.trim();
  if (normalized.length < minimumLength || PLACEHOLDER_PATTERN.test(normalized)) {
    throw credentialsError('STORAGE_CREDENTIALS_INVALID', `Storage credentials field is missing or invalid: ${field}`);
  }
  return normalized;
}

function validateStorageCredentials(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw credentialsError('STORAGE_CREDENTIALS_INVALID', 'Storage credentials file must contain a JSON object');
  }

  const unsupported = Object.keys(value).filter((field) => !ALLOWED_FIELDS.has(field));
  if (unsupported.length > 0) {
    throw credentialsError('STORAGE_CREDENTIALS_INVALID', `Storage credentials file contains unsupported field: ${unsupported[0]}`);
  }

  const credentials = {
    accessKeyId: requireCredential(value.accessKeyId, 'accessKeyId', 8),
    secretAccessKey: requireCredential(value.secretAccessKey, 'secretAccessKey', 16),
  };
  if (value.sessionToken !== undefined && String(value.sessionToken || '').trim()) {
    credentials.sessionToken = requireCredential(value.sessionToken, 'sessionToken', 8);
  }
  return Object.freeze(credentials);
}

function loadStorageCredentialsSync(options = {}) {
  const filePath = path.resolve(options.filePath);
  let initialStat;
  try {
    initialStat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw credentialsError('STORAGE_CREDENTIALS_MISSING', `Storage credentials file is missing: ${filePath}`);
    }
    throw error;
  }

  if (initialStat.isSymbolicLink()) {
    throw credentialsError('STORAGE_CREDENTIALS_UNSAFE_FILE', 'Storage credentials file must not be a symbolic link');
  }

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw credentialsError('STORAGE_CREDENTIALS_UNSAFE_FILE', 'Storage credentials file must not be a symbolic link');
    }
    throw error;
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw credentialsError('STORAGE_CREDENTIALS_UNSAFE_FILE', 'Storage credentials path must be a regular file');
    }
    if (stat.size <= 0 || stat.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw credentialsError('STORAGE_CREDENTIALS_INVALID', 'Storage credentials file has an invalid size');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw credentialsError('STORAGE_CREDENTIALS_PERMISSIONS', 'Storage credentials file permissions must be 0600 or stricter');
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw credentialsError('STORAGE_CREDENTIALS_INVALID', 'Storage credentials file is not valid JSON');
      }
      throw error;
    }
    return validateStorageCredentials(parsed);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  loadStorageCredentialsSync,
  validateStorageCredentials,
};
