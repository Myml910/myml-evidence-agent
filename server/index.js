const fs = require('fs');
const path = require('path');

function loadLocalEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .forEach((rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) {
        return;
      }

      const separatorIndex = line.indexOf('=');
      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
}

loadLocalEnv();

const cors = require('cors');
const express = require('express');
const packageJson = require('../package.json');
const {
  addCategoryCatalogEntry,
  CATEGORY_IMAGE_PUBLIC_PATH,
  CATEGORY_IMAGE_UPLOAD_DIR,
  loadCategoryCatalog,
  removeCategoryCatalogImage,
  saveCategoryCatalogImageUpload,
} = require('./services/categoryCatalog');
const { composeFinalPrompt } = require('./services/aiFinalPromptComposer');
const { generatePatternImage } = require('./services/aiImageGenerator');
const { analyzeMaterialShapeLevels } = require('./services/aiMaterialShapeAnalyzer');
const {
  prepareCompanyProjectDataLayerLookup,
  prepareProposalFromCompanyLookup,
} = require('./services/companyLookupAdapter');
const {
  PROPOSAL_PACKAGE_CACHE_DIR,
  PROPOSAL_PACKAGE_PUBLIC_PATH,
  prepareProposalFromPackage,
} = require('./services/proposalPackageAdapter');
const {
  PROJECT_RUN_ASSET_DIR,
  PROJECT_RUN_ASSET_PUBLIC_PATH,
  getLatestProjectRunForCode,
  getProjectRun,
  getProjectRunsForCode,
  recordProjectGenerationResult,
} = require('./services/projectRunStore');
const { prepareProjectFinalDisplay } = require('./services/projectFinalDisplayService');
const { createCanvasChatRouter } = require('./services/canvasChatContract');

const app = express();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3101);
const FINAL_DISPLAY_LONG_REQUEST_TIMEOUT_MS = 31 * 60 * 1000;

function publicBaseUrlFromRequest(request) {
  const configuredBaseUrl = String(process.env.EVIDENCE_PUBLIC_BASE_URL || '').trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, '');
  }
  return `${request.protocol}://${request.get('host')}`;
}

app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(CATEGORY_IMAGE_PUBLIC_PATH, express.static(CATEGORY_IMAGE_UPLOAD_DIR));
app.use(PROPOSAL_PACKAGE_PUBLIC_PATH, express.static(PROPOSAL_PACKAGE_CACHE_DIR));
app.use(PROJECT_RUN_ASSET_PUBLIC_PATH, express.static(PROJECT_RUN_ASSET_DIR));

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'myml-evidence-agent',
    mode: 'real_company_data_viewer',
  });
});

app.use('/v1', createCanvasChatRouter({
  prepareCompanyProjectDataLayerLookup,
  prepareProposalFromCompanyLookup,
  prepareProjectFinalDisplay,
  projectRunStore: {
    getLatestProjectRunForCode,
    getProjectRun,
    getProjectRunsForCode,
  },
  publicBaseUrlFromRequest,
  version: packageJson.version,
}));

