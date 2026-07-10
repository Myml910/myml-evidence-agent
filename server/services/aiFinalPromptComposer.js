const { getAiElementMapperConfig } = require('./aiElementMapper');

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_ENDPOINT_PATH = '/chat/completions';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 2400;
const DEFAULT_MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024;
const SOURCE = 'ai_final_prompt_composer';

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

function getAiFinalPromptComposerConfig(env = process.env) {
  const fallback = getAiElementMapperConfig(env);
  return {
    enabled: isEnabledValue(
      env.AI_FINAL_PROMPT_COMPOSER_ENABLED === undefined
        ? fallback.enabled
        : env.AI_FINAL_PROMPT_COMPOSER_ENABLED,
    ),
    baseUrl: cleanString(env.AI_FINAL_PROMPT_COMPOSER_BASE_URL) || fallback.baseUrl,
    endpointPath:
      cleanString(env.AI_FINAL_PROMPT_COMPOSER_ENDPOINT_PATH) ||
      fallback.endpointPath ||
      DEFAULT_ENDPOINT_PATH,
    apiKey: cleanString(env.AI_FINAL_PROMPT_COMPOSER_API_KEY) || fallback.apiKey,
    model: cleanString(env.AI_FINAL_PROMPT_COMPOSER_MODEL) || fallback.model || DEFAULT_MODEL,
    timeoutMs: parseInteger(
      env.AI_FINAL_PROMPT_COMPOSER_TIMEOUT_MS,
      fallback.timeoutMs || DEFAULT_TIMEOUT_MS,
    ),
    maxTokens: parseInteger(env.AI_FINAL_PROMPT_COMPOSER_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    maxInputImageBytes: parseInteger(
      env.AI_FINAL_PROMPT_COMPOSER_MAX_INPUT_IMAGE_BYTES,
      DEFAULT_MAX_INPUT_IMAGE_BYTES,
    ),
    embedInputImages: isEnabledValue(env.AI_FINAL_PROMPT_COMPOSER_EMBED_INPUT_IMAGES),
    responseFormat: cleanString(env.AI_FINAL_PROMPT_COMPOSER_RESPONSE_FORMAT) || 'json_object',
  };
}

function buildEmptyFinalPromptResult(status, config = {}, error = null, extra = {}) {
  return {
    status,
    source: SOURCE,
    model: config.model || DEFAULT_MODEL,
    prompt_template_id: cleanString(extra.prompt_template_id),
    final_prompt: '',
    prompt_strategy: '',
    history_layout_lock_policy: '',
    history_layout_lock_reason: '',
    warnings: [],
    input_image_count: extra.input_image_count || 0,
    ai_error: error,
  };
}

function normalizeInputImages(inputImages = []) {
  if (!Array.isArray(inputImages)) {
    return [];
  }

  return inputImages
    .map((image, index) => ({
      id: cleanString(image.id) || `input-${index + 1}`,
      role: cleanString(image.role || image.kind) || 'reference',
      label: cleanString(image.label) || `输入图 ${index + 1}`,
      filename: cleanString(image.filename),
      url: cleanString(image.url),
      detail: cleanString(image.detail).slice(0, 800),
    }))
    .filter((image) => image.url)
    .slice(0, 4);
}

function generationImageRolePriority(role) {
  if (role === 'history') {
    return 0;
  }
  if (role === 'material') {
    return 1;
  }
  return 2;
}

function sortInputImages(inputImages = []) {
  return [...inputImages].sort((left, right) => (
    generationImageRolePriority(left.role) - generationImageRolePriority(right.role)
  ));
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
  return mimeFromBuffer(buffer) || mimeFromFilename(filenameOrUrl) || 'image/png';
}

async function imageUrlToDataUrl(image, config, fetchImpl) {
  if (image.url.startsWith('data:')) {
    const parsed = dataUrlToBuffer(image.url);
    if (!parsed) {
      throw new Error(`Invalid data URL for ${image.label || image.id}.`);
    }
    if (parsed.buffer.byteLength > config.maxInputImageBytes) {
      throw new Error(`Input image ${image.label || image.id} is larger than the configured limit.`);
    }
    const mimeType = String(parsed.mimeType || '').startsWith('image/')
      ? parsed.mimeType
      : mimeFromBuffer(parsed.buffer) || mimeFromFilename(image.filename || image.url) || 'image/png';
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
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function buildSystemPrompt(promptTemplateId = '') {
  if (promptTemplateId === 'material_board_reverse') {
    return [
      'You are a visual prompt reverse-engineering AI for MYML material-board processing.',
      'Your task is to analyze the provided material-board image and output a detailed visual description that strictly follows the requested Markdown template.',
      'Do not write a final image-generation prompt, do not explain your process, and do not add sections outside the requested template.',
      'The Markdown description must be placed in the JSON field "final_prompt".',
      'Return JSON only.',
    ].join('\n');
  }

  return [
    '你是 MYML 图案设计流程里的“最终提示词编写 AI”。',
    '你的任务不是生成图片，而是结合输入图和提示词模板，输出一段真正提交给图生图模型的最终提示词。',
    '输入图角色必须严格遵守：图1/第一张输入图是历史设计图或历史空版式母版，只用于版式、刀模、设计单元、比例、占位、留白和密度；图2及以后是素材图，只用于素材外观、文字字形、线条、纹理、局部装饰和配色关系。',
    '你必须先根据真实品类、图1历史设计图/空版式母版和模板内容判断“版式母版锁定策略”，并在 JSON 中输出 history_layout_lock_policy。',
    'history_layout_lock_policy 只能是 geometry_lock、layout_lock、flexible_reference 三者之一：杯套、刀模、包装、纸巾、餐盘、固定裁切版位等生产结构必须严格不变时用 geometry_lock；只需要保留设计单元数量、相对位置、画布比例和留白时用 layout_lock；异形贴纸、异形轮廓、需要重新适配外形或历史图只是参考方向时用 flexible_reference。',
    '如果判断为 geometry_lock，最终提示词必须写明保持图1刀模外轮廓、红色刀线位置、中心收腰缺口、上下印刷版位关系、单元间距、左右边距、顶部留白、底部留白和版位外白底比例，并禁止拉伸、压缩、放大、缩小、裁切、移动或重新排布图1刀模模板。',
    '如果判断为 layout_lock 或 flexible_reference，最终提示词不要强行锁死每条刀线或异形轮廓；仍必须禁止把整张历史图拉伸、压扁、放大到铺满画布或改变原始画布比例。',
    '你必须根据实际输入图理解版式母版和素材图，而不是只改写模板文字。',
    '禁止让历史图里的旧主题、旧文字、旧图案、旧角色、旧场景、旧边框花纹、旧底纹或旧配色进入新设计。',
    '禁止把素材图或公司参考图的整图构图替代历史设计图。',
    '最终输出只给生图模型使用，不要写解释、不要写 Markdown、不要输出分析过程。',
    'Return JSON only.',
  ].join('\n');
}

function branchInstruction(promptTemplateId) {
  if (promptTemplateId === 'material_board_reverse') {
    return [
      'Current mode: material board reverse prompt.',
      'Analyze only the provided material-board image.',
      'Output the visual description strictly in the requested Markdown template.',
      'Keep the bold English/Chinese section headers exactly as requested.',
      'Write detailed, high-quality English descriptions in each section.',
      'Return JSON only, with final_prompt containing the Markdown result.',
    ].join('\n');
  }

  if (promptTemplateId === 'minimal_natural') {
    return [
      '当前模板板块是“自然语言板”。',
      '最终提示词只允许保留两类结构化策略：历史设计图怎么参考、背景策略怎么实施。',
      '除了这两类结构化策略，其余内容用自然语言表达。',
      '自然语言核心任务必须接近：用素材图替换掉历史设计图中的设计主题，生成一张新的设计图。',
      '不要输出 Core Subject、Art Style、Composition 等多维度结构化标题。',
    ].join('\n');
  }

  return [
    '当前模板板块是“结构板”。',
    '最终提示词需要保留结构化控制维度，但必须由你结合输入图重新组织成真正可执行的生图提示词。',
    '结构板应覆盖：输入图角色、真实品类、主要图案元素、文字元素、素材使用、历史版式、背景策略、单个版位设计维度、质量约束和禁止偏离。',
    '不要机械复制模板；要根据图1版式母版和图2+素材图输出更清晰、可执行、去冗余的最终提示词。',
  ].join('\n');
}

function buildUserPayload(request, inputImages) {
  return {
    prompt_template_id: cleanString(request.prompt_template_id || request.promptTemplateId),
    project_code: cleanString(request.project_code || request.projectCode),
    category: cleanString(request.category),
    template_prompt: cleanString(request.template_prompt || request.templatePrompt),
    input_images: inputImages.map((image, index) => ({
      image_index: index + 1,
      role: image.role,
      label: image.label,
      filename: image.filename,
      detail: image.detail,
    })),
    output_schema: {
      final_prompt: 'the real final image-generation prompt in Chinese',
      prompt_strategy: 'short reason describing how you used the selected prompt board',
      history_layout_lock_policy: 'geometry_lock | layout_lock | flexible_reference',
      history_layout_lock_reason: 'short Chinese reason based on category and the first history image',
      warnings: ['short warning if inputs are insufficient'],
    },
  };
}

async function buildMessages(request, inputImages, config, fetchImpl) {
  const promptTemplateId = cleanString(request.prompt_template_id || request.promptTemplateId);
  const imageParts = [];
  for (const image of sortInputImages(inputImages)) {
    imageParts.push({
      type: 'image_url',
      image_url: {
        url: await imageUrlToDataUrl(image, config, fetchImpl),
      },
    });
  }

  return [
    { role: 'system', content: buildSystemPrompt(promptTemplateId) },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            branchInstruction(promptTemplateId),
            '',
            JSON.stringify(buildUserPayload(request, inputImages)),
          ].join('\n'),
        },
        ...imageParts,
      ],
    },
  ];
}

