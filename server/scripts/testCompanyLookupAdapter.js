const assert = require('assert');
const {
  ERROR_FIELD_MAPPING_EMPTY,
  ERROR_PROJECT_CODE_UNRECOGNIZED,
  deriveGraphicElementsFromProjectFields,
  extractProjectCodeFromMessage,
  normalizeDevelopmentKeywords,
  prepareProposalFromCompanyLookup,
  resolveProjectCode,
} = require('../services/companyLookupAdapter');

const BASE_ENV = {
  COMPANY_DB_HOST: '127.0.0.1',
  COMPANY_DB_PORT: '3306',
  COMPANY_DB_NAME: 'company',
  COMPANY_DB_USER: 'readonly_user',
  COMPANY_DB_PASSWORD: 'secret-password-used-only-in-test',
  COMPANY_DB_VIEW: 'company_project_lookup_view',
  COMPANY_DB_PROJECT_CODE_COLUMN: 'project_code',
  COMPANY_REFERENCE_IMAGE_BASE_URL: 'https://assets.example.test/static/',
  ELEMENT_SOURCE_GALLERY_INDEX_PATH: 'C:/definitely/missing/element-source-gallery-index.json',
};

function makeMysqlMock(rows) {
  return {
    async createConnection() {
      return {
        async execute() {
          return [rows];
        },
        async end() {},
      };
    },
  };
}

