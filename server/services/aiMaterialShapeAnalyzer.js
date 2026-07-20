const { getAiFinalPromptComposerConfig, normalizeInputImages } = require('./aiFinalPromptComposer');

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_ENDPOINT_PATH = '/chat/completions';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_TOKENS = 2200;
const DEFAULT_MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024;
const SOURCE = 'ai_material_shape_analyzer';

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isEnabledValue(value) {
  if (value === undefined || value === null || value === '') {
    return true;
  }
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function safeError(type, stage, message, extra = {}) {
  return {
    type,
    stage,
    message,
    ...extra,
  };
}

function safePreview(value, maxLength = 800) {
  return String(value || '').slice(0, maxLength);
}

function getAiMaterialShapeAnalyzerConfig(env = process.env) {
  const fallback = getAiFinalPromptComposerConfig(env);
  return {
    enabled: isEnabledValue(
      env.AI_MATERIAL_SHAPE_ANALYZER_ENABLED === undefined
        ? fallback.enabled
        : env.AI_MATERIAL_SHAPE_ANALYZER_ENABLED,
    ),
    baseUrl: cleanString(env.AI_MATERIAL_SHAPE_ANALYZER_BASE_URL) || fallback.baseUrl,
    endpointPath:
      cleanString(env.AI_MATERIAL_SHAPE_ANALYZER_ENDPOINT_PATH) ||
      fallback.endpointPath ||
      DEFAULT_ENDPOINT_PATH,
    apiKey: cleanString(env.AI_MATERIAL_SHAPE_ANALYZER_API_KEY) || fallback.apiKey,
    model: cleanString(env.AI_MATERIAL_SHAPE_ANALYZER_MODEL) || fallback.model || DEFAULT_MODEL,
    timeoutMs: parseInteger(
      env.AI_MATERIAL_SHAPE_ANALYZER_TIMEOUT_MS,
      fallback.timeoutMs || DEFAULT_TIMEOUT_MS,
    ),
    maxTokens: parseInteger(env.AI_MATERIAL_SHAPE_ANALYZER_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    maxInputImageBytes: parseInteger(
      env.AI_MATERIAL_SHAPE_ANALYZER_MAX_INPUT_IMAGE_BYTES,
      fallback.maxInputImageBytes || DEFAULT_MAX_INPUT_IMAGE_BYTES,
    ),
    embedInputImages: isEnabledValue(env.AI_MATERIAL_SHAPE_ANALYZER_EMBED_INPUT_IMAGES),
    responseFormat: cleanString(env.AI_MATERIAL_SHAPE_ANALYZER_RESPONSE_FORMAT) || 'json_object',
  };
}

function buildEmptyMaterialShapeAnalysisResult(status, config = {}, error = null, extra = {}) {
  return {
    status,
    source: SOURCE,
    model: config.model || DEFAULT_MODEL,
    source_kind: cleanString(extra.source_kind),
    input_image_count: extra.input_image_count || 0,
    split_required: true,
    split_mode: 'split_by_level',
    split_reason: '',
    single_material_guidance: '',
    levels: {
      primary: emptyLevel('primary'),
      secondary: emptyLevel('secondary'),
      tertiary: emptyLevel('tertiary'),
    },
    global_notes: [],
    ai_error: error,
  };
}

function emptyLevel(level) {
  return {
    level,
    extraction_targets: [],
    preserve_details: [],
    exclude_items: [],
    source_reasoning: '',
    prompt_guidance: '',
  };
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) {
    return null;
  }

  return {
    buffer: match[2]
      ? Buffer.from(match[3] || '', 'base64')
      : Buffer.from(decodeURIComponent(match[3] || ''), 'utf8'),
    mimeType: match[1] || 'image/png',
  };
}

function mimeFromContentType(contentType) {
  const clean = cleanString(contentType).split(';')[0].trim();
  return clean && clean.includes('/') ? clean : 'image/png';
}

function mimeFromFilename(filenameOrUrl) {
  const clean = cleanString(filenameOrUrl).split(/[?#]/)[0].toLowerCase();
  if (/\.(jpe?g|jfif)$/.test(clean)) {
    return 'image/jpeg';
  }
  if (/\.png$/.test(clean)) {
    return 'image/png';
  }
  if (/\.webp$/.test(clean)) {
    return 'image/webp';
  }
  if (/\.gif$/.test(clean)) {
    return 'image/gif';
  }
  return '';
}

function mimeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength < 12) {
    return '';
  }
  if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  const gifHeader = buffer.subarray(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return 'image/gif';
  }
  return '';
}

function resolveImageMimeType(contentType, buffer, filenameOrUrl) {
  const headerMime = mimeFromContentType(contentType);
  if (headerMime.startsWith('image/')) {
    return headerMime;
  }
  return mimeFromBuffer(buffer) || mimeFromFilename(filenameOrUrl);
}

async function imageUrlToDataUrl(image, config, fetchImpl) {
  if (image.url.startsWith('data:')) {
    const parsed = dataUrlToBuffer(image.url);
    if (!parsed) {
      throw new Error(`Invalid data URL for ${image.label || image.id}.`);
    }
    const mimeType = String(parsed.mimeType || '').startsWith('image/')
      ? parsed.mimeType
      : mimeFromBuffer(parsed.buffer) || mimeFromFilename(image.filename || image.url);
    if (!mimeType) {
      throw new Error(`Input image ${image.label || image.id} is not an image data URL.`);
    }
    if (parsed.buffer.byteLength > config.maxInputImageBytes) {
      throw new Error(`Input image ${image.label || image.id} is larger than the configured limit.`);
    }
    return `data:${mimeType};base64,${parsed.buffer.toString('base64')}`;
  }

  if (!config.embedInputImages) {
    return image.url;
  }

  const response = await fetchImpl(image.url);
  if (!response.ok) {
    throw new Error(`Unable to fetch input image ${image.label || image.id}.`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > config.maxInputImageBytes) {
    throw new Error(`Input image ${image.label || image.id} is larger than the configured limit.`);
  }

  const buffer = Buffer.from(arrayBuffer);
  const mimeType = resolveImageMimeType(
    response.headers?.get?.('content-type'),
    buffer,
    image.filename || image.url,
  );
  if (!mimeType) {
    throw new Error(
      `Input image ${image.label || image.id} returned non-image content-type: ${response.headers?.get?.('content-type') || 'unknown'}.`,
    );
  }
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function normalizeStringList(values, maxItems = 12, maxLength = 180) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.map(cleanString).filter(Boolean))]
    .map((value) => value.slice(0, maxLength))
    .slice(0, maxItems);
}

