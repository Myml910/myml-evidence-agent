const fs = require('fs');
const path = require('path');

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function createError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeStorageKey(input, options = {}) {
  const { allowEmpty = false } = options;
  if (typeof input !== 'string') throw new TypeError('Storage key must be a string');
  const value = input.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!value) {
    if (allowEmpty) return '';
    throw createError('STORAGE_KEY_EMPTY');
  }
  if (CONTROL_CHARACTERS.test(value) || /^[A-Za-z]:/.test(value)) {
    throw createError('STORAGE_KEY_INVALID');
  }
  const segments = value.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw createError('STORAGE_KEY_TRAVERSAL');
  }
  return segments.join('/');
}

function joinStorageKey(...parts) {
  return normalizeStorageKey(parts
    .filter((part) => part !== undefined && part !== null && String(part).trim())
    .map((part) => String(part).replace(/\\/g, '/'))
    .join('/'));
}

function relativePathWithinRoot(rootDir, filePath) {
  const root = path.resolve(rootDir);
  const file = path.resolve(filePath);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw createError('EVIDENCE_STORAGE_PATH_OUTSIDE_ROOT');
  }
  return normalizeStorageKey(relative.split(path.sep).join('/'));
}

function validateSourceMappings(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw createError('EVIDENCE_STORAGE_SOURCES_REQUIRED');
  }
  const roots = new Set();
  const names = new Set();
  return sources.map((source) => {
    const name = String(source?.name || '').trim();
    const rootDir = path.resolve(String(source?.rootDir || ''));
    const keyPrefix = normalizeStorageKey(String(source?.keyPrefix || ''));
    if (!name || names.has(name)) throw createError('EVIDENCE_STORAGE_SOURCE_NAME_INVALID');
    const rootKey = process.platform === 'win32' ? rootDir.toLowerCase() : rootDir;
    if (roots.has(rootKey)) throw createError('EVIDENCE_STORAGE_SOURCE_ROOT_AMBIGUOUS');
    names.add(name);
    roots.add(rootKey);
    return { name, rootDir, keyPrefix };
  });
}

function locateStorageSource(filePath, sources, options = {}) {
  const resolvedFile = path.resolve(filePath);
  const candidates = sources.map((source) => {
    try {
      return {
        source,
        relativePath: relativePathWithinRoot(source.rootDir, resolvedFile),
      };
    } catch (error) {
      if (error.code === 'EVIDENCE_STORAGE_PATH_OUTSIDE_ROOT') return null;
      throw error;
    }
  }).filter(Boolean).sort((left, right) => right.source.rootDir.length - left.source.rootDir.length);

  if (candidates.length === 0) throw createError('EVIDENCE_STORAGE_PATH_UNMAPPED');
  if (candidates.length > 1 && candidates[0].source.rootDir === candidates[1].source.rootDir) {
    throw createError('EVIDENCE_STORAGE_PATH_AMBIGUOUS');
  }

  const selected = candidates[0];
  if (options.requireExisting !== false) {
    const stat = fs.lstatSync(resolvedFile);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw createError('EVIDENCE_STORAGE_FILE_INVALID');
    }
    const realRoot = fs.realpathSync(selected.source.rootDir);
    const realFile = fs.realpathSync(resolvedFile);
    relativePathWithinRoot(realRoot, realFile);
  }

  return {
    filePath: resolvedFile,
    objectKey: joinStorageKey(selected.source.keyPrefix, selected.relativePath),
    relativePath: selected.relativePath,
    source: selected.source.name,
  };
}

function resolveOperationFile(operation, sources) {
  const source = sources.find((item) => item.name === operation.source);
  if (!source) throw createError('EVIDENCE_STORAGE_OPERATION_SOURCE_INVALID');
  const filePath = path.resolve(source.rootDir, ...normalizeStorageKey(operation.relativePath).split('/'));
  const located = locateStorageSource(filePath, [source]);
  if (located.objectKey !== operation.objectKey) {
    throw createError('EVIDENCE_STORAGE_OPERATION_KEY_MISMATCH');
  }
  return filePath;
}

module.exports = {
  createError,
  joinStorageKey,
  locateStorageSource,
  normalizeStorageKey,
  resolveOperationFile,
  validateSourceMappings,
};