async function main() {
  assert.strictEqual(extractProjectCodeFromMessage('YXF2603230144'), 'YXF2603230144');
  assert.strictEqual(
    extractProjectCodeFromMessage('开始 YXF2603230144 项目'),
    'YXF2603230144',
  );
  assert.strictEqual(extractProjectCodeFromMessage('yxf2603230144'), 'YXF2603230144');
  assert.strictEqual(resolveProjectCode({ projectCode: '开始 YXF2603230144 项目' }), null);
  assert.strictEqual(
    resolveProjectCode({
      projectCode: '开始 YXF2603230144 项目',
      message: '开始 YXF2603230144 项目',
    }),
    'YXF2603230144',
  );
  assert.deepStrictEqual(normalizeDevelopmentKeywords({ devKeywords: 'one; two, one' }), {
    keywords: ['one', 'two'],
    fieldAliasUsed: 'devKeywords',
  });
  assert.strictEqual(
    deriveGraphicElementsFromProjectFields({
      projectName: 'baby in bloom plates',
      developmentKeywords: ['plates', 'baby in bloom', 'baby shower decorations'],
    }),
    'baby in bloom',
  );
  assert.strictEqual(
    deriveGraphicElementsFromProjectFields({
      projectName: 'plates',
      developmentKeywords: ['plates', 'baby in bloom', 'baby shower decorations'],
    }),
    '',
  );
  assert.strictEqual(
    deriveGraphicElementsFromProjectFields({
      projectName: '',
      developmentKeywords: ['baby in bloom', 'baby shower decorations'],
    }),
    '',
  );
  assert.strictEqual(
    deriveGraphicElementsFromProjectFields({
      projectName: 'garden flower plates',
      developmentKeywords: [],
    }),
    'garden flower',
  );
  assert.strictEqual(
    deriveGraphicElementsFromProjectFields({
      projectName: '派对-餐盘套装-火焰骰子派对装饰24个黑色叉子+24小餐盘+24大餐盘+24餐巾纸（24件套）',
      developmentKeywords: ['dungeons and dragons', 'dragon birthday party decorations'],
    }),
    '火焰骰子; 黑色',
  );
  assert.strictEqual(
    deriveGraphicElementsFromProjectFields({
      projectName: '手工艺-手工材料包-绘画类-钻石面-动画Q版耶稣降临主题钻石画)水箱贴-12pcs',
    }),
    '动画Q版耶稣降临主题',
  );
  assert.strictEqual(
    deriveGraphicElementsFromProjectFields({
      projectName: '厨房-热带植物主题-冰箱贴-圆形5.5以内-12pcs',
    }),
    '热带植物主题',
  );

  const missingCode = await prepareProposalFromCompanyLookup({}, {
    env: BASE_ENV,
    mysql: makeMysqlMock([]),
  });
  assert.strictEqual(missingCode.found, false);
  assert.strictEqual(missingCode.error_code, ERROR_PROJECT_CODE_UNRECOGNIZED);

  const missingConfig = await prepareProposalFromCompanyLookup({
    projectCode: 'YXF2603230144',
  }, {
    env: {},
    mysql: makeMysqlMock([]),
  });
  assert.strictEqual(missingConfig.found, false);
  assert.strictEqual(missingConfig.source, 'real_company_lookup');
  assert.strictEqual(missingConfig.data_origin, 'real_company_db');
  assert.strictEqual(missingConfig.mock, false);
  assert.strictEqual(missingConfig.error_code, 'COMPANY_DB_NOT_CONFIGURED');
  assert(missingConfig.error_message.includes('真实公司数据源未配置'));
  assert.strictEqual(missingConfig.proposal.project_code, 'YXF2603230144');

  const found = await prepareProposalFromCompanyLookup({
    message: '开始 YXF2603230144 项目',
  }, {
    env: BASE_ENV,
    mysql: makeMysqlMock([
      {
        project_code: 'YXF2603230144',
        project_name: 'baby in bloom plates',
        category: '125',
        category_label: 'Party Plates',
        development_keywords: 'baby in bloom; baby shower',
        brief: 'Core prompt',
        designRequirement: 'Design idea',
        graphic_elements: 'random company graphic field',
        text_elements: 'Baby in Bloom',
        design_img: 'temp/design-1.jpg,temp/design-2.jpg',
        oper_img: 'temp/oper-1.jpg,temp/oper-2.jpg',
        colorRequirement: 'pink',
        updated_at: '2026-06-01',
      },
    ]),
  });
  assert.strictEqual(found.found, true);
  assert.strictEqual(found.project_code, 'YXF2603230144');
  assert.strictEqual(found.source, 'real_company_lookup');
  assert.strictEqual(found.data_origin, 'real_company_db');
  assert.strictEqual(found.mock, false);
  assert.strictEqual(found.proposal.project_name, 'baby in bloom plates');
  assert.deepStrictEqual(found.proposal.development_keywords, ['baby in bloom', 'baby shower']);
  assert.strictEqual(found.proposal.element_requirement, 'baby in bloom');
  assert.strictEqual(found.proposal.element_requirement_source, 'derived_from_project_name');
  assert.strictEqual(found.proposal.ai_graphic_elements, 'baby in bloom');
  assert.strictEqual(found.proposal.ai_graphic_elements_source, 'derived_from_project_name');
  assert.strictEqual(found.proposal.real_graphic_elements, 'random company graphic field');
  assert.strictEqual(found.proposal.real_graphic_elements_source, 'real_company_element_requirement');
  assert.strictEqual(found.proposal.text_elements, 'Baby in Bloom');
  assert.strictEqual(found.proposal.design_img, 'temp/design-1.jpg,temp/design-2.jpg');
  assert.strictEqual(found.proposal.oper_img, 'temp/oper-1.jpg,temp/oper-2.jpg');
  assert.strictEqual(found.proposal.reference_images.length, 4);
  assert.strictEqual(
    found.proposal.reference_images[0].url,
    'https://assets.example.test/static/temp/design-1.jpg',
  );
  assert.strictEqual(found.element_terms.source, 'builtin_element_terms');
  assert(found.element_terms.term_count > 3000);
  assert(found.element_terms.matched_terms.some((match) => match.term === 'baby shower'));
  assert.strictEqual(found.ai_element_mapping.ai_status, 'missing_config');
  assert.strictEqual(found.ai_element_mapping.model, 'gpt-5.5');
  assert.strictEqual(found.ai_element_mapping.primary_element_terms.length, 0);
  assert.strictEqual(found.element_gallery.status, 'skipped');
  assert.deepStrictEqual(found.element_gallery.graph.nodes, []);
  assert(
    found.element_terms.matched_terms.every(
      (match) =>
        !Object.prototype.hasOwnProperty.call(match, 'source_skus') &&
        !Object.prototype.hasOwnProperty.call(match, 'category_labels'),
    ),
  );
  assert.strictEqual(found.field_summary.development_keywords_count, 2);
  assert(found.field_summary.non_empty_field_count > 0);
  assert(!JSON.stringify(found).includes(BASE_ENV.COMPANY_DB_PASSWORD));
  for (const legacyKey of ['matched_' + 'element_terms', 'ranked_' + 'images']) {
    assert(!Object.prototype.hasOwnProperty.call(found, legacyKey));
  }

  const emptyMapping = await prepareProposalFromCompanyLookup({
    projectCode: 'YXF2603230144',
  }, {
    env: BASE_ENV,
    mysql: makeMysqlMock([{ project_code: 'YXF2603230144' }]),
  });
  assert.strictEqual(emptyMapping.found, false);
  assert.strictEqual(emptyMapping.error_code, ERROR_FIELD_MAPPING_EMPTY);

  const notFound = await prepareProposalFromCompanyLookup({
    projectCode: 'YXF2603230144',
  }, {
    env: BASE_ENV,
    mysql: makeMysqlMock([]),
  });
  assert.strictEqual(notFound.found, false);
  assert.strictEqual(notFound.error_code, 'COMPANY_PROJECT_NOT_FOUND');

  let aiGraphicRequestCount = 0;
  const aiGraphicResult = await prepareProposalFromCompanyLookup({
    projectCode: 'YXF2606110233',
  }, {
    env: {
      ...BASE_ENV,
      AI_TERM_MATCHER_BASE_URL: 'https://ai.example.test/v1',
      AI_TERM_MATCHER_API_KEY: 'test-key',
      AI_TERM_MATCHER_TIMEOUT_MS: '5000',
    },
    mysql: makeMysqlMock([
      {
        project_code: 'YXF2606110233',
        project_name: '厨房-热带植物主题-冰箱贴-圆形5.5以内-12pcs',
        development_keywords: '',
      },
    ]),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (JSON.stringify(body.messages).includes('graphic element extraction assistant')) {
        aiGraphicRequestCount += 1;
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
                      reason: 'The theme segment is the graphic motif.',
                    }),
                  },
                },
              ],
            });
          },
        };
      }

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
                    primary_element_terms: [],
                    scene_terms: [],
                    style_terms: [],
                    attribute_terms: [],
                    unmatched_terms: [],
                  }),
                },
              },
            ],
          });
        },
      };
    },
  });
  assert.strictEqual(aiGraphicRequestCount, 1);
  assert.strictEqual(aiGraphicResult.found, true);
  assert.strictEqual(aiGraphicResult.proposal.ai_graphic_elements, '热带植物');
  assert.strictEqual(aiGraphicResult.proposal.element_requirement, '热带植物');
  assert.strictEqual(aiGraphicResult.proposal.ai_graphic_elements_source, 'ai_project_name');

  let aiTextRequestCount = 0;
  const aiTextResult = await prepareProposalFromCompanyLookup({
    projectCode: 'YXF2606110234',
  }, {
    env: {
      ...BASE_ENV,
      AI_TERM_MATCHER_BASE_URL: 'https://ai.example.test/v1',
      AI_TERM_MATCHER_API_KEY: 'test-key',
      AI_TERM_MATCHER_TIMEOUT_MS: '5000',
    },
    mysql: makeMysqlMock([
      {
        project_code: 'YXF2606110234',
        project_name: '派对-餐盘-thank you for all you do主题',
        designRequirement: '整体彩色系，画面中需要出现 Thank You For All You Do 文字。',
        text_elements: '',
      },
    ]),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const bodyText = JSON.stringify(body.messages);
      if (bodyText.includes('text element extraction assistant')) {
        aiTextRequestCount += 1;
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
                      reason: 'The design idea explicitly asks for visible text.',
                    }),
                  },
                },
              ],
            });
          },
        };
      }
      if (bodyText.includes('graphic element extraction assistant')) {
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
                      graphic_elements: ['彩色系', 'thank you for all you do主题'],
                    }),
                  },
                },
              ],
            });
          },
        };
      }

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
                    primary_element_terms: [],
                    scene_terms: [],
                    style_terms: [],
                    attribute_terms: [],
                    unmatched_terms: [],
                  }),
                },
              },
            ],
          });
        },
      };
    },
  });
  assert.strictEqual(aiTextRequestCount, 1);
  assert.strictEqual(aiTextResult.proposal.text_elements, 'Thank You For All You Do');
  assert.strictEqual(aiTextResult.proposal.text_elements_source, 'ai_design_requirement_text_elements');
  assert.strictEqual(aiTextResult.proposal.text_elements_status, 'success');

  console.log('[test:company-lookup] Company lookup adapter tests passed.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
