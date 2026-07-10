const { getAiElementMapperConfig } = require('./aiElementMapper');
const { collectRequiredGraphicElements } = require('./aiGalleryImageFilter');

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_ENDPOINT_PATH = '/chat/completions';
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_MIN_MATCH_SCORE = 0.72;
const SOURCE = 'ai_company_reference_design_analysis';
const BASIS = 'company_reference_images_and_graphic_elements';

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

function getAiReferenceDesignAnalyzerConfig(env = process.env) {
  const fallback = getAiElementMapperConfig(env);
  return {
    enabled: isEnabledValue(
      env.AI_REFERENCE_DESIGN_ANALYZER_ENABLED === undefined
        ? env.AI_ELEMENT_MAPPER_ENABLED || env.AI_TERM_MATCHER_ENABLED
        : env.AI_REFERENCE_DESIGN_ANALYZER_ENABLED,
    ),
    baseUrl: cleanString(env.AI_REFERENCE_DESIGN_ANALYZER_BASE_URL) || fallback.baseUrl,
    endpointPath:
      cleanString(env.AI_REFERENCE_DESIGN_ANALYZER_ENDPOINT_PATH) ||
      fallback.endpointPath ||
      DEFAULT_ENDPOINT_PATH,
    apiKey: cleanString(env.AI_REFERENCE_DESIGN_ANALYZER_API_KEY) || fallback.apiKey,
    model: cleanString(env.AI_REFERENCE_DESIGN_ANALYZER_MODEL) || fallback.model || DEFAULT_MODEL,
    timeoutMs: parseInteger(
      env.AI_REFERENCE_DESIGN_ANALYZER_TIMEOUT_MS,
      fallback.timeoutMs || DEFAULT_TIMEOUT_MS,
    ),
    maxTokens: parseInteger(
      env.AI_REFERENCE_DESIGN_ANALYZER_MAX_TOKENS,
      Math.min(fallback.maxTokens || DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    ),
    maxImages: parseInteger(env.AI_REFERENCE_DESIGN_ANALYZER_MAX_IMAGES, DEFAULT_MAX_IMAGES),
    minMatchScore: Math.min(
      1,
      parseNumber(env.AI_REFERENCE_DESIGN_ANALYZER_MIN_MATCH_SCORE, DEFAULT_MIN_MATCH_SCORE),
    ),
    responseFormat:
      cleanString(env.AI_REFERENCE_DESIGN_ANALYZER_RESPONSE_FORMAT) ||
      fallback.responseFormat ||
      'json_object',
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

function buildEmptyReferenceDesignAnalysis(status, config = {}, error = null, extra = {}) {
  return {
    status,
    source: SOURCE,
    basis: BASIS,
    model: config.model || DEFAULT_MODEL,
    triggered_by_no_qualified_gallery_images: extra.triggered_by_no_qualified_gallery_images === true,
    required_graphic_elements: extra.required_graphic_elements || [],
    reference_image_count: extra.reference_image_count || 0,
    matched_reference_count: 0,
    matched_references: [],
    design_reference_summary: '',
    prompt_notes: [],
    min_match_score: config.minMatchScore ?? DEFAULT_MIN_MATCH_SCORE,
    ai_error: error,
  };
}

function collectReferenceImageCandidates(proposal = {}, maxImages = DEFAULT_MAX_IMAGES) {
  return (proposal.reference_images || [])
    .filter((image) => image?.url)
    .filter((image) => cleanString(image.source_field) === 'design_img')
    .slice(0, maxImages)
    .map((image, index) => ({
      reference_index: index + 1,
      source_field: cleanString(image.source_field),
      label: cleanString(image.label),
      filename: cleanString(image.filename || image.raw_path),
      url: cleanString(image.url),
    }));
}

function hasQualifiedGalleryImage(selectedGalleryImages = {}, minScore = 0.8) {
  return (selectedGalleryImages.selected_images || []).some(
    (image) => Number(image.match_score) >= minScore,
  );
}

function hasDesignReferenceOrBackgroundDirective(proposal = {}) {
  const text = cleanString(proposal.design_requirement);
  return /(?:参考\s*(?:图|图片)|背景|底色|底纹|色系|渐变|紫色|蓝色|粉色|红色|绿色|黑色|白色|黄色|橙色|金色|银色)/i.test(text);
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

function buildSystemPrompt() {
  return [
    'You are the MYML company reference image design analyst.',
    'This step runs when no high-confidence gallery material image can be used, or when the development requirement explicitly names design reference images, background, base color, or color style.',
    'Judge whether company reference images visually match the required graphic elements.',
    'If a reference image matches, extract only text-based design guidance that can help a new pattern design.',
    'The required_graphic_elements are the only allowed core motif requirements for the downstream design.',
    'Company reference images may contribute palette, background treatment, composition, hierarchy, line style, texture, spacing, and production-friendly arrangement only.',
    'Do not add, recommend, or strengthen any reference-image object, character, animal, creature, logo, text, or theme that is not listed in required_graphic_elements.',
    'Do not instruct the downstream model to use, copy, upload, include, or reference the original image as an input image.',
    'Do not return image URLs, raw paths, base64, binary data, or instructions that recreate the exact original image.',
    'Return JSON only.',
  ].join('\n');
}

function buildUserPayload(proposal, requiredGraphicElements, candidates, config) {
  return {
    proposal: compactProposal(proposal),
    required_graphic_elements: requiredGraphicElements,
    min_match_score: config.minMatchScore,
    strict_usage_rules: [
      'Only required_graphic_elements can become new core motifs.',
      'Use matching company reference images as text-only guidance for color, background treatment, composition, visual hierarchy, line/texture style, spacing, and production layout.',
      'For background_treatment, describe the usable base color, gradient, subtle texture, small background accents, light effects, edge background pattern, density, and atmosphere as text. Do not describe product photography or carrier surfaces.',
      'If the reference image contains attractive motifs that are not in required_graphic_elements, omit those motifs from design_reference_summary, prompt_notes, and design_information.',
      'Never tell the downstream image model to add a motif/theme/object from the reference image unless it is also in required_graphic_elements.',
      'Never use the original company reference image as an image-to-image input.',
    ],
    company_reference_images: candidates.map((image) => ({
      reference_index: image.reference_index,
      source_field: image.source_field,
      label: image.label,
      filename: image.filename,
    })),
    output_schema: {
      matched_references: [
        {
          reference_index: 1,
          is_match: true,
          match_score: 0.0,
          matched_graphic_elements: ['required graphic element visible in this image'],
          design_information: {
            motif_treatment: 'text-only motif or illustration treatment to borrow',
            composition: 'text-only composition/layout information',
            color_palette: 'text-only palette relationship, not exact original image',
            background_treatment: 'text-only background/base color/gradient/texture/accent treatment to apply inside pattern slots',
            style_texture: 'text-only style, line, texture, or finish guidance',
            usable_details: ['short text-only detail useful for new design'],
          },
          reason: 'short visual reason',
        },
      ],
      design_reference_summary: 'combined text-only design reference for prompt',
      prompt_notes: ['short text-only notes to append to image generation prompt'],
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
            url: image.url,
          },
        })),
      ],
    },
  ];
}