function parseJsonObject(text) {
  const raw = cleanString(text);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch (_innerError) {
      return null;
    }
  }
}

function normalizeLevel(payload, level) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    level,
    extraction_targets: normalizeStringList(
      source.extraction_targets || source.targets || source.extract_targets,
      12,
      180,
    ),
    preserve_details: normalizeStringList(
      source.preserve_details || source.keep_details || source.visual_details,
      12,
      180,
    ),
    exclude_items: normalizeStringList(
      source.exclude_items || source.exclusions || source.do_not_extract,
      12,
      180,
    ),
    source_reasoning: cleanString(source.source_reasoning || source.reasoning || source.reason).slice(0, 500),
    prompt_guidance: cleanString(source.prompt_guidance || source.guidance || source.instruction).slice(0, 500),
  };
}

function normalizeAnalysisPayload(payload) {
  const levels = payload?.levels || payload || {};
  const splitMode = cleanString(payload?.split_mode || payload?.mode || payload?.recommended_mode);
  const splitRequired = typeof payload?.split_required === 'boolean'
    ? payload.split_required
    : splitMode
      ? !['none', 'no_split', 'single', 'single_material_board', 'skip'].includes(splitMode.toLowerCase())
      : true;
  return {
    split_required: splitRequired,
    split_mode: splitMode || (splitRequired ? 'split_by_level' : 'single_material_board'),
    split_reason: cleanString(payload?.split_reason || payload?.reason || payload?.no_split_reason).slice(0, 600),
    single_material_guidance: cleanString(
      payload?.single_material_guidance ||
      payload?.no_split_guidance ||
      payload?.unified_material_guidance,
    ).slice(0, 800),
    levels: {
      primary: normalizeLevel(levels.primary || payload?.primary, 'primary'),
      secondary: normalizeLevel(levels.secondary || payload?.secondary, 'secondary'),
      tertiary: normalizeLevel(levels.tertiary || payload?.tertiary, 'tertiary'),
    },
    global_notes: normalizeStringList(payload?.global_notes || payload?.notes, 8, 220),
  };
}

