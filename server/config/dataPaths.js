const path = require('path');

function cleanPath(value) {
  return typeof value === 'string' && value.trim() ? path.resolve(value.trim()) : '';
}

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');

const EVIDENCE_DATA_DIR = cleanPath(process.env.EVIDENCE_DATA_DIR) || DEFAULT_DATA_DIR;
const EVIDENCE_RUNTIME_DIR = cleanPath(process.env.EVIDENCE_RUNTIME_DIR) || EVIDENCE_DATA_DIR;

module.exports = {
  EVIDENCE_DATA_DIR,
  EVIDENCE_RUNTIME_DIR,
};
