const {
  loadElementTerms,
  normalizeText,
} = require('./elementTermExtractor');

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_ENDPOINT_PATH = '/chat/completions';
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_TOP_N = 40;

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

function getAiElementMapperConfig(env = process.env) {
  const mapperBaseUrl = cleanString(env.AI_ELEMENT_MAPPER_BASE_URL);
  const termMatcherBaseUrl = cleanString(env.AI_TERM_MATCHER_BASE_URL);
  const imageGeneratorBaseUrl = cleanString(env.AI_IMAGE_GENERATOR_BASE_URL);
  const baseUrl = mapperBaseUrl || termMatcherBaseUrl || imageGeneratorBaseUrl;
  const endpointPath = cleanString(
    env.AI_ELEMENT_MAPPER_ENDPOINT_PATH ||
      env.AI_TERM_MATCHER_ENDPOINT_PATH ||
      DEFAULT_ENDPOINT_PATH,
  );
  const mapperApiKey = cleanString(env.AI_ELEMENT_MAPPER_API_KEY);
  const termMatcherApiKey = cleanString(env.AI_TERM_MATCHER_API_KEY);
  const imageGeneratorApiKey = cleanString(env.AI_IMAGE_GENERATOR_API_KEY);
  const shouldReuseImageGeneratorKey =
    imageGeneratorApiKey && imageGeneratorBaseUrl && baseUrl === imageGeneratorBaseUrl;
  const apiKey =
    mapperApiKey ||
    (shouldReuseImageGeneratorKey ? imageGeneratorApiKey : '') ||
    termMatcherApiKey ||
    imageGeneratorApiKey;

  return {
    enabled: isEnabledValue(env.AI_ELEMENT_MAPPER_ENABLED || env.AI_TERM_MATCHER_ENABLED),
    baseUrl,
    endpointPath,
    apiKey,
    model: cleanString(env.AI_ELEMENT_MAPPER_MODEL) || DEFAULT_MODEL,
    timeoutMs: parseInteger(
      env.AI_ELEMENT_MAPPER_TIMEOUT_MS || env.AI_TERM_MATCHER_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    maxTokens: parseInteger(
      env.AI_ELEMENT_MAPPER_MAX_TOKENS || env.AI_TERM_MATCHER_MAX_TOKENS,
      DEFAULT_MAX_TOKENS,
    ),
    topN: parseInteger(
      env.AI_ELEMENT_MAPPER_TOP_N || env.AI_TERM_MATCHER_TOP_N,
      DEFAULT_TOP_N,
    ),
    responseFormat:
      cleanString(env.AI_ELEMENT_MAPPER_RESPONSE_FORMAT || env.AI_TERM_MATCHER_RESPONSE_FORMAT) ||
      'json_object',
  };
}

function buildEmptyAiElementMapping(status, config = {}, error = null) {
  return {
    ai_status: status,
    model: config.model || DEFAULT_MODEL,
    source: 'ai_element_mapper',
    basis: 'builtin_element_terms',
    primary_element_terms: [],
    scene_terms: [],
    style_terms: [],
    attribute_terms: [],
    unmatched_terms: [],
    summary: {
      primary_count: 0,
      scene_count: 0,
      style_count: 0,
      attribute_count: 0,
      unmatched_count: 0,
    },
    ai_error: error,
  };
}

function tokenSet(value) {
  return new Set(normalizeText(value).split(' ').filter((token) => token.length >= 2));
}

function scoreTermAgainstText(term, normalizedText) {
  if (!term || !normalizedText) {
    return 0;
  }
  if (normalizedText === term) {
    return 1000 + term.length;
  }
  if (` ${normalizedText} `.includes(` ${term} `)) {
    return 800 + term.length;
  }

  const textTokens = tokenSet(normalizedText);
  const termTokens = [...tokenSet(term)];
  if (termTokens.length === 0) {
    return 0;
  }
  const overlapCount = termTokens.filter((token) => textTokens.has(token)).length;
  if (overlapCount === 0) {
    return 0;
  }
  return overlapCount * 80 + (overlapCount / termTokens.length) * 100 + Math.min(term.length, 60);
}

function recallCandidateTerms(texts, terms, topN) {
  const normalizedTexts = texts.map(normalizeText).filter(Boolean);
  const scored = [];

  for (const term of terms) {
    let score = 0;
    for (const normalizedText of normalizedTexts) {
      score = Math.max(score, scoreTermAgainstText(term, normalizedText));
    }
    if (score > 0) {
      scored.push({ term, score });
    }
  }

  return scored
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (b.term.length !== a.term.length) {
        return b.term.length - a.term.length;
      }
      return a.term.localeCompare(b.term);
    })
    .slice(0, topN)
    .map((item) => item.term);
}

