const assert = require('assert');
const {
  buildTextElementRequestBody,
  inferTextElementsFromDesignRequirementWithAi,
  parseTextElements,
} = require('../services/aiTextElementExtractor');

async function main() {
  assert.deepStrictEqual(parseTextElements('Thank You; Thank You;  Gracias '), ['Thank You', 'Gracias']);
  assert.deepStrictEqual(parseTextElements('文案 Happy Halloween'), ['Happy Halloween']);
  assert.deepStrictEqual(parseTextElements('文案Happy Halloween；中文说明不是设计文字'), ['Happy Halloween']);
  assert.deepStrictEqual(parseTextElements('中文说明；不要作为设计文字'), []);

  const realData = await inferTextElementsFromDesignRequirementWithAi({
    text_elements: '文案 Happy Birthday',
    design_requirement: 'Use colorful stars.',
  }, {
    env: {},
  });
  assert.strictEqual(realData.text_elements, 'Happy Birthday');
  assert.strictEqual(realData.text_elements_source, 'real_company_text_elements');
  assert.strictEqual(realData.text_elements_status, 'real_data');

  const emptyDesignRequirement = await inferTextElementsFromDesignRequirementWithAi({
    text_elements: '',
    design_requirement: '',
  }, {
    env: {},
  });
  assert.strictEqual(emptyDesignRequirement.text_elements, '');
  assert.strictEqual(emptyDesignRequirement.text_elements_status, 'empty_design_requirement');

  let requestBody = null;
  const aiResult = await inferTextElementsFromDesignRequirementWithAi({
    text_elements: '',
    design_requirement: '需要在画面中写 Thank You For All You Do，彩色系，适合教师感谢主题。',
  }, {
    env: {
      AI_TERM_MATCHER_BASE_URL: 'https://ai.example.test/v1',
      AI_TERM_MATCHER_API_KEY: 'test-key',
      AI_TERM_MATCHER_TIMEOUT_MS: '5000',
      AI_TERM_MATCHER_MAX_TOKENS: '1200',
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
                    has_text_requirement: true,
                    text_elements: ['Thank You For All You Do'],
                    ignored_terms: ['彩色系', '教师感谢主题'],
                    reason: 'The phrase is explicitly required as visible text.',
                  }),
                },
              },
            ],
          });
        },
      };
    },
  });

  assert.strictEqual(aiResult.text_elements, 'Thank You For All You Do');
  assert.strictEqual(aiResult.text_elements_source, 'ai_design_requirement_text_elements');
  assert.strictEqual(aiResult.text_elements_status, 'success');
  assert.strictEqual(aiResult.text_elements_error, null);
  assert.strictEqual(requestBody.stream, false);
  assert.strictEqual(requestBody.max_tokens, 400);
  assert(JSON.stringify(requestBody.messages).includes('Use only the design_requirement field'));
  assert(!JSON.stringify(requestBody).includes('test-key'));

  const noText = await inferTextElementsFromDesignRequirementWithAi({
    text_elements: '',
    design_requirement: '做彩色植物图案，不需要文字。',
  }, {
    env: {
      AI_TERM_MATCHER_BASE_URL: 'https://ai.example.test/v1',
      AI_TERM_MATCHER_API_KEY: 'test-key',
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
                  has_text_requirement: false,
                  text_elements: [],
                  reason: 'No visible text is required.',
                }),
              },
            },
          ],
        });
      },
    }),
  });
  assert.strictEqual(noText.text_elements, '');
  assert.strictEqual(noText.text_elements_status, 'no_text_requirement');

  const body = buildTextElementRequestBody({
    model: 'gpt-5.5',
    maxTokens: 1200,
    responseFormat: 'none',
  }, {
    design_requirement: 'Write Gracias',
  });
  assert.strictEqual(body.response_format, undefined);

  console.log('[test:ai-text-elements] AI text element extractor tests passed.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