function buildReferenceDesignAnalysisRequestBody(config, proposal, requiredGraphicElements, candidates) {
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

function resolveReferenceFromAiItem(item, byIndex) {
  const referenceIndex = Number(item?.reference_index || item?.image_index || item?.index);
  if (Number.isInteger(referenceIndex) && byIndex.has(referenceIndex)) {
    return byIndex.get(referenceIndex);
  }
  return null;
}

function cleanTextList(values, maxItems = 6, maxLength = 180) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((value) => cleanString(String(value)).slice(0, maxLength)).filter(Boolean).slice(0, maxItems);
}

function normalizeDesignInformation(value = {}) {
  return {
    motif_treatment: cleanString(value.motif_treatment).slice(0, 260),
    composition: cleanString(value.composition).slice(0, 260),
    color_palette: cleanString(value.color_palette).slice(0, 260),
    background_treatment: cleanString(value.background_treatment || value.backgroundTreatment).slice(0, 320),
    style_texture: cleanString(value.style_texture).slice(0, 260),
    usable_details: cleanTextList(value.usable_details, 8, 180),
  };
}

function validateReferenceDesignPayload(payload, candidates, config) {
  const byIndex = new Map(candidates.map((image) => [image.reference_index, image]));
  const seen = new Set();
  const matchedReferences = [];

  for (const item of payload?.matched_references || payload?.references || []) {
    const reference = resolveReferenceFromAiItem(item, byIndex);
    if (!reference || seen.has(reference.reference_index)) {
      continue;
    }

    const matchScore = clampScore(item.match_score ?? item.score ?? item.confidence, 0);
    const isMatch = item.is_match === undefined ? matchScore >= config.minMatchScore : item.is_match === true;
    if (!isMatch || matchScore < config.minMatchScore) {
      continue;
    }

    seen.add(reference.reference_index);
    matchedReferences.push({
      reference_index: reference.reference_index,
      source_field: reference.source_field,
      label: reference.label,
      filename: reference.filename,
      match_score: matchScore,
      matched_graphic_elements: cleanTextList(item.matched_graphic_elements, 8, 80),
      design_information: normalizeDesignInformation(item.design_information || item.designInfo || {}),
      reason: cleanString(item.reason).slice(0, 300),
    });
  }

  return {
    matched_references: matchedReferences.sort((left, right) => right.match_score - left.match_score),
    design_reference_summary: cleanString(payload?.design_reference_summary || payload?.summary).slice(0, 900),
    prompt_notes: cleanTextList(payload?.prompt_notes || payload?.notes, 8, 220),
  };
}

function fallbackPromptNotes(matchedReferences) {
  return matchedReferences
    .flatMap((reference) => [
      reference.design_information.motif_treatment,
      reference.design_information.composition,
      reference.design_information.color_palette,
      reference.design_information.background_treatment,
      reference.design_information.style_texture,
      ...reference.design_information.usable_details,
    ])
    .filter(Boolean)
    .slice(0, 8);
}

