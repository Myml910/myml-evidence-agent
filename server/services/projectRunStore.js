const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EVIDENCE_RUNTIME_DIR } = require('../config/dataPaths');
const { commitEvidenceFileSync } = require('../storage/evidenceStorageRuntime');
const { writeFileAtomicSync } = require('../storage/localFileCommit');

const PROJECT_RUN_DATA_DIR = EVIDENCE_RUNTIME_DIR;
const PROJECT_RUN_STORE_PATH = path.join(PROJECT_RUN_DATA_DIR, 'project-runs.json');
const PROJECT_RUN_ASSET_DIR = path.join(PROJECT_RUN_DATA_DIR, 'project-run-assets');
const PROJECT_RUN_ASSET_PUBLIC_PATH = '/project-run-assets';
const MAX_STORED_EVENTS = 80;
const MAX_BASE64_IMAGE_BYTES = 25 * 1024 * 1024;

const STAGE_TO_COLLECTION = {
  element_image: 'elementImages',
  split_element_image: 'elementImages',
  material_cleanup: 'elementImages',
  material_split: 'elementImages',
  design_reference_split: 'elementImages',
  design_reference_material: 'elementImages',
  final_design: 'finalDesignImages',
  final_generation: 'finalDesignImages',
  final_generated_image: 'finalDesignImages',
};

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function normalizeProjectCode(value) {
  const code = cleanString(value).toUpperCase();
  return /^YXF\d{10}$/.test(code) ? code : '';
}

