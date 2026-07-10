const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_ENDPOINT_PATH = '/images/edits';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SIZE = '1024x1024';
const DEFAULT_QUALITY = 'standard';
const DEFAULT_STYLE = 'vivid';
const DEFAULT_N = 1;
const DEFAULT_RESPONSE_FORMAT = 'url';
const DEFAULT_REQUEST_MODE = 'edits';
const DEFAULT_MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_IMAGE_FIELD_NAME = 'image';

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseSizeDimensions(size) {
  const match = cleanString(size).match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function roundSizeDimension(value) {
  return Math.max(64, Math.round(Number(value) / 8) * 8);
}

function isEnabledValue(value) {
  if (value === undefined || value === null || value === '') {
    return true;
  }
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function getAiImageGeneratorConfig(env = process.env) {
  return {
    enabled: isEnabledValue(env.AI_IMAGE_GENERATOR_ENABLED),
    baseUrl: cleanString(env.AI_IMAGE_GENERATOR_BASE_URL),
    endpointPath: cleanString(env.AI_IMAGE_GENERATOR_ENDPOINT_PATH) || DEFAULT_ENDPOINT_PATH,
    apiKey: cleanString(env.AI_IMAGE_GENERATOR_API_KEY),
    model: cleanString(env.AI_IMAGE_GENERATOR_MODEL) || DEFAULT_MODEL,
    timeoutMs: parseInteger(env.AI_IMAGE_GENERATOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    size: cleanString(env.AI_IMAGE_GENERATOR_SIZE) || DEFAULT_SIZE,
    quality: cleanString(env.AI_IMAGE_GENERATOR_QUALITY) || DEFAULT_QUALITY,
    style: cleanString(env.AI_IMAGE_GENERATOR_STYLE) || DEFAULT_STYLE,
    n: Math.min(10, parseInteger(env.AI_IMAGE_GENERATOR_N, DEFAULT_N)),
    responseFormat: cleanString(env.AI_IMAGE_GENERATOR_RESPONSE_FORMAT) || DEFAULT_RESPONSE_FORMAT,
    requestMode: cleanString(env.AI_IMAGE_GENERATOR_REQUEST_MODE) || DEFAULT_REQUEST_MODE,
    matchHistoryAspect: isEnabledValue(env.AI_IMAGE_GENERATOR_MATCH_HISTORY_ASPECT),
    embedInputImages: isEnabledValue(env.AI_IMAGE_GENERATOR_EMBED_INPUT_IMAGES),
    maxInputImageBytes: parseInteger(
      env.AI_IMAGE_GENERATOR_MAX_INPUT_IMAGE_BYTES,
      DEFAULT_MAX_INPUT_IMAGE_BYTES,
    ),
    imageFieldName: cleanString(env.AI_IMAGE_GENERATOR_IMAGE_FIELD_NAME) || DEFAULT_IMAGE_FIELD_NAME,
  };
}

function imageGenerationRequestMode(value) {
  const mode = cleanString(value).toLowerCase();
  return ['edits', 'images', 'chat'].includes(mode) ? mode : '';
}

function applyRequestOverrides(config, request = {}) {
  const requestMode = imageGenerationRequestMode(request.request_mode || request.requestMode);
  const endpointPath = cleanString(request.endpoint_path || request.endpointPath);
  const nextConfig = { ...config };

  if (requestMode) {
    nextConfig.requestMode = requestMode;
  }

  if (endpointPath) {
    nextConfig.endpointPath = endpointPath;
  } else if (requestMode === 'images' && /\/images\/edits$/i.test(nextConfig.endpointPath)) {
    nextConfig.endpointPath = nextConfig.endpointPath.replace(/\/images\/edits$/i, '/images/generations');
  }

  return nextConfig;
}

function safeError(type, stage, message, extra = {}) {
  return {
    type,
    stage,
    message,
    ...extra,
  };
}

function buildEmptyImageGenerationResult(status, config = {}, error = null, extra = {}) {
  return {
    status,
    source: 'ai_image_generator',
    model: config.model || DEFAULT_MODEL,
    request_mode: config.requestMode || DEFAULT_REQUEST_MODE,
    input_image_count: extra.input_image_count || 0,
    images: [],
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
      detail: cleanString(image.detail).slice(0, 500),
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

function sortInputImagesForGeneration(inputImages = []) {
  return [...inputImages].sort((left, right) => {
    const priorityDelta = generationImageRolePriority(left.role) - generationImageRolePriority(right.role);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return 0;
  });
}

function normalizeHistoryLayoutLockPolicy(value) {
  const clean = cleanString(value).toLowerCase();
  if (['geometry_lock', 'layout_lock', 'flexible_reference'].includes(clean)) {
    return clean;
  }
  return 'layout_lock';
}

function buildHistoryLayoutLockRule(policy, historyImage) {
  if (!historyImage) {
    return '';
  }

  if (policy === 'geometry_lock') {
    return '版式母版策略：geometry_lock。图1不是可重绘的风格参考，而是最终画布的几何坐标和刀模位置约束。必须保持图1刀模外轮廓、红色刀线位置、中心收腰缺口、上下印刷版位关系、单元间距、左右边距、顶部留白、底部留白和版位外白底比例；禁止拉伸、压缩、放大、缩小、裁切、移动或重新排布图1刀模模板；禁止把刀模/版位放大到铺满整张画布；禁止把窄长杯套变成更宽、更短或更靠近画布边缘的形状。';
  }

  if (policy === 'flexible_reference') {
    return '版式母版策略：flexible_reference。图1只作为历史版式方向和画布比例参考，不强行锁死每条刀线、异形轮廓或局部边界；允许根据真实品类和新主题重新适配异形轮廓或版位内部设计。仍必须保持图1的原始画布比例、主要设计单元关系和基本留白方向；禁止把整张历史图拉伸、压扁、放大到铺满画布，禁止把历史图旧内容直接复用到新设计。';
  }

  return '版式母版策略：layout_lock。图1用于锁定整体版式关系：画布比例、设计单元数量、相对位置、主体占位、主要留白、边缘区域和密度节奏；不要求逐线复制每条刀线或异形局部轮廓。禁止把整张历史图拉伸、压扁、放大到铺满画布，禁止改变主要版位数量和相对位置，禁止复用历史图旧内容。';
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

function extensionFromMimeType(mimeType) {
  if (mimeType === 'image/jpeg') {
    return 'jpg';
  }
  if (mimeType === 'image/webp') {
    return 'webp';
  }
  if (mimeType === 'image/gif') {
    return 'gif';
  }
  return 'png';
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) {
    return null;
  }

  const mimeType = match[1] || 'image/png';
  const isBase64 = Boolean(match[2]);
  const body = match[3] || '';
  const buffer = isBase64
    ? Buffer.from(body, 'base64')
    : Buffer.from(decodeURIComponent(body), 'utf8');

  return {
    buffer,
    mimeType,
  };
}

function parsePngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength < 24) {
    return null;
  }

  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    return null;
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

const JPEG_SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

function parseJpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.byteLength) {
    while (offset < buffer.byteLength && buffer[offset] !== 0xff) {
      offset += 1;
    }
    while (offset < buffer.byteLength && buffer[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buffer.byteLength) {
      break;
    }

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }
    if (offset + 2 > buffer.byteLength) {
      break;
    }

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.byteLength) {
      break;
    }

    if (JPEG_SOF_MARKERS.has(marker) && segmentLength >= 7) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    offset += segmentLength;
  }

  return null;
}

function imageDimensionsFromBuffer(buffer, mimeType = '') {
  const cleanMimeType = cleanString(mimeType).toLowerCase();
  if (cleanMimeType.includes('png')) {
    return parsePngDimensions(buffer);
  }
  if (cleanMimeType.includes('jpeg') || cleanMimeType.includes('jpg')) {
    return parseJpegDimensions(buffer);
  }

  return parsePngDimensions(buffer) || parseJpegDimensions(buffer);
}

function imageAspectRatioLabel(dimensions) {
  if (!dimensions?.width || !dimensions?.height) {
    return '';
  }

  const ratio = dimensions.width / dimensions.height;
  if (ratio >= 1.8) {
    return '宽幅横向多设计单元/刀模版式';
  }
  if (ratio >= 1.25) {
    return '横向版式';
  }
  if (ratio <= 0.55) {
    return '竖向长版式';
  }
  if (ratio <= 0.8) {
    return '竖向版式';
  }
  return '接近方形版式';
}

function imageDimensionsText(dimensions) {
  if (!dimensions?.width || !dimensions?.height) {
    return '尺寸未知';
  }
  return `${dimensions.width}x${dimensions.height}，宽高比 ${(dimensions.width / dimensions.height).toFixed(2)}`;
}

function resolveOutputSizeForHistoryAspect(config, preparedImages = []) {
  if (!config.matchHistoryAspect) {
    return config.size;
  }

  const historyImage = preparedImages.find((image) => image.role === 'history');
  const width = historyImage?.dimensions?.width;
  const height = historyImage?.dimensions?.height;
  if (!width || !height) {
    return config.size;
  }

  const baseSize = parseSizeDimensions(config.size);
  if (!baseSize) {
    return config.size;
  }

  const longEdge = Math.max(baseSize.width, baseSize.height);
  const shortEdge = roundSizeDimension(longEdge / 2);
  const ratio = width / height;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return config.size;
  }

  if (ratio > 1.08) {
    return `${longEdge}x${shortEdge}`;
  }

  if (ratio < 0.92) {
    return `${shortEdge}x${longEdge}`;
  }

  return `${longEdge}x${longEdge}`;
}

