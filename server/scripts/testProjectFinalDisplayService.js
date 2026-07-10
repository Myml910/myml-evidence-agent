const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getLatestProjectRunForCode,
  getProjectRunsForCode,
  recordProjectGenerationResult,
  recordProjectRunMetadata,
} = require('../services/projectRunStore');
const { prepareProjectFinalDisplay } = require('../services/projectFinalDisplayService');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myml-final-display-'));
const storeOptions = {
  storePath: path.join(tempDir, 'project-runs.json'),
  assetDir: path.join(tempDir, 'assets'),
  assetPublicPath: '/test-assets',
};

const calls = [];

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

  const generatedCalls = [];
  const composeCalls = [];
  const generated = await prepareProjectFinalDisplay({
    projectCode: 'YXF2511160005',
    request: {},
    dependencies: {
      publicBaseUrlFromRequest: () => 'http://127.0.0.1:3101',
      getProjectRunsForCode: (projectCode) => getProjectRunsForCode(projectCode, storeOptions),
      getLatestProjectRunForCode: (projectCode) => getLatestProjectRunForCode(projectCode, storeOptions),
      recordProjectGenerationResult: (request, result) => recordProjectGenerationResult(request, result, storeOptions),
      recordProjectRunMetadata: (request, metadata) => recordProjectRunMetadata(request, metadata, storeOptions),
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
      generatePatternImage: async (request) => {
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
  assert.strictEqual(generatedStoredRun.projectDataLayer.sections.designReferenceImages.count, 1);
  assert.deepStrictEqual(generatedStoredRun.projectDataLayer.sections.textElements.visible, ['CLEVELAND']);
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
      getProjectRunsForCode: (projectCode) => getProjectRunsForCode(projectCode, storeOptions),
      getLatestProjectRunForCode: (projectCode) => getLatestProjectRunForCode(projectCode, storeOptions),
      recordProjectGenerationResult: (request, result) => recordProjectGenerationResult(request, result, storeOptions),
      recordProjectRunMetadata: (request, metadata) => recordProjectRunMetadata(request, metadata, storeOptions),
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
  const asyncDependencies = {
    publicBaseUrlFromRequest: () => 'http://127.0.0.1:3101',
    getProjectRunsForCode: (projectCode) => getProjectRunsForCode(projectCode, storeOptions),
    getLatestProjectRunForCode: (projectCode) => getLatestProjectRunForCode(projectCode, storeOptions),
    recordProjectGenerationResult: (request, result) => recordProjectGenerationResult(request, result, storeOptions),
    recordProjectRunMetadata: (request, metadata) => recordProjectRunMetadata(request, metadata, storeOptions),
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
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: 'success',
        source: 'ai_image_generator',
        model: 'gpt-image-2',
        request_mode: request.request_mode || 'edits',
        input_image_count: request.input_images.length,
        images: [{
          b64_json: Buffer.from(`${request.generation_stage}:${request.generation_source}:${asyncCalls.length}`).toString('base64'),
          mime_type: 'image/png',
        }],
      };
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
  assert.strictEqual(completed.run.elementImages.length, 3);
  assert.strictEqual(completed.run.finalDesignImages.length, 1);
  assert.strictEqual(completed.display.projectDataLayer.sections.designReferenceImages.count, 1);
  assert.strictEqual(new Set(asyncCalls.map((call) => call.runId)).size, 1);
  assert.deepStrictEqual(asyncCalls.map((call) => call.source), [
    'company_design_reference_split',
    'company_design_reference_split',
    'company_design_reference_split',
    'automated_flow_final_generation',
  ]);

  const comboGenerateCalls = [];
  const comboComposeCalls = [];
  const combo = await prepareProjectFinalDisplay({
    projectCode: 'YXF2511160008',
    request: {},
    dependencies: {
      publicBaseUrlFromRequest: () => 'http://127.0.0.1:3101',
      getProjectRunsForCode: (projectCode) => getProjectRunsForCode(projectCode, storeOptions),
      getLatestProjectRunForCode: (projectCode) => getLatestProjectRunForCode(projectCode, storeOptions),
      recordProjectGenerationResult: (request, result) => recordProjectGenerationResult(request, result, storeOptions),
      recordProjectRunMetadata: (request, metadata) => recordProjectRunMetadata(request, metadata, storeOptions),
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

  console.log('[test:project-final-display] Project final display tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
