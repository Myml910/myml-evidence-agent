const assert = require('assert');
const {
  buildCategoryRequestBody,
  classifyCategoryWithRules,
  classifyProposalCategoryWithAi,
  validateAiCategoryPayload,
} = require('../services/aiCategoryClassifier');

const CATALOG = {
  source: '2026-6月-近期品类表.xlsx',
  raw_count: 4,
  candidate_count: 3,
  candidates: ['餐盘', '冰箱贴邮轮门贴', '化妆包'],
  entries: [
    {
      category: '餐盘',
      image_url: '',
      image_filename: '',
      note: '',
      source: '2026-6月-近期品类表.xlsx',
      created_at: '',
      updated_at: '',
    },
    {
      category: '冰箱贴邮轮门贴',
      image_url: 'https://assets.example.test/cruise-door-magnet.png',
      image_filename: 'cruise-door-magnet.png',
      note: '测试品类图',
      source: 'manual_category_catalog',
      created_at: '',
      updated_at: '',
      history_images: [
        {
          image_url: 'https://assets.example.test/cruise-door-magnet-layout-a.png',
          image_filename: 'cruise-door-magnet-layout-a.png',
          note: '历史构图 A',
          source: 'manual_category_image_upload',
          created_at: '2026-06-20T00:00:00.000Z',
        },
        {
          image_url: 'https://assets.example.test/cruise-door-magnet-layout-b.png',
          image_filename: 'cruise-door-magnet-layout-b.png',
          note: '历史构图 B',
          source: 'manual_category_image_upload',
          created_at: '2026-06-21T00:00:00.000Z',
        },
      ],
    },
    {
      category: '化妆包',
      image_url: '',
      image_filename: '',
      note: '',
      source: '2026-6月-近期品类表.xlsx',
      created_at: '',
      updated_at: '',
    },
  ],
};

async function main() {
  const ruleMatch = classifyCategoryWithRules({
    project_name: 'summer party plates',
    category_label: '餐盘',
  }, CATALOG.candidates);
  assert.strictEqual(ruleMatch.category, '餐盘');
  assert(ruleMatch.confidence > 0.5);
  assert(ruleMatch.evidence_fields.includes('category_label'));

  const validated = validateAiCategoryPayload({
    predicted_category: '冰箱贴邮轮门贴',
    confidence: 0.91,
    reason: 'Project fields describe cruise door magnet stickers.',
    evidence_fields: ['project_name', 'development_keywords', 'unsafe_field'],
    alternatives: [
      {
        category: '餐盘',
        confidence: 0.2,
        reason: 'Weaker evidence.',
      },
    ],
  }, CATALOG.candidates);
  assert.strictEqual(validated.predicted_category, '冰箱贴邮轮门贴');
  assert.deepStrictEqual(validated.evidence_fields, ['project_name', 'development_keywords']);
  assert.strictEqual(validated.alternatives.length, 1);

  const body = buildCategoryRequestBody({
    model: 'gpt-5.5',
    maxTokens: 900,
    responseFormat: 'json_object',
  }, {
    project_name: '邮轮门贴 冰箱贴 装饰',
    development_keywords: ['cruise door magnet'],
  }, CATALOG.candidates);
  assert.strictEqual(body.stream, false);
  assert.strictEqual(body.response_format.type, 'json_object');
  assert(JSON.stringify(body.messages).includes('candidate_categories'));
  assert(JSON.stringify(body.messages).includes('冰箱贴邮轮门贴'));

  let requestBody = null;
  const aiResult = await classifyProposalCategoryWithAi({
    project_code: 'YXF2603230144',
    project_name: '邮轮门贴 冰箱贴 装饰',
    development_keywords: ['cruise door magnet'],
  }, {
    catalog: CATALOG,
    env: {
      AI_CATEGORY_CLASSIFIER_BASE_URL: 'https://ai.example.test/v1',
      AI_CATEGORY_CLASSIFIER_API_KEY: 'test-key',
      AI_CATEGORY_CLASSIFIER_TIMEOUT_MS: '5000',
    },
    fetchImpl: async (_url, options) => {
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
                    predicted_category: '冰箱贴邮轮门贴',
                    confidence: 0.93,
                    reason: 'The proposal points to cruise door magnet stickers.',
                    evidence_fields: ['project_name', 'development_keywords'],
                    alternatives: [
                      {
                        category: '餐盘',
                        confidence: 0.12,
                        reason: 'No plate evidence.',
                      },
                    ],
                  }),
                },
              },
            ],
          });
        },
      };
    },
  });
  assert.strictEqual(requestBody.model, 'gpt-5.5');
  assert(!JSON.stringify(requestBody).includes('test-key'));
  assert.strictEqual(aiResult.status, 'success');
  assert.strictEqual(aiResult.match_source, 'ai');
  assert.strictEqual(aiResult.predicted_category, '冰箱贴邮轮门贴');
  assert.strictEqual(
    aiResult.category_image.image_url,
    'https://assets.example.test/cruise-door-magnet.png',
  );
  assert.strictEqual(aiResult.category_image.history_images.length, 3);
  assert.strictEqual(
    aiResult.category_image.history_images[0].image_url,
    'https://assets.example.test/cruise-door-magnet-layout-a.png',
  );
  assert.strictEqual(aiResult.candidate_count, 3);
  assert.strictEqual(aiResult.alternatives[0].category, '餐盘');

  const missingConfig = await classifyProposalCategoryWithAi({
    category_label: '餐盘',
  }, {
    catalog: CATALOG,
    env: {},
  });
  assert.strictEqual(missingConfig.status, 'missing_config');
  assert.strictEqual(missingConfig.match_source, 'rule_fallback');
  assert.strictEqual(missingConfig.predicted_category, '餐盘');
  assert.strictEqual(missingConfig.ai_error.type, 'missing_config');

  const invalidAi = await classifyProposalCategoryWithAi({
    category_label: '餐盘',
  }, {
    catalog: CATALOG,
    env: {
      AI_CATEGORY_CLASSIFIER_BASE_URL: 'https://ai.example.test/v1',
      AI_CATEGORY_CLASSIFIER_API_KEY: 'test-key',
    },
    fetchImpl: async () => ({
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
                  predicted_category: '不存在的品类',
                  confidence: 0.99,
                  reason: 'Invalid category.',
                }),
              },
            },
          ],
        });
      },
    }),
  });
  assert.strictEqual(invalidAi.status, 'error');
  assert.strictEqual(invalidAi.ai_error.type, 'invalid_ai_category');
  assert.strictEqual(invalidAi.predicted_category, '餐盘');
  assert.strictEqual(invalidAi.match_source, 'rule_fallback');

  console.log('[test:ai-category-classifier] AI category classifier tests passed.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