async function imageUrlToBlob(image, config, fetchImpl) {
  let buffer;
  let mimeType = 'image/png';

  if (image.url.startsWith('data:')) {
    const parsed = dataUrlToBuffer(image.url);
    if (!parsed) {
      throw new Error(`Invalid data URL for ${image.label || image.id}.`);
    }
    buffer = parsed.buffer;
    mimeType = String(parsed.mimeType || '').startsWith('image/')
      ? parsed.mimeType
      : mimeFromBuffer(buffer) || mimeFromFilename(image.filename || image.url) || 'image/png';
  } else {
    const response = await fetchImpl(image.url);
    if (!response.ok) {
      throw new Error(`Unable to fetch input image ${image.label || image.id}.`);
    }
    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
    mimeType = resolveImageMimeType(
      response.headers?.get?.('content-type'),
      buffer,
      image.filename || image.url,
    );
  }

  if (buffer.byteLength > config.maxInputImageBytes) {
    throw new Error(`Input image ${image.label || image.id} is larger than the configured limit.`);
  }

  const filename = image.filename || `${image.id || 'input-image'}.${extensionFromMimeType(mimeType)}`;
  return {
    blob: new Blob([buffer], { type: mimeType }),
    filename,
    dimensions: imageDimensionsFromBuffer(buffer, mimeType),
  };
}