function sourceKindLabel(sourceKind) {
  if (sourceKind === 'material') {
    return '图库/渠道素材图';
  }
  if (sourceKind === 'design_reference') {
    return '设计参考图或外部竞品证据图';
  }
  return '输入参考图';
}

function buildSystemPrompt() {
  return [
    '你是 MYML 图案素材提取流程里的“一级形/二级形/三级形判断 AI”。',
    '你的任务不是生成图片，也不是重新设计，而是观察输入图中真实存在的视觉内容，先判断是否有必要拆分成一级形/二级形/三级形；只有确实需要分层时，才判断每一层应该提取什么、保留什么、排除什么。',
    '必须严格区分商品载体、产品展示截图、包装、价格/店铺信息与真正可复用的图案素材。',
    '开发思路 design_requirement_directives 是高优先级判断依据：如果开发思路写明“形状见图1、图案见图2、排版见参考图3、文案见文字元素、黑色底/纯白色”等关系，必须结合这些关系判断是否拆分、每一层从哪张图提取什么，不能只取其中一张参考图。',
    '只有开发思路明确写出图号和具体要求时，才建立对应图片职责；如果没有出现具体图号或具体用途，不得虚构“图1负责主体、图2负责排版”等绑定，应根据全部输入图的真实视觉内容、主要图案元素和文字元素正常判断。',
    '当多张参考图承担不同角色时，应把图1/图2/图3/图4的角色分别纳入判断：形状/轮廓/载体外形通常只作为边界或版式依据，主题图案和文字字形可作为一级形或二级形，排版/边框/布局可作为二级形，细小点缀/纹理/重复符号可作为三级形。',
    '如果输入图已经是同一层级的多个独立贴图、成品小图案集合、素材板、刀模小图合集，且没有明显主视觉/辅助/点缀层级差异，则 split_required 必须为 false，不要强行拆成一级形、二级形、三级形。',
    '如果 split_required 为 false，只输出如何统一清理素材板：去除尺寸线、尺寸文字、边框框选、截图标注、背景和无关信息，保留每个独立可用图案素材。',
    '一级形只允许是最核心主视觉或主标题字形，数量少而明确；二级形是辅助结构、边框、角花、中等图标；三级形是散点、小符号、底纹、轻装饰。',
    '不得把整张产品图、完整版式、完整素材板或同一组元素同时分配到多个层级。',
    '不得要求提取输入图中不存在的元素；主要图案元素和文字元素只用于筛选和命名，不允许凭空生成。',
    'Return JSON only.',
  ].join('\n');
}