function chineseNumberToInteger(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) {
    return Number(text);
  }

  const map = {
    '\u4e00': 1,
    '\u4e8c': 2,
    '\u4e24': 2,
    '\u4e09': 3,
    '\u56db': 4,
    '\u4e94': 5,
    '\u516d': 6,
    '\u4e03': 7,
    '\u516b': 8,
    '\u4e5d': 9,
    '\u5341': 10,
  };
  return map[text] || null;
}

function extractReferencedImageIndexes(text) {
  const indexes = [];
  const pattern = /(?:\u53c2\u8003\u56fe|\u56fe\u7247|\u56fe)\s*([\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]|\d+)/g;
  let match = pattern.exec(text || '');
  while (match) {
    const index = chineseNumberToInteger(match[1]);
    if (index && !indexes.includes(index)) {
      indexes.push(index);
    }
    match = pattern.exec(text || '');
  }
  return indexes;
}

function selectReferencedImages(proposal = {}) {
  const designRequirement = proposal.design_requirement || '';
  const indexes = extractReferencedImageIndexes(designRequirement);
  if (indexes.length === 0) {
    return [];
  }

  const designImages = (proposal.reference_images || []).filter(
    (image) => image.source_field === 'design_img',
  );
  const fallbackImages = proposal.reference_images || [];
  const imagePool = designImages.length > 0 ? designImages : fallbackImages;

  return indexes
    .map((index) => ({
      reference_index: index,
      image: imagePool[index - 1],
    }))
    .filter((entry) => entry.image && entry.image.url);
}

function nonEmptyValues(values) {
  return values.flatMap((value) => {
    if (Array.isArray(value)) {
      return value.map(String).filter(Boolean);
    }
    return value ? [String(value)] : [];
  });
}

const PRODUCT_CARRIER_TERMS = new Set([
  'plate',
  'plates',
  'cup',
  'cups',
  'napkin',
  'napkins',
  'banner',
  'backdrop',
  'sticker',
  'stickers',
  'bag',
  'bags',
  'box',
  'boxes',
  'decor',
  'decoration',
  'decorations',
  'supplies',
  'party',
  'set',
  'pack',
  'pcs',
  'piece',
  'pieces',
]);

const REAL_ELEMENT_REQUIREMENT_SOURCE = 'real_company_element_requirement';
const TITLE_DERIVED_ELEMENT_REQUIREMENT_SOURCE = 'derived_from_project_name';
const CJK_COLOR_ALIASES = [
  ['\u9ed1\u91d1', 'black gold'],
  ['\u9ed1\u767d', 'black and white'],
  ['\u7ea2\u7eff', 'red green'],
  ['\u84dd\u767d', 'blue white'],
  ['\u7c89\u91d1', 'pink gold'],
  ['\u73ab\u7470\u91d1', 'rose gold'],
  ['\u9ed1\u8272', 'black'],
  ['\u767d\u8272', 'white'],
  ['\u7ea2\u8272', 'red'],
  ['\u7eff\u8272', 'green'],
  ['\u84dd\u8272', 'blue'],
  ['\u7c89\u8272', 'pink'],
  ['\u7d2b\u8272', 'purple'],
  ['\u9ec4\u8272', 'yellow'],
  ['\u91d1\u8272', 'gold'],
  ['\u94f6\u8272', 'silver'],
  ['\u68d5\u8272', 'brown'],
  ['\u6a59\u8272', 'orange'],
  ['\u7070\u8272', 'gray'],
  ['\u5f69\u8272', 'colorful'],
];

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizePrimaryThemeTerm(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }

  const parts = normalized.split(' ').filter(Boolean);
  let end = parts.length;
  while (end > 0 && PRODUCT_CARRIER_TERMS.has(parts[end - 1])) {
    end -= 1;
  }

  if (end === 0 || end === parts.length) {
    return normalized;
  }

  return parts.slice(0, end).join(' ');
}

function hasRealGraphicElementRequirement(proposal = {}) {
  if (!cleanString(proposal.element_requirement)) {
    return false;
  }

  const source = cleanString(proposal.element_requirement_source);
  if (!source) {
    return true;
  }

  return source === REAL_ELEMENT_REQUIREMENT_SOURCE;
}

