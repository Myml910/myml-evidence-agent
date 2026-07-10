const { getAiElementMapperConfig } = require('./aiElementMapper');
const { normalizeText } = require('./elementTermExtractor');
const {
  findCategoryCatalogEntry,
  loadCategoryCatalog,
  normalizeCategoryName,
} = require('./categoryCatalog');

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_ENDPOINT_PATH = '/chat/completions';
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_TOKENS = 900;

const CATEGORY_CLASSIFIER_SOURCE = 'ai_category_classifier';
const CATEGORY_CLASSIFIER_BASIS = 'test_category_catalog';

const CATEGORY_EVIDENCE_FIELDS = [
  'project_name',
  'category',
  'category_label',
  'development_keywords',
  'core_prompt',
  'design_requirement',
  'ai_graphic_elements',
  'real_graphic_elements',
  'text_elements',
  'color_requirement',
  'style_requirement',
  'craft_requirement',
  'material',
  'market',
  'audience',
  'scene',
  'quantity',
  'size',
  'specification',
];

const FIELD_WEIGHTS = {
  category_label: 230,
  category: 220,
  project_name: 190,
  development_keywords: 145,
  real_graphic_elements: 125,
  ai_graphic_elements: 115,
  design_requirement: 105,
  core_prompt: 85,
  text_elements: 80,
  specification: 78,
  material: 72,
  size: 66,
  scene: 60,
  color_requirement: 48,
  style_requirement: 48,
  craft_requirement: 48,
  market: 30,
  audience: 30,
  quantity: 24,
};

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

function clampConfidence(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, parsed));
}

function valueToTexts(value) {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return [String(value)];
}

