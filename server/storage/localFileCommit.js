const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

function writeFileAtomicSync(filePath, body, options = {}) {
  const targetPath = path.resolve(filePath);
  const dirPath = path.dirname(targetPath);
  const mode = options.mode === undefined ? 0o600 : options.mode;
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporaryPath, 'wx', mode);
    fs.writeFileSync(fd, body, options.encoding ? { encoding: options.encoding } : undefined);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, targetPath);
    fs.chmodSync(targetPath, mode);
    syncDirectory(dirPath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  return targetPath;
}

module.exports = {
  writeFileAtomicSync,
};