function realGraphicElementValues(proposal = {}) {
  return hasRealGraphicElementRequirement(proposal)
    ? sourceValues(proposal.element_requirement)
    : [];
}

function titleDerivedGraphicElementValues(proposal = {}) {
  return cleanString(proposal.element_requirement_source) === TITLE_DERIVED_ELEMENT_REQUIREMENT_SOURCE
    ? sourceValues(proposal.element_requirement)
    : sourceValues(proposal.project_name);
}

function titleDerivedGraphicElementValuesForAi(proposal = {}) {
  const values = titleDerivedGraphicElementValues(proposal);
  const text = values.join('\n');
  const aliases = CJK_COLOR_ALIASES
    .filter(([cjkTerm]) => text.includes(cjkTerm))
    .map(([, alias]) => alias);
  return uniqueValues([...values, ...aliases]);
}

function sourceValues(value) {
  return nonEmptyValues([value])
    .flatMap((item) => String(item).split(/[\n\r,;，；]+/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function scorePrimaryThemeCandidate(value, sourcePriority) {
  const normalized = normalizePrimaryThemeTerm(value);
  if (!normalized || normalized.length < 2) {
    return -1;
  }

  const tokens = normalized.split(' ').filter(Boolean);
  const productTokenCount = tokens.filter((token) => PRODUCT_CARRIER_TERMS.has(token)).length;
  if (tokens.length > 0 && productTokenCount === tokens.length) {
    return -1;
  }

  const tokenScore = Math.min(tokens.length || 1, 6) * 8;
  const lengthScore = Math.min(normalized.length, 48);
  const phraseScore = tokens.length >= 2 ? 20 : 0;
  const productPenalty = productTokenCount * 18;
  return sourcePriority + tokenScore + lengthScore + phraseScore - productPenalty;
}

function extractPrimaryThemeStandard(proposal = {}) {
  const sources = hasRealGraphicElementRequirement(proposal)
    ? [
        {
          field: 'element_requirement',
          priority: 180,
          values: sourceValues(proposal.element_requirement),
        },
        {
          field: 'project_name',
          priority: 130,
          values: sourceValues(proposal.project_name),
        },
        {
          field: 'development_keywords',
          priority: 110,
          values: sourceValues(proposal.development_keywords),
        },
        {
          field: 'text_elements',
          priority: 70,
          values: sourceValues(proposal.text_elements),
        },
        {
          field: 'core_prompt',
          priority: 50,
          values: sourceValues(proposal.core_prompt),
        },
      ]
    : [
        {
          field: 'project_name',
          priority: 180,
          values: titleDerivedGraphicElementValues(proposal),
        },
      ];
  const candidates = [];

  for (const source of sources) {
    for (const value of source.values) {
      const score = scorePrimaryThemeCandidate(value, source.priority);
      if (score < 0) {
        continue;
      }
      candidates.push({
        raw: cleanString(value),
        term: normalizePrimaryThemeTerm(value),
        source_field: source.field,
        score,
      });
    }
  }

  return candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.term.localeCompare(right.term, 'en');
  })[0] || null;
}

function ensurePrimaryElementTerms(mapping, proposal = {}) {
  return mapping;
}

function normalizePrimaryGraphicElementSource(mapping, proposal = {}) {
  if (hasRealGraphicElementRequirement(proposal)) {
    return mapping;
  }

  return {
    ...mapping,
    primary_element_terms: (mapping.primary_element_terms || []).map((item) => ({
      ...item,
      source_fields: ['project_name'],
      reason:
        'Graphic element inferred only from project_name because the real graphic element field was empty.',
    })),
  };
}

function buildMappingTasks(proposal, terms, topN) {
  const referencedImages = selectReferencedImages(proposal);
  const hasRealGraphicElement = hasRealGraphicElementRequirement(proposal);
  const realGraphicElementTexts = realGraphicElementValues(proposal);
  const primaryTexts = [];
  const primarySourceFields = [];
  const primaryInstruction = hasRealGraphicElement
    ? 'Choose the core visual theme standard for the new pattern design. Treat element_requirement as the real company graphic-element field and strongest evidence. Exclude product/carrier terms.'
    : 'No real company graphic-element field was provided. Infer the graphic element only from project_name. Do not use development_keywords, text_elements, core_prompt, or other fields for the primary graphic element. Exclude product/carrier terms.';
  const styleSourceFields = hasRealGraphicElement
    ? [
        'development_keywords',
        'text_elements',
        'design_requirement',
        'element_requirement',
        'color_requirement',
        'style_requirement',
        'design_img',
      ]
    : [
        'development_keywords',
        'text_elements',
        'design_requirement',
        'color_requirement',
        'style_requirement',
        'design_img',
      ];
  const attributeSourceFields = hasRealGraphicElement
    ? [
        'element_requirement',
        'design_requirement',
        'color_requirement',
        'style_requirement',
        'material',
        'size',
        'specification',
        'design_img',
      ]
    : [
        'design_requirement',
        'color_requirement',
        'style_requirement',
        'material',
        'size',
        'specification',
        'design_img',
      ];
  const sceneTexts = nonEmptyValues([
    proposal.project_name,
    proposal.development_keywords,
    proposal.scene,
    proposal.design_requirement,
    proposal.text_elements,
  ]);
  const styleTexts = nonEmptyValues([
    proposal.development_keywords,
    proposal.text_elements,
    proposal.design_requirement,
    realGraphicElementTexts,
    proposal.color_requirement,
    proposal.style_requirement,
  ]);
  const attributeTexts = nonEmptyValues([
    realGraphicElementTexts,
    proposal.design_requirement,
    proposal.color_requirement,
    proposal.style_requirement,
    proposal.material,
    proposal.size,
    proposal.specification,
  ]);

  return [
    {
      id: 'primary',
      label: 'primary element terms',
      instruction: primaryInstruction,
      source_fields: primarySourceFields,
      text: primaryTexts.join('\n'),
      candidates: recallCandidateTerms(primaryTexts, terms, topN),
    },
    {
      id: 'scene',
      label: 'scene terms',
      instruction:
        'Choose occasion, event, season, time, place, or usage-scene terms. Exclude product terms.',
      source_fields: ['project_name', 'development_keywords', 'scene', 'design_requirement'],
      text: sceneTexts.join('\n'),
      candidates: recallCandidateTerms(sceneTexts, terms, topN),
    },
    {
      id: 'style',
      label: 'style terms',
      instruction:
        'Choose visual style, color mood, motif, pattern, and aesthetic-expression terms. Use referenced images as visual evidence when supplied. Exclude product terms.',
      source_fields: styleSourceFields,
      text: styleTexts.join('\n'),
      images: referencedImages.map((entry) => ({
        reference_index: entry.reference_index,
        url: entry.image.url,
        filename: entry.image.filename,
        source_field: entry.image.source_field,
      })),
      candidates: recallCandidateTerms(styleTexts, terms, topN),
    },
    {
      id: 'attribute',
      label: 'attribute terms',
      instruction:
        'Choose material, shape, physical attribute, compatible form, and visual-structure terms. Use referenced images as visual evidence when supplied. Exclude product terms.',
      source_fields: attributeSourceFields,
      text: attributeTexts.join('\n'),
      images: referencedImages.map((entry) => ({
        reference_index: entry.reference_index,
        url: entry.image.url,
        filename: entry.image.filename,
        source_field: entry.image.source_field,
      })),
      candidates: recallCandidateTerms(attributeTexts, terms, topN),
    },
  ].filter((task) => task.text || task.images?.length > 0);
}

function buildSystemPrompt() {
  return [
    'You are the MYML element-term mapping assistant.',
    'The built-in candidate list is the only legal vocabulary.',
    'You must choose terms only from each task candidate_terms list.',
    'Do not invent terms. Do not return product/carrier terms, SKUs, categories, historical images, or binary image content.',
    'Classify selected terms into exactly these groups: primary_element_terms, scene_terms, style_terms, attribute_terms.',
    'Return JSON only.',
  ].join('\n');
}

function buildUserPayload(tasks) {
  return {
    tasks: tasks.map((task) => ({
      id: task.id,
      label: task.label,
      instruction: task.instruction,
      source_fields: task.source_fields,
      text: task.text,
      images: (task.images || []).map((image) => ({
        reference_index: image.reference_index,
        filename: image.filename,
        source_field: image.source_field,
      })),
      candidate_terms: task.candidates,
    })),
    output_schema: {
      primary_element_terms: [
        {
          term: 'candidate term only',
          confidence: 0.0,
          reason: 'short reason',
          source_fields: ['project_name'],
        },
      ],
      scene_terms: [],
      style_terms: [],
      attribute_terms: [],
      unmatched_terms: [],
    },
  };
}

function buildMessages(tasks) {
  const imageEntries = tasks.flatMap((task) => task.images || []);
  const userPayload = buildUserPayload(tasks);
  const text = JSON.stringify(userPayload);

  if (imageEntries.length === 0) {
    return [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: text },
    ];
  }

  return [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: [
        { type: 'text', text },
        ...imageEntries.map((image) => ({
          type: 'image_url',
          image_url: {
            url: image.url,
          },
        })),
      ],
    },
  ];
}