function buildImageRoleHardConstraintPrompt(preparedImages = [], historyLayoutLockPolicy = 'layout_lock') {
  if (preparedImages.length === 0) {
    return '';
  }

  const imageLines = preparedImages.map((image, index) => {
    const roleLabel = image.role === 'history'
      ? '历史设计图/构图母版'
      : image.role === 'material'
        ? '素材图/元素外观参考'
        : '参考输入图';
    const dimensionText = imageDimensionsText(image.dimensions);
    const aspectLabel = imageAspectRatioLabel(image.dimensions);
    return `${index + 1}. ${image.filename || image.label || image.id}：${roleLabel}，${dimensionText}${aspectLabel ? `，${aspectLabel}` : ''}。`;
  });

  const historyImage = preparedImages.find((image) => image.role === 'history');
  const lockPolicy = normalizeHistoryLayoutLockPolicy(historyLayoutLockPolicy);
  const hasMaterialImage = preparedImages.some((image) => image.role === 'material');
  const historyRatio = historyImage?.dimensions?.width && historyImage?.dimensions?.height
    ? historyImage.dimensions.width / historyImage.dimensions.height
    : null;
  const inputOrderRule = historyImage
    ? hasMaterialImage
      ? '严格输入顺序：图1/第一张输入图是历史设计图/构图母版；图2及以后是素材图/素材本体来源。图1只用于版式、刀模、设计单元、比例、占位、留白和密度；图2及以后必须优先保留其中可识别素材的元素造型、文字字形、线条、纹理、局部装饰和配色关系，只允许为适配历史版式做缩放、裁切、旋转、重排、层级组合和局部衔接。'
      : '严格输入顺序：图1/第一张输入图是历史设计图/构图母版，只用于版式、刀模、设计单元、比例、占位、留白和密度。'
    : hasMaterialImage
      ? '严格输入顺序：所有输入图都是素材图/素材本体来源，必须优先保留其中可识别素材的元素造型、文字字形、线条、纹理、局部装饰和配色关系。'
      : '';
  const wideHistoryRule = historyRatio && historyRatio >= 1.8
    ? '已识别第一张历史设计图为宽幅横向版式：后端会按第一张历史图所属的 2K 方/横/竖比例请求输出画布；最终图必须保持历史图在整张画布中的原始缩放比例、版式位置、白边/留白范围和横向多设计单元/多裁切区域/刀模稿整体结构；不要为了填满画布而放大、拉伸、裁切或移动历史版式，不要额外加黑边或把版式压缩成方形画面。'
    : historyImage
      ? '第一张历史设计图是唯一构图母版：后端会按第一张历史图所属的 2K 方/横/竖比例请求输出画布；最终图必须优先保持它的画布比例、设计单元数量、主体位置、版式在画布内的缩放比例、白边/留白范围、边框区域、图案密度和重复节奏；不要为了填满画布而放大、拉伸、裁切或移动历史版式，不要额外加黑边或新增历史图中没有的大面积空白。'
      : '';
  const historySlotLockRule = historyImage
    ? '版位硬锁定：先识别历史设计图中的每个闭合设计单元/刀模区域/圆形或方形或矩形版位，最终图只能在这些已有版位内部重绘图案；版位外的白底、单元间隙、尺寸线、尺寸文字、裁切标注区和外围背景不得新增图案、雪花、散点、边框、横向装饰带、贴纸阵列或独立素材。'
    : '';
  const historySlotCountRule = historyImage
    ? '单元数量硬锁定：最终输出必须保持历史设计图中设计单元的数量、相对大小、相对位置和外轮廓形状；如果历史图是两个圆形加一个方形/矩形版位，就仍然输出两个圆形加一个方形/矩形版位，不得增加中间大标题区、全宽横幅、上下花边或额外素材区。'
    : '';
  const historyContentBanRule = historyImage
    ? '历史内容禁用：第一张历史设计图中的旧文字、旧图案、旧主题、旧角色、旧场景、旧边框花纹、旧底纹、旧配色和任何可识别内容都禁止出现在最终设计里；第一张图只允许提供版式结构和版位关系。'
    : '';
  const historyLayoutLockRule = buildHistoryLayoutLockRule(lockPolicy, historyImage);
  const materialPlacementRule = historyImage && preparedImages.some((image) => image.role === 'material')
    ? '素材图硬边界：素材图是最终素材本体来源，不是只看风格的参考图。素材图中已经存在的主体、文字字形、辅助图形、边框、点缀、线条、纹理和配色关系应尽量保持不变；只能按历史图已有版位进行缩放、裁切、旋转、重排、层级组合和局部衔接。不要把素材图的完整素材板、产品组合、横向色带、整排小图标或整体构图搬到最终画布；也不要抛弃素材图重新画一套全新元素。只有用户提示词明确要求但素材图没有的元素才可以创新补充。'
    : '';
  const backgroundStrategyRule = preparedImages.length > 0
    ? '背景策略硬约束：AI 空版式母版或历史空白版位中的白底只表示版位空白和留白结构，不代表最终背景必须白色；素材图中的白底只表示抠图底或素材展示底，不作为最终背景参考。最终背景必须服从提示词里的开发思路和公司设计参考图背景策略；背景只能进入历史图已有版位内部，版位外白底、单元间隙、尺寸线、尺寸文字、裁切标注区和外围背景不得铺色或新增图案。'
    : '';
  const designQualityRule = historyImage && hasMaterialImage
    ? '设计质量要求：最终图应像设计师把素材图中的可用素材排入历史版式后完成的一套新品图案，保持系列感、主次层级、边框节奏、呼吸感和生产友好的细节密度；不要把每个版位做成同一个公式模板，也不要整张全新重画而忽略素材图。'
    : '';
  const detailStabilityRule = preparedImages.length > 0
    ? '细节稳定硬约束：Clean and polished image, controllable details, smooth and consistent textures, clear subject-background separation, no over-sharpening, no color blotches, no noise, no broken patterns, no artifacts, and no distortion.'
    : '';

  return [
    '输入图角色与构图硬约束：',
    ...imageLines,
    inputOrderRule,
    historyImage
      ? '历史设计图只负责最终产出的版式结构；素材图负责提供主要图案元素的素材本体，素材中已有元素要尽量保持外观不变；公司参考图文字只允许辅助配色、线条和局部风格。'
      : '',
    wideHistoryRule,
    historyContentBanRule,
    historyLayoutLockRule,
    historySlotLockRule,
    historySlotCountRule,
    materialPlacementRule,
    backgroundStrategyRule,
    designQualityRule,
    detailStabilityRule,
    historyImage
      ? '负向约束：不要生成单个圆形餐盘、单个中心徽章、单个产品摄影展示图、横向装饰海报或素材图产品组合展示，除非第一张历史设计图本身就是这种格式；不要让素材图或公司参考图的构图替代历史设计图。'
      : '',
  ].filter(Boolean).join('\n');
}

