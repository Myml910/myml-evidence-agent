const assert = require('assert');
const {
  ERROR_NOT_CONFIGURED,
  ERROR_PROJECT_NOT_FOUND,
  ERROR_QUERY_FAILED,
  lookupCompanyProjectFromDb,
  resolveCompanyDbConfig,
} = require('../services/companyDbLookupClient');
const { normalizeMinimalCompanyFields } = require('../services/companyLookupAdapter');

const BASE_ENV = {
  COMPANY_DB_HOST: '127.0.0.1',
  COMPANY_DB_PORT: '3306',
  COMPANY_DB_NAME: 'company',
  COMPANY_DB_USER: 'readonly_user',
  COMPANY_DB_PASSWORD: 'secret-password-used-only-in-test',
  COMPANY_DB_VIEW: 'company_project_lookup_view',
  COMPANY_DB_PROJECT_CODE_COLUMN: 'project_code',
  COMPANY_DB_TIMEOUT_MS: '10000',
  COMPANY_REFERENCE_IMAGE_BASE_URL: 'https://assets.example.test/static/',
};

function makeMysqlMock(rows, options = {}) {
  const calls = {
    config: null,
    sql: null,
    params: null,
    endCalled: false,
  };

  return {
    calls,
    mysql: {
      async createConnection(config) {
        calls.config = config;
        if (options.failConnect) {
          throw new Error('simulated connection failure with secret details');
        }
        return {
          async execute(statement, params) {
            calls.sql = statement.sql;
            calls.params = params;
            if (options.failQuery) {
              throw new Error('simulated query failure with secret details');
            }
            return [rows];
          },
          async end() {
            calls.endCalled = true;
          },
        };
      },
    },
  };
}

async function main() {
  const missingConfig = resolveCompanyDbConfig({});
  assert.strictEqual(missingConfig.ok, false);
  assert.strictEqual(missingConfig.errorCode, ERROR_NOT_CONFIGURED);
  assert(missingConfig.warnings[0].includes('真实公司数据源未配置'));

  const unsafeView = resolveCompanyDbConfig({
    ...BASE_ENV,
    COMPANY_DB_VIEW: 'company.view',
  });
  assert.strictEqual(unsafeView.ok, false);
  assert(unsafeView.warnings.some((warning) => warning.includes('COMPANY_DB_VIEW')));

  const row = {
    project_code: 'YXF2603230144',
    project_name: 'flower baby plates',
    category: '125',
    category_label: 'Party Plates',
    development_keywords: 'baby in bloom; baby shower',
    brief: 'Core prompt text',
    designRequirement: 'Development idea text',
    graphicElements: 'flower, baby',
    text_elements: 'Baby in Bloom',
    design_img: 'temp/design-1.jpg,temp/design-2.jpg',
    oper_img: 'temp/oper-1.jpg,temp/oper-2.jpg',
    colorRequirement: 'pink',
    styleRequirement: 'floral',
    craft: 'paper printing',
    material: 'paper',
    market: 'US',
    audience: 'girls',
    scene: 'baby shower',
    quantityRequirement: '96pc',
    sizeRequirement: '7 inch',
    specification: 'set',
    source_row_id: 'row-1',
    updated_at: '2026-06-01',
    created_at: '2026-05-01',
  };
  const successMysql = makeMysqlMock([row]);
  const success = await lookupCompanyProjectFromDb('YXF2603230144', {
    env: BASE_ENV,
    normalizeMinimalCompanyFields,
    mysql: successMysql.mysql,
  });
  assert.strictEqual(success.found, true);
  assert.strictEqual(success.source, 'company_db_minimal_lookup');
  assert.strictEqual(success.dataSource, 'db_minimal');
  assert.strictEqual(success.companyFields, null);
  assert(successMysql.calls.sql.startsWith('SELECT * FROM `company_project_lookup_view`'));
  assert.deepStrictEqual(successMysql.calls.params, ['YXF2603230144']);
  assert.strictEqual(successMysql.calls.endCalled, true);
  assert.strictEqual(success.minimalFields.project_name, 'flower baby plates');
  assert.deepStrictEqual(success.minimalFields.development_keywords, [
    'baby in bloom',
    'baby shower',
  ]);
  assert.strictEqual(success.minimalFields.core_prompt, 'Core prompt text');
  assert.strictEqual(success.minimalFields.element_requirement, 'flower baby');
  assert.strictEqual(success.minimalFields.element_requirement_source, 'derived_from_project_name');
  assert.strictEqual(success.minimalFields.ai_graphic_elements, 'flower baby');
  assert.strictEqual(success.minimalFields.real_graphic_elements, 'flower, baby');
  assert.strictEqual(
    success.minimalFields.real_graphic_elements_source,
    'real_company_element_requirement',
  );
  assert.strictEqual(success.minimalFields.text_elements, 'Baby in Bloom');
  assert.strictEqual(success.minimalFields.design_img, 'temp/design-1.jpg,temp/design-2.jpg');
  assert.strictEqual(success.minimalFields.oper_img, 'temp/oper-1.jpg,temp/oper-2.jpg');
  assert.strictEqual(success.minimalFields.reference_images.length, 4);
  assert.strictEqual(
    success.minimalFields.reference_images[0].url,
    'https://assets.example.test/static/temp/design-1.jpg',
  );
  assert.strictEqual(success.minimalFields.reference_images[0].source_field, 'design_img');
  assert.strictEqual(success.minimalFields.material, 'paper');

  const notFound = await lookupCompanyProjectFromDb('YXF2603230144', {
    env: BASE_ENV,
    normalizeMinimalCompanyFields,
    mysql: makeMysqlMock([]).mysql,
  });
  assert.strictEqual(notFound.found, false);
  assert.strictEqual(notFound.errorCode, ERROR_PROJECT_NOT_FOUND);
  assert.strictEqual(notFound.lookupStatus, 'not_found');

  const queryFailure = await lookupCompanyProjectFromDb('YXF2603230144', {
    env: BASE_ENV,
    normalizeMinimalCompanyFields,
    mysql: makeMysqlMock([], { failQuery: true }).mysql,
  });
  assert.strictEqual(queryFailure.found, false);
  assert.strictEqual(queryFailure.errorCode, ERROR_QUERY_FAILED);
  assert(!JSON.stringify(queryFailure).includes(BASE_ENV.COMPANY_DB_PASSWORD));

  console.log('[test:company-db] Company DB lookup client tests passed.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