async function analyzeCompanyReferenceImagesForDesignText(
  proposal = {},
  aiMapping = {},
  selectedGalleryImages = {},
  options = {},
) {
  const env = options.env || process.env;
  const config = getAiReferenceDesignAnalyzerConfig(env);
  const qualifiedGalleryMinScore = Number(options.qualifiedGalleryMinScore || 0.8);
  const requiredGraphicElements =
    options.requiredGraphicElements || collectRequiredGraphicElements(proposal, aiMapping);
  const candidates = collectReferenceImageCandidates(proposal, config.maxImages);
  const qualifiedGalleryImageAvailable = hasQualifiedGalleryImage(
    selectedGalleryImages,
    qualifiedGalleryMinScore,
  );
  const designReferenceOrBackgroundDirective = hasDesignReferenceOrBackgroundDirective(proposal);
  const baseExtra = {
    triggered_by_no_qualified_gallery_images: !qualifiedGalleryImageAvailable,
    required_graphic_elements: requiredGraphicElements,
    reference_image_count: candidates.length,
  };

  if (qualifiedGalleryImageAvailable && !designReferenceOrBackgroundDirective) {
    return buildEmptyReferenceDesignAnalysis('skipped_qualified_gallery_images', config, null, {
      ...baseExtra,
      triggered_by_no_qualified_gallery_images: false,
    });
  }

  if (requiredGraphicElements.length === 0) {
    return buildEmptyReferenceDesignAnalysis(
      'no_graphic_elements',
      config,
      safeError('no_graphic_elements', 'input', 'No graphic elements were available for company reference analysis.'),
      baseExtra,
    );
  }

  if (candidates.length === 0) {
    return buildEmptyReferenceDesignAnalysis('no_reference_images', config, null, baseExtra);
  }

  if (!config.enabled) {
    return buildEmptyReferenceDesignAnalysis('disabled', config, null, baseExtra);
  }

  if (!config.baseUrl || !config.apiKey) {
    return buildEmptyReferenceDesignAnalysis(
      'missing_config',
      config,
      safeError('missing_config', 'config', 'AI company reference design analyzer is not configured.', {
        timeout_ms: config.timeoutMs,
      }),
      baseExtra,
    );
  }

  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    return buildEmptyReferenceDesignAnalysis(
      'error',
      config,
      safeError('missing_fetch', 'request', 'No fetch implementation is available.', {
        timeout_ms: config.timeoutMs,
      }),
      baseExtra,
    );
  }

  const requestBody = buildReferenceDesignAnalysisRequestBody(
    config,
    proposal,
    requiredGraphicElements,
    candidates,
  );
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/${config.endpointPath.replace(/^\/+/, '')}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    const contentType = response.headers?.get?.('content-type') || '';
    const responseText = await response.text();

    if (!response.ok) {
      return buildEmptyReferenceDesignAnalysis(
        'error',
        config,
        safeError('http_error', 'response', `AI company reference design analysis failed with HTTP ${response.status}.`, {
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
      return buildEmptyReferenceDesignAnalysis(
        'error',
        config,
        safeError('json_parse_error', 'response_parse', 'AI company reference design response was not valid JSON.', {
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
      return buildEmptyReferenceDesignAnalysis(
        'error',
        config,
        safeError('empty_ai_result', 'message_content', 'AI company reference design response did not include message content.', {
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
      return buildEmptyReferenceDesignAnalysis(
        'error',
        config,
        safeError('json_parse_error', 'content_parse', 'AI company reference design content was not valid JSON.', {
          http_status: response.status,
          content_type: contentType,
          response_preview: safePreview(content),
          duration_ms: durationMs,
        }),
        baseExtra,
      );
    }

    const validated = validateReferenceDesignPayload(payload, candidates, config);
    const promptNotes = validated.prompt_notes.length > 0
      ? validated.prompt_notes
      : fallbackPromptNotes(validated.matched_references);

    return {
      ...buildEmptyReferenceDesignAnalysis('success', config, null, baseExtra),
      matched_reference_count: validated.matched_references.length,
      matched_references: validated.matched_references,
      design_reference_summary: validated.design_reference_summary,
      prompt_notes: promptNotes,
      ai_error: null,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const isTimeout = error?.name === 'AbortError';
    return buildEmptyReferenceDesignAnalysis(
      'error',
      config,
      safeError(
        isTimeout ? 'timeout' : 'request_failed',
        isTimeout ? 'timeout' : 'request',
        isTimeout ? 'AI company reference design analysis timed out.' : 'AI company reference design analysis failed.',
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
  analyzeCompanyReferenceImagesForDesignText,
  buildEmptyReferenceDesignAnalysis,
  buildReferenceDesignAnalysisRequestBody,
  collectReferenceImageCandidates,
  hasDesignReferenceOrBackgroundDirective,
  getAiReferenceDesignAnalyzerConfig,
  hasQualifiedGalleryImage,
  validateReferenceDesignPayload,
};
