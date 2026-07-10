const fs = require('fs');
const path = require('path');
const { EVIDENCE_DATA_DIR, EVIDENCE_RUNTIME_DIR } = require('../config/dataPaths');

const PLACEHOLDER_PATTERN = /(change[_-]?this|please[_-]?change|example|replace[_-]?me)/i;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function enabled(value, fallback = true) {
  const text = cleanString(value).toLowerCase();
  if (!text) return fallback;
  return !['0', 'false', 'no', 'off'].includes(text);
}

function isConfigured(value, minimumLength = 1) {
  const text = cleanString(value);
  return text.length >= minimumLength && !PLACEHOLDER_PATTERN.test(text);
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(cleanString(value));
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function parseJson(filePath, expectedType) {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (expectedType === 'array' && !Array.isArray(value)) {
    throw new Error('expected a JSON array');
  }
  if (expectedType === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('expected a JSON object');
  }
  return value;
}

function countRegularFiles(rootPath) {
  let count = 0;
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolutePath);
      if (entry.isFile()) count += 1;
    }
  }
  return count;
}

function galleryIndexPath(env) {
  const explicit = cleanString(env.ELEMENT_SOURCE_GALLERY_INDEX_PATH);
  if (explicit) return path.resolve(explicit);
  const root = cleanString(env.MYML_DESIGN_KNOWLEDGE_BASE_PATH || env.DESIGN_KNOWLEDGE_BASE_PATH);
  return root
    ? path.resolve(root, 'data', 'indexes', 'element-source-gallery-index.json')
    : '';
}

