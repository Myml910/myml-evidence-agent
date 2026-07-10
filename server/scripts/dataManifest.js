const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_SCHEMA_VERSION = 1;

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function listFiles(rootPath) {
  const files = [];

  async function visit(directoryPath) {
    const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));

    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error('Data manifests do not follow symbolic links.');
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  await visit(rootPath);
  return files;
}

async function buildDataManifest(rootDirectory) {
  const requestedRoot = path.resolve(String(rootDirectory || ''));
  const rootPath = await fs.promises.realpath(requestedRoot);
  const rootStat = await fs.promises.stat(rootPath);
  if (!rootStat.isDirectory()) {
    throw new Error('Manifest root must be a directory.');
  }

  const absoluteFiles = await listFiles(rootPath);
  const files = [];
  let totalBytes = 0;

  for (const filePath of absoluteFiles) {
    const stat = await fs.promises.stat(filePath);
    const relativePath = path.relative(rootPath, filePath).split(path.sep).join('/');
    totalBytes += stat.size;
    files.push({
      path: relativePath,
      size: stat.size,
      sha256: await hashFile(filePath),
    });
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    algorithm: 'sha256',
    createdAt: new Date().toISOString(),
    rootName: path.basename(rootPath),
    fileCount: files.length,
    totalBytes,
    files,
  };
}

async function createDataManifest(rootDirectory, outputFile) {
  const rootPath = await fs.promises.realpath(path.resolve(String(rootDirectory || '')));
  const outputPath = path.resolve(String(outputFile || ''));
  if (isPathInside(rootPath, outputPath)) {
    throw new Error('Write the manifest outside the data directory being hashed.');
  }

  const manifest = await buildDataManifest(rootPath);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await fs.promises.rename(temporaryPath, outputPath);
  return manifest;
}

function safeManifestRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return '';
  const segments = normalized.split('/');
  return segments.some((segment) => !segment || segment === '.' || segment === '..')
    ? ''
    : normalized;
}

async function verifyDataManifest(rootDirectory, manifestFile) {
  const rootPath = await fs.promises.realpath(path.resolve(String(rootDirectory || '')));
  const manifest = JSON.parse(await fs.promises.readFile(path.resolve(manifestFile), 'utf8'));
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported or malformed data manifest.');
  }

  const expected = new Map();
  for (const item of manifest.files) {
    const relativePath = safeManifestRelativePath(item?.path);
    if (!relativePath || expected.has(relativePath)) {
      throw new Error('Manifest contains an unsafe or duplicate relative path.');
    }
    expected.set(relativePath, item);
  }

  const actualManifest = await buildDataManifest(rootPath);
  const actual = new Map(actualManifest.files.map((item) => [item.path, item]));
  let missing = 0;
  let changed = 0;
  let unexpected = 0;

  for (const [relativePath, expectedItem] of expected) {
    const actualItem = actual.get(relativePath);
    if (!actualItem) {
      missing += 1;
      continue;
    }
    if (actualItem.size !== expectedItem.size || actualItem.sha256 !== expectedItem.sha256) {
      changed += 1;
    }
  }

  for (const relativePath of actual.keys()) {
    if (!expected.has(relativePath)) unexpected += 1;
  }

  return {
    ok: missing === 0 && changed === 0 && unexpected === 0,
    fileCount: actualManifest.fileCount,
    totalBytes: actualManifest.totalBytes,
    missing,
    changed,
    unexpected,
  };
}

function printUsage() {
  console.error('Usage:');
  console.error('  node server/scripts/dataManifest.js create <data-directory> <manifest-file>');
  console.error('  node server/scripts/dataManifest.js verify <data-directory> <manifest-file>');
}

async function main(argv = process.argv.slice(2)) {
  const [command, rootDirectory, manifestFile] = argv;
  if (!['create', 'verify'].includes(command) || !rootDirectory || !manifestFile) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  if (command === 'create') {
    const manifest = await createDataManifest(rootDirectory, manifestFile);
    console.log(`Created SHA-256 manifest: ${manifest.fileCount} files, ${manifest.totalBytes} bytes.`);
    return;
  }

  const result = await verifyDataManifest(rootDirectory, manifestFile);
  if (!result.ok) {
    console.error(
      `Manifest verification failed: missing=${result.missing}, changed=${result.changed}, unexpected=${result.unexpected}.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Manifest verification passed: ${result.fileCount} files, ${result.totalBytes} bytes.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Data manifest command failed.');
    process.exitCode = 1;
  });
}

module.exports = {
  buildDataManifest,
  createDataManifest,
  verifyDataManifest,
};
