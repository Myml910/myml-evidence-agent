const DATA_SOURCE = 'db_minimal';
const LOOKUP_SOURCE = 'company_db_minimal_lookup';
const DATA_ORIGIN = 'company_db_view';
const SOURCE_TYPE = 'db_minimal';

const ERROR_NOT_CONFIGURED = 'COMPANY_DB_NOT_CONFIGURED';
const ERROR_QUERY_FAILED = 'COMPANY_DB_QUERY_FAILED';
const ERROR_PROJECT_NOT_FOUND = 'COMPANY_PROJECT_NOT_FOUND';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/;
const PROJECT_CODE_PATTERN = /^YXF\d+$/i;

function cleanOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeProjectCode(projectCode) {
  const cleaned = cleanOptionalString(projectCode);
  return cleaned ? cleaned.toUpperCase() : null;
}

function isSafeIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function parsePort(value) {
  const port = Number(value || 3306);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function parseTimeout(value) {
  const timeout = Number(value || 10000);
  return Number.isInteger(timeout) && timeout > 0 ? timeout : 10000;
}

function baseFailure(errorCode, warnings, lookupStatus = 'unavailable') {
  return {
    found: false,
    source: LOOKUP_SOURCE,
    dataSource: DATA_SOURCE,
    lookupStatus,
    errorCode,
    companyFields: null,
    minimalFields: null,
    data_origin: DATA_ORIGIN,
    source_type: SOURCE_TYPE,
    warnings,
  };
}

function resolveCompanyDbConfig(env = process.env) {
  const host = cleanOptionalString(env.COMPANY_DB_HOST);
  const name = cleanOptionalString(env.COMPANY_DB_NAME);
  const user = cleanOptionalString(env.COMPANY_DB_USER);
  const password = typeof env.COMPANY_DB_PASSWORD === 'string' ? env.COMPANY_DB_PASSWORD : null;
  const view = cleanOptionalString(env.COMPANY_DB_VIEW);
  const projectCodeColumn =
    cleanOptionalString(env.COMPANY_DB_PROJECT_CODE_COLUMN) || 'project_code';
  const port = parsePort(env.COMPANY_DB_PORT);
  const timeoutMs = parseTimeout(env.COMPANY_DB_TIMEOUT_MS);
  const missing = [];

  if (!host) missing.push('COMPANY_DB_HOST');
  if (!name) missing.push('COMPANY_DB_NAME');
  if (!user) missing.push('COMPANY_DB_USER');
  if (password === null) missing.push('COMPANY_DB_PASSWORD');
  if (!view) missing.push('COMPANY_DB_VIEW');

  if (missing.length > 0) {
    return {
      ok: false,
      errorCode: ERROR_NOT_CONFIGURED,
      warnings: [
        `真实公司数据源未配置，请检查 COMPANY_DB_* 配置。缺失：${missing.join(', ')}。`,
      ],
    };
  }

  if (!port) {
    return {
      ok: false,
      errorCode: ERROR_NOT_CONFIGURED,
      warnings: ['COMPANY_DB_PORT must be a valid integer port.'],
    };
  }

  if (!isSafeIdentifier(view)) {
    return {
      ok: false,
      errorCode: ERROR_NOT_CONFIGURED,
      warnings: ['COMPANY_DB_VIEW must be a simple MySQL identifier.'],
    };
  }

  if (!isSafeIdentifier(projectCodeColumn)) {
    return {
      ok: false,
      errorCode: ERROR_NOT_CONFIGURED,
      warnings: ['COMPANY_DB_PROJECT_CODE_COLUMN must be a simple MySQL identifier.'],
    };
  }

  return {
    ok: true,
    config: {
      host,
      port,
      database: name,
      user,
      password,
      view,
      projectCodeColumn,
      timeoutMs,
    },
  };
}

function parseJsonLikeValue(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    )
  ) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    return value;
  }
}

function parseJsonLikeRow(row) {
  if (!row || typeof row !== 'object') {
    return row;
  }
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, parseJsonLikeValue(value)]),
  );
}

async function lookupCompanyProjectFromDb(projectCode, options = {}) {
  const normalizedProjectCode = normalizeProjectCode(projectCode);
  if (!normalizedProjectCode || !PROJECT_CODE_PATTERN.test(normalizedProjectCode)) {
    return baseFailure(
      ERROR_NOT_CONFIGURED,
      ['projectCode must match YXF followed by digits.'],
      'invalid_project_code',
    );
  }

  const configResult = resolveCompanyDbConfig(options.env || process.env);
  if (!configResult.ok) {
    return baseFailure(configResult.errorCode, configResult.warnings);
  }

  if (typeof options.normalizeMinimalCompanyFields !== 'function') {
    return baseFailure(ERROR_NOT_CONFIGURED, ['normalizeMinimalCompanyFields dependency is required.']);
  }

  const mysql = options.mysql || require('mysql2/promise');
  const config = configResult.config;
  let connection = null;

  try {
    connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      connectTimeout: config.timeoutMs,
    });

    const sql = `SELECT * FROM \`${config.view}\` WHERE \`${config.projectCodeColumn}\` = ? LIMIT 1`;
    const [rows] = await connection.execute({ sql, timeout: config.timeoutMs }, [
      normalizedProjectCode,
    ]);
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

    if (!row) {
      return baseFailure(
        ERROR_PROJECT_NOT_FOUND,
        [`No company DB row found for ${normalizedProjectCode}.`],
        'not_found',
      );
    }

    return {
      found: true,
      source: LOOKUP_SOURCE,
      dataSource: DATA_SOURCE,
      lookupStatus: 'found',
      errorCode: null,
      companyFields: null,
      minimalFields: options.normalizeMinimalCompanyFields(parseJsonLikeRow(row), {
        env: options.env || process.env,
      }),
      data_origin: DATA_ORIGIN,
      source_type: SOURCE_TYPE,
      warnings: [],
    };
  } catch (_error) {
    return baseFailure(ERROR_QUERY_FAILED, [
      'Company DB minimal lookup failed. Credentials and connection details were not included in this response.',
    ]);
  } finally {
    if (connection && typeof connection.end === 'function') {
      await connection.end().catch(() => {});
    }
  }
}

module.exports = {
  DATA_ORIGIN,
  DATA_SOURCE,
  ERROR_NOT_CONFIGURED,
  ERROR_PROJECT_NOT_FOUND,
  ERROR_QUERY_FAILED,
  IDENTIFIER_PATTERN,
  LOOKUP_SOURCE,
  SOURCE_TYPE,
  isSafeIdentifier,
  lookupCompanyProjectFromDb,
  parseJsonLikeRow,
  resolveCompanyDbConfig,
};