function buildImageEditPrompt(prompt, preparedImages = [], historyLayoutLockPolicy = 'layout_lock') {
  const constraintPrompt = buildImageRoleHardConstraintPrompt(preparedImages, historyLayoutLockPolicy);
  return [constraintPrompt, prompt].filter(Boolean).join('\n\n');
}

async function imageUrlToDataUrl(image, config, fetchImpl) {
  if (!config.embedInputImages || image.url.startsWith('data:')) {
    return image.url;
  }
  if (!/^https?:\/\//i.test(image.url)) {
    return image.url;
  }

  const response = await fetchImpl(image.url);
  if (!response.ok) {
    return image.url;
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > config.maxInputImageBytes) {
    return image.url;
  }

  const buffer = Buffer.from(arrayBuffer);
  const mimeType = resolveImageMimeType(
    response.headers?.get?.('content-type'),
    buffer,
    image.filename || image.url,
  );
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function buildChatContent(prompt, inputImages, config, fetchImpl, historyLayoutLockPolicy = 'layout_lock') {
  const imageParts = [];
  for (const image of sortInputImagesForGeneration(inputImages)) {
    const imageUrl = await imageUrlToDataUrl(image, config, fetchImpl);
    imageParts.push({
      type: 'image_url',
      image_url: {
        url: imageUrl,
      },
    });
  }

  const sortedInputImages = sortInputImagesForGeneration(inputImages);
  const historyImage = sortedInputImages.find((image) => image.role === 'history');
  const historyLayoutLockRule = buildHistoryLayoutLockRule(
    normalizeHistoryLayoutLockPolicy(historyLayoutLockPolicy),
    historyImage,
  );

  return [
    {
      type: 'text',
      text: [
        prompt,
        inputImages.length > 0
          ? '\n\n输入图角色硬约束：图1/第一张输入图是历史设计图/构图母版，优先保持它的画布比例、设计单元数量、主体位置、版式在画布内的缩放比例、白边/留白范围、边框区域、图案密度和重复节奏；不要为了填满输出画布而放大、拉伸、裁切或移动历史版式；禁止复用图1中的旧文字、旧图案、旧主题、旧角色、旧场景、旧边框花纹、旧底纹和旧配色；图2及以后是素材图/素材本体来源，素材中已有的元素造型、文字字形、线条、纹理、局部装饰、边框语言和配色关系要尽量保持不变，只允许为适配历史版位做缩放、裁切、旋转、重排、层级组合和局部衔接；只有素材图没有但提示词明确要求的元素才允许新创；素材图和 AI 空版式母版中的白底只代表抠图底、素材展示底或版位留白，不代表最终背景必须白色；最终背景必须服从开发思路和公司设计参考图背景策略，且只能进入历史图已有版位内部；细节稳定硬约束：Clean and polished image, controllable details, smooth and consistent textures, clear subject-background separation, no over-sharpening, no color blotches, no noise, no broken patterns, no artifacts, and no distortion.；版位外的白底、单元间隙、尺寸线、尺寸文字和外围背景不得新增图案、横向花边、贴纸阵列或素材色带；不要把历史版式改造成单个圆形餐盘、单个产品效果图或横向装饰海报，不要整张全新重画而忽略素材图。'
          : '',
        historyLayoutLockRule ? `\n\n${historyLayoutLockRule}` : '',
      ].join(''),
    },
    ...imageParts,
  ];
}

async function buildImageGenerationRequestBody(
  prompt,
  inputImages,
  config,
  fetchImpl,
  options = {},
) {
  const shared = {
    model: config.model,
    size: config.size,
    quality: config.quality,
    style: config.style,
    n: config.n,
  };

  if (config.requestMode === 'images') {
    return {
      ...shared,
      prompt,
      response_format: config.responseFormat,
    };
  }

  return {
    ...shared,
    messages: [
      {
        role: 'user',
        content: await buildChatContent(
          prompt,
          inputImages,
          config,
          fetchImpl,
          options.historyLayoutLockPolicy,
        ),
      },
    ],
    stream: false,
  };
}

async function buildImageEditFormData(prompt, inputImages, config, fetchImpl, options = {}) {
  const preparedImages = [];
  for (const image of sortInputImagesForGeneration(inputImages)) {
    const { blob, filename, dimensions } = await imageUrlToBlob(image, config, fetchImpl);
    preparedImages.push({
      ...image,
      blob,
      filename,
      dimensions,
    });
  }

  const formData = new FormData();
  const outputSize = resolveOutputSizeForHistoryAspect(config, preparedImages);
  formData.append('model', config.model);
  formData.append('prompt', buildImageEditPrompt(
    prompt,
    preparedImages,
    options.historyLayoutLockPolicy,
  ));
  formData.append('size', outputSize);
  formData.append('quality', config.quality);
  formData.append('style', config.style);
  formData.append('n', String(config.n));
  formData.append('response_format', config.responseFormat);

  for (const image of preparedImages) {
    formData.append(config.imageFieldName, image.blob, image.filename);
  }

  return formData;
}

async function buildImageGenerationFetchPayload(prompt, inputImages, config, fetchImpl, options = {}) {
  if (config.requestMode === 'edits') {
    return {
      body: await buildImageEditFormData(prompt, inputImages, config, fetchImpl, options),
      headers: {},
    };
  }

  return {
    body: JSON.stringify(await buildImageGenerationRequestBody(
      prompt,
      inputImages,
      config,
      fetchImpl,
      options,
    )),
    headers: {
      'Content-Type': 'application/json',
    },
  };
}

function safePreview(value, maxLength = 800) {
  return String(value || '').slice(0, maxLength);
}

function collectUrlMatches(text) {
  return [...String(text || '').matchAll(/https?:\/\/[^\s)\]"']+/g)].map((match) => ({
    url: match[0],
  }));
}