function safeIdPart(value, fallback = 'item') {
  return cleanString(value)
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || fallback;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function emptyStore() {
  return {
    version: 1,
    runs: {},
    latestByProjectCode: {},
  };
}

function readStore(options = {}) {
  const storePath = options.storePath || PROJECT_RUN_STORE_PATH;
  if (!fs.existsSync(storePath)) {
    return emptyStore();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return {
      ...emptyStore(),
      ...parsed,
      runs: parsed.runs && typeof parsed.runs === 'object' ? parsed.runs : {},
      latestByProjectCode: parsed.latestByProjectCode && typeof parsed.latestByProjectCode === 'object'
        ? parsed.latestByProjectCode
        : {},
    };
  } catch (_error) {
    return emptyStore();
  }
}

function writeStore(store, options = {}) {
  const storePath = options.storePath || PROJECT_RUN_STORE_PATH;
  const commitFile = options.commitFile || commitEvidenceFileSync;
  const payload = JSON.stringify(store, null, 2);
  writeFileAtomicSync(storePath, payload, { encoding: 'utf8' });
  commitFile(storePath, {
    body: Buffer.from(payload),
    contentType: 'application/json',
  });
}

function createRunId(projectCode) {
  return `prun_${safeIdPart(projectCode, 'project')}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function promptSummary(prompt) {
  const text = cleanString(prompt);
  if (!text) {
    return null;
  }
  return {
    length: text.length,
    hash: hashValue(text),
  };
}

function cleanPublicUrl(value) {
  const raw = cleanString(value);
  if (!raw || /^javascript:/i.test(raw)) {
    return '';
  }

  if (raw.startsWith('/')) {
    return raw.split('?')[0].split('#')[0];
  }

  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_error) {
    return '';
  }
}

function mimeExtension(mimeType) {
  const mime = cleanString(mimeType).toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  return 'png';
}

function decodeBase64Image(value) {
  const raw = cleanString(value);
  if (!raw) {
    return null;
  }

  const dataUrlMatch = raw.match(/^data:([^;,]+);base64,(.+)$/i);
  const mimeType = dataUrlMatch ? dataUrlMatch[1] : 'image/png';
  const base64 = dataUrlMatch ? dataUrlMatch[2] : raw;
  const normalized = base64.replace(/\s/g, '');
  if (!/^[a-z0-9+/=]+$/i.test(normalized)) {
    return null;
  }

  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer.length || buffer.length > MAX_BASE64_IMAGE_BYTES) {
    return null;
  }

  return { buffer, mimeType };
}

function saveBase64Image(image, context, options = {}) {
  const decoded = decodeBase64Image(image.b64_json || image.base64 || image.url);
  if (!decoded) {
    return '';
  }

  const assetDir = options.assetDir || PROJECT_RUN_ASSET_DIR;
  const publicPath = options.assetPublicPath || PROJECT_RUN_ASSET_PUBLIC_PATH;
  const runDirName = safeIdPart(context.runId, 'run');
  const outputDir = path.join(assetDir, runDirName);
  ensureDir(outputDir);

  const ext = mimeExtension(image.mime_type || decoded.mimeType);
  const digest = hashValue(decoded.buffer);
  const fileName = `${safeIdPart(context.stage, 'stage')}-${context.index + 1}-${digest}.${ext}`;
  const filePath = path.join(outputDir, fileName);
  writeFileAtomicSync(filePath, decoded.buffer);
  const commitFile = options.commitFile || commitEvidenceFileSync;
  commitFile(filePath, {
    body: decoded.buffer,
    contentType: decoded.mimeType,
  });

  return `${publicPath}/${encodeURIComponent(runDirName)}/${encodeURIComponent(fileName)}`;
}

function imageUrlFromGeneratedImage(image, context, options = {}) {
  const directUrl = cleanPublicUrl(image.url);
  if (directUrl && !/^data:/i.test(directUrl)) {
    return directUrl;
  }

  if (image.b64_json || image.base64 || /^data:/i.test(cleanString(image.url))) {
    return saveBase64Image(image, context, options);
  }

  return '';
}

function resultCollectionForStage(stage) {
  return STAGE_TO_COLLECTION[cleanString(stage).toLowerCase()] || '';
}

function projectRunSummary(run) {
  if (!run) {
    return null;
  }

  return {
    runId: run.runId,
    requestId: cleanString(run.requestId),
    projectCode: run.projectCode,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    flowVersion: cleanString(run.flowVersion),
    elementImages: Array.isArray(run.elementImages) ? run.elementImages : [],
    finalDesignImages: Array.isArray(run.finalDesignImages) ? run.finalDesignImages : [],
    project: run.project && typeof run.project === 'object' ? run.project : null,
    designReferenceImages: Array.isArray(run.designReferenceImages) ? run.designReferenceImages : [],
    projectDataLayer: run.projectDataLayer && typeof run.projectDataLayer === 'object'
      ? run.projectDataLayer
      : null,
    progress: run.progress && typeof run.progress === 'object'
      ? {
          stage: cleanString(run.progress.stage),
          status: cleanString(run.progress.status),
          attempt: Number(run.progress.attempt) || 0,
          maxAttempts: Number(run.progress.maxAttempts) || 0,
          durationMs: Number(run.progress.durationMs) || 0,
          updatedAt: cleanString(run.progress.updatedAt),
        }
      : null,
    error: run.error && typeof run.error === 'object'
      ? {
          code: cleanString(run.error.code),
          retryable: Boolean(run.error.retryable),
          stage: cleanString(run.error.stage),
          failedAt: cleanString(run.error.failedAt),
        }
      : null,
  };
}

function ensureRun(store, projectCode, requestedRunId) {
  const runId = safeIdPart(requestedRunId, '') || createRunId(projectCode);
  const now = nowIso();
  if (!store.runs[runId]) {
    store.runs[runId] = {
      runId,
      projectCode,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      elementImages: [],
      finalDesignImages: [],
      events: [],
    };
  }

  store.latestByProjectCode[projectCode] = runId;
  return store.runs[runId];
}

function buildImageRecord(image, context, options = {}) {
  const imageUrl = imageUrlFromGeneratedImage(image, context, options);
  if (!imageUrl) {
    return null;
  }

  const source = cleanString(context.request.generation_source || context.request.generationSource);
  const label = cleanString(context.request.generation_label || context.request.generationLabel);
  const createdAt = nowIso();

  return {
    id: `img_${hashValue([context.runId, context.stage, context.index, imageUrl].join('|'))}`,
    projectCode: context.projectCode,
    category: cleanString(context.request.category),
    runId: context.runId,
    status: 'completed',
    stage: context.stage,
    source: source || 'image_generation',
    title: label || (context.collection === 'finalDesignImages' ? 'Final generated image' : 'Split element image'),
    imageUrl,
    thumbnailUrl: imageUrl,
    model: context.result.model,
    requestMode: context.result.request_mode,
    inputImageCount: Number(context.result.input_image_count) || 0,
    prompt: promptSummary(context.request.prompt),
    revisedPrompt: promptSummary(image.revised_prompt),
    createdAt,
  };
}

function appendUniqueImages(run, collection, images) {
  const current = Array.isArray(run[collection]) ? run[collection] : [];
  const seen = new Set(current.map((image) => image.imageUrl).filter(Boolean));

  for (const image of images) {
    if (!image?.imageUrl || seen.has(image.imageUrl)) {
      continue;
    }
    current.push(image);
    seen.add(image.imageUrl);
  }

  run[collection] = current;
}

function recordProjectGenerationResult(request = {}, result = {}, options = {}) {
  if (result.status !== 'success' || !Array.isArray(result.images) || result.images.length === 0) {
    return null;
  }

  const projectCode = normalizeProjectCode(request.project_code || request.projectCode);
  const stage = cleanString(request.generation_stage || request.generationStage || request.result_stage || request.resultStage);
  const collection = resultCollectionForStage(stage);
  if (!projectCode || !collection) {
    return null;
  }

  const store = readStore(options);
  const run = ensureRun(store, projectCode, request.project_run_id || request.projectRunId);
  const records = result.images
    .map((image, index) => buildImageRecord(image, {
      collection,
      index,
      projectCode,
      request,
      result,
      runId: run.runId,
      stage,
    }, options))
    .filter(Boolean);

  if (records.length === 0) {
    return null;
  }

  appendUniqueImages(run, collection, records);
  const defersRunCompletion = collection === 'finalDesignImages' && (
    request.defer_project_run_completion === true ||
    request.deferProjectRunCompletion === true
  );
  run.status = collection === 'finalDesignImages' && !defersRunCompletion
    ? 'completed'
    : 'running';
  run.updatedAt = nowIso();
  run.events = [
    ...(Array.isArray(run.events) ? run.events : []),
    {
      stage,
      collection,
      status: result.status,
      imageCount: records.length,
      model: result.model,
      requestMode: result.request_mode,
      inputImageCount: Number(result.input_image_count) || 0,
      category: cleanString(request.category),
      createdAt: run.updatedAt,
    },
  ].slice(-MAX_STORED_EVENTS);

  writeStore(store, options);
  return projectRunSummary(run);
}

function recordProjectRunMetadata(request = {}, metadata = {}, options = {}) {
  const projectCode = normalizeProjectCode(request.project_code || request.projectCode);
  if (!projectCode) {
    return null;
  }

  const store = readStore(options);
  const run = ensureRun(store, projectCode, request.project_run_id || request.projectRunId);
  if (metadata.project && typeof metadata.project === 'object') {
    run.project = metadata.project;
  }
  if (Array.isArray(metadata.designReferenceImages)) {
    run.designReferenceImages = metadata.designReferenceImages;
  }
  if (metadata.projectDataLayer && typeof metadata.projectDataLayer === 'object') {
    run.projectDataLayer = metadata.projectDataLayer;
  }
  if (cleanString(metadata.flowVersion)) {
    run.flowVersion = cleanString(metadata.flowVersion);
  }

  run.updatedAt = nowIso();
  run.events = [
    ...(Array.isArray(run.events) ? run.events : []),
    {
      stage: 'project_data_layer',
      collection: 'metadata',
      status: 'success',
      imageCount: 0,
      createdAt: run.updatedAt,
    },
  ].slice(-MAX_STORED_EVENTS);

  writeStore(store, options);
  return projectRunSummary(run);
}

function recordProjectRunProgress(request = {}, progress = {}, options = {}) {
  const projectCode = normalizeProjectCode(request.project_code || request.projectCode);
  if (!projectCode) {
    return null;
  }

  const stage = cleanString(progress.stage) || 'project_final_display';
  const progressStatus = cleanString(progress.status) || 'running';
  const runStatus = cleanString(progress.runStatus);
  const now = nowIso();
  const store = readStore(options);
  const run = ensureRun(store, projectCode, request.project_run_id || request.projectRunId);
  const requestId = cleanString(request.request_id || request.requestId);
  if (requestId) {
    run.requestId = requestId;
  }
  const errorCode = cleanString(progress.error?.code || progress.errorCode);
  const retryable = Boolean(progress.error?.retryable ?? progress.retryable);

  if (runStatus) {
    run.status = runStatus;
  }

  run.updatedAt = now;
  run.progress = {
    stage,
    status: progressStatus,
    attempt: Number(progress.attempt) || 0,
    maxAttempts: Number(progress.maxAttempts) || 0,
    durationMs: Number(progress.durationMs) || 0,
    updatedAt: now,
  };

  if (progressStatus === 'failed' || runStatus === 'failed') {
    run.error = {
      code: errorCode || 'EVIDENCE_AGENT_FINAL_DISPLAY_FAILED',
      retryable,
      stage,
      failedAt: now,
    };
  } else if (
    progressStatus === 'started' ||
    progressStatus === 'success' ||
    progressStatus === 'partial' ||
    progressStatus === 'blocked' ||
    runStatus === 'completed'
  ) {
    run.error = null;
  }

  run.events = [
    ...(Array.isArray(run.events) ? run.events : []),
    {
      stage,
      collection: 'progress',
      status: progressStatus,
      attempt: Number(progress.attempt) || 0,
      maxAttempts: Number(progress.maxAttempts) || 0,
      durationMs: Number(progress.durationMs) || 0,
      errorCode: errorCode || undefined,
      retryable: errorCode ? retryable : undefined,
      imageCount: 0,
      createdAt: now,
    },
  ].slice(-MAX_STORED_EVENTS);

  writeStore(store, options);
  return projectRunSummary(run);
}

function getProjectRun(runId, options = {}) {
  const safeRunId = safeIdPart(runId, '');
  if (!safeRunId) {
    return null;
  }
  const store = readStore(options);
  return projectRunSummary(store.runs[safeRunId]);
}

function getLatestProjectRunForCode(projectCode, options = {}) {
  const normalizedCode = normalizeProjectCode(projectCode);
  if (!normalizedCode) {
    return null;
  }
  const store = readStore(options);
  const runId = store.latestByProjectCode[normalizedCode];
  return projectRunSummary(runId ? store.runs[runId] : null);
}

function getProjectRunsForCode(projectCode, options = {}) {
  const normalizedCode = normalizeProjectCode(projectCode);
  if (!normalizedCode) {
    return [];
  }
  const store = readStore(options);
  return Object.values(store.runs || {})
    .filter((run) => run?.projectCode === normalizedCode)
    .sort((first, second) => String(second.updatedAt || '').localeCompare(String(first.updatedAt || '')))
    .map(projectRunSummary)
    .filter(Boolean);
}

module.exports = {
  PROJECT_RUN_ASSET_DIR,
  PROJECT_RUN_ASSET_PUBLIC_PATH,
  PROJECT_RUN_STORE_PATH,
  getLatestProjectRunForCode,
  getProjectRun,
  getProjectRunsForCode,
  projectRunSummary,
  recordProjectRunMetadata,
  recordProjectRunProgress,
  recordProjectGenerationResult,
};