async function buildFinalPromptRequestBody(request, inputImages, config, fetchImpl) {
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

function cleanStringList(values, maxItems = 8, maxLength = 220) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.map(cleanString).filter(Boolean))]
    .map((value) => value.slice(0, maxLength))
    .slice(0, maxItems);
}

function normalizeHistoryLayoutLockPolicy(value) {
  const clean = cleanString(value).toLowerCase();
  if (['geometry_lock', 'layout_lock', 'flexible_reference'].includes(clean)) {
    return clean;
  }
  return '';
}

function normalizeFinalPromptPayload(payload, fallbackText = '') {
  const finalPrompt = cleanString(payload?.final_prompt || payload?.prompt || fallbackText);
  return {
    final_prompt: finalPrompt,
    prompt_strategy: cleanString(payload?.prompt_strategy || payload?.strategy).slice(0, 500),
    history_layout_lock_policy: normalizeHistoryLayoutLockPolicy(
      payload?.history_layout_lock_policy || payload?.layout_lock_policy,
    ),
    history_layout_lock_reason: cleanString(
      payload?.history_layout_lock_reason || payload?.layout_lock_reason,
    ).slice(0, 500),
    warnings: cleanStringList(payload?.warnings || payload?.warning, 8, 220),
  };
}

async function composeFinalPrompt(request = {}, options = {}) {
  const config = getAiFinalPromptComposerConfig(options.env || process.env);
  const inputImages = normalizeInputImages(request.input_images || request.inputImages);
  const templatePrompt = cleanString(request.template_prompt || request.templatePrompt);
  const promptTemplateId = cleanString(request.prompt_template_id || request.promptTemplateId);

  if (!templatePrompt) {
    return buildEmptyFinalPromptResult(
      'missing_template_prompt',
      config,
      safeError('missing_template_prompt', 'input', 'Template prompt is required.'),
      { prompt_template_id: promptTemplateId, input_image_count: inputImages.length },
    );
  }

  if (inputImages.length === 0) {
    return buildEmptyFinalPromptResult(
      'missing_input_images',
      config,
      safeError('missing_input_images', 'input', 'Final prompt composition requires input images.'),
      { prompt_template_id: promptTemplateId, input_image_count: 0 },
    );
  }

  if (!config.enabled) {
    return buildEmptyFinalPromptResult(
      'disabled',
      config,
      null,
      { prompt_template_id: promptTemplateId, input_image_count: inputImages.length },
    );
  }

  if (!config.baseUrl || !config.apiKey) {
    return buildEmptyFinalPromptResult(
      'missing_config',
      config,
      safeError('missing_config', 'config', 'AI final prompt composer is not configured.'),
      { prompt_template_id: promptTemplateId, input_image_count: inputImages.length },
    );
  }

  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    return buildEmptyFinalPromptResult(
      'missing_fetch',
      config,
      safeError('missing_fetch', 'request', 'No fetch implementation is available.'),
      { prompt_template_id: promptTemplateId, input_image_count: inputImages.length },
    );
  }

  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/${config.endpointPath.replace(/^\/+/, '')}`;
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const requestBody = await buildFinalPromptRequestBody(request, inputImages, config, fetchImpl);
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
      return buildEmptyFinalPromptResult(
        'http_error',
        config,
        safeError('http_error', 'response', `AI final prompt request failed with HTTP ${response.status}.`, {
          http_status: response.status,
          content_type: contentType,
          response_preview: safePreview(responseText),
          duration_ms: Date.now() - startedAt,
        }),
        { prompt_template_id: promptTemplateId, input_image_count: inputImages.length },
      );
    }

    let envelope;
    try {
      envelope = JSON.parse(responseText);
    } catch (_error) {
      return buildEmptyFinalPromptResult(
        'json_parse_error',
        config,
        safeError('json_parse_error', 'response_parse', 'AI final prompt response was not valid JSON.', {
          content_type: contentType,
          response_preview: safePreview(responseText),
        }),
        { prompt_template_id: promptTemplateId, input_image_count: inputImages.length },
      );
    }

    const content = envelope.choices?.[0]?.message?.content;
    if (!content) {
      return buildEmptyFinalPromptResult(
        'empty_ai_result',
        config,
        safeError('empty_ai_result', 'message_content', 'AI final prompt response did not include message content.'),
        { prompt_template_id: promptTemplateId, input_image_count: inputImages.length },
      );
    }

    const parsed = parseJsonObject(content);
    const normalized = normalizeFinalPromptPayload(parsed, parsed ? '' : content);
    if (!normalized.final_prompt) {
      return buildEmptyFinalPromptResult(
        'empty_final_prompt',
        config,
        safeError('empty_final_prompt', 'validation', 'AI final prompt response did not include final_prompt.', {
          response_preview: safePreview(content),
        }),
        { prompt_template_id: promptTemplateId, input_image_count: inputImages.length },
      );
    }

    return {
      status: 'success',
      source: SOURCE,
      model: config.model,
      prompt_template_id: promptTemplateId,
      final_prompt: normalized.final_prompt,
      prompt_strategy: normalized.prompt_strategy,
      history_layout_lock_policy: normalized.history_layout_lock_policy || 'layout_lock',
      history_layout_lock_reason: normalized.history_layout_lock_reason,
      warnings: normalized.warnings,
      input_image_count: inputImages.length,
      ai_error: null,
    };
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    return buildEmptyFinalPromptResult(
      isTimeout ? 'timeout' : 'error',
      config,
      safeError(
        isTimeout ? 'timeout' : 'request_error',
        isTimeout ? 'timeout' : 'request',
        isTimeout ? 'AI final prompt request timed out.' : 'AI final prompt request failed.',
        {
          message: error instanceof Error ? error.message : String(error),
          duration_ms: Date.now() - startedAt,
          timeout_ms: config.timeoutMs,
        },
      ),
      { prompt_template_id: promptTemplateId, input_image_count: inputImages.length },
    );
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  buildFinalPromptRequestBody,
  composeFinalPrompt,
  getAiFinalPromptComposerConfig,
  normalizeInputImages,
};