function buildRequestBody(config, tasks) {
  const body = {
    model: config.model,
    messages: buildMessages(tasks),
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

function normalizeAiTermItem(item, options) {
  const term = normalizeText(item?.term || item?.matched_term || item?.matched_normalized_term);
  if (!term || !options.termSet.has(term) || !options.candidateSet.has(term)) {
    return null;
  }

  const normalized = {
    term,
    confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0,
    reason: cleanString(item.reason).slice(0, 240),
    source_fields: Array.isArray(item.source_fields)
      ? item.source_fields.map(String).filter(Boolean)
      : options.defaultSourceFields,
  };

  const referenceIndex = Number(item.reference_index);
  if (Number.isInteger(referenceIndex) && referenceIndex > 0) {
    normalized.reference_index = referenceIndex;
  }
  if (item.image_filename) {
    normalized.image_filename = cleanString(item.image_filename).slice(0, 160);
  }

  return normalized;
}

function uniqueTermItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item || seen.has(item.term)) {
      continue;
    }
    seen.add(item.term);
    result.push(item);
  }
  return result;
}

function validateGroup(payload, groupName, task, termSet, defaultSourceFields) {
  const candidateSet = new Set(task?.candidates || []);
  return uniqueTermItems(
    (payload[groupName] || []).map((item) =>
      normalizeAiTermItem(item, {
        termSet,
        candidateSet,
        defaultSourceFields,
      }),
    ),
  );
}