function normalizeImageItem(item = {}) {
  if (typeof item === 'string') {
    return item.startsWith('http') || item.startsWith('data:image') ? { url: item } : null;
  }
  if (item.url) {
    return {
      url: cleanString(item.url),
      revised_prompt: cleanString(item.revised_prompt || item.prompt),
    };
  }
  if (item.b64_json || item.base64) {
    return {
      b64_json: cleanString(item.b64_json || item.base64),
      mime_type: cleanString(item.mime_type) || 'image/png',
      revised_prompt: cleanString(item.revised_prompt || item.prompt),
    };
  }
  if (item.image_url?.url) {
    return {
      url: cleanString(item.image_url.url),
    };
  }
  return null;
}

function collectImagesFromContent(content) {
  if (!content) {
    return [];
  }
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      return collectGeneratedImages(parsed);
    } catch (_error) {
      return collectUrlMatches(content);
    }
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => normalizeImageItem(part) || normalizeImageItem(part?.image))
      .filter(Boolean);
  }
  return collectGeneratedImages(content);
}

function collectGeneratedImages(payload = {}) {
  const directImages = [
    ...(Array.isArray(payload.data) ? payload.data : []),
    ...(Array.isArray(payload.images) ? payload.images : []),
    ...(Array.isArray(payload.output) ? payload.output : []),
  ]
    .map((item) => normalizeImageItem(item))
    .filter(Boolean);

  const choiceImages = (payload.choices || []).flatMap((choice) => (
    collectImagesFromContent(choice?.message?.content || choice?.delta?.content)
  ));

  return [...directImages, ...choiceImages].filter((image) => image.url || image.b64_json);
}

