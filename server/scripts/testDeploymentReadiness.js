const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runDeploymentChecks } = require('./checkDeploymentReadiness');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myml-evidence-readiness-'));
const dataDir = path.join(tempRoot, 'data');
const runtimeDir = path.join(tempRoot, 'runtime');
const knowledgeDir = path.join(tempRoot, 'knowledge');

try {
  writeJson(path.join(dataDir, 'element-terms.json'), ['flower']);
  writeJson(path.join(dataDir, 'category-candidates.json'), ['rug']);
  writeJson(path.join(dataDir, 'category-catalog-overrides.json'), {});
  fs.mkdirSync(path.join(dataDir, 'category-images'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'category-images', 'sample.png'), Buffer.from([1]));
  fs.mkdirSync(runtimeDir, { recursive: true });
  writeJson(
    path.join(knowledgeDir, 'data', 'indexes', 'element-source-gallery-index.json'),
    [{
      normalized_term: 'flower',
      candidate_source_design_images_via_sku: [{
        source_image_url: 'http://images.internal/flower.png',
      }],
    }],
  );

  const env = {
    MYML_EVIDENCE_AGENT_TOKEN: 'a'.repeat(48),
    COMPANY_DB_HOST: 'db.internal',
    COMPANY_DB_NAME: 'company',
    COMPANY_DB_USER: 'readonly',
    COMPANY_DB_PASSWORD: 'not-a-placeholder',
    COMPANY_DB_VIEW: 'approved_view',
    COMPANY_REFERENCE_IMAGE_BASE_URL: 'http://images.internal',
    AI_ELEMENT_MAPPER_ENABLED: 'true',
    AI_ELEMENT_MAPPER_BASE_URL: 'http://ai.internal/v1',
    AI_ELEMENT_MAPPER_API_KEY: 'mapper-key',
    AI_ELEMENT_MAPPER_MODEL: 'chat-model',
    AI_IMAGE_GENERATOR_ENABLED: 'true',
    AI_IMAGE_GENERATOR_BASE_URL: 'http://ai.internal/v1',
    AI_IMAGE_GENERATOR_API_KEY: 'image-key',
    AI_IMAGE_GENERATOR_MODEL: 'image-model',
    MYML_DESIGN_KNOWLEDGE_BASE_PATH: knowledgeDir,
  };

  const checks = runDeploymentChecks({ env, dataDir, runtimeDir });
  assert.equal(checks.every((check) => check.status === 'pass'), true);

  const missingToken = runDeploymentChecks({
    env: { ...env, MYML_EVIDENCE_AGENT_TOKEN: '' },
    dataDir,
    runtimeDir,
  });
  assert.equal(
    missingToken.find((check) => check.name === 'env:MYML_EVIDENCE_AGENT_TOKEN')?.status,
    'fail',
  );

  console.log('Deployment readiness tests passed.');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