function validateAiPayload(payload, tasks, terms) {
  const termSet = new Set(terms);
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  const primary = validateGroup(
    payload,
    'primary_element_terms',
    taskById.get('primary'),
    termSet,
    ['project_name'],
  );
  const scene = validateGroup(payload, 'scene_terms', taskById.get('scene'), termSet, [
    'project_name',
    'development_keywords',
    'scene',
    'design_requirement',
  ]);
  const style = validateGroup(payload, 'style_terms', taskById.get('style'), termSet, [
    'development_keywords',
    'text_elements',
    'design_requirement',
    'element_requirement',
    'style_requirement',
    'design_img',
  ]);
  const attribute = validateGroup(payload, 'attribute_terms', taskById.get('attribute'), termSet, [
    'element_requirement',
    'design_requirement',
    'material',
    'color_requirement',
    'style_requirement',
    'design_img',
  ]);

  const unmatched = Array.isArray(payload.unmatched_terms)
    ? payload.unmatched_terms.slice(0, 20).map((item) => ({
        input: cleanString(item.input || item.term || item.raw_term).slice(0, 120),
        source: cleanString(item.source || item.source_field).slice(0, 80),
        reason: cleanString(item.reason).slice(0, 240),
      }))
    : [];

  return {
    ai_status: 'success',
    primary_element_terms: primary,
    scene_terms: scene,
    style_terms: style,
    attribute_terms: attribute,
    unmatched_terms: unmatched,
  };
}

