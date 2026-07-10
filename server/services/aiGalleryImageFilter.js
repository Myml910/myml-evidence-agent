const { getAiElementMapperConfig } = require('./aiElementMapper');

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_ENDPOINT_PATH = '/chat/completions';
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_TOKENS = 1400;
const DEFAULT_MAX_IMAGES = 12;
const DEFAULT_MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MIN_SCORE = 0.62;
const SOURCE = 'ai_gallery_image_filter';
const BASIS = 'graphic_element_requirement';

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isEnabledValue(value) {
  if (value === undefined || value === null || value === '') {
    return true;
  }
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function clampScore(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, parsed));
}

function splitTerms(value) {
  return String(value || '')
    .split(/[\n\r,;，；、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getAiGalleryImageFilterConfig(env = process.env) {
  const fallback = getAiElementMapperConfig(env);
  return {
    enabled: isEnabledValue(
      env.AI_GALLERY_IMAGE_FILTER_ENABLED === undefined
        ? env.AI_ELEMENT_MAPPER_ENABLED || env.AI_TERM_MATCHER_ENABLED
        : env.AI_GALLERY_IMAGE_FILTER_ENABLED,
    ),
    baseUrl: cleanString(env.AI_GALLERY_IMAGE_FILTER_BASE_URL) || fallback.baseUrl,
    endpointPath:
      cleanString(env.AI_GALLERY_IMAGE_FILTER_ENDPOINT_PATH) ||
      fallback.endpointPath ||
      DEFAULT_ENDPOINT_PATH,
    apiKey: cleanString(env.AI_GALLERY_IMAGE_FILTER_API_KEY) || fallback.apiKey,
    model: cleanString(env.AI_GALLERY_IMAGE_FILTER_MODEL) || fallback.model || DEFAULT_MODEL,
    timeoutMs: parseInteger(
      env.AI_GALLERY_IMAGE_FILTER_TIMEOUT_MS,
      fallback.timeoutMs || DEFAULT_TIMEOUT_MS,
    ),
    maxTokens: parseInteger(
      env.AI_GALLERY_IMAGE_FILTER_MAX_TOKENS,
      Math.min(fallback.maxTokens || DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    ),
    maxImages: parseInteger(env.AI_GALLERY_IMAGE_FILTER_MAX_IMAGES, DEFAULT_MAX_IMAGES),
    maxInputImageBytes: parseInteger(
      env.AI_GALLERY_IMAGE_FILTER_MAX_INPUT_IMAGE_BYTES,
      DEFAULT_MAX_INPUT_IMAGE_BYTES,
    ),
    minScore: Math.min(
      1,
      parseNumber(env.AI_GALLERY_IMAGE_FILTER_MIN_SCORE, DEFAULT_MIN_SCORE),
    ),
    responseFormat:
      cleanString(env.AI_GALLERY_IMAGE_FILTER_RESPONSE_FORMAT) ||
      fallback.responseFormat ||
      'json_object',
  };
}

function buildEmptyGalleryImageSelection(status, config = {}, error = null, extra = {}) {
  return {
    status,
    source: SOURCE,
    basis: BASIS,
    model: config.model || DEFAULT_MODEL,
    required_graphic_elements: extra.required_graphic_elements || [],
    candidate_image_count: extra.candidate_image_count || 0,
    selected_image_count: 0,
    selected_images: [],
    rejected_image_count: extra.rejected_image_count || 0,
    min_score: config.minScore ?? DEFAULT_MIN_SCORE,
    ai_error: error,
  };
}

function safeError(type, stage, message, extra = {}) {
  return {
    type,
    stage,
    message,
    ...extra,
  };
}

function collectRequiredGraphicElements(proposal = {}, aiMapping = {}) {
  const primaryTerms = Array.isArray(aiMapping.primary_element_terms)
    ? aiMapping.primary_element_terms.map((item) => item.term)
    : [];

  return unique([
    ...splitTerms(proposal.ai_graphic_elements || proposal.element_requirement),
    ...splitTerms(proposal.real_graphic_elements),
    ...primaryTerms,
  ]).slice(0, 12);
}

function imageSortScore(candidate) {
  return (
    (candidate.is_top_intersection ? 10000 : 0) +
    (candidate.intersection_count || 0) * 100 +
    candidate.connected_terms.length * 20
  );
}

function addCandidateImage(candidateMap, image, match) {
  if (!image || !image.image_id) {
    return;
  }

  const existing = candidateMap.get(image.image_id) || {
    image_id: image.image_id,
    url: cleanString(image.url),
    filename: cleanString(image.filename),
    category_label: cleanString(image.category_label),
    usage_scope: cleanString(image.usage_scope),
    found_local: image.found_local === true,
    term_type: cleanString(image.term_type),
    intersection_count: Number(image.intersection_count) || 0,
    is_top_intersection: image.is_top_intersection === true,
    connected_terms: [],
  };

  if (image.intersection_count > existing.intersection_count) {
    existing.intersection_count = image.intersection_count;
  }
  existing.is_top_intersection = existing.is_top_intersection || image.is_top_intersection === true;

  const term = cleanString(match?.normalized_term || match?.raw_term);
  if (term && !existing.connected_terms.some((item) => item.term === term && item.role === match.role)) {
    existing.connected_terms.push({
      term,
      raw_term: cleanString(match.raw_term || term),
      role: cleanString(match.role),
      role_label: cleanString(match.role_label),
    });
  }

  candidateMap.set(image.image_id, existing);
}

function collectGalleryImageCandidates(elementGallery = {}, maxImages = DEFAULT_MAX_IMAGES) {
  const candidateMap = new Map();
  const matchGroups = [
    ...(elementGallery.primary_element_gallery_matches || []),
    ...(elementGallery.scene_element_gallery_matches || []),
    ...(elementGallery.style_element_gallery_matches || []),
    ...(elementGallery.attribute_element_gallery_matches || []),
    ...(elementGallery.other_element_gallery_matches || []),
  ];

  for (const match of matchGroups) {
    for (const image of match.candidate_images || []) {
      addCandidateImage(candidateMap, image, match);
    }
  }

  return [...candidateMap.values()]
    .filter((image) => image.url)
    .sort((left, right) => {
      const scoreDelta = imageSortScore(right) - imageSortScore(left);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.filename.localeCompare(right.filename, 'en');
    })
    .slice(0, maxImages)
    .map((image, index) => ({
      ...image,
      image_index: index + 1,
    }));
}

function buildSystemPrompt() {
  return [
    'You are the MYML gallery image suitability filter.',
    'Select candidate gallery images that visually match the required graphic elements for the development proposal.',
    'Use the provided images as visual evidence. Metadata and connected terms are supporting evidence only.',
    'Select an image only when it clearly contains, illustrates, or can directly support the required graphic motif/pattern.',
    'Reject images that match only product category, occasion, carrier, text, color, or vague style without the required motif.',
    'Return JSON only.',
  ].join('\n');
}

function compactProposal(proposal = {}) {
  return {
    project_name: cleanString(proposal.project_name),
    category_label: cleanString(proposal.category_label || proposal.category),
    design_requirement: cleanString(proposal.design_requirement).slice(0, 600),
    ai_graphic_elements: cleanString(proposal.ai_graphic_elements || proposal.element_requirement),
    real_graphic_elements: cleanString(proposal.real_graphic_elements),
    text_elements: cleanString(proposal.text_elements).slice(0, 240),
    color_requirement: cleanString(proposal.color_requirement),
    style_requirement: cleanString(proposal.style_requirement),
  };
}

function buildUserPayload(proposal, requiredGraphicElements, candidates, config) {
  return {
    proposal: compactProposal(proposal),
    required_graphic_elements: requiredGraphicElements,
    min_match_score: config.minScore,
    candidate_images: candidates.map((image) => ({
      image_index: image.image_index,
      image_id: image.image_id,
      filename: image.filename,
      category_label: image.category_label,
      connected_terms: image.connected_terms.map((term) => ({
        term: term.term,
        role: term.role,
      })),
      intersection_count: image.intersection_count,
      is_top_intersection: image.is_top_intersection,
    })),
    output_schema: {
      selected_images: [
        {
          image_index: 1,
          match_score: 0.0,
          matched_graphic_elements: ['required element this image satisfies'],
          reason: 'short visual reason',
          concerns: 'optional limitation',
        },
      ],
    },
  };
}

function buildMessages(config, proposal, requiredGraphicElements, candidates) {
  const text = JSON.stringify(buildUserPayload(proposal, requiredGraphicElements, candidates, config));
  return [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: [
        { type: 'text', text },
        ...candidates.map((image) => ({
          type: 'image_url',
          image_url: {
            url: image.model_url || image.url,
          },
        })),
      ],
    },
  ];
}

function buildGalleryImageFilterRequestBody(config, proposal, requiredGraphicElements, candidates) {
  const body = {
    model: config.model,
    messages: buildMessages(config, proposal, requiredGraphicElements, candidates),
    stream: false,
    max_tokens: config.maxTokens,
  };

  if (config.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  return body;
}

function safePreview(value, maxLength = 800) {
  return String(value || '').slice(0, maxLength);
}

function dataUrlToBuffer(value) {
  const match = cleanString(value).match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1] || 'image/png',
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function mimeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return '';
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif';
  }
  if (
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return '';
}

function mimeFromFilename(value) {
  const clean = cleanString(value).toLowerCase().split(/[?#]/)[0];
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (clean.endsWith('.png')) {
    return 'image/png';
  }
  if (clean.endsWith('.webp')) {
    return 'image/webp';
  }
  if (clean.endsWith('.gif')) {
    return 'image/gif';
  }
  return '';
}

function normalizeImageMime(contentType, filenameOrUrl, buffer) {
  const headerMime = cleanString(contentType).split(';')[0].toLowerCase();
  if (headerMime.startsWith('image/')) {
    return headerMime;
  }
  return mimeFromBuffer(buffer) || mimeFromFilename(filenameOrUrl);
}

async function imageUrlToDataUrl(image, config, fetchImpl) {
  if (cleanString(image.url).startsWith('data:')) {
    const parsed = dataUrlToBuffer(image.url);
    if (!parsed || parsed.buffer.length === 0) {
      throw new Error(`Invalid data URL for ${image.filename || image.image_id}.`);
    }
    if (parsed.buffer.length > config.maxInputImageBytes) {
      throw new Error(`Input image ${image.filename || image.image_id} is larger than the configured limit.`);
    }
    const mimeType = parsed.mimeType.startsWith('image/')
      ? parsed.mimeType
      : mimeFromBuffer(parsed.buffer) || mimeFromFilename(image.filename || image.url) || 'image/png';
    return `data:${mimeType};base64,${parsed.buffer.toString('base64')}`;
  }

  const response = await fetchImpl(image.url);
  if (!response.ok) {
    throw new Error(`Unable to fetch candidate image ${image.filename || image.image_id}: HTTP ${response.status}.`);
  }

  const contentType = response.headers?.get?.('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error(`Candidate image ${image.filename || image.image_id} is empty.`);
  }
  if (buffer.length > config.maxInputImageBytes) {
    throw new Error(`Candidate image ${image.filename || image.image_id} is larger than the configured limit.`);
  }

  const mimeType = normalizeImageMime(contentType, image.filename || image.url, buffer);
  if (!mimeType || !mimeType.startsWith('image/')) {
    throw new Error(`Candidate image ${image.filename || image.image_id} returned non-image content-type: ${contentType || 'unknown'}.`);
  }

  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function prepareCandidateImagesForModel(candidates, config, fetchImpl) {
  const prepared = [];
  const skipped = [];

  for (const candidate of candidates) {
    try {
      prepared.push({
        ...candidate,
        model_url: await imageUrlToDataUrl(candidate, config, fetchImpl),
      });
    } catch (error) {
      skipped.push({
        image_id: candidate.image_id,
        filename: candidate.filename,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    candidates: prepared,
    skipped,
  };
}

function resolveCandidateFromAiItem(item, byId, byIndex) {
  const imageId = cleanString(item?.image_id);
  if (imageId && byId.has(imageId)) {
    return byId.get(imageId);
  }

  const imageIndex = Number(item?.image_index || item?.index);
  if (Number.isInteger(imageIndex) && byIndex.has(imageIndex)) {
    return byIndex.get(imageIndex);
  }

  return null;
}

function validateGalleryImageFilterPayload(payload, candidates, config) {
  const byId = new Map(candidates.map((image) => [image.image_id, image]));
  const byIndex = new Map(candidates.map((image) => [image.image_index, image]));
  const selected = [];
  const seen = new Set();

  for (const item of payload?.selected_images || payload?.images || []) {
    const candidate = resolveCandidateFromAiItem(item, byId, byIndex);
    if (!candidate || seen.has(candidate.image_id)) {
      continue;
    }

    const matchScore = clampScore(item.match_score ?? item.score ?? item.confidence, 0);
    if (matchScore < config.minScore) {
      continue;
    }

    seen.add(candidate.image_id);
    const { model_url: _modelUrl, ...publicCandidate } = candidate;
    selected.push({
      ...publicCandidate,
      match_score: matchScore,
      matched_graphic_elements: Array.isArray(item.matched_graphic_elements)
        ? item.matched_graphic_elements.map(String).filter(Boolean).slice(0, 8)
        : [],
      reason: cleanString(item.reason).slice(0, 360),
      concerns: cleanString(item.concerns).slice(0, 240),
    });
  }

  return selected.sort((left, right) => {
    if (right.match_score !== left.match_score) {
      return right.match_score - left.match_score;
    }
    return imageSortScore(right) - imageSortScore(left);
  });
}

async function filterGalleryImagesForGraphicElements(proposal = {}, aiMapping = {}, elementGallery = {}, options = {}) {
  const env = options.env || process.env;
  const config = getAiGalleryImageFilterConfig(env);
  const requiredGraphicElements = collectRequiredGraphicElements(proposal, aiMapping);
  const candidates = collectGalleryImageCandidates(elementGallery, config.maxImages);
  const baseExtra = {
    required_graphic_elements: requiredGraphicElements,
    candidate_image_count: candidates.length,
  };

  if (requiredGraphicElements.length === 0) {
    return buildEmptyGalleryImageSelection(
      'no_graphic_elements',
      config,
      safeError('no_graphic_elements', 'input', 'No graphic elements were available for image filtering.'),
      baseExtra,
    );
  }

  if (candidates.length === 0) {
    return buildEmptyGalleryImageSelection('no_candidates', config, null, baseExtra);
  }

  if (!config.enabled) {
    return buildEmptyGalleryImageSelection('disabled', config, null, baseExtra);
  }

  if (!config.baseUrl || !config.apiKey) {
    return buildEmptyGalleryImageSelection(
      'missing_config',
      config,
      safeError('missing_config', 'config', 'AI gallery image filter is not configured.', {
        timeout_ms: config.timeoutMs,
      }),
      baseExtra,
    );
  }

  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    return buildEmptyGalleryImageSelection(
      'error',
      config,
      safeError('missing_fetch', 'request', 'No fetch implementation is available.', {
        timeout_ms: config.timeoutMs,
      }),
      baseExtra,
    );
  }

  const preparedImages = await prepareCandidateImagesForModel(candidates, config, fetchImpl);
  if (preparedImages.candidates.length === 0) {
    return buildEmptyGalleryImageSelection(
      'error',
      config,
      safeError(
        'no_valid_candidate_images',
        'image_fetch',
        'No candidate gallery images could be fetched as valid images before AI filtering.',
        {
          skipped_images: preparedImages.skipped.slice(0, 8),
        },
      ),
      baseExtra,
    );
  }

  const requestBody = buildGalleryImageFilterRequestBody(
    config,
    proposal,
    requiredGraphicElements,
    preparedImages.candidates,
  );
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/${config.endpointPath.replace(/^\/+/, '')}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();

  try {
    let response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    let contentType = response.headers?.get?.('content-type') || '';
    let responseText = await response.text();

    if (!response.ok && response.status === 400 && requestBody.response_format) {
      const retryRequestBody = { ...requestBody };
      delete retryRequestBody.response_format;
      const retryResponse = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(retryRequestBody),
        signal: controller.signal,
      });
      const retryContentType = retryResponse.headers?.get?.('content-type') || '';
      const retryResponseText = await retryResponse.text();
      if (retryResponse.ok) {
        response = retryResponse;
        contentType = retryContentType;
        responseText = retryResponseText;
      } else {
        responseText = `${responseText}\n\nRetry without response_format:\n${retryResponseText}`;
      }
    }

    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      return buildEmptyGalleryImageSelection(
        'error',
        config,
        safeError('http_error', 'response', `AI gallery image filter failed with HTTP ${response.status}.`, {
          http_status: response.status,
          content_type: contentType,
          response_preview: safePreview(responseText),
          duration_ms: durationMs,
          timeout_ms: config.timeoutMs,
        }),
        baseExtra,
      );
    }

    let envelope;
    try {
      envelope = JSON.parse(responseText);
    } catch (_error) {
      return buildEmptyGalleryImageSelection(
        'error',
        config,
        safeError('json_parse_error', 'response_parse', 'AI gallery image filter response was not valid JSON.', {
          http_status: response.status,
          content_type: contentType,
          response_preview: safePreview(responseText),
          duration_ms: durationMs,
        }),
        baseExtra,
      );
    }

    const content = envelope.choices?.[0]?.message?.content;
    if (!content) {
      return buildEmptyGalleryImageSelection(
        'error',
        config,
        safeError('empty_ai_result', 'message_content', 'AI gallery image filter response did not include message content.', {
          http_status: response.status,
          content_type: contentType,
          response_preview: safePreview(responseText),
          duration_ms: durationMs,
        }),
        baseExtra,
      );
    }

    let payload;
    try {
      payload = typeof content === 'string' ? JSON.parse(content) : content;
    } catch (_error) {
      return buildEmptyGalleryImageSelection(
        'error',
        config,
        safeError('json_parse_error', 'content_parse', 'AI gallery image filter content was not valid JSON.', {
          http_status: response.status,
          content_type: contentType,
          response_preview: safePreview(content),
          duration_ms: durationMs,
        }),
        baseExtra,
      );
    }

    const selectedImages = validateGalleryImageFilterPayload(payload, preparedImages.candidates, config);
    return {
      ...buildEmptyGalleryImageSelection('success', config, null, baseExtra),
      selected_image_count: selectedImages.length,
      selected_images: selectedImages,
      rejected_image_count: Math.max(0, candidates.length - selectedImages.length),
      skipped_candidate_image_count: preparedImages.skipped.length,
      ai_error: null,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const isTimeout = error?.name === 'AbortError';
    return buildEmptyGalleryImageSelection(
      'error',
      config,
      safeError(
        isTimeout ? 'timeout' : 'request_failed',
        isTimeout ? 'timeout' : 'request',
        isTimeout ? 'AI gallery image filter request timed out.' : 'AI gallery image filter request failed.',
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
  BASIS,
  SOURCE,
  buildEmptyGalleryImageSelection,
  buildGalleryImageFilterRequestBody,
  collectGalleryImageCandidates,
  collectRequiredGraphicElements,
  filterGalleryImagesForGraphicElements,
  getAiGalleryImageFilterConfig,
  prepareCandidateImagesForModel,
  validateGalleryImageFilterPayload,
};
