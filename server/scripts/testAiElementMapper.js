const assert = require('assert');
const {
  DEFAULT_MODEL,
  buildMappingTasks,
  ensurePrimaryElementTerms,
  extractPrimaryThemeStandard,
  extractReferencedImageIndexes,
  getAiElementMapperConfig,
  hasRealGraphicElementRequirement,
  mapProposalElementTermsWithAi,
  selectReferencedImages,
} = require('../services/aiElementMapper');

async function main() {
  const config = getAiElementMapperConfig({
    AI_TERM_MATCHER_BASE_URL: 'https://ai.example.test/v1',
    AI_TERM_MATCHER_API_KEY: 'test-key',
    AI_TERM_MATCHER_MODEL: 'gpt-5.4-mini',
  });
  assert.strictEqual(config.model, DEFAULT_MODEL);
  assert.strictEqual(config.model, 'gpt-5.5');

  const sharedProviderConfig = getAiElementMapperConfig({
    AI_ELEMENT_MAPPER_BASE_URL: 'https://ai.internal.example/v1',
    AI_TERM_MATCHER_API_KEY: 'old-judging-key',
    AI_IMAGE_GENERATOR_BASE_URL: 'https://ai.internal.example/v1',
    AI_IMAGE_GENERATOR_API_KEY: 'shared-image-provider-key',
  });
  assert.strictEqual(sharedProviderConfig.apiKey, 'shared-image-provider-key');

  assert.deepStrictEqual(extractReferencedImageIndexes('用图二的色系风格'), [2]);
  assert.deepStrictEqual(extractReferencedImageIndexes('参考图1和图三'), [1, 3]);

  const proposal = {
    project_name: 'baby shower plates',
    development_keywords: ['flower bloom', 'flower decorations'],
    text_elements: 'baby in bloom',
    design_requirement: '用图二的 flower bloom 色系风格',
    reference_images: [
      {
        source_field: 'design_img',
        label: '设计参考图',
        raw_path: 'temp/design-1.jpg',
        url: 'https://assets.example.test/temp/design-1.jpg',
        filename: 'design-1.jpg',
      },
      {
        source_field: 'design_img',
        label: '设计参考图',
        raw_path: 'temp/design-2.jpg',
        url: 'https://assets.example.test/temp/design-2.jpg',
        filename: 'design-2.jpg',
      },
    ],
  };

  const referencedImages = selectReferencedImages(proposal);
  assert.strictEqual(referencedImages.length, 1);
  assert.strictEqual(referencedImages[0].reference_index, 2);
  assert.strictEqual(referencedImages[0].image.filename, 'design-2.jpg');

  let requestBody = null;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: {
        get() {
          return 'application/json';
        },
      },
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  primary_element_terms: [
                    {
                      term: 'baby shower',
                      confidence: 0.93,
                      reason: 'Project name contains baby shower.',
                      source_fields: ['project_name'],
                    },
                  ],
                  scene_terms: [
                    {
                      term: 'baby shower',
                      confidence: 0.96,
                      reason: 'The project is for a baby shower scene.',
                      source_fields: ['project_name', 'development_keywords'],
                    },
                  ],
                  style_terms: [
                    {
                      term: 'flower decorations',
                      confidence: 0.88,
                      reason: 'Development keywords mention flower decorations.',
                      source_fields: ['development_keywords'],
                    },
                    {
                      term: 'baby in bloom',
                      confidence: 0.99,
                      reason: 'This term is not in the built-in element term list and must be filtered.',
                      source_fields: ['text_elements'],
                    },
                  ],
                  attribute_terms: [
                    {
                      term: 'flower bloom',
                      confidence: 0.84,
                      reason: 'Reference image 2 and requirement mention flower bloom.',
                      source_fields: ['design_requirement', 'design_img'],
                      reference_index: 2,
                      image_filename: 'design-2.jpg',
                    },
                  ],
                  unmatched_terms: [],
                }),
              },
            },
          ],
        });
      },
    };
  };

  const result = await mapProposalElementTermsWithAi(proposal, {
    env: {
      AI_TERM_MATCHER_BASE_URL: 'https://ai.example.test/v1',
      AI_TERM_MATCHER_API_KEY: 'test-key',
      AI_TERM_MATCHER_TIMEOUT_MS: '5000',
      AI_TERM_MATCHER_TOP_N: '40',
    },
    fetchImpl,
  });

  assert.strictEqual(requestBody.model, 'gpt-5.5');
  assert.strictEqual(requestBody.stream, false);
  assert(requestBody.messages[1].content.some((part) => part.type === 'image_url'));
  assert.strictEqual(result.ai_status, 'success');
  assert.deepStrictEqual(result.primary_element_terms.map((term) => term.term), []);
  assert(result.scene_terms.some((term) => term.term === 'baby shower'));
  assert(result.style_terms.some((term) => term.term === 'flower decorations'));
  assert(!result.style_terms.some((term) => term.term === 'baby in bloom'));
  assert(result.attribute_terms.some((term) => term.term === 'flower bloom'));
  assert.strictEqual(result.attribute_terms[0].image_filename, 'design-2.jpg');
  assert.strictEqual(result.summary.primary_count, 0);
  assert.strictEqual(result.summary.scene_count, 1);
  assert.strictEqual(result.summary.style_count, 1);
  assert.strictEqual(result.summary.attribute_count, 1);

  const fallbackProposal = {
    project_name: 'baby in bloom plates',
    development_keywords: ['plates', 'baby in bloom'],
    element_requirement: 'baby in bloom',
    element_requirement_source: 'derived_from_project_name',
    text_elements: '',
  };
  const primaryTheme = extractPrimaryThemeStandard(fallbackProposal);
  assert.strictEqual(primaryTheme.term, 'baby in bloom');
  assert.strictEqual(primaryTheme.source_field, 'project_name');
  assert.strictEqual(hasRealGraphicElementRequirement(fallbackProposal), false);

  const carrierOnlyTitleProposal = {
    project_name: 'plates',
    development_keywords: ['baby in bloom'],
    element_requirement: '',
    text_elements: 'baby in bloom',
  };
  assert.strictEqual(extractPrimaryThemeStandard(carrierOnlyTitleProposal), null);

  const titleDerivedChineseProposal = {
    project_name: '派对-餐盘套装-火焰骰子派对装饰24个黑色叉子+24小餐盘+24大餐盘+24餐巾纸（24件套）',
    development_keywords: ['dungeons and dragons', 'dragon birthday party decorations'],
    element_requirement: '火焰骰子; 黑色',
    element_requirement_source: 'derived_from_project_name',
  };
  const titleDerivedTheme = extractPrimaryThemeStandard(titleDerivedChineseProposal);
  assert.strictEqual(titleDerivedTheme.term, '火焰骰子');
  assert.strictEqual(titleDerivedTheme.source_field, 'project_name');

  const realGraphicElementProposal = {
    project_name: 'christmas plates',
    development_keywords: ['christmas plates'],
    element_requirement: 'gingerbread man',
    element_requirement_source: 'real_company_element_requirement',
  };
  const realPrimaryTheme = extractPrimaryThemeStandard(realGraphicElementProposal);
  assert.strictEqual(realPrimaryTheme.term, 'gingerbread man');
  assert.strictEqual(realPrimaryTheme.source_field, 'element_requirement');
  assert.strictEqual(hasRealGraphicElementRequirement(realGraphicElementProposal), true);

  const fallbackMapping = ensurePrimaryElementTerms({
    ai_status: 'success',
    model: 'gpt-5.5',
    source: 'ai_element_mapper',
    basis: 'builtin_element_terms',
    primary_element_terms: [],
    scene_terms: [],
    style_terms: [],
    attribute_terms: [],
    unmatched_terms: [],
    summary: {
      primary_count: 0,
      scene_count: 0,
      style_count: 0,
      attribute_count: 0,
      unmatched_count: 0,
    },
    ai_error: null,
  }, fallbackProposal);
  assert.strictEqual(fallbackMapping.primary_element_terms.length, 0);
  assert.strictEqual(fallbackMapping.summary.primary_count, 0);

  const tasks = buildMappingTasks(fallbackProposal, ['baby shower', 'baby in bloom'], 10);
  const primaryTask = tasks.find((task) => task.id === 'primary');
  assert.strictEqual(primaryTask, undefined);

  const carrierOnlyTasks = buildMappingTasks(
    carrierOnlyTitleProposal,
    ['baby in bloom'],
    10,
  );
  const carrierOnlyPrimaryTask = carrierOnlyTasks.find((task) => task.id === 'primary');
  assert(!carrierOnlyPrimaryTask || !carrierOnlyPrimaryTask.candidates.includes('baby in bloom'));

  const titleDerivedTasks = buildMappingTasks(
    titleDerivedChineseProposal,
    ['dragon', 'black'],
    10,
  );
  const titleDerivedPrimaryTask = titleDerivedTasks.find((task) => task.id === 'primary');
  assert.strictEqual(titleDerivedPrimaryTask, undefined);

  const colorOnlyAiMapping = ensurePrimaryElementTerms({
    ai_status: 'success',
    model: 'gpt-5.5',
    source: 'ai_element_mapper',
    basis: 'builtin_element_terms',
    primary_element_terms: [
      {
        term: 'black',
        confidence: 0.8,
        reason: 'Color from project title.',
        source_fields: ['project_name'],
      },
    ],
    scene_terms: [],
    style_terms: [],
    attribute_terms: [],
    unmatched_terms: [],
    summary: {
      primary_count: 1,
      scene_count: 0,
      style_count: 0,
      attribute_count: 0,
      unmatched_count: 0,
    },
    ai_error: null,
  }, titleDerivedChineseProposal);
  assert.deepStrictEqual(
    colorOnlyAiMapping.primary_element_terms.map((term) => term.term),
    ['black'],
  );

  const realTasks = buildMappingTasks(
    realGraphicElementProposal,
    ['gingerbread man', 'christmas'],
    10,
  );
  const realPrimaryTask = realTasks.find((task) => task.id === 'primary');
  assert.strictEqual(realPrimaryTask, undefined);

  const disabledAiMapping = await mapProposalElementTermsWithAi(fallbackProposal, {
    env: {
      AI_TERM_MATCHER_ENABLED: 'false',
    },
    terms: ['baby shower'],
  });
  assert.strictEqual(disabledAiMapping.ai_status, 'disabled');
  assert.strictEqual(disabledAiMapping.primary_element_terms.length, 0);

  const disabledCarrierOnlyMapping = await mapProposalElementTermsWithAi(carrierOnlyTitleProposal, {
    env: {
      AI_TERM_MATCHER_ENABLED: 'false',
    },
    terms: ['baby in bloom'],
  });
  assert.strictEqual(disabledCarrierOnlyMapping.ai_status, 'disabled');
  assert.strictEqual(disabledCarrierOnlyMapping.primary_element_terms.length, 0);

  console.log('[test:ai-element-mapper] AI element mapper tests passed.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