function galleryImageReferenceIsUsable(image, indexPath, knowledgeRoot) {
  if (isHttpUrl(image?.source_image_url)) return true;
  const localPath = cleanString(image?.source_image_path || image?.local_path);
  if (!localPath) return false;

  const candidates = path.isAbsolute(localPath)
    ? [localPath]
    : [
        path.resolve(path.dirname(indexPath), localPath),
        ...(knowledgeRoot ? [path.resolve(knowledgeRoot, localPath)] : []),
      ];
  return candidates.some((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function runDeploymentChecks({ env = process.env, dataDir = EVIDENCE_DATA_DIR, runtimeDir = EVIDENCE_RUNTIME_DIR } = {}) {
  const checks = [];
  const add = (name, check, failureMessage) => {
    try {
      const result = check();
      if (result && typeof result === 'object') {
        checks.push({
          name,
          status: result.status === 'warn' ? 'warn' : 'pass',
          detail: cleanString(result.detail),
        });
      } else {
        checks.push({ name, status: 'pass', detail: typeof result === 'string' ? result : '' });
      }
    } catch {
      checks.push({ name, status: 'fail', detail: failureMessage });
    }
  };

  add('env:MYML_EVIDENCE_AGENT_TOKEN', () => {
    if (!isConfigured(env.MYML_EVIDENCE_AGENT_TOKEN, 32)) throw new Error();
  }, 'missing, placeholder, or shorter than 32 characters');

  for (const name of [
    'COMPANY_DB_HOST',
    'COMPANY_DB_NAME',
    'COMPANY_DB_USER',
    'COMPANY_DB_PASSWORD',
    'COMPANY_DB_VIEW',
  ]) {
    add(`env:${name}`, () => {
      if (!isConfigured(env[name])) throw new Error();
    }, 'required value is not configured');
  }

  add('env:COMPANY_REFERENCE_IMAGE_BASE_URL', () => {
    if (!isHttpUrl(env.COMPANY_REFERENCE_IMAGE_BASE_URL)) throw new Error();
  }, 'must be an http(s) URL without embedded credentials');

  if (enabled(env.AI_ELEMENT_MAPPER_ENABLED, true)) {
    for (const name of ['AI_ELEMENT_MAPPER_BASE_URL', 'AI_ELEMENT_MAPPER_API_KEY', 'AI_ELEMENT_MAPPER_MODEL']) {
      add(`env:${name}`, () => {
        const valid = name.endsWith('BASE_URL') ? isHttpUrl(env[name]) : isConfigured(env[name]);
        if (!valid) throw new Error();
      }, 'required by the enabled AI element mapper');
    }
  }

  if (enabled(env.AI_IMAGE_GENERATOR_ENABLED, true)) {
    for (const name of ['AI_IMAGE_GENERATOR_BASE_URL', 'AI_IMAGE_GENERATOR_API_KEY', 'AI_IMAGE_GENERATOR_MODEL']) {
      add(`env:${name}`, () => {
        const valid = name.endsWith('BASE_URL') ? isHttpUrl(env[name]) : isConfigured(env[name]);
        if (!valid) throw new Error();
      }, 'required by the enabled AI image generator');
    }
  }

  add('data:separate-runtime-directory', () => {
    if (path.resolve(dataDir) === path.resolve(runtimeDir)) throw new Error();
  }, 'production data and runtime directories must be separate');

  add('data:element-terms.json', () => {
    const values = parseJson(path.join(dataDir, 'element-terms.json'), 'array');
    if (values.length === 0) throw new Error();
    return `${values.length} records`;
  }, 'missing, invalid, or empty');

  add('data:category-candidates.json', () => {
    const values = parseJson(path.join(dataDir, 'category-candidates.json'), 'array');
    if (values.length === 0) throw new Error();
    return `${values.length} records`;
  }, 'missing, invalid, or empty');

  add('data:category-catalog-overrides.json', () => {
    parseJson(path.join(dataDir, 'category-catalog-overrides.json'));
  }, 'missing or invalid JSON');

  add('data:category-images', () => {
    const directory = path.join(dataDir, 'category-images');
    if (!fs.statSync(directory).isDirectory()) throw new Error();
    const count = countRegularFiles(directory);
    if (count === 0) throw new Error();
    return `${count} files`;
  }, 'missing or empty directory');

  add('runtime:directory', () => {
    if (!fs.statSync(runtimeDir).isDirectory()) throw new Error();
    fs.accessSync(runtimeDir, fs.constants.R_OK | fs.constants.W_OK);
  }, 'directory must exist and be readable/writable');

  add('knowledge:element-gallery-index', () => {
    const indexPath = galleryIndexPath(env);
    if (!indexPath) throw new Error();
    const values = parseJson(indexPath, 'array');
    if (values.length === 0) throw new Error();
    const imageReferences = values.flatMap((entry) =>
      Array.isArray(entry?.candidate_source_design_images_via_sku)
        ? entry.candidate_source_design_images_via_sku
        : [],
    );
    if (imageReferences.length === 0) throw new Error();
    const knowledgeRoot = cleanString(
      env.MYML_DESIGN_KNOWLEDGE_BASE_PATH || env.DESIGN_KNOWLEDGE_BASE_PATH,
    );
    const usableCount = imageReferences.filter((image) =>
      galleryImageReferenceIsUsable(image, indexPath, knowledgeRoot),
    ).length;
    if (usableCount === 0) throw new Error();
    if (usableCount < imageReferences.length) {
      return {
        status: 'warn',
        detail: `${usableCount}/${imageReferences.length} image references are usable`,
      };
    }
    return `${values.length} records; ${usableCount} usable image references`;
  }, 'missing, invalid, empty, or contains no usable image references');

  return checks;
}

function main() {
  const checks = runDeploymentChecks();
  for (const check of checks) {
    const marker = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL';
    const detail = check.detail ? ` - ${check.detail}` : '';
    console.log(`[${marker}] ${check.name}${detail}`);
  }

  const failed = checks.filter((check) => check.status === 'fail').length;
  if (failed > 0) {
    console.error(`Evidence Agent deployment readiness failed: ${failed} check(s).`);
    process.exitCode = 1;
    return;
  }
  console.log('Evidence Agent deployment readiness passed.');
}

if (require.main === module) {
  main();
}

module.exports = {
  runDeploymentChecks,
};
