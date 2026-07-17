const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getLatestProjectRunForCode,
  getProjectRun,
  getProjectRunsForCode,
  recordProjectGenerationResult,
  recordProjectRunMetadata,
  recordProjectRunProgress,
} = require('../services/projectRunStore');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myml-project-run-store-'));
const committedFiles = [];
const options = {
  storePath: path.join(tempDir, 'project-runs.json'),
  assetDir: path.join(tempDir, 'assets'),
  assetPublicPath: '/test-project-run-assets',
  commitFile: (filePath, details) => committedFiles.push({ filePath, details }),
};

const elementRun = recordProjectGenerationResult({
  project_code: 'YXF2606190001',
  project_run_id: 'run_test_1',
  generation_stage: 'element_image',
  generation_source: 'company_design_reference_split',
  generation_label: 'Primary element',
  prompt: 'do not persist this full prompt',
}, {
  status: 'success',
  source: 'ai_image_generator',
  model: 'gpt-image-2',
  request_mode: 'edits',
  input_image_count: 1,
  images: [{
    url: 'https://assets.example.test/generated-element.png?token=secret#hash',
    revised_prompt: 'do not persist this full revised prompt',
  }],
}, options);

assert(elementRun);
assert.strictEqual(elementRun.runId, 'run_test_1');
assert.strictEqual(elementRun.projectCode, 'YXF2606190001');
assert.strictEqual(elementRun.elementImages.length, 1);
assert.strictEqual(elementRun.elementImages[0].imageUrl, 'https://assets.example.test/generated-element.png');
assert.strictEqual(elementRun.elementImages[0].prompt.length, 'do not persist this full prompt'.length);
assert.strictEqual(elementRun.elementImages[0].prompt.hash.length, 16);
assert(!JSON.stringify(elementRun).includes('do not persist this full prompt'));
assert(!JSON.stringify(elementRun).includes('token=secret'));

const metadataRun = recordProjectRunMetadata({
  project_code: 'YXF2606190001',
  project_run_id: 'run_test_1',
}, {
  project: {
    projectCode: 'YXF2606190001',
    textElements: 'CLEVELAND',
    graphicElements: 'wild flowers',
  },
  designReferenceImages: [{
    id: 'ref_1',
    title: 'Company design reference',
    imageUrl: 'https://assets.example.test/reference.png',
  }],
  projectDataLayer: {
    projectCode: 'YXF2606190001',
    trueCategory: 'kitchen mat',
    sections: {
      designReferenceImages: {
        count: 1,
        items: [{ id: 'ref_1', usageScenario: 'reference preview' }],
      },
      graphicElements: {
        aiExtracted: ['wild flowers'],
      },
      textElements: {
        visible: ['CLEVELAND'],
      },
    },
  },
}, options);

assert(metadataRun);
assert.strictEqual(metadataRun.projectDataLayer.sections.designReferenceImages.count, 1);
assert.deepStrictEqual(metadataRun.projectDataLayer.sections.graphicElements.aiExtracted, ['wild flowers']);
assert.deepStrictEqual(metadataRun.projectDataLayer.sections.textElements.visible, ['CLEVELAND']);

const progressRun = recordProjectRunProgress({
  project_code: 'YXF2606190001',
  project_run_id: 'run_test_1',
}, {
  stage: 'material',
  status: 'started',
  runStatus: 'running',
  attempt: 1,
  maxAttempts: 3,
}, options);
assert.strictEqual(progressRun.status, 'running');
assert.strictEqual(progressRun.progress.stage, 'material');
assert.strictEqual(progressRun.progress.attempt, 1);
assert.strictEqual(progressRun.error, null);

const base64Image = Buffer.from('fake png bytes').toString('base64');
const finalRun = recordProjectGenerationResult({
  project_code: 'YXF2606190001',
  project_run_id: 'run_test_1',
  generation_stage: 'final_design',
  generation_source: 'manual_final_generation',
  generation_label: 'Final design',
  prompt: 'final prompt should be summarized',
}, {
  status: 'success',
  source: 'ai_image_generator',
  model: 'gpt-image-2',
  request_mode: 'edits',
  input_image_count: 2,
  images: [{
    b64_json: base64Image,
    mime_type: 'image/png',
  }],
}, options);

assert(finalRun);
assert.strictEqual(finalRun.status, 'completed');
assert.strictEqual(finalRun.elementImages.length, 1);
assert.strictEqual(finalRun.finalDesignImages.length, 1);
assert.strictEqual(finalRun.projectDataLayer.sections.designReferenceImages.count, 1);
assert(finalRun.finalDesignImages[0].imageUrl.startsWith('/test-project-run-assets/run_test_1/final_design-1-'));
assert(!JSON.stringify(finalRun).includes(base64Image));

const automatedRun = recordProjectGenerationResult({
  project_code: 'YXF2606190002',
  project_run_id: 'run_test_automated',
  generation_stage: 'final_design',
  generation_source: 'automated_flow_final_generation',
  generation_label: 'Automated final design',
  defer_project_run_completion: true,
}, {
  status: 'success',
  source: 'ai_image_generator',
  model: 'gpt-image-2',
  request_mode: 'edits',
  input_image_count: 2,
  images: [{ b64_json: base64Image, mime_type: 'image/png' }],
}, options);
assert.strictEqual(automatedRun.status, 'running');

const failedRun = recordProjectRunProgress({
  project_code: 'YXF2606190002',
  project_run_id: 'run_test_automated',
  request_id: 'request_test_automated',
}, {
  stage: 'reference',
  status: 'failed',
  runStatus: 'failed',
  attempt: 3,
  maxAttempts: 3,
  error: {
    code: 'EVIDENCE_AGENT_REFERENCE_FAILED',
    message: 'must not be persisted',
    retryable: false,
  },
}, options);
assert.strictEqual(failedRun.status, 'failed');
assert.strictEqual(failedRun.requestId, 'request_test_automated');
assert.strictEqual(failedRun.progress.stage, 'reference');
assert.strictEqual(failedRun.error.code, 'EVIDENCE_AGENT_REFERENCE_FAILED');
assert.strictEqual(failedRun.error.retryable, false);
assert(!JSON.stringify(failedRun).includes('must not be persisted'));

const fetchedByRunId = getProjectRun('run_test_1', options);
assert.strictEqual(fetchedByRunId.finalDesignImages.length, 1);

const fetchedLatest = getLatestProjectRunForCode('YXF2606190001', options);
assert.strictEqual(fetchedLatest.runId, 'run_test_1');
assert.strictEqual(fetchedLatest.elementImages.length, 1);
assert.strictEqual(fetchedLatest.finalDesignImages.length, 1);
assert.deepStrictEqual(fetchedLatest.projectDataLayer.sections.textElements.visible, ['CLEVELAND']);

const fetchedRuns = getProjectRunsForCode('YXF2606190001', options);
assert.strictEqual(fetchedRuns.length, 1);
assert.strictEqual(fetchedRuns[0].runId, 'run_test_1');

assert.strictEqual(
  committedFiles.filter((entry) => entry.filePath === options.storePath).length,
  6,
);
assert.strictEqual(
  committedFiles.filter((entry) => entry.filePath.endsWith('.png')).length,
  2,
);
assert(committedFiles.every((entry) => entry.details.body));

console.log('[test:project-run-store] Project run store tests passed.');