function buildUserPayload(request, inputImages) {
  return {
    project_code: cleanString(request.project_code || request.projectCode),
    category: cleanString(request.category),
    source_kind: cleanString(request.source_kind || request.sourceKind),
    source_label: sourceKindLabel(cleanString(request.source_kind || request.sourceKind)),
    graphic_elements: normalizeStringList(request.graphic_elements || request.graphicElements, 20, 120),
    text_elements: normalizeStringList(request.text_elements || request.textElements, 12, 120),
    design_requirement_directives: normalizeStringList(
      request.design_requirement_directives || request.designRequirementDirectives,
      12,
      180,
    ),
    input_images: inputImages.map((image, index) => ({
      image_index: index + 1,
      role: image.role,
      label: image.label,
      filename: image.filename,
      detail: image.detail,
    })),
    output_schema: {
      split_required: 'boolean; false when the input should be kept as one cleaned material board instead of split into primary/secondary/tertiary',
      split_mode: 'split_by_level | single_material_board',
      split_reason: 'short Chinese reason explaining why splitting is or is not needed',
      single_material_guidance: 'if split_required=false, Chinese guidance for cleaning one unified material board',
      levels: {
        primary: {
          extraction_targets: ['only 1-3 existing core motif/title candidates from the input images'],
          preserve_details: ['visual details that must be preserved while extracting primary shapes'],
          exclude_items: ['items that must not appear in primary extraction'],
          source_reasoning: 'why these are primary shapes based on the input images',
          prompt_guidance: 'short Chinese instruction to append to the image extraction prompt',
        },
        secondary: {
          extraction_targets: ['existing supporting frames/icons/borders/mid-weight elements'],
          preserve_details: ['details to preserve'],
          exclude_items: ['items that must not appear in secondary extraction'],
          source_reasoning: 'why these are secondary shapes',
          prompt_guidance: 'short Chinese instruction to append to the image extraction prompt',
        },
        tertiary: {
          extraction_targets: ['existing small accents/dots/texture/pattern details'],
          preserve_details: ['details to preserve'],
          exclude_items: ['items that must not appear in tertiary extraction'],
          source_reasoning: 'why these are tertiary shapes',
          prompt_guidance: 'short Chinese instruction to append to the image extraction prompt',
        },
      },
      global_notes: ['short notes about carrier removal and overlapping risk'],
    },
  };
}

async function buildMessages(request, inputImages, config, fetchImpl) {
  const imageParts = [];
  for (const image of inputImages) {
    imageParts.push({
      type: 'image_url',
      image_url: {
        url: await imageUrlToDataUrl(image, config, fetchImpl),
      },
    });
  }

  return [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: JSON.stringify(buildUserPayload(request, inputImages)),
        },
        ...imageParts,
      ],
    },
  ];
}