async function generatePatternImage(request = {}, options = {}) {
  const env = options.env || process.env;
  const config = applyRequestOverrides(getAiImageGeneratorConfig(env), request);
  const prompt = cleanString(request.prompt);
  const inputImages = normalizeInputImages(request.input_images || request.inputImages);
  const historyLayoutLockPolicy = normalizeHistoryLayoutLockPolicy(
    request.history_layout_lock_policy || request.historyLayoutLockPolicy,
  );
  const baseExtra = {
    input_image_count: inputImages.length,
  };

  if (!prompt) {
    return buildEmptyImageGenerationResult(
      'missing_prompt',
      config,
      safeError('missing_prompt', 'input', 'Image generation prompt is required.'),
      baseExtra,
    );
  }

  if (!config.enabled) {
    return buildEmptyImageGenerationResult('disabled', config, null, baseExtra);
  }

  if (!config.baseUrl || !config.apiKey) {
    return buildEmptyImageGenerationResult(
      'missing_config',
      config,
      safeError('missing_config', 'config', 'AI image generator is not configured.'),
      baseExtra,
    );
  }

  if (config.requestMode === 'edits' && inputImages.length === 0) {
    return buildEmptyImageGenerationResult(
      'missing_input_images',
      config,
      safeError('missing_input_images', 'input', 'Image edit generation requires at least one input image.'),
      baseExtra,
    );
  }

  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    return buildEmptyImageGenerationResult(
      'error',
      config,
      safeError('missing_fetch', 'request', 'No fetch implementation is available.'),
      baseExtra,
    );
  }

  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/${config.endpointPath.replace(/^\/+/, '')}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();

  try {
    const fetchPayload = await buildImageGenerationFetchPayload(prompt, inputImages, config, fetchImpl, {
      historyLayoutLockPolicy,
    });
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...fetchPayload.headers,
      },
      body: fetchPayload.body,
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    const contentType = response.headers?.get?.('content-type') || '';
    const responseText = await response.text();

    if (!response.ok) {
      return buildEmptyImageGenerationResult(
        'error',
        config,
        safeError('http_error', 'response', `AI image generation failed with HTTP ${response.status}.`, {
          http_status: response.status,
          content_type: contentType,
          response_preview: safePreview(responseText),
          duration_ms: durationMs,
          timeout_ms: config.timeoutMs,
        }),
        baseExtra,
      );
    }

    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch (_error) {
      return buildEmptyImageGenerationResult(
        'error',
        config,
        safeError('json_parse_error', 'response_parse', 'AI image generation response was not valid JSON.', {
          content_type: contentType,
          response_preview: safePreview(responseText),
          duration_ms: durationMs,
        }),
        baseExtra,
      );
    }

    const images = collectGeneratedImages(payload).slice(0, config.n);
    if (images.length === 0) {
      return buildEmptyImageGenerationResult(
        'no_images',
        config,
        safeError('no_images', 'response_parse', 'AI image generation response did not include an image URL or base64 image.', {
          response_preview: safePreview(responseText),
          duration_ms: durationMs,
        }),
        baseExtra,
      );
    }

    return {
      ...buildEmptyImageGenerationResult('success', config, null, baseExtra),
      images,
      ai_error: null,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const isTimeout = error?.name === 'AbortError';
    return buildEmptyImageGenerationResult(
      'error',
      config,
      safeError(
        isTimeout ? 'timeout' : 'request_failed',
        isTimeout ? 'timeout' : 'request',
        isTimeout ? 'AI image generation timed out.' : 'AI image generation failed.',
        {
          duration_ms: durationMs,
          timeout_ms: config.timeoutMs,
        },
      ),
      baseExtra,
    );
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  buildImageEditFormData,
  buildImageGenerationRequestBody,
  buildImageGenerationFetchPayload,
  collectGeneratedImages,
  generatePatternImage,
  getAiImageGeneratorConfig,
  imageDimensionsFromBuffer,
};