async function handleCompanyProjectLookup(request, response, next) {
  try {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const result = await prepareProposalFromCompanyLookup({
      message: body.message,
      projectCode: body.projectCode || body.project_code,
      publicBaseUrl: publicBaseUrlFromRequest(request),
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
}

app.post('/api/proposal-agent/prepare', handleCompanyProjectLookup);
app.post('/api/company-project/lookup', handleCompanyProjectLookup);

app.post('/api/proposal-package/prepare', async (request, response, next) => {
  try {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const result = await prepareProposalFromPackage({
      packagePath: body.packagePath || body.package_path,
      projectCode: body.projectCode || body.project_code,
      publicBaseUrl: publicBaseUrlFromRequest(request),
    });
    response.json(result);
  } catch (error) {
    if (error?.code === 'PACKAGE_NOT_FOUND') {
      response.status(404).json({
        ok: false,
        error: error.message,
        error_message: error.message,
      });
      return;
    }
    if (error?.code === 'MISSING_MARKDOWN') {
      response.status(400).json({
        ok: false,
        error: error.message,
        error_message: error.message,
      });
      return;
    }
    next(error);
  }
});

app.post('/api/image-generation/generate', async (request, response, next) => {
  try {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const result = await generatePatternImage(body);
    const failedStatuses = new Set([
      'missing_prompt',
      'missing_input_images',
      'missing_config',
      'disabled',
      'error',
      'no_images',
    ]);
    const failed = failedStatuses.has(result.status);
    let projectRun = null;
    if (!failed) {
      try {
        projectRun = recordProjectGenerationResult(body, result);
      } catch (recordError) {
        console.warn('[project-run-store] Failed to record generation result:', recordError?.message || recordError);
      }
    }
    const responseBody = projectRun
      ? {
          ...result,
          project_run: {
            runId: projectRun.runId,
            projectCode: projectRun.projectCode,
            status: projectRun.status,
            elementImageCount: projectRun.elementImages.length,
            finalDesignImageCount: projectRun.finalDesignImages.length,
          },
        }
      : result;
    response.status(failed ? 400 : 200).json(failed
      ? {
          ...responseBody,
          error_message: responseBody.ai_error?.message || responseBody.status,
        }
      : responseBody);
  } catch (error) {
    next(error);
  }
});

app.post('/api/final-prompt/compose', async (request, response, next) => {
  try {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const result = await composeFinalPrompt(body);
    const failedStatuses = new Set([
      'missing_template_prompt',
      'missing_input_images',
      'missing_config',
      'disabled',
      'missing_fetch',
      'timeout',
      'http_error',
      'json_parse_error',
      'empty_ai_result',
      'empty_final_prompt',
      'error',
    ]);
    const failed = failedStatuses.has(result.status);
    response.status(failed ? 400 : 200).json(failed
      ? {
          ...result,
          error_message: result.ai_error?.message || result.status,
        }
      : result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/material-shape/analyze', async (request, response, next) => {
  try {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const result = await analyzeMaterialShapeLevels(body);
    const failedStatuses = new Set([
      'missing_input_images',
      'missing_config',
      'disabled',
      'missing_fetch',
      'timeout',
      'http_error',
      'json_parse_error',
      'empty_ai_result',
      'empty_levels',
      'error',
    ]);
    const failed = failedStatuses.has(result.status);
    response.status(failed ? 400 : 200).json(failed
      ? {
          ...result,
          error_message: result.ai_error?.message || result.status,
        }
      : result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/category-catalog', (request, response, next) => {
  try {
    response.json(loadCategoryCatalog({
      publicBaseUrl: publicBaseUrlFromRequest(request),
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/category-catalog/entries', (request, response, next) => {
  try {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const result = addCategoryCatalogEntry({
      category: body.category,
      image_url: body.image_url || body.imageUrl,
      note: body.note,
    }, {
      publicBaseUrl: publicBaseUrlFromRequest(request),
    });

    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/category-catalog/entries/image', (request, response, next) => {
  try {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const publicBaseUrl = publicBaseUrlFromRequest(request);
    const result = saveCategoryCatalogImageUpload({
      category: body.category,
      image_data: body.image_data || body.imageData,
      filename: body.filename,
      mime_type: body.mime_type || body.mimeType,
      note: body.note,
    }, {
      publicBaseUrl,
    });

    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/category-catalog/entries/image', (request, response, next) => {
  try {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const result = removeCategoryCatalogImage({
      category: body.category,
      image_url: body.image_url || body.imageUrl,
    }, {
      publicBaseUrl: publicBaseUrlFromRequest(request),
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  const isPayloadTooLarge = error?.type === 'entity.too.large' || error?.status === 413;
  const statusCode = isPayloadTooLarge
    ? 413
    : Number.isInteger(error?.statusCode)
      ? error.statusCode
      : 500;
  response.status(statusCode).json({
    ok: false,
    error: isPayloadTooLarge
      ? '图片文件过大，请刷新页面后重试；系统会自动压缩历史设计图后再上传。'
      : error instanceof Error
        ? error.message
        : 'Unknown server error',
  });
});

if (require.main === module) {
  const server = app.listen(port, host, () => {
    console.log(`MYML Evidence Agent server listening at http://${host}:${port}`);
  });
  server.requestTimeout = Math.max(server.requestTimeout || 0, FINAL_DISPLAY_LONG_REQUEST_TIMEOUT_MS);
  server.timeout = Math.max(server.timeout || 0, FINAL_DISPLAY_LONG_REQUEST_TIMEOUT_MS);
}

module.exports = app;