async function buildMaterialShapeAnalysisRequestBody(request, inputImages, config, fetchImpl) {
  const body = {
    model: config.model,
    messages: await buildMessages(request, inputImages, config, fetchImpl),
    stream: false,
    max_tokens: config.maxTokens,
  };

  if (config.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  return body;
}

async function analyzeMaterialShapeLevels(request = {}, options = {}) {
  const config = getAiMaterialShapeAnalyzerConfig(options.env || process.env);
  const inputImages = normalizeInputImages(request.input_images || request.inputImages);
  const sourceKind = cleanString(request.source_kind || request.sourceKind);

  if (inputImages.length === 0) {
    return buildEmptyMaterialShapeAnalysisResult(
      'missing_input_images',
      config,
      safeError('missing_input_images', 'input', 'Material shape analysis requires input images.'),
      { source_kind: sourceKind, input_image_count: 0 },
    );
  }

  if (!config.enabled) {
    return buildEmptyMaterialShapeAnalysisResult(
      'disabled',
      config,
      null,
      { source_kind: sourceKind, input_image_count: inputImages.length },
    );
  }

  if (!config.baseUrl || !config.apiKey) {
    return buildEmptyMaterialShapeAnalysisResult(
      'missing_config',
      config,
      safeError('missing_config', 'config', 'AI material shape analyzer is not configured.'),
      { source_kind: sourceKind, input_image_count: inputImages.length },
    );
  }

  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    return buildEmptyMaterialShapeAnalysisResult(
      'missing_fetch',
      config,
      safeError('missing_fetch', 'request', 'No fetch implementation is available.'),
      { source_kind: sourceKind, input_image_count: inputImages.length },
    );
  }

  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/${config.endpointPath.replace(/^\/+/, '')}`;
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const requestBody = await buildMaterialShapeAnalysisRequestBody(request, inputImages, config, fetchImpl);
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const responseText = await response.text();
    const contentType = response.headers?.get?.('content-type') || '';

    if (!response.ok) {
      return buildEmptyMaterialShapeAnalysisResult(
        'http_error',
        config,
        safeError('http_error', 'response', `AI material shape analysis failed with HTTP ${response.status}.`, {
          http_status: response.status,
          content_type: contentType,
          response_preview: safePreview(responseText),
          duration_ms: Date.now() - startedAt,
        }),
        { source_kind: sourceKind, input_image_count: inputImages.length },
      );
    }

    let envelope;
    try {
      envelope = JSON.parse(responseText);
    } catch (_error) {
      return buildEmptyMaterialShapeAnalysisResult(
        'json_parse_error',
        config,
        safeError('json_parse_error', 'response_parse', 'AI material shape response was not valid JSON.', {
          content_type: contentType,
          response_preview: safePreview(responseText),
        }),
        { source_kind: sourceKind, input_image_count: inputImages.length },
      );
    }

    const content = envelope.choices?.[0]?.message?.content;
    if (!content) {
      return buildEmptyMaterialShapeAnalysisResult(
        'empty_ai_result',
        config,
        safeError('empty_ai_result', 'message_content', 'AI material shape response did not include message content.'),
        { source_kind: sourceKind, input_image_count: inputImages.length },
      );
    }

    const parsed = parseJsonObject(content);
    if (!parsed) {
      return buildEmptyMaterialShapeAnalysisResult(
        'json_parse_error',
        config,
        safeError('json_parse_error', 'message_parse', 'AI material shape content was not valid JSON.', {
          response_preview: safePreview(content),
        }),
        { source_kind: sourceKind, input_image_count: inputImages.length },
      );
    }

    const normalized = normalizeAnalysisPayload(parsed);
    const hasAnyTarget = !normalized.split_required || Object.values(normalized.levels).some((level) => (
      level.extraction_targets.length > 0 || level.prompt_guidance
    ));
    if (!hasAnyTarget) {
      return buildEmptyMaterialShapeAnalysisResult(
        'empty_levels',
        config,
        safeError('empty_levels', 'validation', 'AI material shape response did not include useful level guidance.', {
          response_preview: safePreview(content),
        }),
        { source_kind: sourceKind, input_image_count: inputImages.length },
      );
    }

    return {
      status: 'success',
      source: SOURCE,
      model: config.model,
      source_kind: sourceKind,
      input_image_count: inputImages.length,
      split_required: normalized.split_required,
      split_mode: normalized.split_mode,
      split_reason: normalized.split_reason,
      single_material_guidance: normalized.single_material_guidance,
      levels: normalized.levels,
      global_notes: normalized.global_notes,
      ai_error: null,
    };
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    return buildEmptyMaterialShapeAnalysisResult(
      isTimeout ? 'timeout' : 'error',
      config,
      safeError(
        isTimeout ? 'timeout' : 'request_error',
        isTimeout ? 'timeout' : 'request',
        isTimeout ? 'AI material shape analysis timed out.' : 'AI material shape analysis failed.',
        {
          message: error instanceof Error ? error.message : String(error),
          duration_ms: Date.now() - startedAt,
          timeout_ms: config.timeoutMs,
        },
      ),
      { source_kind: sourceKind, input_image_count: inputImages.length },
    );
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  analyzeMaterialShapeLevels,
  buildMaterialShapeAnalysisRequestBody,
  getAiMaterialShapeAnalyzerConfig,
  normalizeAnalysisPayload,
};