function compactFieldValue(value, maxLength = 420) {
  const text = valueToTexts(value).join('; ').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function buildProposalEvidence(proposal = {}) {
  return Object.fromEntries(
    CATEGORY_EVIDENCE_FIELDS
      .map((field) => [field, compactFieldValue(proposal[field])])
      .filter(([, value]) => value),
  );
}

function getAiCategoryClassifierConfig(env = process.env) {
  const fallback = getAiElementMapperConfig(env);
  const baseUrl = cleanString(env.AI_CATEGORY_CLASSIFIER_BASE_URL) || fallback.baseUrl;
  const endpointPath =
    cleanString(env.AI_CATEGORY_CLASSIFIER_ENDPOINT_PATH) ||
    fallback.endpointPath ||
    DEFAULT_ENDPOINT_PATH;
  const apiKey = cleanString(env.AI_CATEGORY_CLASSIFIER_API_KEY) || fallback.apiKey;

  return {
    enabled: isEnabledValue(
      env.AI_CATEGORY_CLASSIFIER_ENABLED === undefined
        ? env.AI_ELEMENT_MAPPER_ENABLED || env.AI_TERM_MATCHER_ENABLED
        : env.AI_CATEGORY_CLASSIFIER_ENABLED,
    ),
    baseUrl,
    endpointPath,
    apiKey,
    model:
      cleanString(env.AI_CATEGORY_CLASSIFIER_MODEL) ||
      fallback.model ||
      DEFAULT_MODEL,
    timeoutMs: parseInteger(
      env.AI_CATEGORY_CLASSIFIER_TIMEOUT_MS,
      fallback.timeoutMs || DEFAULT_TIMEOUT_MS,
    ),
    maxTokens: parseInteger(
      env.AI_CATEGORY_CLASSIFIER_MAX_TOKENS,
      Math.min(fallback.maxTokens || DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    ),
    responseFormat:
      cleanString(env.AI_CATEGORY_CLASSIFIER_RESPONSE_FORMAT) ||
      fallback.responseFormat ||
      'json_object',
  };
}

function buildCategoryHistoryImages(entry) {
  if (!entry) {
    return [];
  }

  const historyImages = Array.isArray(entry.history_images) ? entry.history_images : [];
  const seen = new Set();

  return [
    ...historyImages,
    entry.image_url
      ? {
          image_url: entry.image_url,
          image_filename: entry.image_filename || '',
          note: entry.note || '',
          source: entry.source || '',
          created_at: entry.updated_at || entry.created_at || '',
        }
      : null,
  ]
    .filter((image) => image?.image_url)
    .filter((image) => {
      if (seen.has(image.image_url)) {
        return false;
      }
      seen.add(image.image_url);
      return true;
    })
    .map((image) => ({
      image_url: image.image_url,
      image_filename: image.image_filename || '',
      note: image.note || '',
      source: image.source || '',
      created_at: image.created_at || '',
    }));
}

function buildCategoryImage(category, catalog = {}) {
  const entry = findCategoryCatalogEntry(category, { catalog });
  const historyImages = buildCategoryHistoryImages(entry);
  const primaryImage = entry?.image_url
    ? {
        image_url: entry.image_url,
        image_filename: entry.image_filename || '',
        note: entry.note || '',
        source: entry.source || '',
      }
    : historyImages[0];

  if (!entry || !primaryImage?.image_url) {
    return null;
  }

  return {
    category: entry.category,
    image_url: primaryImage.image_url,
    image_filename: primaryImage.image_filename || '',
    note: primaryImage.note || '',
    source: primaryImage.source || '',
    history_images: historyImages,
  };
}

function buildCategoryTarget(item = {}, catalog = {}) {
  const category = cleanString(item.category || item.predicted_category);
  if (!category) {
    return null;
  }

  return {
    category,
    confidence: clampConfidence(item.confidence, 0),
    reason: cleanString(item.reason).slice(0, 360),
    evidence_fields: normalizeEvidenceFields(item.evidence_fields || item.evidenceFields),
    category_image: buildCategoryImage(category, catalog),
  };
}

function buildCategoryTargets(items = [], catalog = {}) {
  const seen = new Set();
  return items
    .map((item) => buildCategoryTarget(item, catalog))
    .filter(Boolean)
    .filter((item) => {
      const key = normalizeText(item.category);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function buildEmptyCategoryJudgment(status, config = {}, catalog = {}, error = null, fallback = null) {
  const fallbackCategory = fallback?.category || '';
  const fallbackTargets = fallback?.predicted_categories || (
    fallbackCategory
      ? [{
          category: fallbackCategory,
          confidence: fallback.confidence,
          reason: fallback.reason,
          evidence_fields: fallback.evidence_fields,
        }]
      : []
  );
  const predictedCategories = buildCategoryTargets(fallbackTargets, catalog);
  const categoryImages = predictedCategories
    .map((item) => item.category_image)
    .filter(Boolean);
  return {
    status,
    source: CATEGORY_CLASSIFIER_SOURCE,
    basis: CATEGORY_CLASSIFIER_BASIS,
    model: config.model || DEFAULT_MODEL,
    catalog_source: catalog.source || '',
    candidate_count: catalog.candidate_count || 0,
    predicted_category: fallbackCategory,
    confidence: fallback ? fallback.confidence : 0,
    reason: fallback ? fallback.reason : '',
    evidence_fields: fallback ? fallback.evidence_fields : [],
    alternatives: fallback ? fallback.alternatives : [],
    category_image: buildCategoryImage(fallbackCategory, catalog),
    predicted_categories: predictedCategories,
    category_images: categoryImages,
    match_source: fallbackCategory ? 'rule_fallback' : 'none',
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

function categorySet(candidates = []) {
  return new Map(candidates.map((category) => [normalizeText(category), category]));
}

function resolveCandidateCategory(value, candidates = []) {
  const normalized = normalizeText(normalizeCategoryName(value));
  if (!normalized) {
    return '';
  }
  return categorySet(candidates).get(normalized) || '';
}

function scoreCategoryAgainstText(category, text, field) {
  const normalizedCategory = normalizeText(category);
  const normalizedText = normalizeText(text);
  if (!normalizedCategory || !normalizedText) {
    return 0;
  }

  const weight = FIELD_WEIGHTS[field] || 40;
  if (normalizedText === normalizedCategory) {
    return weight + 1200 + normalizedCategory.length * 4;
  }
  if (` ${normalizedText} `.includes(` ${normalizedCategory} `)) {
    return weight + 700 + normalizedCategory.length * 3;
  }
  if (normalizedText.includes(normalizedCategory)) {
    return weight + 560 + normalizedCategory.length * 3;
  }

  const textTokens = new Set(normalizedText.split(' ').filter((token) => token.length >= 2));
  const categoryTokens = normalizedCategory.split(' ').filter((token) => token.length >= 2);
  if (categoryTokens.length === 0) {
    return 0;
  }
  const overlapCount = categoryTokens.filter((token) => textTokens.has(token)).length;
  if (overlapCount === 0) {
    return 0;
  }
  return weight + overlapCount * 80 + (overlapCount / categoryTokens.length) * 120;
}

function collectScoredCategoryMatches(proposal = {}, candidates = []) {
  const evidence = buildProposalEvidence(proposal);
  const scored = candidates
    .map((category) => {
      const fieldScores = Object.entries(evidence)
        .map(([field, value]) => ({
          field,
          score: scoreCategoryAgainstText(category, value, field),
        }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score);
      const score = fieldScores.reduce((sum, item) => sum + item.score, 0);
      return {
        category,
        score,
        fields: fieldScores.map((item) => item.field),
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.category.localeCompare(right.category, 'zh-Hans-CN');
    });

  return scored;
}

function classifyCategoryWithRules(proposal = {}, candidates = []) {
  const scored = collectScoredCategoryMatches(proposal, candidates);
  if (scored.length === 0) {
    return null;
  }

  const best = scored[0];
  const confidence = Math.min(0.92, Math.max(0.35, best.score / (best.score + 700)));
  const comboMatches = scored
    .filter((item, index) => index === 0 || item.score >= Math.max(360, best.score * 0.55))
    .slice(0, 4)
    .map((item, index) => ({
      category: item.category,
      confidence: index === 0 ? confidence : Math.min(0.86, Math.max(0.2, item.score / (item.score + 800))),
      reason: index === 0
        ? `Matched category evidence in ${item.fields.slice(0, 3).join(', ')}.`
        : `Matched additional combo-category evidence in ${item.fields.slice(0, 3).join(', ')}.`,
      evidence_fields: item.fields.slice(0, 8),
    }));
  return {
    category: best.category,
    confidence,
    reason: `Matched category evidence in ${best.fields.slice(0, 3).join(', ')}.`,
    evidence_fields: best.fields.slice(0, 8),
    predicted_categories: comboMatches,
    alternatives: scored.slice(1, 4).map((item) => ({
      category: item.category,
      confidence: Math.min(0.86, Math.max(0.2, item.score / (item.score + 800))),
      reason: `Matched ${item.fields.slice(0, 2).join(', ')}.`,
    })),
  };
}

function buildSystemPrompt() {
  return [
    'You are the MYML real-category classifier.',
    'Choose the true product category for the development proposal using only company real-data fields.',
    'If the proposal is a single product type, choose exactly one category from candidate_categories.',
    'If the proposal is a combo/set/bundle that clearly contains multiple product categories, choose every required category from candidate_categories.',
    'The first predicted category must be the primary category; additional categories must be true production categories, not style words, themes, or loose alternatives.',
    'Treat existing category/category_label as evidence, but the final predicted_category must still be from candidate_categories.',
    'Do not invent a category, SKU, image label, element term, or marketing theme.',
    'Return JSON only.',
  ].join('\n');
}

function buildUserPayload(proposal, candidates) {
  return {
    proposal: buildProposalEvidence(proposal),
    candidate_categories: candidates,
    output_schema: {
      predicted_category: 'primary candidate category only',
      predicted_categories: [
        {
          category: 'candidate category only',
          confidence: 0.0,
          reason: 'why this category is part of the real product output',
          evidence_fields: ['project_name', 'category_label'],
        },
      ],
      confidence: 0.0,
      reason: 'short reason based on evidence fields',
      evidence_fields: ['project_name', 'category_label'],
      alternatives: [
        {
          category: 'candidate category only',
          confidence: 0.0,
          reason: 'short contrast reason',
        },
      ],
    },
  };
}

function buildCategoryMessages(proposal, candidates) {
  return [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: JSON.stringify(buildUserPayload(proposal, candidates)) },
  ];
}

function buildCategoryRequestBody(config, proposal, candidates) {
  const body = {
    model: config.model,
    messages: buildCategoryMessages(proposal, candidates),
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

function normalizeEvidenceFields(fields) {
  const allowed = new Set(CATEGORY_EVIDENCE_FIELDS);
  return Array.isArray(fields)
    ? [...new Set(fields.map(String).filter((field) => allowed.has(field)))].slice(0, 8)
    : [];
}

function normalizeAlternatives(alternatives, candidates) {
  if (!Array.isArray(alternatives)) {
    return [];
  }

  const seen = new Set();
  return alternatives
    .map((item) => {
      const category = resolveCandidateCategory(item?.category || item?.predicted_category, candidates);
      if (!category || seen.has(category)) {
        return null;
      }
      seen.add(category);
      return {
        category,
        confidence: clampConfidence(item?.confidence, 0),
        reason: cleanString(item?.reason).slice(0, 240),
      };
    })
    .filter(Boolean)
    .slice(0, 5);
}

function normalizePredictedCategories(payload, candidates, primaryCategory) {
  const rawItems = [];
  if (primaryCategory) {
    rawItems.push({
      category: primaryCategory,
      confidence: payload?.confidence,
      reason: payload?.reason,
      evidence_fields: payload?.evidence_fields,
    });
  }

  const predictedCategories = payload?.predicted_categories || payload?.categories || payload?.category_targets;
  if (Array.isArray(predictedCategories)) {
    predictedCategories.forEach((item) => {
      if (typeof item === 'string') {
        rawItems.push({ category: item });
      } else if (item && typeof item === 'object') {
        rawItems.push(item);
      }
    });
  }

  const seen = new Set();
  return rawItems
    .map((item) => {
      const category = resolveCandidateCategory(item?.category || item?.predicted_category, candidates);
      if (!category) {
        return null;
      }
      const key = normalizeText(category);
      if (seen.has(key)) {
        return null;
      }
      seen.add(key);
      return {
        category,
        confidence: clampConfidence(item?.confidence, primaryCategory === category ? 0.5 : 0.45),
        reason: cleanString(item?.reason).slice(0, 360),
        evidence_fields: normalizeEvidenceFields(item?.evidence_fields || item?.evidenceFields),
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

function validateAiCategoryPayload(payload, candidates) {
  const predictedCategory = resolveCandidateCategory(
    payload?.predicted_category || payload?.category,
    candidates,
  );
  const predictedCategories = normalizePredictedCategories(payload, candidates, predictedCategory);
  const primaryCategory = predictedCategory || predictedCategories[0]?.category || '';
  if (!primaryCategory) {
    return null;
  }
  const normalizedTargets = predictedCategories.length > 0
    ? predictedCategories
    : [{
        category: primaryCategory,
        confidence: clampConfidence(payload?.confidence, 0.5),
        reason: cleanString(payload?.reason).slice(0, 360),
        evidence_fields: normalizeEvidenceFields(payload?.evidence_fields),
      }];

  return {
    predicted_category: primaryCategory,
    confidence: clampConfidence(payload?.confidence, 0.5),
    reason: cleanString(payload?.reason).slice(0, 360),
    evidence_fields: normalizeEvidenceFields(payload?.evidence_fields),
    predicted_categories: normalizedTargets,
    alternatives: normalizeAlternatives(payload?.alternatives, candidates).filter(
      (item) => item.category !== primaryCategory,
    ),
  };
}

async function classifyProposalCategoryWithAi(proposal = {}, options = {}) {
  const env = options.env || process.env;
  const config = getAiCategoryClassifierConfig(env);
  const catalog = options.catalog || loadCategoryCatalog({
    publicBaseUrl: options.publicBaseUrl,
  });
  const candidates = Array.isArray(options.candidates) ? options.candidates : catalog.candidates;
  const fallback = classifyCategoryWithRules(proposal, candidates);
  const fetchImpl = options.fetchImpl || global.fetch;

  if (!candidates || candidates.length === 0) {
    return buildEmptyCategoryJudgment(
      'missing_catalog',
      config,
      catalog,
      safeError('missing_catalog', 'catalog', 'Category candidate catalog is empty.'),
    );
  }

  if (!config.enabled) {
    return buildEmptyCategoryJudgment('disabled', config, catalog, null, fallback);
  }

  if (!config.baseUrl || !config.apiKey) {
    return buildEmptyCategoryJudgment(
      'missing_config',
      config,
      catalog,
      safeError('missing_config', 'config', 'AI category classifier is not configured.', {
        timeout_ms: config.timeoutMs,
      }),
      fallback,
    );
  }

  if (typeof fetchImpl !== 'function') {
    return buildEmptyCategoryJudgment(
      'error',
      config,
      catalog,
      safeError('missing_fetch', 'request', 'No fetch implementation is available.', {
        timeout_ms: config.timeoutMs,
      }),
      fallback,
    );
  }

  const requestBody = buildCategoryRequestBody(config, proposal, candidates);
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/${config.endpointPath.replace(/^\/+/, '')}`;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

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
      return buildEmptyCategoryJudgment(
        'error',
        config,
        catalog,
        safeError('http_error', 'response', `AI category request failed with HTTP ${response.status}.`, {
          http_status: response.status,
          content_type: contentType,
          response_preview: safePreview(responseText),
          duration_ms: durationMs,
          timeout_ms: config.timeoutMs,
        }),
        fallback,
      );
    }

    let envelope;
    try {
      envelope = JSON.parse(responseText);
    } catch (_error) {
      return buildEmptyCategoryJudgment(
        'error',
        config,
        catalog,
        safeError('json_parse_error', 'response_parse', 'AI category response was not valid JSON.', {
          http_status: response.status,
          content_type: contentType,
          response_preview: safePreview(responseText),
          duration_ms: durationMs,
        }),
        fallback,
      );
    }

    const content = envelope.choices?.[0]?.message?.content;
    if (!content) {
      return buildEmptyCategoryJudgment(
        'error',
        config,
        catalog,
        safeError('empty_ai_result', 'message_content', 'AI category response did not include message content.', {
          http_status: response.status,
          content_type: contentType,
          response_preview: safePreview(responseText),
          duration_ms: durationMs,
        }),
        fallback,
      );
    }

    let payload;
    try {
      payload = typeof content === 'string' ? JSON.parse(content) : content;
    } catch (_error) {
      return buildEmptyCategoryJudgment(
        'error',
        config,
        catalog,
        safeError('json_parse_error', 'content_parse', 'AI category content was not valid JSON.', {
          http_status: response.status,
          content_type: contentType,
          response_preview: safePreview(content),
          duration_ms: durationMs,
        }),
        fallback,
      );
    }

    const validated = validateAiCategoryPayload(payload, candidates);
    if (!validated) {
      return buildEmptyCategoryJudgment(
        'error',
        config,
        catalog,
        safeError('invalid_ai_category', 'validation', 'AI category result was not in the candidate catalog.', {
          http_status: response.status,
          duration_ms: durationMs,
        }),
        fallback,
      );
    }

    return {
      ...buildEmptyCategoryJudgment('success', config, catalog),
      ...validated,
      category_image: buildCategoryImage(validated.predicted_category, catalog),
      predicted_categories: buildCategoryTargets(validated.predicted_categories, catalog),
      category_images: buildCategoryTargets(validated.predicted_categories, catalog)
        .map((item) => item.category_image)
        .filter(Boolean),
      match_source: 'ai',
      ai_error: null,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const isTimeout = error?.name === 'AbortError';
    return buildEmptyCategoryJudgment(
      'error',
      config,
      catalog,
      safeError(
        isTimeout ? 'timeout' : 'request_failed',
        isTimeout ? 'timeout' : 'request',
        isTimeout ? 'AI category request timed out.' : 'AI category request failed.',
        {
          duration_ms: durationMs,
          timeout_ms: config.timeoutMs,
        },
      ),
      fallback,
    );
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  CATEGORY_CLASSIFIER_BASIS,
  CATEGORY_CLASSIFIER_SOURCE,
  buildEmptyCategoryJudgment,
  buildCategoryMessages,
  buildCategoryRequestBody,
  classifyCategoryWithRules,
  classifyProposalCategoryWithAi,
  getAiCategoryClassifierConfig,
  validateAiCategoryPayload,
};
