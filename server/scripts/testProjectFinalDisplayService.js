const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getLatestProjectRunForCode,
  getProjectRunsForCode,
  recordProjectGenerationResult,
  recordProjectRunMetadata,
  recordProjectRunProgress,
} = require('../services/projectRunStore');
const { referenceSourceHash } = require('../services/projectReferenceMediaStore');
const { prepareProjectFinalDisplay } = require('../services/projectFinalDisplayService');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myml-final-display-'));
const storeOptions = {
  storePath: path.join(tempDir, 'project-runs.json'),
  assetDir: path.join(tempDir, 'assets'),
  assetPublicPath: '/test-assets',
};

const calls = [];

async function persistReferenceMediaForTest({ runId, images }) {
  return {
    images: (Array.isArray(images) ? images : []).map((image) => {
      const sourceUrl = image.imageUrl || image.thumbnailUrl || '';
      const sourceUrlHash = referenceSourceHash(sourceUrl);
      const imageUrl = `/test-assets/${encodeURIComponent(runId)}/references/reference-${sourceUrlHash}.png`;
      return {
        ...image,
        imageUrl,
        thumbnailUrl: imageUrl,
        sourceUrlHash,
        mimeType: 'image/png',
        bytes: 68,
      };
    }),
    failures: [],
  };
}

function recordGeneratedImage(request, label) {
  return recordProjectGenerationResult(request, {
    status: 'success',
    source: 'ai_image_generator',
    model: 'gpt-image-2',
    request_mode: 'edits',
    input_image_count: request.generation_stage === 'final_design' ? 4 : 1,
    images: [{
      b64_json: Buffer.from(`fake ${label}`).toString('base64'),
      mime_type: 'image/png',
    }],
  }, storeOptions);
}

