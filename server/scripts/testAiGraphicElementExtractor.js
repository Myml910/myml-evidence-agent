const assert = require('assert');
const {
  buildGraphicElementRequestBody,
  extractGraphicElementsFromProjectNameWithAi,
} = require('../services/aiGraphicElementExtractor');
const { deriveGraphicElementsFromProjectFields } = require('../services/companyLookupAdapter');

async function main() {
  const projectName = '厨房-热带植物主题-冰箱贴-圆形5.5以内-12pcs';
  const fallbackExtractor = deriveGraphicElementsFromProjectFields;

  const fallback = await extractGraphicElementsFromProjectNameWithAi({
    project_name: projectName,
  }, {
    env: {},
    fallbackExtractor,
  });
  assert.strictEqual(fallback.ai_graphic_elements, '热带植物主题');
  assert.strictEqual(fallback.ai_graphic_elements_source, 'derived_from_project_name');
  assert.strictEqual(fallback.ai_graphic_elements_status, 'missing_config');

  let requestBody = null;
  const aiResult = await extractGraphicElementsFromProjectNameWithAi({
    project_name: projectName,
    real_graphic_elements: '现货',
    real_graphic_elements_source: 'real_company_element_requirement',
  }, {
    env: {
      AI_TERM_MATCHER_BASE_URL: 'https://ai.example.test/v1',
      AI_TERM_MATCHER_API_KEY: 'test-key',
      AI_TERM_MATCHER_TIMEOUT_MS: '5000',
      AI_TERM_MATCHER_MAX_TOKENS: '1200',
    },
    fallbackExtractor,
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
                    graphic_elements: ['热带植物'],
                    ignored_terms: ['厨房', '冰箱贴', '圆形5.5以内', '12pcs'],
                    reason: '热带植物主题 is the visual motif in the project name.',
                  }),
                },
              },
            ],
          });
        },
      };
    },
  });

  assert.strictEqual(aiResult.ai_graphic_elements, '热带植物');
  assert.strictEqual(aiResult.element_requirement, '热带植物');
  assert.strictEqual(aiResult.ai_graphic_elements_source, 'ai_project_name');
  assert.strictEqual(aiResult.element_requirement_source, 'ai_project_name');
  assert.strictEqual(aiResult.ai_graphic_elements_status, 'success');
  assert.strictEqual(aiResult.ai_graphic_elements_error, null);
  assert.strictEqual(aiResult.real_graphic_elements, '现货');
  assert.strictEqual(requestBody.stream, false);
  assert.strictEqual(requestBody.max_tokens, 400);
  assert(!JSON.stringify(requestBody).includes('test-key'));
  assert(JSON.stringify(requestBody.messages).includes(projectName));
  assert(JSON.stringify(requestBody.messages).includes('Do not return SKUs'));

  const body = buildGraphicElementRequestBody({
    model: 'gpt-5.5',
    maxTokens: 1200,
    responseFormat: 'none',
  }, projectName);
  assert.strictEqual(body.response_format, undefined);

  const invalidAi = await extractGraphicElementsFromProjectNameWithAi({
    project_name: projectName,
  }, {
    env: {
      AI_TERM_MATCHER_BASE_URL: 'https://ai.example.test/v1',
      AI_TERM_MATCHER_API_KEY: 'test-key',
    },
    fallbackExtractor,
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
          choices: [{ message: { content: 'not json' } }],
        });
      },
    }),
  });
  assert.strictEqual(invalidAi.ai_graphic_elements, '热带植物主题');
  assert.strictEqual(invalidAi.ai_graphic_elements_status, 'json_parse_error');
  assert.strictEqual(invalidAi.ai_graphic_elements_error.type, 'json_parse_error');

  console.log('[test:ai-graphic-elements] AI graphic element extractor tests passed.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