async function mapProposalElementTermsWithAi(proposal = {}, options = {}) {
  const env = options.env || process.env;
  const config = getAiElementMapperConfig(env);
  const terms = options.terms || loadElementTerms();
  const withPrimaryFallback = (mapping) => ensurePrimaryElementTerms(mapping, proposal);

  if (!config.enabled) {
    return withPrimaryFallback(buildEmptyAiElementMapping('disabled', config));
  }

  if (!config.baseUrl || !config.apiKey) {
    return withPrimaryFallback(buildEmptyAiElementMapping('missing_config', config, {
      type: 'missing_config',
      stage: 'config',
      message: 'AI element mapper is not configured.',
      timeout_ms: config.timeoutMs,
    }));
  }

  const tasks = buildMappingTasks(proposal, terms, config.topN);
  const recallCandidatesCount = tasks.reduce((sum, task) => sum + task.candidates.length, 0);
  if (tasks.length === 0 || recallCandidatesCount === 0) {
    return withPrimaryFallback(buildEmptyAiElementMapping('no_recall_candidates', config, {
      type: 'no_recall_candidates',
      stage: 'recall',
      message: 'No element term candidates were recalled from proposal fields.',
      recall_candidates_count: recallCandidatesCount,
    }));
  }

  const requestBody = buildRequestBody(config, tasks);
  const estimatedPromptSizeChars = JSON.stringify(requestBody.messages).length;
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/${config.endpointPath.replace(/^\/+/, '')}`;
  const fetchImpl = options.fetchImpl || global.fetch;
  const startedAt = Date.now();

  if (typeof fetchImpl !== 'function') {
    return withPrimaryFallback(buildEmptyAiElementMapping('error', config, {
      type: 'missing_fetch',
      stage: 'request',
      message: 'No fetch implementation is available.',
      timeout_ms: config.timeoutMs,
      recall_candidates_count: recallCandidatesCount,
      estimated_prompt_size_chars: estimatedPromptSizeChars,
    }));
  }

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
      return withPrimaryFallback(buildEmptyAiElementMapping('error', config, {
        type: 'http_error',
        stage: 'response',
        message: `AI request failed with HTTP ${response.status}.`,
        http_status: response.status,
        content_type: contentType,
        response_preview: safePreview(responseText),
        duration_ms: durationMs,
        timeout_ms: config.timeoutMs,
        recall_candidates_count: recallCandidatesCount,
        estimated_prompt_size_chars: estimatedPromptSizeChars,
      }));
    }

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (_error) {
      return withPrimaryFallback(buildEmptyAiElementMapping('error', config, {
        type: 'json_parse_error',
        stage: 'response_parse',
        message: 'AI response was not valid JSON.',
        http_status: response.status,
        content_type: contentType,
        response_preview: safePreview(responseText),
        duration_ms: durationMs,
        timeout_ms: config.timeoutMs,
        recall_candidates_count: recallCandidatesCount,
        estimated_prompt_size_chars: estimatedPromptSizeChars,
      }));
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (!content) {
      return withPrimaryFallback(buildEmptyAiElementMapping('error', config, {
        type: 'empty_ai_result',
        stage: 'message_content',
        message: 'AI response did not include message content.',
        http_status: response.status,
        content_type: contentType,
        response_preview: safePreview(responseText),
        duration_ms: durationMs,
        timeout_ms: config.timeoutMs,
        recall_candidates_count: recallCandidatesCount,
        estimated_prompt_size_chars: estimatedPromptSizeChars,
      }));
    }

    let payload;
    try {
      payload = typeof content === 'string' ? JSON.parse(content) : content;
    } catch (_error) {
      return withPrimaryFallback(buildEmptyAiElementMapping('error', config, {
        type: 'json_parse_error',
        stage: 'content_parse',
        message: 'AI message content was not valid JSON.',
        http_status: response.status,
        content_type: contentType,
        response_preview: safePreview(content),
        duration_ms: durationMs,
        timeout_ms: config.timeoutMs,
        recall_candidates_count: recallCandidatesCount,
        estimated_prompt_size_chars: estimatedPromptSizeChars,
      }));
    }

    const validated = normalizePrimaryGraphicElementSource(
      validateAiPayload(payload, tasks, terms),
      proposal,
    );
    return withPrimaryFallback({
      ...buildEmptyAiElementMapping('success', config),
      ...validated,
      summary: {
        primary_count: validated.primary_element_terms.length,
        scene_count: validated.scene_terms.length,
        style_count: validated.style_terms.length,
        attribute_count: validated.attribute_terms.length,
        unmatched_count: validated.unmatched_terms.length,
      },
      ai_error: null,
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const isTimeout = error?.name === 'AbortError';
    return withPrimaryFallback(buildEmptyAiElementMapping('error', config, {
      type: isTimeout ? 'timeout' : 'unknown_error',
      stage: isTimeout ? 'timeout' : 'request',
      message: isTimeout ? 'AI request timed out.' : 'AI request failed.',
      duration_ms: durationMs,
      timeout_ms: config.timeoutMs,
      recall_candidates_count: recallCandidatesCount,
      estimated_prompt_size_chars: estimatedPromptSizeChars,
    }));
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  DEFAULT_MODEL,
  buildMappingTasks,
  ensurePrimaryElementTerms,
  extractPrimaryThemeStandard,
  extractReferencedImageIndexes,
  getAiElementMapperConfig,
  hasRealGraphicElementRequirement,
  mapProposalElementTermsWithAi,
  recallCandidateTerms,
  selectReferencedImages,
  validateAiPayload,
};