async function main() {
  const productRunId = 'prun-YXF2511160004-product';
  recordGeneratedImage({
    project_code: 'YXF2511160004',
    project_run_id: 'prun_YXF2511160004_server_generated',
    generation_stage: 'element_image',
    generation_source: 'company_design_reference_split',
    generation_label: 'server generated should be ignored',
  }, 'server generated element');
  for (const label of ['primary', 'secondary', 'tertiary']) {
    recordGeneratedImage({
      project_code: 'YXF2511160004',
      project_run_id: productRunId,
      generation_stage: 'element_image',
      generation_source: 'company_design_reference_split',
      generation_label: label,
    }, label);
  }
  recordGeneratedImage({
    project_code: 'YXF2511160004',
    project_run_id: productRunId,
    generation_stage: 'final_design',
    generation_source: 'automated_flow_final_generation',
    generation_label: 'Final generated design',
  }, 'final design');

  const result = await prepareProjectFinalDisplay({
    projectCode: 'YXF2511160004',
    request: {},
    dependencies: {
      publicBaseUrlFromRequest: () => 'http://127.0.0.1:3101',
      generatePatternImage: async (request) => {
        calls.push({
          type: 'generate',
          stage: request.generation_stage,
          source: request.generation_source,
          inputImages: request.input_images,
        });
        throw new Error('final-display must not generate images');
      },
      getProjectRunsForCode: (projectCode) => getProjectRunsForCode(projectCode, storeOptions),
    },
  });

  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.source, 'cached_project_final_display');
  assert.strictEqual(result.run.projectCode, 'YXF2511160004');
  assert.strictEqual(result.run.runId, productRunId);
  assert.strictEqual(result.run.elementImages.length, 3);
  assert.strictEqual(result.run.finalDesignImages.length, 1);
  for (const image of result.run.elementImages) {
    assert.match(image.imageUrl, /^http:\/\/127\.0\.0\.1:3101\/test-assets\/prun-YXF2511160004-product\//);
  }
  assert.match(result.run.finalDesignImages[0].imageUrl, /^http:\/\/127\.0\.0\.1:3101\/test-assets\/prun-YXF2511160004-product\//);
  assert.deepStrictEqual(calls, []);

  const legacyRunId = 'prun-YXF2511160013-legacy-direct-reference';
  recordGeneratedImage({
    project_code: 'YXF2511160013',
    project_run_id: legacyRunId,
    generation_stage: 'element_image',
    generation_source: 'company_design_reference_split',
    generation_label: 'legacy material',
  }, 'legacy material');
  recordGeneratedImage({
    project_code: 'YXF2511160013',
    project_run_id: legacyRunId,
    generation_stage: 'final_design',
    generation_source: 'automated_flow_final_generation',
    generation_label: 'legacy final',
  }, 'legacy final');
  const legacyReferenceUrl = 'https://assets.example.test/legacy-reference.png?token=legacy';
  recordProjectRunMetadata({
    project_code: 'YXF2511160013',
    project_run_id: legacyRunId,
  }, {
    project: { projectCode: 'YXF2511160013' },
    designReferenceImages: [{
      id: 'legacy-reference',
      imageUrl: legacyReferenceUrl,
      thumbnailUrl: legacyReferenceUrl,
    }],
    projectDataLayer: {
      projectCode: 'YXF2511160013',
      sections: {
        designReferenceImages: {
          count: 1,
          items: [{
            id: 'legacy-reference',
            imageUrl: legacyReferenceUrl,
            thumbnailUrl: legacyReferenceUrl,
          }],
        },
      },
    },
  }, storeOptions);
  const legacyCached = await prepareProjectFinalDisplay({
    projectCode: 'YXF2511160013',
    request: {},
    dependencies: {
      publicBaseUrlFromRequest: () => 'http://127.0.0.1:3101',
      persistProjectReferenceImages: persistReferenceMediaForTest,
      getProjectRunsForCode: (projectCode) => getProjectRunsForCode(projectCode, storeOptions),
      recordProjectRunMetadata: (request, metadata) => recordProjectRunMetadata(request, metadata, storeOptions),
    },
  });
  assert.strictEqual(legacyCached.source, 'cached_project_final_display');
  assert.strictEqual(legacyCached.designReferenceImages.length, 1);
  assert(!JSON.stringify(legacyCached).includes('assets.example.test'));
  const migratedLegacyRun = getLatestProjectRunForCode('YXF2511160013', storeOptions);
  assert(!JSON.stringify(migratedLegacyRun.designReferenceImages).includes('assets.example.test'));
  assert(!JSON.stringify(migratedLegacyRun.projectDataLayer).includes('assets.example.test'));

  const generatedCalls = [];
  const composeCalls = [];
  const providerTimeouts = [];
  const generated = await prepareProjectFinalDisplay({
    projectCode: 'YXF2511160005',
    request: {},
    dependencies: {
      publicBaseUrlFromRequest: () => 'http://127.0.0.1:3101',
      persistProjectReferenceImages: persistReferenceMediaForTest,
      getProjectRunsForCode: (projectCode) => getProjectRunsForCode(projectCode, storeOptions),
      getLatestProjectRunForCode: (projectCode) => getLatestProjectRunForCode(projectCode, storeOptions),
      recordProjectGenerationResult: (request, result) => recordProjectGenerationResult(request, result, storeOptions),
      recordProjectRunMetadata: (request, metadata) => recordProjectRunMetadata(request, metadata, storeOptions),
      recordProjectRunProgress: (request, progress) => recordProjectRunProgress(request, progress, storeOptions),
      finalDisplayJobTimeoutMs: 10000,
      finalDisplayAiCallTimeoutMs: 5000,
      prepareProposalFromCompanyLookup: async ({ projectCode }) => ({
        found: true,
        project_code: projectCode,
        proposal: {
          project_code: projectCode,
          project_name: 'wildflower kitchen mat',
          category: 'kitchen mat',
          ai_graphic_elements: 'wildflowers and leaves',
          text_elements: 'CLEVELAND',
          design_requirement: 'clean natural layout',
          reference_images: [{
            source_field: 'design_img',
            url: 'https://assets.example.test/design-reference.png?token=secret',
            filename: 'design-reference.png',
            label: 'Company design reference',
          }],
        },
        selected_gallery_images: {
          selected_images: [{
            image_id: 'gallery-1',
            filename: 'gallery-material.png',
            url: 'https://assets.example.test/gallery-material.png',
            match_score: 0.96,
          }],
        },
        category_judgment: {
          predicted_category: 'kitchen mat',
          category_image: {
            image_url: 'https://assets.example.test/history-layout.png',
            image_filename: 'history-layout.png',
            note: 'layout',
          },
        },
      }),
      analyzeMaterialShapeLevels: async () => ({
        status: 'success',
        split_required: true,
        split_reason: 'test split',
        levels: {
          primary: { prompt_guidance: 'primary' },
          secondary: { prompt_guidance: 'secondary' },
          tertiary: { prompt_guidance: 'tertiary' },
        },
      }),
      composeFinalPrompt: async (request) => ({
        ...(composeCalls.push(request), {
          status: 'success',
          final_prompt: `final prompt for ${request.project_code}`,
          history_layout_lock_policy: 'layout_lock',
          history_layout_lock_reason: 'test',
        }),
      }),
      generatePatternImage: async (request, providerOptions) => {
        providerTimeouts.push(providerOptions?.timeoutMs);
        generatedCalls.push({
          stage: request.generation_stage,
          source: request.generation_source,
          runId: request.project_run_id,
          inputImageCount: request.input_images.length,
          inputImages: request.input_images,
          historyLayoutLockPolicy: request.history_layout_lock_policy,
          prompt: request.prompt,
        });
        return {
          status: 'success',
          source: 'ai_image_generator',
          model: 'gpt-image-2',
          request_mode: request.request_mode || 'edits',
          input_image_count: request.input_images.length,
          images: [{
            b64_json: Buffer.from(`${request.generation_stage}:${request.generation_source}:${generatedCalls.length}`).toString('base64'),
            mime_type: 'image/png',
          }],
        };
      },
    },
    options: {
      synchronous: true,
    },
  });

  assert.strictEqual(generated.status, 'completed');
  assert.strictEqual(generated.source, 'generated_project_final_display');
  assert.match(generated.run.runId, /^prun-YXF2511160005-final-display-/);
  assert.strictEqual(generated.run.elementImages.length, 6);
  assert.strictEqual(generated.run.finalDesignImages.length, 1);
  assert.strictEqual(generated.display.materialImageBlock.length, generated.run.elementImages.length);
  assert.strictEqual(generated.display.finalImageGeneration.length, generated.run.finalDesignImages.length);
  assert.strictEqual(generated.display.projectDataLayer.sections.designReferenceImages.count, 1);
  assert.deepStrictEqual(generated.display.projectDataLayer.sections.textElements.visible, ['CLEVELAND']);
  const generatedStoredRun = getLatestProjectRunForCode('YXF2511160005', storeOptions);
  assert.strictEqual(generatedStoredRun.status, 'completed');
  assert.strictEqual(generatedStoredRun.progress.stage, 'project_final_display');
  assert.strictEqual(generatedStoredRun.progress.status, 'success');
  assert.strictEqual(generatedStoredRun.projectDataLayer.sections.designReferenceImages.count, 1);
  assert.deepStrictEqual(generatedStoredRun.projectDataLayer.sections.textElements.visible, ['CLEVELAND']);
  assert(!JSON.stringify(generatedStoredRun.projectDataLayer.sections.designReferenceImages).includes('assets.example.test'));
  assert(!JSON.stringify(generatedStoredRun.designReferenceImages).includes('assets.example.test'));
  assert(providerTimeouts.every((timeoutMs) => timeoutMs > 0 && timeoutMs <= 5000));
  assert.strictEqual(generatedCalls.length, 7);
  assert.deepStrictEqual(generatedCalls.map((call) => call.source), [
    'gallery_material_split_cleanup',
    'gallery_material_split_cleanup',
    'gallery_material_split_cleanup',
    'company_design_reference_split',
    'company_design_reference_split',
    'company_design_reference_split',
    'automated_flow_final_generation',
  ]);
  const finalGeneratedCall = generatedCalls[generatedCalls.length - 1];
  assert.strictEqual(finalGeneratedCall.inputImages[0].role, 'history');
  assert.match(finalGeneratedCall.inputImages[0].url, /history-layout\.png$/);
  assert.strictEqual(finalGeneratedCall.inputImages[1].role, 'material');
  assert.match(finalGeneratedCall.inputImages[1].label, /Primary material/);
  assert.strictEqual(finalGeneratedCall.historyLayoutLockPolicy, 'layout_lock');
  assert.strictEqual(composeCalls.length, 1);
  assert.strictEqual(composeCalls[0].prompt_template_id, 'structured_ai');
  assert.match(composeCalls[0].template_prompt, /Input image order is binding/);
  assert.match(composeCalls[0].template_prompt, /Never stretch, squash, crop, enlarge, shrink, move, or reframe/);
  assert.match(composeCalls[0].template_prompt, /Current final prompt template branch: structured_ai/);
  assert.match(composeCalls[0].template_prompt, /Background strategy/);
  assert(generated.run.elementImages.every((image) => image.imageUrl.startsWith('http://127.0.0.1:3101/test-assets/')));
  assert(generated.run.finalDesignImages.every((image) => image.imageUrl.startsWith('http://127.0.0.1:3101/test-assets/')));

  const unifiedCalls = [];
  const unifiedComposeCalls = [];
  const unifiedAnalyzeCalls = [];
  const unified = await prepareProjectFinalDisplay({
    projectCode: 'YXF2511160007',
    request: {},
    dependencies: {
      publicBaseUrlFromRequest: () => 'http://127.0.0.1:3101',
      persistProjectReferenceImages: persistReferenceMediaForTest,
      getProjectRunsForCode: (projectCode) => getProjectRunsForCode(projectCode, storeOptions),
      getLatestProjectRunForCode: (projectCode) => getLatestProjectRunForCode(projectCode, storeOptions),
      recordProjectGenerationResult: (request, result) => recordProjectGenerationResult(request, result, storeOptions),
      recordProjectRunMetadata: (request, metadata) => recordProjectRunMetadata(request, metadata, storeOptions),
      recordProjectRunProgress: (request, progress) => recordProjectRunProgress(request, progress, storeOptions),
      prepareProposalFromCompanyLookup: async ({ projectCode }) => ({
        found: true,
        project_code: projectCode,
        proposal: {
          project_code: projectCode,
          project_name: 'unified design reference project',
          category: 'blanket',
          ai_graphic_elements: 'football typography',
          text_elements: 'PITTSBURGH',
          design_requirement: 'style reference image 2,4,5',
          reference_images: [1, 2, 3, 4, 5].map((index) => ({
            source_field: 'design_img',
            url: `https://assets.example.test/unified-design-reference-${index}.png`,
            filename: `unified-design-reference-${index}.png`,
            label: `Company design reference ${index}`,
          })),
        },
        selected_gallery_images: {
          selected_images: [],
        },
        category_judgment: {
          predicted_category: 'blanket',
          category_image: {
            image_url: 'https://assets.example.test/unified-history-layout.png',
            image_filename: 'unified-history-layout.png',
            note: 'layout',
          },
        },
      }),
      analyzeMaterialShapeLevels: async (request) => {
        unifiedAnalyzeCalls.push(request);
        return {
          status: 'success',
          split_required: false,
          split_reason: 'single cohesive board',
          single_material_guidance: 'keep as one material board',
        };
      },
      composeFinalPrompt: async (request) => {
        unifiedComposeCalls.push(request);
        if (request.prompt_template_id === 'material_board_reverse') {
          assert.strictEqual(request.input_images.length, 1);
          assert.strictEqual(request.input_images[0].role, 'material_board_reverse_source');
          return {
            status: 'success',
            final_prompt: '## Image Prompt Description\n\n**1. Core Subject & Theme (鏍稿績涓讳綋涓庝富棰?:** Football typography material board.',
          };
        }
        return {
          status: 'success',
          final_prompt: `final prompt for ${request.project_code}`,
          history_layout_lock_policy: 'layout_lock',
          history_layout_lock_reason: 'blanket collage template',
        };
      },
      generatePatternImage: async (request) => {
        unifiedCalls.push({
          stage: request.generation_stage,
          source: request.generation_source,
          label: request.generation_label,
          requestMode: request.request_mode || 'edits',
          inputImages: request.input_images || [],
        });
        return {
          status: 'success',
          source: 'ai_image_generator',
          model: 'gpt-image-2',
          request_mode: request.request_mode || 'edits',
          input_image_count: Array.isArray(request.input_images) ? request.input_images.length : 0,
          images: [{
            b64_json: Buffer.from(`${request.generation_stage}:${request.generation_source}:${unifiedCalls.length}`).toString('base64'),
            mime_type: 'image/png',
          }],
        };
      },
    },
    options: {
      synchronous: true,
    },
  });

  assert.strictEqual(unified.status, 'completed');
  assert.strictEqual(unified.display.projectDataLayer.sections.designReferenceImages.count, 5);
  assert.strictEqual(unified.designReferenceImages.length, 3);
  assert(unified.display.projectDataLayer.sections.designReferenceImages.items.every(
    (image) => image.imageUrl.startsWith('/test-assets/prun-YXF2511160007-'),
  ));
  assert(unified.designReferenceImages.every(
    (image) => image.imageUrl.startsWith('/test-assets/prun-YXF2511160007-'),
  ));
  assert(!JSON.stringify(unified.display.projectDataLayer).includes('assets.example.test'));
  assert(!JSON.stringify(unified.designReferenceImages).includes('assets.example.test'));
  const unifiedStoredRun = getLatestProjectRunForCode('YXF2511160007', storeOptions);
  assert(!JSON.stringify(unifiedStoredRun.projectDataLayer.sections.designReferenceImages).includes('assets.example.test'));
  assert(!JSON.stringify(unifiedStoredRun.designReferenceImages).includes('assets.example.test'));
  assert.deepStrictEqual(
    unifiedAnalyzeCalls[0].input_images.map((image) => image.filename),
    [
      'unified-design-reference-2.png',
      'unified-design-reference-4.png',
      'unified-design-reference-5.png',
    ],
  );
  assert.deepStrictEqual(unifiedCalls.map((call) => call.source), [
    'company_design_reference_unified_split',
    'design_reference_unified_regeneration',
    'automated_flow_final_generation',
  ]);
  assert.strictEqual(unifiedCalls[1].requestMode, 'images');
  assert.strictEqual(unifiedCalls[1].inputImages.length, 0);
  assert.strictEqual(unified.run.elementImages.length, 1);
  assert.strictEqual(unified.run.elementImages[0].source, 'design_reference_unified_regeneration');
  assert.strictEqual(unifiedCalls[2].inputImages[0].role, 'history');
  assert.strictEqual(unifiedCalls[2].inputImages[1].role, 'material');
  assert.match(unifiedCalls[2].inputImages[1].url, /^http:\/\/127\.0\.0\.1:3101\/test-assets\//);
  assert.deepStrictEqual(unifiedComposeCalls.map((call) => call.prompt_template_id), [
    'material_board_reverse',
    'structured_ai',
  ]);

  const asyncCalls = [];
  let activeAsyncGenerations = 0;
  let maxActiveAsyncGenerations = 0;
  const asyncDependencies = {
    publicBaseUrlFromRequest: () => 'http://127.0.0.1:3101',
    persistProjectReferenceImages: persistReferenceMediaForTest,
    finalDisplayRetryBaseDelayMs: 1,
    getProjectRunsForCode: (projectCode) => getProjectRunsForCode(projectCode, storeOptions),
    getLatestProjectRunForCode: (projectCode) => getLatestProjectRunForCode(projectCode, storeOptions),
    recordProjectGenerationResult: (request, result) => recordProjectGenerationResult(request, result, storeOptions),
    recordProjectRunMetadata: (request, metadata) => recordProjectRunMetadata(request, metadata, storeOptions),
    recordProjectRunProgress: (request, progress) => recordProjectRunProgress(request, progress, storeOptions),
    prepareProposalFromCompanyLookup: async ({ projectCode }) => ({
      found: true,
      project_code: projectCode,
      proposal: {
        project_code: projectCode,
        project_name: 'async project',
        category: 'blanket',
        ai_graphic_elements: 'sports mascot and typography',
        text_elements: 'CLEVELAND',
        design_requirement: 'commercial final layout',
        reference_images: [{
          source_field: 'design_img',
          url: 'https://assets.example.test/async-design-reference.png',
          filename: 'async-design-reference.png',
          label: 'Company design reference',
        }],
      },
      selected_gallery_images: {
        selected_images: [],
      },
      category_judgment: {
        predicted_category: 'blanket',
        category_image: {
          image_url: 'https://assets.example.test/async-history-layout.png',
          image_filename: 'async-history-layout.png',
          note: 'layout',
        },
      },
    }),
    analyzeMaterialShapeLevels: async () => ({
      status: 'success',
      split_required: true,
      levels: {
        primary: { prompt_guidance: 'primary' },
        secondary: { prompt_guidance: 'secondary' },
        tertiary: { prompt_guidance: 'tertiary' },
      },
    }),
    composeFinalPrompt: async (request) => ({
      status: 'success',
      final_prompt: `async final prompt for ${request.project_code}`,
    }),
    generatePatternImage: async (request) => {
      asyncCalls.push({
        stage: request.generation_stage,
        source: request.generation_source,
        runId: request.project_run_id,
      });
      activeAsyncGenerations += 1;
      maxActiveAsyncGenerations = Math.max(maxActiveAsyncGenerations, activeAsyncGenerations);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          status: 'success',
          source: 'ai_image_generator',
          model: 'gpt-image-2',
          request_mode: request.request_mode || 'edits',
          input_image_count: request.input_images.length,
          images: [{
            b64_json: Buffer.from(`${request.generation_stage}:${request.generation_source}:${request.generation_label}`).toString('base64'),
            mime_type: 'image/png',
          }],
        };
      } finally {
        activeAsyncGenerations -= 1;
      }
    },
  };

  const pending = await prepareProjectFinalDisplay({
    projectCode: 'YXF2511160006',
    request: {},
    dependencies: asyncDependencies,
  });

  assert.strictEqual(pending.status, 'pending');
  assert.match(pending.run.runId, /^prun-YXF2511160006-final-display-/);
  assert.strictEqual(pending.display.finalImageGeneration.length, 0);
  assert.strictEqual(pending.display.projectDataLayer.sections.designReferenceImages.count, 1);

  let completed = null;
  for (let index = 0; index < 40; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await prepareProjectFinalDisplay({
      projectCode: 'YXF2511160006',
      request: {},
      dependencies: asyncDependencies,
    });
    if (result.status === 'completed') {
      completed = result;
      break;
    }
  }

  assert(completed, 'background final-display job should complete while callers poll');
  assert.strictEqual(completed.run.status, 'completed');
  assert.strictEqual(completed.run.progress.stage, 'project_final_display');
  assert.strictEqual(completed.run.progress.status, 'success');
  assert.strictEqual(completed.run.elementImages.length, 3);
  assert.strictEqual(completed.run.finalDesignImages.length, 1);
  assert.strictEqual(completed.display.projectDataLayer.sections.designReferenceImages.count, 1);
  assert.strictEqual(new Set(asyncCalls.map((call) => call.runId)).size, 1);
  assert.strictEqual(maxActiveAsyncGenerations, 2);
  assert.deepStrictEqual(asyncCalls.map((call) => call.source), [
    'company_design_reference_split',
    'company_design_reference_split',
    'company_design_reference_split',
    'automated_flow_final_generation',
  ]);

  let failedAnalysisAttempts = 0;
  const failingDependencies = {
    ...asyncDependencies,
    analyzeMaterialShapeLevels: async () => {
      failedAnalysisAttempts += 1;
      const error = new Error('temporary analyzer failure');
      error.code = 'EVIDENCE_AGENT_MATERIAL_SHAPE_ANALYSIS_FAILED';
      error.retryable = true;
      throw error;
    },
  };
  const pendingFailure = await prepareProjectFinalDisplay({
    projectCode: 'YXF2511160009',
    request: {},
    dependencies: failingDependencies,
  });
  assert.strictEqual(pendingFailure.status, 'pending');

  let terminalFailure = null;
  for (let index = 0; index < 40; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      await prepareProjectFinalDisplay({
        projectCode: 'YXF2511160009',
        request: {},
        dependencies: failingDependencies,
      });
    } catch (error) {
      terminalFailure = error;
      break;
    }
  }

  assert(terminalFailure, 'failed background job should return a terminal error to polling callers');
  assert.strictEqual(terminalFailure.retryable, false);
  assert.strictEqual(failedAnalysisAttempts, 3);
  const persistedFailure = getLatestProjectRunForCode('YXF2511160009', storeOptions);
  assert.strictEqual(persistedFailure.status, 'failed');
  assert.strictEqual(persistedFailure.progress.stage, 'reference');
  assert.strictEqual(persistedFailure.progress.status, 'failed');
  assert.strictEqual(persistedFailure.error.retryable, false);

  await assert.rejects(
    () => prepareProjectFinalDisplay({
      projectCode: 'YXF2511160009',
      request: {},
      dependencies: failingDependencies,
    }),
    (error) => error === terminalFailure,
  );
  assert.strictEqual(failedAnalysisAttempts, 3, 'polling must not recreate a terminally failed job');

  const persistedFailureRunId = 'prun-YXF2511160010-final-display-persisted';
  recordProjectRunProgress({
    project_code: 'YXF2511160010',
    project_run_id: persistedFailureRunId,
    request_id: 'persisted-request-id',
  }, {
    stage: 'generate',
    status: 'failed',
    runStatus: 'failed',
    attempt: 3,
    maxAttempts: 3,
    error: {
      code: 'EVIDENCE_AGENT_FINAL_GENERATION_FAILED',
      retryable: false,
    },
  }, storeOptions);
  let persistedFailureLookupCalls = 0;
  const persistedFailureDependencies = {
    getProjectRunsForCode: (projectCode) => getProjectRunsForCode(projectCode, storeOptions),
    getLatestProjectRunForCode: (projectCode) => getLatestProjectRunForCode(projectCode, storeOptions),
    prepareProposalFromCompanyLookup: async () => {
      persistedFailureLookupCalls += 1;
      throw new Error('terminal persisted runs must not restart provider work');
    },
  };
  await assert.rejects(
    () => prepareProjectFinalDisplay({
      projectCode: 'YXF2511160010',
      request: { body: { requestId: 'persisted-request-id' } },
      dependencies: persistedFailureDependencies,
      options: { runId: persistedFailureRunId },
    }),
    (error) => error.code === 'EVIDENCE_AGENT_FINAL_GENERATION_FAILED' && error.retryable === false,
  );
  await assert.rejects(
    () => prepareProjectFinalDisplay({
      projectCode: 'YXF2511160010',
      request: { body: { requestId: 'persisted-request-id' } },
      dependencies: persistedFailureDependencies,
    }),
    (error) => error.code === 'EVIDENCE_AGENT_FINAL_GENERATION_FAILED' && error.retryable === false,
  );
  assert.strictEqual(persistedFailureLookupCalls, 0);

  const comboGenerateCalls = [];
  const comboComposeCalls = [];
  const combo = await prepareProjectFinalDisplay({
    projectCode: 'YXF2511160008',
    request: {},
    dependencies: {
      publicBaseUrlFromRequest: () => 'http://127.0.0.1:3101',
      persistProjectReferenceImages: persistReferenceMediaForTest,
      getProjectRunsForCode: (projectCode) => getProjectRunsForCode(projectCode, storeOptions),
      getLatestProjectRunForCode: (projectCode) => getLatestProjectRunForCode(projectCode, storeOptions),
      recordProjectGenerationResult: (request, result) => recordProjectGenerationResult(request, result, storeOptions),
      recordProjectRunMetadata: (request, metadata) => recordProjectRunMetadata(request, metadata, storeOptions),
      recordProjectRunProgress: (request, progress) => recordProjectRunProgress(request, progress, storeOptions),
      prepareProposalFromCompanyLookup: async () => ({
        found: true,
        project_code: 'YXF2511160008',
        proposal: {
          project_code: 'YXF2511160008',
          project_name: 'combo party kit',
          ai_graphic_elements: 'birthday theme',
          text_elements: 'HAPPY BIRTHDAY',
          design_requirement: 'combo kit with plate and napkin',
          reference_images: [{
            source_field: 'design_img',
            url: 'https://assets.example.test/combo-design-reference.png',
            filename: 'combo-design-reference.png',
            label: 'Company design reference',
          }],
        },
        selected_gallery_images: {
          selected_images: [],
        },
        category_judgment: {
          predicted_category: '餐盘',
          predicted_categories: [
            {
              category: '餐盘',
              confidence: 0.93,
              reason: 'plate in combo',
              evidence_fields: ['design_requirement'],
              category_image: {
                category: '餐盘',
                image_url: 'https://assets.example.test/plate-history.png',
                image_filename: 'plate-history.png',
                note: 'plate layout',
                history_images: [{
                  image_url: 'https://assets.example.test/plate-history.png',
                  image_filename: 'plate-history.png',
                  note: 'plate layout',
                }],
              },
            },
            {
              category: '纸巾',
              confidence: 0.91,
              reason: 'napkin in combo',
              evidence_fields: ['design_requirement'],
              category_image: {
                category: '纸巾',
                image_url: 'https://assets.example.test/napkin-history.png',
                image_filename: 'napkin-history.png',
                note: 'napkin layout',
                history_images: [{
                  image_url: 'https://assets.example.test/napkin-history.png',
                  image_filename: 'napkin-history.png',
                  note: 'napkin layout',
                }],
              },
            },
          ],
          category_images: [],
          category_image: {
            category: '餐盘',
            image_url: 'https://assets.example.test/plate-history.png',
            image_filename: 'plate-history.png',
            note: 'plate layout',
            history_images: [{
              image_url: 'https://assets.example.test/plate-history.png',
              image_filename: 'plate-history.png',
              note: 'plate layout',
            }],
          },
        },
      }),
      analyzeMaterialShapeLevels: async () => ({
        status: 'success',
        split_required: true,
        levels: {
          primary: { prompt_guidance: 'primary' },
          secondary: { prompt_guidance: 'secondary' },
          tertiary: { prompt_guidance: 'tertiary' },
        },
      }),
      composeFinalPrompt: async (request) => {
        comboComposeCalls.push(request);
        return {
          status: 'success',
          final_prompt: `combo final prompt for ${request.category}`,
          history_layout_lock_policy: 'layout_lock',
          history_layout_lock_reason: request.category,
        };
      },
      generatePatternImage: async (request) => {
        comboGenerateCalls.push({
          stage: request.generation_stage,
          source: request.generation_source,
          label: request.generation_label,
          category: request.category,
          inputImages: request.input_images,
        });
        return {
          status: 'success',
          source: 'ai_image_generator',
          model: 'gpt-image-2',
          request_mode: request.request_mode || 'edits',
          input_image_count: request.input_images.length,
          images: [{
            b64_json: Buffer.from(`${request.generation_stage}:${request.category}:${comboGenerateCalls.length}`).toString('base64'),
            mime_type: 'image/png',
          }],
        };
      },
    },
    options: {
      synchronous: true,
    },
  });

  assert.strictEqual(combo.status, 'completed');
  assert.strictEqual(combo.run.elementImages.length, 3);
  assert.strictEqual(combo.run.finalDesignImages.length, 2);
  assert.strictEqual(combo.display.projectDataLayer.sections.categoryTargets.count, 2);
  assert.deepStrictEqual(
    comboGenerateCalls.map((call) => call.source),
    [
      'company_design_reference_split',
      'company_design_reference_split',
      'company_design_reference_split',
      'automated_flow_final_generation',
      'automated_flow_final_generation',
    ],
  );
  assert.deepStrictEqual(comboComposeCalls.map((call) => call.category), ['餐盘', '纸巾']);
  assert.deepStrictEqual(
    comboGenerateCalls.filter((call) => call.stage === 'final_design').map((call) => call.category),
    ['餐盘', '纸巾'],
  );
  assert.match(comboGenerateCalls[3].inputImages[0].url, /plate-history\.png$/);
  assert.match(comboGenerateCalls[4].inputImages[0].url, /napkin-history\.png$/);

  const partialGenerateCalls = [];
  const partialCategoryDependencies = {
    ...asyncDependencies,
    prepareProposalFromCompanyLookup: async () => ({
      found: true,
      project_code: 'YXF2511160011',
      proposal: {
        project_code: 'YXF2511160011',
        project_name: 'wind chime and greeting card set',
        ai_graphic_elements: 'botanical gift theme',
        text_elements: 'BEST WISHES',
        design_requirement: 'combo set with wind chime and envelope greeting card',
        reference_images: [{
          source_field: 'design_img',
          url: 'https://assets.example.test/partial-design-reference.png',
          filename: 'partial-design-reference.png',
          label: 'Company design reference',
        }],
      },
      selected_gallery_images: { selected_images: [] },
      category_judgment: {
        predicted_category: 'wind chime',
        predicted_categories: [
          {
            category: 'wind chime',
            confidence: 0.96,
            reason: 'primary product',
          },
          {
            category: 'envelope greeting card',
            confidence: 0.86,
            reason: 'secondary product',
            category_image: {
              category: 'envelope greeting card',
              image_url: 'https://assets.example.test/card-history.png',
              image_filename: 'card-history.png',
              note: 'card layout',
            },
          },
        ],
      },
    }),
    generatePatternImage: async (request) => {
      partialGenerateCalls.push({
        stage: request.generation_stage,
        category: request.category,
      });
      return {
        status: 'success',
        source: 'ai_image_generator',
        model: 'gpt-image-2',
        request_mode: request.request_mode || 'edits',
        input_image_count: request.input_images.length,
        images: [{
          b64_json: Buffer.from(`${request.generation_stage}:${request.category}:${partialGenerateCalls.length}`).toString('base64'),
          mime_type: 'image/png',
        }],
      };
    },
  };
  const partialCategoryResult = await prepareProjectFinalDisplay({
    projectCode: 'YXF2511160011',
    request: {},
    dependencies: partialCategoryDependencies,
    options: { synchronous: true },
  });

  assert.strictEqual(partialCategoryResult.status, 'partial');
  assert.strictEqual(partialCategoryResult.run.elementImages.length, 3);
  assert.strictEqual(partialCategoryResult.run.finalDesignImages.length, 1);
  assert.deepStrictEqual(
    partialGenerateCalls
      .filter((call) => call.stage === 'final_design')
      .map((call) => call.category),
    ['envelope greeting card'],
  );
  assert(partialCategoryResult.warnings.includes('partial_history_layout_coverage'));
  assert(partialCategoryResult.warnings.some((warning) => warning.includes('wind chime')));
  assert.deepStrictEqual(
    partialCategoryResult.display.projectDataLayer.sections.categoryTargets.items
      .map((target) => [target.category, target.hasHistoryTemplate]),
    [
      ['wind chime', false],
      ['envelope greeting card', true],
    ],
  );
  const persistedPartialCategory = getLatestProjectRunForCode('YXF2511160011', storeOptions);
  assert.strictEqual(persistedPartialCategory.status, 'completed');
  assert.strictEqual(persistedPartialCategory.progress.status, 'partial');
  const partialGenerateCallCount = partialGenerateCalls.length;
  const cachedPartialCategoryResult = await prepareProjectFinalDisplay({
    projectCode: 'YXF2511160011',
    request: {},
    dependencies: partialCategoryDependencies,
    options: { synchronous: true },
  });
  assert.strictEqual(cachedPartialCategoryResult.status, 'partial');
  assert.strictEqual(cachedPartialCategoryResult.source, 'cached_project_final_display');
  assert.strictEqual(partialGenerateCalls.length, partialGenerateCallCount);

  const noHistoryResult = await prepareProjectFinalDisplay({
    projectCode: 'YXF2511160012',
    request: {},
    dependencies: {
      ...partialCategoryDependencies,
      prepareProposalFromCompanyLookup: async () => ({
        found: true,
        project_code: 'YXF2511160012',
        proposal: {
          project_code: 'YXF2511160012',
          project_name: 'wind chime only',
          ai_graphic_elements: 'botanical gift theme',
          text_elements: '',
          design_requirement: 'wind chime design',
          reference_images: [{
            source_field: 'design_img',
            url: 'https://assets.example.test/no-history-reference.png',
            filename: 'no-history-reference.png',
            label: 'Company design reference',
          }],
        },
        selected_gallery_images: { selected_images: [] },
        category_judgment: {
          predicted_category: 'wind chime',
          predicted_categories: [{
            category: 'wind chime',
            confidence: 0.96,
            reason: 'primary product',
          }],
        },
      }),
    },
    options: { synchronous: true },
  });

  assert.strictEqual(noHistoryResult.status, 'partial');
  assert.strictEqual(noHistoryResult.run.status, 'partial');
  assert.strictEqual(noHistoryResult.run.elementImages.length, 3);
  assert.strictEqual(noHistoryResult.run.finalDesignImages.length, 0);
  assert.strictEqual(noHistoryResult.display.materialImageBlock.length, 3);
  assert.strictEqual(noHistoryResult.display.finalImageGeneration.length, 0);
  assert(noHistoryResult.warnings.some((warning) => warning.includes('wind chime')));
  const persistedNoHistoryResult = getLatestProjectRunForCode('YXF2511160012', storeOptions);
  assert.strictEqual(persistedNoHistoryResult.status, 'completed');
  assert.strictEqual(persistedNoHistoryResult.progress.status, 'partial');

  console.log('[test:project-final-display] Project final display tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
