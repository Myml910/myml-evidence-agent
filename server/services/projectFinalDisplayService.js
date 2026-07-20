const crypto = require('crypto');
const {
  composeFinalPrompt,
  getAiFinalPromptComposerConfig,
} = require('./aiFinalPromptComposer');
const {
  generatePatternImage,
  getAiImageGeneratorConfig,
} = require('./aiImageGenerator');
const {
  analyzeMaterialShapeLevels,
  getAiMaterialShapeAnalyzerConfig,
} = require('./aiMaterialShapeAnalyzer');
const {
  getLatestProjectRunForCode,
  getProjectRunsForCode,
  recordProjectRunMetadata,
  recordProjectRunProgress,
  recordProjectGenerationResult,
} = require('./projectRunStore');
const {
  persistProjectReferenceImages,
  referenceSourceHash,
} = require('./projectReferenceMediaStore');

const FINAL_DISPLAY_PROMPT_TEMPLATE_ID = 'structured_ai';
const FINAL_DISPLAY_FINAL_GENERATION_SOURCE = 'automated_flow_final_generation';
const FINAL_DISPLAY_FLOW_VERSION = 'category_full_v1';
const MATERIAL_BOARD_REVERSE_PROMPT_TEMPLATE_ID = 'material_board_reverse';
const GENERATION_MATERIAL_MIN_SCORE = 0.8;
const AGENT_FLOW_MAX_RETRIES = 3;
const MAX_DESIGN_REFERENCE_MATERIAL_IMAGES = 4;
const DESIGN_REFERENCE_SOURCE_FIELD = 'design_img';
const EXTERNAL_EVIDENCE_SOURCE_FIELD = 'external_evidence_img';
const MATERIAL_SHAPE_LEVELS = [
  {
    key: 'primary',
    label: 'Primary material',
    title: 'primary shape / core hero material',
    focus: 'Only the strongest existing hero motif, main title lettering, core icon, character, badge, or largest visual unit. This is not an all-elements collection.',
    countRule: 'Keep 1-3 independent core subjects at most. It is better to extract fewer clear primary materials than to include a full product board.',
    hardBoundary: 'Do not include whole product carriers, complete plate/napkin/cup/packaging layouts, full screenshot boards, repeated strips, secondary frames, or tertiary scatter marks.',
    output: 'A clean material image with large, clear, complete primary assets that can be placed into the history layout as the main visual.',
  },
  {
    key: 'secondary',
    label: 'Secondary material',
    title: 'secondary shape / supporting structure material',
    focus: 'Existing supporting icons, frames, borders, corner ornaments, medium motifs, ribbons, banners, and layout-supporting decorative structures.',
    countRule: 'Keep 4-12 medium-weight reusable assets. Exclude the full primary hero, full title lockups, and excessive tiny scatter marks.',
    hardBoundary: 'Do not repeat the primary hero material, do not include complete product pages, and do not include long full material strips as one object.',
    output: 'A clean material image with reusable supporting assets for borders, corners, surrounding decoration, and series variation.',
  },
  {
    key: 'tertiary',
    label: 'Tertiary material',
    title: 'tertiary shape / small accent material',
    focus: 'Existing lightweight accents such as dots, small stars, sparkles, texture marks, tiny icons, micro patterns, and repeated rhythm marks.',
    countRule: 'Keep many small accents only when they already exist in the input image. Do not include readable main text, primary icons, or medium frames.',
    hardBoundary: 'Do not include primary title lockups, full badges, complete main icons, medium border groups, product carriers, or screenshot information.',
    output: 'A clean material image with small accent marks and background-supporting details for density control.',
  },
];
const ACCEPTED_ELEMENT_SOURCES = new Set([
  'gallery_material_unified_cleanup',
  'gallery_material_split_cleanup',
  'company_design_reference_split',
  'design_reference_unified_regeneration',
]);
const ACCEPTED_FINAL_SOURCES = new Set([
  FINAL_DISPLAY_FINAL_GENERATION_SOURCE,
  'manual_final_generation',
]);
const DEFAULT_FAILED_JOB_RESULT_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_FINAL_DISPLAY_AI_MAX_CONCURRENCY = 8;
const DEFAULT_FINAL_DISPLAY_STAGE_CONCURRENCY = 2;
const DEFAULT_FINAL_DISPLAY_JOB_TIMEOUT_MS = 28 * 60 * 1000;
const DEFAULT_FINAL_DISPLAY_AI_CALL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_FINAL_DISPLAY_RETRY_BASE_DELAY_MS = 2 * 1000;
const COMPLETED_JOB_RESULT_CACHE_MS = 30 * 60 * 1000;
const PROJECT_DATA_LAYER_LOOKUP_TIMEOUT_MS = 20 * 1000;
const activeFinalDisplayJobs = new Map();

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const FAILED_JOB_RESULT_CACHE_MS = positiveInteger(
  process.env.FINAL_DISPLAY_FAILED_JOB_CACHE_MS,
  DEFAULT_FAILED_JOB_RESULT_CACHE_MS,
);
const FINAL_DISPLAY_AI_MAX_CONCURRENCY = positiveInteger(
  process.env.FINAL_DISPLAY_AI_MAX_CONCURRENCY,
  DEFAULT_FINAL_DISPLAY_AI_MAX_CONCURRENCY,
);
const FINAL_DISPLAY_STAGE_CONCURRENCY = positiveInteger(
  process.env.FINAL_DISPLAY_STAGE_CONCURRENCY,
  DEFAULT_FINAL_DISPLAY_STAGE_CONCURRENCY,
);
const FINAL_DISPLAY_JOB_TIMEOUT_MS = positiveInteger(
  process.env.FINAL_DISPLAY_JOB_TIMEOUT_MS,
  DEFAULT_FINAL_DISPLAY_JOB_TIMEOUT_MS,
);
const FINAL_DISPLAY_AI_CALL_TIMEOUT_MS = positiveInteger(
  process.env.FINAL_DISPLAY_AI_CALL_TIMEOUT_MS,
  DEFAULT_FINAL_DISPLAY_AI_CALL_TIMEOUT_MS,
);
const FINAL_DISPLAY_RETRY_BASE_DELAY_MS = positiveInteger(
  process.env.FINAL_DISPLAY_RETRY_BASE_DELAY_MS,
  DEFAULT_FINAL_DISPLAY_RETRY_BASE_DELAY_MS,
);

function finalDisplayTimeoutError(stage = 'project_final_display') {
  const error = new Error('Project final display generation exceeded its execution deadline.');
  error.statusCode = 504;
  error.code = 'EVIDENCE_AGENT_FINAL_DISPLAY_TIMEOUT';
  error.retryable = false;
  error.stepName = stage;
  return error;
}

function createAsyncGate(limit) {
  let active = 0;
  const waiting = [];

  function grantNext() {
    while (waiting.length > 0) {
      const entry = waiting.shift();
      if (entry.cancelled) continue;
      entry.granted = true;
      clearTimeout(entry.timeout);
      active += 1;
      entry.resolve();
      return;
    }
  }

  async function acquire(deadlineAt) {
    if (active < limit) {
      active += 1;
      return;
    }

    await new Promise((resolve, reject) => {
      const entry = {
        cancelled: false,
        granted: false,
        resolve,
        timeout: null,
      };
      const remainingMs = Number(deadlineAt) - Date.now();
      if (Number.isFinite(remainingMs)) {
        if (remainingMs <= 0) {
          reject(finalDisplayTimeoutError());
          return;
        }
        entry.timeout = setTimeout(() => {
          if (entry.granted) return;
          entry.cancelled = true;
          reject(finalDisplayTimeoutError());
        }, remainingMs);
        entry.timeout.unref?.();
      }
      waiting.push(entry);
    });
  }

  return async function runWithGate(action, options = {}) {
    await acquire(options.deadlineAt);
    try {
      if (Number.isFinite(Number(options.deadlineAt)) && Date.now() >= Number(options.deadlineAt)) {
        throw finalDisplayTimeoutError();
      }
      return await action();
    } finally {
      active -= 1;
      grantNext();
    }
  };
}

const runWithFinalDisplayAiPermit = createAsyncGate(FINAL_DISPLAY_AI_MAX_CONCURRENCY);

function createFinalDisplayJobDeadline(dependencies = {}) {
  return Date.now() + positiveInteger(
    dependencies.finalDisplayJobTimeoutMs,
    FINAL_DISPLAY_JOB_TIMEOUT_MS,
  );
}

function deadlineBoundProviderOptions({
  deadlineAt,
  envKey,
  configuredTimeoutMs,
  maxCallTimeoutMs,
  stage,
}) {
  const remainingMs = Number(deadlineAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw finalDisplayTimeoutError(stage);
  }

  const timeoutMs = Math.max(1, Math.min(
    positiveInteger(configuredTimeoutMs, maxCallTimeoutMs),
    positiveInteger(maxCallTimeoutMs, FINAL_DISPLAY_AI_CALL_TIMEOUT_MS),
    remainingMs,
  ));
  return {
    deadlineAt,
    timeoutMs,
    env: {
      ...process.env,
      [envKey]: String(timeoutMs),
    },
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const source = Array.isArray(items) ? items : [];
  if (source.length === 0) return [];

  const results = new Array(source.length);
  let nextIndex = 0;
  let firstError = null;
  const workers = Array.from(
    { length: Math.min(positiveInteger(limit, 1), source.length) },
    async () => {
      while (nextIndex < source.length && !firstError) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await mapper(source[index], index);
        } catch (error) {
          firstError = firstError || error;
        }
      }
    },
  );
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function categoryScopedGenerationLabel(category, label) {
  const cleanCategory = cleanString(category) || 'uncategorized';
  return `${cleanCategory} · ${cleanString(label) || 'Generated image'}`;
}

function finalDisplayRequestId(request) {
  return cleanString(
    request?.body?.requestId ||
    request?.body?.request_id ||
    request?.headers?.['x-myml-request-id'] ||
    request?.get?.('x-myml-request-id'),
  );
}

function normalizeProjectCode(value) {
  const code = cleanString(value).toUpperCase();
  return /^YXF\d{10}$/.test(code) ? code : '';
}

function safeBaseUrl(value) {
  const raw = cleanString(value);
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/g, '');
    return parsed.toString().replace(/\/+$/g, '');
  } catch (_error) {
    return '';
  }
}

function safeImageUrl(value) {
  const raw = cleanString(value);
  if (!raw || /^data:/i.test(raw) || /^javascript:/i.test(raw)) return '';
  if (/^[a-z]:[\\/]/i.test(raw) || /^\\\\/.test(raw)) return '';

  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_error) {
    return '';
  }
}

function rootRelativePublicUrl(value) {
  const raw = cleanString(value);
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '';
  return raw.split('?')[0].split('#')[0];
}

function absolutePublicUrl(value, publicBaseUrl = '') {
  const absoluteUrl = safeImageUrl(value);
  if (absoluteUrl) return absoluteUrl;

  const relativeUrl = rootRelativePublicUrl(value);
  if (!relativeUrl) return '';

  const baseUrl = safeBaseUrl(publicBaseUrl);
  return baseUrl ? `${baseUrl}${relativeUrl}` : relativeUrl;
}

function safeFilename(value) {
  return cleanString(value).split(/[\\/]/).filter(Boolean).pop() || '';
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRunId(projectCode) {
  return `prun-${projectCode}-final-display-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function listFromText(value, maxItems = 12) {
  return String(value || '')
    .split(/[\n\r,;，；、]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function visibleTextElementSummary(value) {
  return String(value || '')
    .split(/[\n\r,;，；、]+/)
    .map((item) => normalizeVisibleDesignText(item))
    .filter((item) => /[a-z0-9]/i.test(item))
    .filter(Boolean)
    .slice(0, 8)
    .join('; ');
}

function normalizeVisibleDesignText(value) {
  return cleanString(value)
    .replace(/[\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:："'“”‘’\-]+|[\s:："'“”‘’\-]+$/g, '');
}

function sanitizeDesignRequirementForGeneration(value) {
  const fragments = String(value || '')
    .replace(/\r?\n/g, ';')
    .split(/[;；。!！?？]+/)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
  const keepPattern = /(文案|文字|图案|风格|参考图|配色|颜色|色系|底色|背景|渐变|可爱|卡通|线条|排版|主题|palette|color|background|gradient|style|reference|ref|text|copy|theme|happy|birthday|halloween|diwali|navidad|christmas|thank|pastor|flirty|thriving)/i;
  const sizeOnlyPattern = /(尺寸|规格|大小|cm|mm|厘米|毫米|英寸|直径|长|宽|高|大餐盘|小餐盘|纸巾|杯套|刀模)/i;

  return fragments
    .map((fragment) => fragment
      .replace(/\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|in)\b/gi, '')
      .replace(/\d+(?:\.\d+)?\s*(?:厘米|毫米|英寸)/g, '')
      .replace(/\d+(?:\.\d+)?\s*[*x×]\s*\d+(?:\.\d+)?/gi, '')
      .trim())
    .filter(Boolean)
    .filter((fragment) => keepPattern.test(fragment) || !sizeOnlyPattern.test(fragment))
    .slice(0, 10)
    .join('; ');
}

function parseChineseReferenceNumber(value) {
  const raw = cleanString(value);
  if (!raw) return 0;

  const direct = Number(raw);
  if (Number.isInteger(direct) && direct > 0) {
    return direct;
  }

  const normalized = raw.replace(/\s+/g, '');
  const digitMap = {
    '一': 1,
    '二': 2,
    '两': 2,
    '三': 3,
    '四': 4,
    '五': 5,
    '六': 6,
    '七': 7,
    '八': 8,
    '九': 9,
    '十': 10,
  };

  if (digitMap[normalized]) {
    return digitMap[normalized];
  }
  if (normalized === '十一') return 11;
  if (normalized === '十二') return 12;
  if (normalized.startsWith('十')) {
    return 10 + (digitMap[normalized.slice(1)] || 0);
  }
  if (normalized.endsWith('十')) {
    return (digitMap[normalized.slice(0, -1)] || 0) * 10;
  }
  if (normalized.includes('十')) {
    const [tens, ones] = normalized.split('十');
    return (digitMap[tens] || 0) * 10 + (digitMap[ones] || 0);
  }

  return 0;
}

function referenceIndicesFromRequirementText(value) {
  const indices = new Set();
  const referenceNumberGroupPattern = /[0-9]+|[一二两三四五六七八九十]+/g;
  const patterns = [
    /(?:公司)?(?:设计)?(?:参考)?\s*(?:图|图片)\s*[:：#-]?\s*([0-9一二两三四五六七八九十、,，和及\s]+)/g,
    /第\s*([0-9一二两三四五六七八九十]+)\s*(?:张)?\s*(?:公司)?(?:设计)?(?:参考)?\s*(?:图|图片)/g,
    /(?:style|reference|ref)\s*(?:image|img|fig|figure)?\s*#?\s*([0-9,\s]+)/gi,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(String(value || ''));
    while (match) {
      const numberGroup = match[1] || '';
      const numberMatches = numberGroup.match(referenceNumberGroupPattern) || [];
      for (const numberText of numberMatches) {
        const parsed = parseChineseReferenceNumber(numberText);
        if (parsed > 0) {
          indices.add(parsed);
        }
      }
      match = pattern.exec(String(value || ''));
    }
  }

  return Array.from(indices).sort((left, right) => left - right);
}

function designRequirementRoles(value) {
  const roles = [];
  if (/(形状|外形|轮廓|刀模|款式)/i.test(value)) roles.push('shape/outline reference');
  if (/(图案|主体|主图|元素|装饰|角色)/i.test(value)) roles.push('motif material reference');
  if (/(排版|布局|版式|位置|一面|另一面)/i.test(value)) roles.push('layout/placement reference');
  if (/(文案|文字|字体|字形|标题)/i.test(value)) roles.push('text/lettering reference');
  if (/(配色|颜色|色系|底色|背景|黑色|白色|紫色|蓝色|粉色|红色|绿色|黄色|橙色)/i.test(value)) roles.push('color/background reference');
  if (/(风格|可爱|卡通|童趣|复古|简约|高端|酷|温馨)/i.test(value)) roles.push('style reference');
  return Array.from(new Set(roles.length > 0 ? roles : ['development requirement reference']));
}

function collectDesignRequirementImageDirectives(proposal = {}) {
  const designRequirement = String(proposal.design_requirement || proposal.development_requirement || '');
  const directiveMap = new Map();
  const fragments = designRequirement
    .replace(/\r?\n/g, '，')
    .split(/[，,；;。.!！?？]+/)
    .map((fragment) => fragment.trim())
    .filter(Boolean);

  fragments.forEach((fragment, index) => {
    const referenceIndices = referenceIndicesFromRequirementText(fragment);
    if (referenceIndices.length === 0) return;
    const previousFragment = fragments[index - 1] || '';
    const referenceOnly = /^(?:见|看|参考|按|按照|跟|根据)?\s*(?:公司)?(?:设计)?(?:参考)?\s*(?:图|图片)\s*[:：#-]?\s*[0-9一二两三四五六七八九十、,，和及\s]+$/i.test(fragment);
    const directive = (
      referenceOnly && previousFragment && referenceIndicesFromRequirementText(previousFragment).length === 0
        ? `${previousFragment}，${fragment}`
        : fragment
    ).slice(0, 240);
    const roles = designRequirementRoles(directive);
    referenceIndices.forEach((referenceIndex) => {
      const current = directiveMap.get(referenceIndex) || { directives: [], roles: [] };
      directiveMap.set(referenceIndex, {
        directives: Array.from(new Set([...current.directives, directive])),
        roles: Array.from(new Set([...current.roles, ...roles])),
      });
    });
  });

  return directiveMap;
}

function collectDesignRequirementReferenceIndices(proposal = {}) {
  const designRequirement = String(proposal.design_requirement || proposal.development_requirement || '');
  const directiveIndices = Array.from(collectDesignRequirementImageDirectives(proposal).keys());
  return Array.from(new Set([
    ...directiveIndices,
    ...referenceIndicesFromRequirementText(designRequirement),
  ])).sort((left, right) => left - right);
}

function projectPreviewFromLookup(result) {
  const proposal = result?.proposal || {};
  const rawDesignRequirement = cleanString(proposal.design_requirement || proposal.development_requirement);
  const categoryTargets = categoryTargetsFromLookup(result);
  const categorySummary = categoryTargets.length > 0
    ? categoryTargets.map((target) => target.category).join(' / ')
    : cleanString(result?.category_judgment?.predicted_category || proposal.category_label || proposal.category);
  return {
    projectCode: result?.project_code || proposal.project_code || '',
    title: cleanString(proposal.project_name).slice(0, 220),
    category: categorySummary.slice(0, 180),
    graphicElements: cleanString(proposal.ai_graphic_elements || proposal.element_requirement || proposal.real_graphic_elements).slice(0, 500),
    textElements: visibleTextElementSummary(proposal.text_elements).slice(0, 500),
    designRequirement: sanitizeDesignRequirementForGeneration(rawDesignRequirement).slice(0, 1000),
    rawDesignRequirement: rawDesignRequirement.slice(0, 1600),
  };
}

function selectedMaterialImagesFromLookup(result) {
  const projectCode = result?.project_code || result?.proposal?.project_code || '';
  const selected = Array.isArray(result?.selected_gallery_images?.selected_images)
    ? result.selected_gallery_images.selected_images
    : [];

  return selected
    .filter((image) => {
      const score = Number(image.match_score);
      return !Number.isFinite(score) || score >= GENERATION_MATERIAL_MIN_SCORE;
    })
    .slice(0, 2)
    .map((image, index) => {
      const imageUrl = safeImageUrl(image.url || image.image_url);
      if (!imageUrl) return null;
      return {
        id: cleanString(image.image_id) || `gallery_material_${projectCode}_${index + 1}`,
        projectCode,
        title: cleanString(image.filename || image.label) || `Selected material ${index + 1}`,
        category: 'selected_gallery_material',
        source: 'company_gallery_material',
        filename: safeFilename(image.filename || image.url || image.image_url),
        imageUrl,
        thumbnailUrl: imageUrl,
      };
    })
    .filter(Boolean);
}

function designReferenceImagesFromLookup(result) {
  const projectCode = result?.project_code || result?.proposal?.project_code || '';
  const proposal = result?.proposal || {};
  const referenceImages = Array.isArray(proposal.reference_images) ? proposal.reference_images : [];
  const designImages = referenceImages.filter((image) => image?.source_field === DESIGN_REFERENCE_SOURCE_FIELD);
  const externalEvidenceImages = referenceImages.filter((image) => image?.source_field === EXTERNAL_EVIDENCE_SOURCE_FIELD);
  const sourceImages = designImages.length > 0 ? designImages : externalEvidenceImages;
  const sourceLabel = designImages.length > 0 ? 'Company design reference' : 'External evidence reference';
  const requestedIndices = collectDesignRequirementReferenceIndices(proposal);
  const requestedIndexSet = new Set(requestedIndices);
  const imageDirectiveMap = collectDesignRequirementImageDirectives(proposal);
  const indexedImages = sourceImages
    .filter((image) => safeImageUrl(image.url))
    .map((image, index) => ({
      image,
      referenceIndex: index + 1,
    }));
  const selectedImages = requestedIndices.length > 0
    ? indexedImages.filter((item) => requestedIndexSet.has(item.referenceIndex))
    : indexedImages.slice(0, MAX_DESIGN_REFERENCE_MATERIAL_IMAGES);
  const finalImages = selectedImages.length > 0
    ? selectedImages
    : indexedImages.slice(0, MAX_DESIGN_REFERENCE_MATERIAL_IMAGES);

  return finalImages
    .slice(0, MAX_DESIGN_REFERENCE_MATERIAL_IMAGES)
    .map(({ image, referenceIndex }) => {
      const imageUrl = safeImageUrl(image.url);
      if (!imageUrl) return null;
      const imageDirective = imageDirectiveMap.get(referenceIndex);
      const designRequirementDirective = imageDirective?.directives.join('; ') || '';
      const designRequirementRoleList = imageDirective?.roles || [];
      return {
        id: `company_design_reference_${projectCode}_${referenceIndex}`,
        projectCode,
        title: cleanString(image.label) || `${sourceLabel} ${referenceIndex}`,
        category: designImages.length > 0 ? 'company_design_reference' : 'external_evidence_reference',
        source: designImages.length > 0 ? 'company_project_data' : 'external_evidence_data',
        filename: safeFilename(image.filename || image.raw_path),
        imageUrl,
        thumbnailUrl: imageUrl,
        sourceField: image.source_field,
        referenceIndex,
        selectedByDesignRequirement: requestedIndexSet.has(referenceIndex),
        designRequirementDirective,
        designRequirementRoles: designRequirementRoleList,
      };
    })
    .filter(Boolean);
}

function designReferenceSourceLabel(images = []) {
  return images.some((image) => image.sourceField === EXTERNAL_EVIDENCE_SOURCE_FIELD)
    ? 'external evidence material'
    : 'company design reference material';
}

function referenceImageForDataLayer(image, index) {
  const sourceField = cleanString(image?.source_field);
  const imageUrl = safeImageUrl(image?.url);
  if (!imageUrl) return null;
  return {
    id: `reference_${sourceField || 'image'}_${index + 1}`,
    index: index + 1,
    sourceField,
    role: sourceField === DESIGN_REFERENCE_SOURCE_FIELD
      ? 'design_reference'
      : sourceField === EXTERNAL_EVIDENCE_SOURCE_FIELD
        ? 'external_evidence_reference'
        : 'operation_or_other_reference',
    label: cleanString(image.label) || `Reference image ${index + 1}`,
    filename: safeFilename(image.filename || image.raw_path || image.url),
    imageUrl,
    thumbnailUrl: imageUrl,
    usageScenario: sourceField === DESIGN_REFERENCE_SOURCE_FIELD
      ? 'Used by the material extraction and final prompt data layer as company design reference. The original image is not passed as final image-generation input.'
      : sourceField === EXTERNAL_EVIDENCE_SOURCE_FIELD
        ? 'Fallback material evidence only when company design references are unavailable. The original external image is not passed as final image-generation input.'
        : 'Company operation/reference image for data display only; not used as the main design material source by default.',
  };
}

function buildProjectDataLayerFromLookup(result) {
  const proposal = result?.proposal || {};
  const referenceImages = Array.isArray(proposal.reference_images) ? proposal.reference_images : [];
  const mappedReferenceImages = referenceImages
    .map(referenceImageForDataLayer)
    .filter(Boolean);
  const designReferenceImages = mappedReferenceImages.filter((image) => image.sourceField === DESIGN_REFERENCE_SOURCE_FIELD);
  const operationReferenceImages = mappedReferenceImages.filter((image) => image.sourceField !== DESIGN_REFERENCE_SOURCE_FIELD);
  const graphicElementsRaw = cleanString(
    proposal.ai_graphic_elements ||
    proposal.element_requirement ||
    proposal.real_graphic_elements,
  );
  const visibleText = visibleTextElementSummary(proposal.text_elements);
  const categoryTargets = categoryTargetsFromLookup(result);
  const categorySummary = categoryTargets.length > 0
    ? categoryTargets.map((target) => target.category).join(' / ')
    : cleanString(result?.category_judgment?.predicted_category || proposal.category_label || proposal.category);

  return {
    projectCode: result?.project_code || proposal.project_code || '',
    trueCategory: categorySummary,
    sections: {
      categoryTargets: {
        title: 'category_targets',
        count: categoryTargets.length,
        items: categoryTargets.map((target) => ({
          category: target.category,
          confidence: target.confidence,
          reason: target.reason,
          hasHistoryTemplate: Boolean(historyImageFromCategoryTarget(result, target)),
        })),
        usageScenario: 'For combo-category proposals, material extraction runs once while final prompt and final generation are repeated for each category-specific history layout template.',
      },
      designReferenceImages: {
        title: 'company_design_reference_images',
        count: designReferenceImages.length,
        items: designReferenceImages,
        usageScenario: 'Primary company reference source for extracting usable design materials, background/color cues, and design-language signals. Originals are not used directly as final image-generation inputs.',
      },
      graphicElements: {
        title: 'graphic_elements',
        aiExtracted: listFromText(graphicElementsRaw, 20),
        raw: graphicElementsRaw,
        realCompanyRaw: cleanString(proposal.real_graphic_elements),
        usageScenario: 'Controls the required motif/theme boundary for material filtering, material shape analysis, and final prompt composition.',
      },
      textElements: {
        title: 'text_elements',
        visible: listFromText(visibleText, 12),
        raw: cleanString(proposal.text_elements),
        usageScenario: 'Only visible English/number text requirements enter final prompt composition. Chinese notes are treated as instructions, not text to print in the final design.',
      },
      operationReferenceImages: {
        title: 'operation_or_external_reference_images',
        count: operationReferenceImages.length,
        items: operationReferenceImages,
        usageScenario: 'Displayed for traceability. Operation references are not default design-material inputs; external evidence is fallback only when no company design reference is available.',
      },
    },
  };
}

function buildFinalDisplayView(run, dataLayer = null) {
  const safeRun = run || {};
  const projectDataLayer = dataLayer || safeRun.projectDataLayer || null;
  return {
    materialImageBlock: Array.isArray(safeRun.elementImages) ? safeRun.elementImages : [],
    finalImageGeneration: Array.isArray(safeRun.finalDesignImages) ? safeRun.finalDesignImages : [],
    projectDataLayer,
  };
}

function recordProjectDataLayerForRun({
  dependencies,
  normalizedCode,
  runId,
  project,
  designReferenceImages,
  dataLayer,
}) {
  if (!runId || !dataLayer) {
    return null;
  }

  const recordMetadata = dependencies.recordProjectRunMetadata || recordProjectRunMetadata;
  return recordMetadata({
    project_code: normalizedCode,
    project_run_id: runId,
  }, {
    project,
    designReferenceImages,
    projectDataLayer: dataLayer,
    flowVersion: FINAL_DISPLAY_FLOW_VERSION,
  });
}

async function lookupProjectDataLayer({ normalizedCode, request, dependencies }) {
  const lookupProject = typeof dependencies.prepareCompanyProjectDataLayerLookup === 'function'
    ? dependencies.prepareCompanyProjectDataLayerLookup
    : dependencies.prepareProjectDataLayerFromCompanyLookup || dependencies.prepareProposalFromCompanyLookup;
  if (typeof lookupProject !== 'function') {
    return null;
  }

  const publicBaseUrl = dependencies.publicBaseUrlFromRequest?.(request) || '';
  try {
    const lookup = await lookupProject({
      projectCode: normalizedCode,
      publicBaseUrl,
    });
    if (!lookup?.found) {
      return null;
    }
    return {
      lookup,
      project: projectPreviewFromLookup(lookup),
      dataLayer: buildProjectDataLayerFromLookup(lookup),
    };
  } catch (_error) {
    return null;
  }
}

async function lookupProjectDataLayerWithTimeout(args, timeoutMs = PROJECT_DATA_LAYER_LOOKUP_TIMEOUT_MS) {
  let timeout = null;
  try {
    return await Promise.race([
      lookupProjectDataLayer(args),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function categoryTargetsFromLookup(result) {
  const judgment = result?.category_judgment || {};
  const imageByCategory = new Map(
    (Array.isArray(judgment.category_images) ? judgment.category_images : [])
      .filter((image) => cleanString(image?.category))
      .map((image) => [cleanString(image.category), image]),
  );
  const rawTargets = Array.isArray(judgment.predicted_categories) && judgment.predicted_categories.length > 0
    ? judgment.predicted_categories
    : judgment.predicted_category
      ? [{
          category: judgment.predicted_category,
          confidence: judgment.confidence,
          reason: judgment.reason,
          category_image: judgment.category_image,
        }]
      : [];
  const seen = new Set();

  return rawTargets
    .map((target) => {
      const category = cleanString(target?.category || target?.predicted_category);
      const key = category.toLocaleLowerCase();
      if (!category || seen.has(key)) {
        return null;
      }
      seen.add(key);
      return {
        category,
        confidence: Number(target.confidence) || 0,
        reason: cleanString(target.reason),
        categoryImage: target.category_image ||
          imageByCategory.get(category) ||
          (cleanString(judgment.category_image?.category) === category ? judgment.category_image : null),
      };
    })
    .filter(Boolean);
}

function historyImageFromCategoryTarget(result, target) {
  const categoryImage = target?.categoryImage || result?.category_judgment?.category_image;
  const candidates = Array.isArray(categoryImage?.history_images) && categoryImage.history_images.length > 0
    ? categoryImage.history_images
    : categoryImage
      ? [categoryImage]
      : [];
  const usableCandidates = candidates.filter((image) => safeImageUrl(image.image_url));
  if (usableCandidates.length === 0) return null;
  const seed = [
    result?.project_code,
    target?.category || result?.category_judgment?.predicted_category,
    ...usableCandidates.map((image) => image.image_url),
  ].join('|');
  const first = usableCandidates[hashString(seed) % usableCandidates.length];
  return {
    id: `history_layout_${result.project_code}_${hashString(target?.category || categoryImage?.category || 'category')}`,
    role: 'history',
    label: `${target?.category || categoryImage?.category || 'Category'} history layout reference`,
    filename: safeFilename(first.image_filename || first.image_url),
    url: safeImageUrl(first.image_url),
    detail: cleanString(first.note).slice(0, 300) || 'History layout reference for final design generation.',
  };
}

function historyImageFromLookup(result) {
  const target = categoryTargetsFromLookup(result)[0] || null;
  return historyImageFromCategoryTarget(result, target);
}

function imageInputsFromProjectImages(images, role, detail) {
  return images.map((image, index) => ({
    id: image.id,
    role,
    label: image.title || `Project image ${index + 1}`,
    filename: image.filename || `${image.id}.png`,
    url: image.imageUrl,
    detail: [
      detail,
      image.designRequirementDirective
        ? `Development requirement for reference image ${image.referenceIndex || index + 1}: ${image.designRequirementDirective}.`
        : '',
      Array.isArray(image.designRequirementRoles) && image.designRequirementRoles.length > 0
        ? `This image must serve only these roles during material extraction: ${image.designRequirementRoles.join(', ')}. Do not mix its role with another reference image.`
        : '',
    ].filter(Boolean).join(' '),
    designRequirementDirective: cleanString(image.designRequirementDirective),
    designRequirementRoles: Array.isArray(image.designRequirementRoles)
      ? image.designRequirementRoles
      : [],
    referenceIndex: Number(image.referenceIndex) || index + 1,
  }));
}

function imageInputsFromRunImages(images, publicBaseUrl = '') {
  return images
    .map((image, index) => ({
      id: image.id || `element-${index + 1}`,
      role: 'material',
      label: image.title || `Split element image ${index + 1}`,
      filename: `${image.id || `element-${index + 1}`}.png`,
      url: absolutePublicUrl(image.imageUrl, publicBaseUrl),
      detail: 'Generated material image from the project production flow.',
    }))
    .filter((image) => image.url);
}

function materialShapeAnalysisRequiresSplit(analysis) {
  return !analysis || analysis.status !== 'success' || analysis.split_required !== false;
}

function materialShapeAnalysisSummary(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    return 'shape analysis unavailable';
  }

  return [
    analysis.split_required === false ? 'split not required' : 'split required',
    cleanString(analysis.split_reason),
    cleanString(analysis.single_material_guidance),
  ].filter(Boolean).join('; ');
}

const MATERIAL_BOARD_REVERSE_PROMPT_TEMPLATE = [
  '## Image Prompt Description',
  '',
  '**1. Core Subject & Theme (核心主体与主题):**',
  '[Summarize the main content in one sentence]',
  '',
  '**2. Art Style & Medium (艺术风格与媒介):**',
  '[Describe the art style, medium, lines, and aesthetic]',
  '',
  '**3. Color Palette & Lighting (配色与光影):**',
  '[Describe colors, lighting quality, and atmosphere]',
  '',
  '**4. Composition & Perspective (构图与视角):**',
  '[Describe layout, balance, and view angle]',
  '',
  '**5. Detailed Visual Elements (分层细节描述):**',
  '',
  '*   **Main Focus (Center/Midground):** [Describe the core elements]',
  '*   **Background & Atmosphere:** [Describe the setting and environment]',
  '*   **Foreground & Framing:** [Describe foreground elements]',
  '*   **Specific Details/Props:** [Describe specific objects, patterns]',
  '',
  '**6. Text & Typography (If any):**',
  '[Describe text content and font style if applicable. If none, write "None".]',
].join('\n');

function buildMaterialBoardReversePrompt(sourceLabel, sourceNames, shapeAnalysis) {
  return [
    'Analyze the provided unified material board and describe only the visual content that already exists in the image.',
    `Material source: ${sourceLabel}. Source images: ${sourceNames || '-'}.`,
    shapeAnalysis ? `Previous AI shape decision: ${materialShapeAnalysisSummary(shapeAnalysis)}.` : '',
    'Return only the requested Markdown visual description. Do not explain the workflow and do not add extra sections.',
    '',
    MATERIAL_BOARD_REVERSE_PROMPT_TEMPLATE,
  ].filter(Boolean).join('\n');
}

function buildMaterialBoardRegenerationPrompt(reverseDescription, sourceLabel, sourceNames) {
  return [
    'Generate a new clean unified material board using text-to-image only, based strictly on the reverse-engineered visual description below.',
    '',
    `Material source: ${sourceLabel}. Original source images: ${sourceNames || '-'}.`,
    'This is a material-board regeneration step, not a final product design and not a new theme creation task.',
    'Preserve the motif shapes, lettering shapes, linework, texture, local decorations, border language, and color relationships described below.',
    'Do not add new subjects, new readable text, new icons, new characters, or new decorations that are not described.',
    'Do not recreate the original product carrier, product mockup, screenshot interface, price/platform/store information, measurements, shadows, or scene background.',
    'Output a clean unified material board on a plain background with clear spacing between independent reusable assets. It must be suitable to combine with primary/secondary/tertiary material assets in the final image input.',
    '',
    'Reverse-engineered visual description:',
    reverseDescription,
  ].join('\n');
}

function buildMaterialProcessingPrompt({ sourceLabel, project, shapeLevel, shapeAnalysis, inputImages = [] }) {
  const isSplit = Boolean(shapeLevel);
  const imageRoleBindings = inputImages
    .map((image, index) => cleanString(image.designRequirementDirective)
      ? `Input image ${index + 1}, company reference image ${image.referenceIndex || index + 1} (${image.filename || image.label || image.id}): ${image.designRequirementDirective}. Required role: ${(image.designRequirementRoles || []).join(', ') || 'explicit development requirement reference'}.`
      : '')
    .filter(Boolean)
    .join('\n');
  return [
    `Process ${sourceLabel} into clean reusable material assets for the MYML default automatic flow.`,
    'This is an extraction/cleanup task, not final product design and not theme re-creation.',
    'Only extract, clean, group, and arrange visual assets that already exist in the input images. Do not redraw similar assets from text and do not invent missing objects.',
    isSplit
      ? `Extract only this material layer: ${shapeLevel.title || shapeLevel.label}.`
      : 'AI has judged that forced primary/secondary/tertiary splitting is not needed. Create one unified cleaned material board.',
    project.graphicElements ? `Graphic elements: ${project.graphicElements}` : '',
    project.textElements ? `Text elements: ${project.textElements}` : '',
    project.designRequirement ? `Design requirement directives used only for selection, not for inventing new assets: ${project.designRequirement}` : '',
    imageRoleBindings
      ? `Source-image responsibility bindings. Execute only bindings explicitly present; when no image-specific binding exists, let the AI judge from the visible image content:\n${imageRoleBindings}`
      : '',
    shapeAnalysis?.split_reason ? `Shape analysis: ${shapeAnalysis.split_reason}` : '',
    !shapeLevel && shapeAnalysis?.single_material_guidance
      ? `Unified material guidance: ${shapeAnalysis.single_material_guidance}`
      : '',
    shapeLevel && shapeAnalysis?.levels?.[shapeLevel.key]?.prompt_guidance
      ? `Layer guidance: ${shapeAnalysis.levels[shapeLevel.key].prompt_guidance}`
      : '',
    shapeLevel?.focus ? `Layer focus: ${shapeLevel.focus}` : '',
    shapeLevel?.countRule ? `Layer count boundary: ${shapeLevel.countRule}` : '',
    shapeLevel?.hardBoundary ? `Hard boundary: ${shapeLevel.hardBoundary}` : '',
    shapeLevel?.output ? `Output target: ${shapeLevel.output}` : '',
    'Carrier removal rule: remove product carriers, plates, napkins, cups, forks, packaging, screenshots, product cards, measurements, red size lines, price/platform/store information, watermarks, shadows, scene backgrounds, and non-pattern annotations.',
    'Layer exclusivity rule: do not mix primary, secondary, and tertiary layers in the same output. If this is a unified board, keep independent usable assets separated with clear spacing.',
    'Text rule: keep lettering shapes only when the text already exists in the input image and matches the project text requirement; Chinese notes or platform descriptions are not final design text.',
    'Output form: a clean plain-background material board, with complete edges, clear spacing, and production-friendly reusable assets. Do not output a final product mockup or the original complete reference layout.',
  ].filter(Boolean).join('\n');
}

function buildFinalTemplatePrompt(project, elementImages, hasHistoryImage, inputImages = []) {
  const inputOrder = inputImages
    .map((image, index) => {
      const roleLabel = image.role === 'history'
        ? 'history layout / composition master'
        : image.role === 'material'
          ? 'material image / reusable motif source'
          : image.role || 'reference image';
      return `Image ${index + 1}: ${image.filename || image.label || image.id} | role: ${roleLabel} | detail: ${image.detail || '-'}`;
    })
    .join('\n');
  const materialSummary = elementImages
    .map((image, index) => {
      const source = cleanString(image.source);
      const sourceLabel = source.includes('design_reference')
        ? 'company design reference extracted material'
        : source.includes('gallery')
          ? 'internal gallery material'
          : 'material image';
      return `${index + 1}. ${image.title || image.id || `material ${index + 1}`} (${sourceLabel})`;
    })
    .join('\n');
  const textRequirement = project.textElements
    ? `Required visible text elements: ${project.textElements}. These must appear exactly and readably in the final pattern. Chinese notes in source fields are not final design text.`
    : 'Text element requirement: empty. Do not add new core slogans, Chinese notes, platform words, or readable theme text unless it already exists as a required material shape.';
  const designRequirement = project.designRequirement
    ? `Development design directives after removing carrier size/spec information: ${project.designRequirement}`
    : '';

  return [
    'Current final prompt template branch: structured_ai.',
    'This template is not submitted directly to the image model. A prompt-writing AI must first read the input images and this template, then output the real final prompt for image generation.',
    'The final image-generation input must contain only three blocks: 1) history layout image block, 2) material/reference image block, 3) the AI-composed final prompt.',
    project.title ? `Project title: ${project.title}` : '',
    project.category ? `Product category: ${project.category}` : '',
    project.graphicElements ? `Required main graphic elements: ${project.graphicElements}` : 'Required main graphic elements: use the project development requirement and extracted materials as the theme boundary.',
    textRequirement,
    designRequirement,
    `Material image count: ${elementImages.length}`,
    materialSummary ? `Material image block:\n${materialSummary}` : '',
    inputOrder ? `Input image order is binding:\n${inputOrder}` : '',
    hasHistoryImage
      ? [
          'Input image role rule: image 1 is the history design image / layout master. It controls canvas aspect ratio, layout scale inside the canvas, margins, blank areas, design-unit count, unit positions, unit shapes, density, and repetition rhythm.',
          'Images 2 and later are material images / reusable motif sources. They control existing motif appearance, lettering shapes, linework, texture, local decoration, border language, and color relationships.',
          'History layout strategy: first decide history_layout_lock_policy from the real category and image 1. Use geometry_lock for fixed production structures such as cup sleeves, die lines, packaging, napkins, plates, fixed print slots, and cut templates. Use layout_lock for normal layout/collage/all-over masters. Use flexible_reference only when image 1 is directional or the category requires a free-shape redesign.',
          'If geometry_lock is chosen, the real final prompt must explicitly preserve die-line outlines, red cut-line positions, center waist notches, upper/lower print-slot relations, unit spacing, outer blank areas, and the original canvas aspect ratio. Never stretch, squash, crop, enlarge, shrink, move, or reframe image 1 to fill the output canvas.',
          'If layout_lock or flexible_reference is chosen, do not over-lock every line, but still preserve image 1 canvas aspect ratio, design-unit count, relative positions, scale within canvas, and required blank areas.',
          'Historical content ban: old text, old motifs, old theme, old characters, old scenes, old borders, old background texture, and old colorway from image 1 are forbidden in the new design. Image 1 only controls structure.',
          'Background strategy: white in the history image or extracted material board means blank layout/padding/cutout background, not necessarily the final design background. Background color, gradient, texture, small background elements, and atmosphere should come from development directives and company design-reference material/text signals. Apply backgrounds only inside existing historical design slots; keep outside-slot padding, dimension areas, and structural blanks clean.',
          'Material fidelity strategy: use the material images as actual material sources, not as vague style references. Preserve existing usable motifs, lettering shapes, linework, border language, and local decorations as much as possible. Only invent new elements when explicitly required by text and missing from materials.',
          'Single-pattern design definition: one pattern design means one independent closed print slot / die area / crop region inside image 1, not the whole output canvas. If image 1 contains multiple slots, refine each slot separately while keeping a coherent series.',
        ].join('\n')
      : 'No history layout image is available. The default automatic full flow must not generate a final design without a history layout; it should stop after material output.',
    'Structured design dimensions to preserve in the real final prompt: Core Subject & Theme, Art Style & Medium, Color Palette & Lighting, Composition & Perspective, Detailed Visual Elements, Text & Typography. These are internal design-control dimensions, not Markdown to be drawn into the image.',
    'Avoid formulaic output: do not make a mechanical "layout template plus stickers" result. The final design should look like a complete commercial product pattern series.',
    'Final image quality rule: Clean and polished image, controllable details, smooth and consistent textures, clear subject-background separation, no over-sharpening, no color blotches, no noise, no broken patterns, no artifacts, and no distortion.',
    'Forbidden deviations: do not output a single badge, single plate, product mockup, screenshot, poster, new cropped composition, or material-board display unless image 1 itself has that exact format. Do not reuse old content from image 1.',
  ].filter(Boolean).join('\n');
}

function buildFallbackFinalPrompt(project, elementImages, hasHistoryImage) {
  return [
    buildFinalTemplatePrompt(project, elementImages, hasHistoryImage),
    'Generate a polished final commercial design image. Keep motif distribution clean, coherent, and production-ready.',
  ].join('\n');
}

function imageRecordWithPublicUrls(image, publicBaseUrl = '') {
  if (!image || typeof image !== 'object') return image;

  const imageUrl = absolutePublicUrl(image.imageUrl, publicBaseUrl);
  const thumbnailUrl = absolutePublicUrl(image.thumbnailUrl, publicBaseUrl) || imageUrl;

  return {
    ...image,
    imageUrl: imageUrl || image.imageUrl,
    thumbnailUrl: thumbnailUrl || image.thumbnailUrl || imageUrl || image.imageUrl,
  };
}

function runWithPublicUrls(run, publicBaseUrl = '') {
  if (!run || typeof run !== 'object') return run;

  return {
    ...run,
    elementImages: Array.isArray(run.elementImages)
      ? run.elementImages.map((image) => imageRecordWithPublicUrls(image, publicBaseUrl))
      : [],
    finalDesignImages: Array.isArray(run.finalDesignImages)
      ? run.finalDesignImages.map((image) => imageRecordWithPublicUrls(image, publicBaseUrl))
      : [],
  };
}

function generationOutputRun(run) {
  if (!run || typeof run !== 'object') return null;

  return {
    ...run,
    elementImages: Array.isArray(run.elementImages)
      ? sortElementImagesForFinalInput(
        run.elementImages.filter((image) => ACCEPTED_ELEMENT_SOURCES.has(cleanString(image.source))),
      )
      : [],
    finalDesignImages: Array.isArray(run.finalDesignImages)
      ? run.finalDesignImages.filter((image) => ACCEPTED_FINAL_SOURCES.has(cleanString(image.source)))
      : [],
  };
}

function materialShapeLevelIndexFromRecord(image) {
  const text = [
    image?.source,
    image?.title,
    image?.generation_label,
    image?.label,
  ].map(cleanString).join(' ').toLowerCase();
  if (text.includes('primary')) return 0;
  if (text.includes('secondary')) return 1;
  if (text.includes('tertiary')) return 2;
  return MATERIAL_SHAPE_LEVELS.length;
}

function finalMaterialSourceIndexFromRecord(image) {
  const source = cleanString(image?.source);
  if (source === 'company_design_reference_split' || source === 'design_reference_unified_regeneration') {
    return 0;
  }
  if (source === 'gallery_material_unified_cleanup' || source === 'gallery_material_split_cleanup') {
    return 1;
  }
  return 2;
}

function sortElementImagesForFinalInput(images = []) {
  return [...images].sort((first, second) => {
    const levelDifference = materialShapeLevelIndexFromRecord(first) - materialShapeLevelIndexFromRecord(second);
    if (levelDifference !== 0) return levelDifference;

    const sourceDifference = finalMaterialSourceIndexFromRecord(first) - finalMaterialSourceIndexFromRecord(second);
    if (sourceDifference !== 0) return sourceDifference;

    return cleanString(first?.id).localeCompare(cleanString(second?.id));
  });
}

function elementImagesForCategory(images = [], category = '') {
  const normalizedCategory = cleanString(category).toLocaleLowerCase();
  return sortElementImagesForFinalInput(images.filter((image) => (
    cleanString(image?.category).toLocaleLowerCase() === normalizedCategory
  )));
}

function hasDisplayRun(run) {
  return run &&
    Array.isArray(run.elementImages) &&
    run.elementImages.length > 0 &&
    Array.isArray(run.finalDesignImages) &&
    run.finalDesignImages.length > 0;
}

function hasAnyDisplayImage(run) {
  return run &&
    (
      (Array.isArray(run.elementImages) && run.elementImages.length > 0) ||
      (Array.isArray(run.finalDesignImages) && run.finalDesignImages.length > 0)
    );
}

function isProjectFinalDisplayRunId(value) {
  return /^prun-/.test(cleanString(value));
}

function isReusableFinalDisplayRun(run) {
  const runId = cleanString(run?.runId);
  return cleanString(run?.flowVersion) === FINAL_DISPLAY_FLOW_VERSION &&
    isProjectFinalDisplayRunId(runId) &&
    cleanString(run?.status) === 'completed' &&
    hasDisplayRun(generationOutputRun(run));
}

function dataLayerWithPersistedDesignReferences(dataLayer, images = []) {
  if (!dataLayer || typeof dataLayer !== 'object') return dataLayer;
  const sections = dataLayer.sections && typeof dataLayer.sections === 'object'
    ? dataLayer.sections
    : {};
  const designSection = sections.designReferenceImages && typeof sections.designReferenceImages === 'object'
    ? sections.designReferenceImages
    : {};
  return {
    ...dataLayer,
    sections: {
      ...sections,
      designReferenceImages: {
        ...designSection,
        count: images.length,
        items: images,
      },
    },
  };
}

function selectedPersistedDesignReferences(sourceImages = [], persistedImages = []) {
  const bySourceHash = new Map(
    persistedImages
      .filter((image) => cleanString(image?.sourceUrlHash))
      .map((image) => [cleanString(image.sourceUrlHash), image]),
  );
  return sourceImages
    .map((image) => {
      const persisted = bySourceHash.get(referenceSourceHash(image?.imageUrl || image?.thumbnailUrl));
      if (!persisted) return null;
      return {
        ...image,
        imageUrl: persisted.imageUrl,
        thumbnailUrl: persisted.thumbnailUrl || persisted.imageUrl,
        sourceUrlHash: persisted.sourceUrlHash,
        mimeType: persisted.mimeType,
        bytes: persisted.bytes,
      };
    })
    .filter(Boolean);
}

async function persistDesignReferenceMediaForRun({
  dependencies,
  runId,
  designReferenceImages = [],
  dataLayer,
}) {
  const dataLayerImages = Array.isArray(dataLayer?.sections?.designReferenceImages?.items)
    ? dataLayer.sections.designReferenceImages.items
    : [];
  const sourceImages = dataLayerImages.length > 0 ? dataLayerImages : designReferenceImages;
  if (!runId || sourceImages.length === 0) {
    return {
      dataLayer: dataLayerWithPersistedDesignReferences(dataLayer, []),
      designReferenceImages: [],
      failureCount: 0,
      changed: dataLayerImages.length > 0 || designReferenceImages.length > 0,
    };
  }

  const persistReferences = dependencies.persistProjectReferenceImages || persistProjectReferenceImages;
  let result;
  try {
    result = await persistReferences({
      runId,
      images: sourceImages,
    });
  } catch (_error) {
    result = {
      images: [],
      failures: sourceImages.map((_image, index) => ({ index })),
    };
  }

  const persistedImages = Array.isArray(result?.images) ? result.images : [];
  const safeDesignReferenceImages = selectedPersistedDesignReferences(
    designReferenceImages,
    persistedImages,
  );
  const sourceUrls = sourceImages.map((image) => cleanString(image?.imageUrl || image?.thumbnailUrl));
  const persistedUrls = persistedImages.map((image) => cleanString(image?.imageUrl || image?.thumbnailUrl));

  return {
    dataLayer: dataLayerWithPersistedDesignReferences(dataLayer, persistedImages),
    designReferenceImages: safeDesignReferenceImages,
    failureCount: Array.isArray(result?.failures) ? result.failures.length : 0,
    changed: sourceUrls.length !== persistedUrls.length ||
      sourceUrls.some((value, index) => value !== persistedUrls[index]) ||
      designReferenceImages.length !== safeDesignReferenceImages.length,
  };
}

function referenceMediaWarnings(failureCount) {
  return failureCount > 0
    ? [`company_design_reference_media_unavailable:${failureCount}`]
    : [];
}

function isPartialFinalDisplayRun(run) {
  const runId = cleanString(run?.runId);
  return cleanString(run?.flowVersion) === FINAL_DISPLAY_FLOW_VERSION &&
    isProjectFinalDisplayRunId(runId) &&
    hasAnyDisplayImage(generationOutputRun(run));
}

function getProjectRunsForCodeFromDependencies(dependencies, projectCode) {
  if (typeof dependencies.getProjectRunsForCode === 'function') {
    return dependencies.getProjectRunsForCode(projectCode);
  }

  if (typeof dependencies.projectRunStore?.getProjectRunsForCode === 'function') {
    return dependencies.projectRunStore.getProjectRunsForCode(projectCode);
  }

  return getProjectRunsForCode(projectCode);
}

function projectRunById(dependencies, projectCode, runId) {
  const requestedRunId = cleanString(runId);
  if (!requestedRunId) return null;
  return getProjectRunsForCodeFromDependencies(dependencies, projectCode)
    .find((run) => cleanString(run?.runId) === requestedRunId) || null;
}

function terminalProjectRunError(run) {
  const code = cleanString(run?.error?.code) || 'EVIDENCE_AGENT_FINAL_DISPLAY_FAILED';
  const error = new Error('Project final display generation reached a terminal failure. Submit a new request to retry.');
  error.statusCode = code === 'EVIDENCE_AGENT_FINAL_DISPLAY_TIMEOUT' ? 504 : 502;
  error.code = code;
  error.retryable = false;
  error.stepName = cleanString(run?.error?.stage || run?.progress?.stage) || 'project_final_display';
  error.attempt = Number(run?.progress?.attempt) || 1;
  error.maxAttempts = Number(run?.progress?.maxAttempts) || AGENT_FLOW_MAX_RETRIES;
  return error;
}

function latestReusableOutputRunForCode(dependencies, projectCode) {
  const runs = getProjectRunsForCodeFromDependencies(dependencies, projectCode);
  const reusable = runs.find(isReusableFinalDisplayRun);
  return reusable ? generationOutputRun(reusable) : null;
}

function latestOutputRunForCode(dependencies, projectCode) {
  const runs = getProjectRunsForCodeFromDependencies(dependencies, projectCode);
  const reusable = runs.find(isReusableFinalDisplayRun);
  if (reusable) return generationOutputRun(reusable);

  const partial = runs.find(isPartialFinalDisplayRun);
  return partial ? generationOutputRun(partial) : null;
}

function latestProjectRunForCode(dependencies, projectCode) {
  if (typeof dependencies.getLatestProjectRunForCode === 'function') {
    return dependencies.getLatestProjectRunForCode(projectCode);
  }

  if (typeof dependencies.projectRunStore?.getLatestProjectRunForCode === 'function') {
    return dependencies.projectRunStore.getLatestProjectRunForCode(projectCode);
  }

  return getLatestProjectRunForCode(projectCode);
}

function resolveProgressRecorder(dependencies = {}) {
  if (typeof dependencies.recordProjectRunProgress === 'function') {
    return dependencies.recordProjectRunProgress;
  }
  if (typeof dependencies.projectRunStore?.recordProjectRunProgress === 'function') {
    return dependencies.projectRunStore.recordProjectRunProgress;
  }

  const hasCustomRunStore = [
    dependencies.recordProjectGenerationResult,
    dependencies.recordProjectRunMetadata,
    dependencies.getProjectRunsForCode,
    dependencies.getLatestProjectRunForCode,
    dependencies.projectRunStore,
  ].some(Boolean);
  return hasCustomRunStore ? null : recordProjectRunProgress;
}

function createProgressReporter(dependencies, projectCode, runId, requestId = '') {
  const recorder = resolveProgressRecorder(dependencies);
  if (!recorder) return async () => {};

  return async (progress) => {
    try {
      return recorder({
        project_code: projectCode,
        project_run_id: runId,
        request_id: requestId,
      }, progress);
    } catch (_error) {
      return null;
    }
  };
}

async function emitStepProgress(onProgress, payload) {
  if (typeof onProgress !== 'function') return;
  try {
    await onProgress(payload);
  } catch (_error) {
    // Progress persistence must not turn a successful provider call into a failed job.
  }
}

async function waitForStepRetry(attempt, options = {}) {
  const baseDelayMs = positiveInteger(
    options.retryBaseDelayMs,
    FINAL_DISPLAY_RETRY_BASE_DELAY_MS,
  );
  const delayMs = baseDelayMs * (2 ** Math.max(0, attempt - 1));
  const deadlineAt = Number(options.deadlineAt);
  if (Number.isFinite(deadlineAt) && Date.now() + delayMs >= deadlineAt) {
    const error = finalDisplayTimeoutError(options.stepName);
    error.attempt = attempt;
    error.maxAttempts = AGENT_FLOW_MAX_RETRIES;
    throw error;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function runAgentFlowStep(stepName, action, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= AGENT_FLOW_MAX_RETRIES; attempt += 1) {
    const startedAt = Date.now();
    await emitStepProgress(options.onProgress, {
      stage: stepName,
      status: 'started',
      runStatus: 'running',
      attempt,
      maxAttempts: AGENT_FLOW_MAX_RETRIES,
    });

    try {
      const result = await action(attempt);
      await emitStepProgress(options.onProgress, {
        stage: stepName,
        status: 'success',
        runStatus: 'running',
        attempt,
        maxAttempts: AGENT_FLOW_MAX_RETRIES,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      lastError.stepName = stepName;
      lastError.attempt = attempt;
      lastError.maxAttempts = AGENT_FLOW_MAX_RETRIES;
      const exhausted = attempt >= AGENT_FLOW_MAX_RETRIES;
      const terminal = lastError.retryable === false || exhausted;
      if (terminal) {
        lastError.retryable = false;
      }
      await emitStepProgress(options.onProgress, {
        stage: stepName,
        status: terminal ? 'failed' : 'retrying',
        runStatus: terminal ? 'failed' : 'running',
        attempt,
        maxAttempts: AGENT_FLOW_MAX_RETRIES,
        durationMs: Date.now() - startedAt,
        error: {
          code: lastError.code || 'EVIDENCE_AGENT_FINAL_DISPLAY_FAILED',
          retryable: !terminal,
        },
      });
      if (terminal) {
        throw lastError;
      }
      await waitForStepRetry(attempt, {
        ...options,
        stepName,
      });
    }
  }

  const error = lastError || new Error(`${stepName} failed.`);
  error.stepName = stepName;
  throw error;
}

function hasRecordedImageForRequest(run, collection, source, label) {
  const images = Array.isArray(run?.[collection]) ? run[collection] : [];
  const expectedSource = cleanString(source);
  const expectedLabel = cleanString(label);
  return images.some((image) =>
    cleanString(image.source) === expectedSource &&
    (!expectedLabel || cleanString(image.title) === expectedLabel)
  );
}

function recordedImageForRequest(run, collection, source, label) {
  const images = Array.isArray(run?.[collection]) ? run[collection] : [];
  const expectedSource = cleanString(source);
  const expectedLabel = cleanString(label);
  return images.find((image) =>
    cleanString(image.source) === expectedSource &&
    (!expectedLabel || cleanString(image.title) === expectedLabel)
  ) || null;
}

function recordedImageToInputImage(image, publicBaseUrl = '', fallbackLabel = 'Generated material image') {
  if (!image) return null;
  const imageUrl = absolutePublicUrl(image.imageUrl, publicBaseUrl);
  if (!imageUrl) return null;
  return {
    id: cleanString(image.id) || `generated_${Date.now()}`,
    role: 'material',
    label: cleanString(image.title) || fallbackLabel,
    filename: safeFilename(image.imageUrl || image.id) || `${cleanString(image.id) || 'generated-material'}.png`,
    url: imageUrl,
    detail: cleanString(image.title) || fallbackLabel,
  };
}

async function analyzeMaterialSource({
  analyzeShapes,
  project,
  sourceKind,
  inputImages,
}) {
  const result = await analyzeShapes({
    project_code: project.projectCode,
    category: project.category,
    source_kind: sourceKind,
    graphic_elements: listFromText(project.graphicElements),
    text_elements: listFromText(project.textElements),
    design_requirement_directives: listFromText(project.designRequirement, 8),
    input_images: inputImages,
  });

  if (!result || result.status !== 'success') {
    const upstream = result?.ai_error;
    const message = upstream?.message ||
      `AI material shape analysis did not complete successfully for ${sourceKind}.`;
    const error = new Error(message);
    error.statusCode = 502;
    error.code = 'EVIDENCE_AGENT_MATERIAL_SHAPE_ANALYSIS_FAILED';
    error.retryable = result?.status !== 'missing_config';
    throw error;
  }

  return result;
}

async function generateAndRecordImage({
  generateImage,
  recordResult,
  dependencies,
  normalizedCode,
  request,
}) {
  const result = await generateImage(request);
  if (result.status !== 'success' || !Array.isArray(result.images) || result.images.length === 0) {
    const error = new Error(result.ai_error?.message || 'Project image generation failed.');
    error.statusCode = 502;
    error.code = request.generation_stage === 'final_design'
      ? 'EVIDENCE_AGENT_FINAL_GENERATION_FAILED'
      : 'EVIDENCE_AGENT_MATERIAL_GENERATION_FAILED';
    error.retryable = true;
    throw error;
  }

  const recordedRun = recordResult(request, result);
  return recordedRun || latestProjectRunForCode(dependencies, normalizedCode);
}

async function generateMaterialOutputs({
  analyzeShapes,
  composePrompt,
  generateImage,
  recordResult,
  dependencies,
  normalizedCode,
  runId,
  publicBaseUrl,
  project,
  sourceImages,
  sourceKind,
  sourceLabel,
  unifiedSource,
  splitSource,
  unifiedLabel,
  stageConcurrency = FINAL_DISPLAY_STAGE_CONCURRENCY,
}) {
  if (!Array.isArray(sourceImages) || sourceImages.length === 0) {
    return latestProjectRunForCode(dependencies, normalizedCode);
  }

  const inputImages = imageInputsFromProjectImages(
    sourceImages,
    sourceKind === 'material' ? 'material_cleanup' : 'design_reference_material_source',
    `${sourceLabel} used by evidence-agent material extraction.`,
  );
  const shapeAnalysis = await analyzeMaterialSource({
    analyzeShapes,
    project,
    sourceKind,
    inputImages,
  });
  const splitRequired = materialShapeAnalysisRequiresSplit(shapeAnalysis);
  const levels = splitRequired ? MATERIAL_SHAPE_LEVELS : [null];

  let currentRun = latestProjectRunForCode(dependencies, normalizedCode);
  if (splitRequired) {
    const generatedRuns = await mapWithConcurrency(levels, stageConcurrency, async (shapeLevel) => {
      const generationLabel = categoryScopedGenerationLabel(
        project.category,
        `${sourceLabel} ${shapeLevel.label}`,
      );
      const rawRun = latestProjectRunForCode(dependencies, normalizedCode) || currentRun;
      if (hasRecordedImageForRequest(rawRun, 'elementImages', splitSource, generationLabel)) {
        return rawRun;
      }

      return generateAndRecordImage({
        generateImage,
        recordResult,
        dependencies,
        normalizedCode,
        request: {
          prompt: buildMaterialProcessingPrompt({
            sourceLabel,
            project,
            shapeLevel,
            shapeAnalysis,
            inputImages,
          }),
          project_code: normalizedCode,
          project_run_id: runId,
          generation_stage: 'element_image',
          generation_source: splitSource,
          generation_label: generationLabel,
          category: project.category,
          input_images: inputImages,
        },
      });
    });

    return latestProjectRunForCode(dependencies, normalizedCode) ||
      generatedRuns.filter(Boolean).at(-1) ||
      currentRun;
  }

  for (const shapeLevel of levels) {
    const generationSource = shapeLevel ? splitSource : unifiedSource;
    const generationLabel = categoryScopedGenerationLabel(
      project.category,
      shapeLevel ? `${sourceLabel} ${shapeLevel.label}` : unifiedLabel,
    );
    const rawRun = latestProjectRunForCode(dependencies, normalizedCode) || currentRun;
    const isDesignReferenceUnified = !shapeLevel && sourceKind === 'design_reference';
    const hasExistingGeneratedImage = hasRecordedImageForRequest(
      rawRun,
      'elementImages',
      generationSource,
      generationLabel,
    );
    if (hasExistingGeneratedImage && !isDesignReferenceUnified) {
      currentRun = rawRun || currentRun;
      continue;
    }

    if (hasExistingGeneratedImage) {
      currentRun = rawRun || currentRun;
    } else {
      const request = {
        prompt: buildMaterialProcessingPrompt({
          sourceLabel,
          project,
          shapeLevel,
          shapeAnalysis,
          inputImages,
        }),
        project_code: normalizedCode,
        project_run_id: runId,
        generation_stage: 'element_image',
        generation_source: generationSource,
        generation_label: generationLabel,
        category: project.category,
        input_images: inputImages,
      };
      currentRun = await generateAndRecordImage({
        generateImage,
        recordResult,
        dependencies,
        normalizedCode,
        request,
      }) || currentRun;
    }

    if (isDesignReferenceUnified) {
      const latestRun = latestProjectRunForCode(dependencies, normalizedCode) || currentRun;
      const regeneratedSource = 'design_reference_unified_regeneration';
      const regeneratedLabel = categoryScopedGenerationLabel(
        project.category,
        'Regenerated unified design reference material',
      );
      if (hasRecordedImageForRequest(latestRun, 'elementImages', regeneratedSource, regeneratedLabel)) {
        currentRun = latestRun;
        continue;
      }

      const unifiedRecord = recordedImageForRequest(
        latestRun,
        'elementImages',
        generationSource,
        generationLabel,
      );
      const unifiedInputImage = recordedImageToInputImage(
        unifiedRecord,
        publicBaseUrl,
        generationLabel,
      );
      if (!unifiedInputImage) {
        continue;
      }

      const sourceNames = sourceImages.map((image) => image.filename).filter(Boolean).join(', ');
      const reverseResponse = await composePrompt({
        template_prompt: buildMaterialBoardReversePrompt(sourceLabel, sourceNames, shapeAnalysis),
        prompt_template_id: MATERIAL_BOARD_REVERSE_PROMPT_TEMPLATE_ID,
        project_code: normalizedCode,
        category: project.category,
        input_images: [
          {
            ...unifiedInputImage,
            role: 'material_board_reverse_source',
            detail: 'Intermediate unified material board generated from company design reference images. It is used only for reverse prompt analysis.',
          },
        ],
      });

      if (reverseResponse.status !== 'success' || !reverseResponse.final_prompt) {
        const error = new Error(reverseResponse.ai_error?.message || 'AI material board reverse prompt failed.');
        error.statusCode = 502;
        error.code = 'EVIDENCE_AGENT_MATERIAL_REVERSE_FAILED';
        error.retryable = true;
        throw error;
      }

      currentRun = await generateAndRecordImage({
        generateImage,
        recordResult,
        dependencies,
        normalizedCode,
        request: {
          prompt: buildMaterialBoardRegenerationPrompt(
            reverseResponse.final_prompt,
            sourceLabel,
            sourceNames,
          ),
          project_code: normalizedCode,
          project_run_id: runId,
          generation_stage: 'element_image',
          generation_source: regeneratedSource,
          generation_label: regeneratedLabel,
          request_mode: 'images',
          category: project.category,
          input_images: [],
        },
      }) || currentRun;
    }
  }

  return currentRun;
}

function buildPendingProjectFinalDisplayResult({
  normalizedCode,
  publicBaseUrl,
  run,
  runId,
  dataLayer = null,
  source = 'project_final_display_running',
  warnings = ['project_final_display_running'],
} = {}) {
  const outputRun = generationOutputRun(run) || {};
  const responseRun = runWithPublicUrls({
    runId: cleanString(outputRun.runId) || cleanString(runId),
    projectCode: cleanString(outputRun.projectCode) || normalizedCode,
    status: cleanString(outputRun.status) || 'running',
    createdAt: outputRun.createdAt,
    updatedAt: outputRun.updatedAt,
    elementImages: Array.isArray(outputRun.elementImages) ? outputRun.elementImages : [],
    finalDesignImages: Array.isArray(outputRun.finalDesignImages) ? outputRun.finalDesignImages : [],
    progress: outputRun.progress || null,
    error: outputRun.error || null,
  }, publicBaseUrl);
  return {
    status: 'pending',
    source,
    project: { projectCode: normalizedCode },
    designReferenceImages: [],
    run: responseRun,
    dataLayer,
    display: buildFinalDisplayView(responseRun, dataLayer),
    usage: { providerCost: true },
    warnings,
  };
}

function buildTerminalProjectFinalDisplayResult({
  normalizedCode,
  publicBaseUrl,
  project,
  designReferenceImages = [],
  run,
  runId,
  dataLayer = null,
  status = 'blocked',
  reason,
  warnings = [],
} = {}) {
  const terminalStatus = status === 'partial' ? 'partial' : 'blocked';
  const outputRun = generationOutputRun(run) || {};
  const responseRun = runWithPublicUrls({
    runId: cleanString(outputRun.runId) || cleanString(runId),
    projectCode: cleanString(outputRun.projectCode) || normalizedCode,
    status: terminalStatus,
    createdAt: outputRun.createdAt,
    updatedAt: outputRun.updatedAt,
    elementImages: Array.isArray(outputRun.elementImages) ? outputRun.elementImages : [],
    finalDesignImages: Array.isArray(outputRun.finalDesignImages) ? outputRun.finalDesignImages : [],
    progress: outputRun.progress || null,
    error: outputRun.error || null,
  }, publicBaseUrl);
  return {
    status: terminalStatus,
    source: `project_final_display_${terminalStatus}`,
    project: project || { projectCode: normalizedCode },
    designReferenceImages,
    run: responseRun,
    dataLayer,
    display: buildFinalDisplayView(responseRun, dataLayer),
    usage: { providerCost: true },
    warnings: [reason, ...warnings].filter(Boolean),
  };
}

function activeJobForProject(projectCode) {
  const job = activeFinalDisplayJobs.get(projectCode);
  if (!job) return null;

  if (
    job.status === 'completed' &&
    Date.now() - Number(job.finishedAt || 0) > COMPLETED_JOB_RESULT_CACHE_MS
  ) {
    activeFinalDisplayJobs.delete(projectCode);
    return null;
  }

  if (
    job.status === 'failed' &&
    Date.now() - Number(job.finishedAt || 0) > FAILED_JOB_RESULT_CACHE_MS
  ) {
    activeFinalDisplayJobs.delete(projectCode);
    return null;
  }

  return job;
}

function scheduleFailedJobCleanup(projectCode, job) {
  const timeout = setTimeout(() => {
    if (activeFinalDisplayJobs.get(projectCode) === job) {
      activeFinalDisplayJobs.delete(projectCode);
    }
  }, FAILED_JOB_RESULT_CACHE_MS);
  timeout.unref?.();
}

function scheduleCompletedJobCleanup(projectCode, job) {
  const timeout = setTimeout(() => {
    if (activeFinalDisplayJobs.get(projectCode) === job) {
      activeFinalDisplayJobs.delete(projectCode);
    }
  }, COMPLETED_JOB_RESULT_CACHE_MS);
  timeout.unref?.();
}

function startProjectFinalDisplayJob({
  normalizedCode,
  request,
  dependencies,
  options,
  runId,
}) {
  const job = {
    projectCode: normalizedCode,
    runId,
    requestId: finalDisplayRequestId(request),
    status: 'running',
    startedAt: Date.now(),
    deadlineAt: createFinalDisplayJobDeadline(dependencies),
    finishedAt: 0,
    error: null,
  };
  activeFinalDisplayJobs.set(normalizedCode, job);
  const reportProgress = createProgressReporter(
    dependencies,
    normalizedCode,
    runId,
    job.requestId,
  );
  void reportProgress({
    stage: 'project_final_display',
    status: 'started',
    runStatus: 'running',
    attempt: 1,
    maxAttempts: 1,
  });

  job.promise = generateProjectFinalDisplayNow({
    normalizedCode,
    request,
    dependencies,
    options: {
      ...options,
      runId,
      jobDeadlineAt: job.deadlineAt,
    },
    })
    .then(async (result) => {
      job.finishedAt = Date.now();
      const blocked = result?.status === 'blocked';
      const partial = result?.status === 'partial';
      await reportProgress({
        stage: 'project_final_display',
        status: blocked ? 'blocked' : partial ? 'partial' : 'success',
        runStatus: blocked ? 'blocked' : 'completed',
        attempt: 1,
        maxAttempts: 1,
        durationMs: job.finishedAt - job.startedAt,
      });
      const persistedRun = latestOutputRunForCode(dependencies, normalizedCode);
      const publicBaseUrl = dependencies.publicBaseUrlFromRequest?.(request) || '';
      const completedResult = persistedRun
        ? {
            ...result,
            run: runWithPublicUrls(persistedRun, publicBaseUrl),
            display: buildFinalDisplayView(runWithPublicUrls(persistedRun, publicBaseUrl), result.dataLayer),
          }
        : result;
      job.status = 'completed';
      job.result = completedResult;
      scheduleCompletedJobCleanup(normalizedCode, job);
      return completedResult;
    })
    .catch(async (error) => {
      job.finishedAt = Date.now();
      await reportProgress({
        stage: error?.stepName || 'project_final_display',
        status: 'failed',
        runStatus: 'failed',
        attempt: Number(error?.attempt) || 1,
        maxAttempts: Number(error?.maxAttempts) || AGENT_FLOW_MAX_RETRIES,
        durationMs: job.finishedAt - job.startedAt,
        error: {
          code: error?.code || 'EVIDENCE_AGENT_FINAL_DISPLAY_FAILED',
          retryable: false,
        },
      });
      job.status = 'failed';
      job.error = error;
      scheduleFailedJobCleanup(normalizedCode, job);
      return null;
    });

  return job;
}

async function generateProjectFinalDisplayNow({
  normalizedCode,
  projectCode,
  request,
  dependencies = {},
  options = {},
} = {}) {
  const code = normalizedCode || normalizeProjectCode(projectCode);
  const publicBaseUrl = dependencies.publicBaseUrlFromRequest?.(request) || '';
  const cachedRun = options.force ? null : latestReusableOutputRunForCode(dependencies, code);
  if (cachedRun) {
    const lookupData = cachedRun.projectDataLayer
      ? null
      : await lookupProjectDataLayerWithTimeout({
          normalizedCode: code,
          request,
          dependencies,
        });
    const sourceDataLayer = cachedRun.projectDataLayer || lookupData?.dataLayer || null;
    const sourceDesignReferenceImages = cachedRun.designReferenceImages ||
      (lookupData?.lookup ? designReferenceImagesFromLookup(lookupData.lookup) : []);
    const referenceMedia = await persistDesignReferenceMediaForRun({
      dependencies,
      runId: cachedRun.runId,
      designReferenceImages: sourceDesignReferenceImages,
      dataLayer: sourceDataLayer,
    });
    const dataLayer = referenceMedia.dataLayer;
    const safeDesignReferenceImages = referenceMedia.designReferenceImages;
    if (referenceMedia.changed || (!cachedRun.projectDataLayer && lookupData?.dataLayer)) {
      recordProjectDataLayerForRun({
        dependencies,
        normalizedCode: code,
        runId: cachedRun.runId,
        project: cachedRun.project || lookupData?.project,
        designReferenceImages: safeDesignReferenceImages,
        dataLayer,
      });
    }
    const responseRun = runWithPublicUrls({
      ...cachedRun,
      designReferenceImages: safeDesignReferenceImages,
      projectDataLayer: dataLayer,
    }, publicBaseUrl);
    return {
      status: cleanString(cachedRun.progress?.status) === 'partial' ? 'partial' : 'completed',
      source: 'cached_project_final_display',
      project: cachedRun.project || lookupData?.project || { projectCode: code },
      designReferenceImages: safeDesignReferenceImages,
      run: responseRun,
      dataLayer,
      display: buildFinalDisplayView(responseRun, dataLayer),
      usage: { providerCost: false },
      warnings: referenceMediaWarnings(referenceMedia.failureCount),
    };
  }

  const resumableRun = options.force ? null : latestOutputRunForCode(dependencies, code);
  const runId = cleanString(options.runId) || cleanString(resumableRun?.runId) || createRunId(code);
  const reportProgress = createProgressReporter(
    dependencies,
    code,
    runId,
    finalDisplayRequestId(request),
  );
  const jobDeadlineAt = Number(options.jobDeadlineAt) || createFinalDisplayJobDeadline(dependencies);
  const maxCallTimeoutMs = positiveInteger(
    dependencies.finalDisplayAiCallTimeoutMs,
    FINAL_DISPLAY_AI_CALL_TIMEOUT_MS,
  );
  const runStep = (stepName, action) => runAgentFlowStep(stepName, action, {
    onProgress: reportProgress,
    deadlineAt: jobDeadlineAt,
    retryBaseDelayMs: dependencies.finalDisplayRetryBaseDelayMs,
  });
  const lookup = await runStep('project_lookup', () => dependencies.prepareProposalFromCompanyLookup({
    projectCode: code,
    publicBaseUrl,
  }));
  if (!lookup?.found) {
    const error = new Error(lookup?.error_message || 'Project lookup failed.');
    error.statusCode = lookup?.error_code === 'COMPANY_PROJECT_NOT_FOUND' ? 404 : 502;
    error.code = lookup?.error_code === 'COMPANY_PROJECT_NOT_FOUND'
      ? 'EVIDENCE_AGENT_PROJECT_NOT_FOUND'
      : 'EVIDENCE_AGENT_UPSTREAM_UNAVAILABLE';
    error.retryable = lookup?.error_code !== 'COMPANY_PROJECT_NOT_FOUND';
    throw error;
  }

  const project = projectPreviewFromLookup(lookup);
  const sourceDataLayer = buildProjectDataLayerFromLookup(lookup);
  const selectedMaterialImages = selectedMaterialImagesFromLookup(lookup);
  const generationDesignReferenceImages = designReferenceImagesFromLookup(lookup);
  if (selectedMaterialImages.length === 0 && generationDesignReferenceImages.length === 0) {
    const error = new Error('No material or company design reference image is available for final display generation.');
    error.statusCode = 422;
    error.code = 'EVIDENCE_AGENT_NO_DESIGN_REFERENCE_IMAGE';
    throw error;
  }

  const referenceMedia = await persistDesignReferenceMediaForRun({
    dependencies,
    runId,
    designReferenceImages: generationDesignReferenceImages,
    dataLayer: sourceDataLayer,
  });
  const dataLayer = referenceMedia.dataLayer;
  const designReferenceImages = referenceMedia.designReferenceImages;
  const mediaWarnings = referenceMediaWarnings(referenceMedia.failureCount);

  recordProjectDataLayerForRun({
    dependencies,
    normalizedCode: code,
    runId,
    project,
    designReferenceImages,
    dataLayer,
  });

  const runWithAiPermit = dependencies.runWithFinalDisplayAiPermit || runWithFinalDisplayAiPermit;
  const rawGenerateImage = dependencies.generatePatternImage || generatePatternImage;
  const rawComposePrompt = dependencies.composeFinalPrompt || composeFinalPrompt;
  const rawAnalyzeShapes = dependencies.analyzeMaterialShapeLevels || analyzeMaterialShapeLevels;
  const generateImage = (input) => runWithAiPermit(() => {
    const providerOptions = deadlineBoundProviderOptions({
      deadlineAt: jobDeadlineAt,
      envKey: 'AI_IMAGE_GENERATOR_TIMEOUT_MS',
      configuredTimeoutMs: getAiImageGeneratorConfig(process.env).timeoutMs,
      maxCallTimeoutMs,
      stage: 'generate',
    });
    return rawGenerateImage(input, providerOptions);
  }, { deadlineAt: jobDeadlineAt });
  const composePrompt = (input) => runWithAiPermit(() => {
    const providerOptions = deadlineBoundProviderOptions({
      deadlineAt: jobDeadlineAt,
      envKey: 'AI_FINAL_PROMPT_COMPOSER_TIMEOUT_MS',
      configuredTimeoutMs: getAiFinalPromptComposerConfig(process.env).timeoutMs,
      maxCallTimeoutMs,
      stage: 'prompt',
    });
    return rawComposePrompt(input, providerOptions);
  }, { deadlineAt: jobDeadlineAt });
  const analyzeShapes = (input) => runWithAiPermit(() => {
    const providerOptions = deadlineBoundProviderOptions({
      deadlineAt: jobDeadlineAt,
      envKey: 'AI_MATERIAL_SHAPE_ANALYZER_TIMEOUT_MS',
      configuredTimeoutMs: getAiMaterialShapeAnalyzerConfig(process.env).timeoutMs,
      maxCallTimeoutMs,
      stage: 'material_analysis',
    });
    return rawAnalyzeShapes(input, providerOptions);
  }, { deadlineAt: jobDeadlineAt });
  const recordResult = dependencies.recordProjectGenerationResult || recordProjectGenerationResult;
  const stageConcurrency = positiveInteger(
    dependencies.finalDisplayStageConcurrency,
    FINAL_DISPLAY_STAGE_CONCURRENCY,
  );

  const categoryTargets = categoryTargetsFromLookup(lookup);
  const finalTargets = (categoryTargets.length > 0
    ? categoryTargets
    : [{
        category: project.category,
        confidence: 0,
        reason: '',
        categoryImage: lookup.category_judgment?.category_image || null,
      }]
  ).map((target) => ({
    ...target,
    historyImage: historyImageFromCategoryTarget(lookup, target),
  }));

  let currentRun = resumableRun;
  const categoryMaterialGroups = [];
  for (const target of finalTargets) {
    const targetProject = {
      ...project,
      category: target.category || project.category,
    };

    if (selectedMaterialImages.length > 0) {
      currentRun = await runStep('material', () => generateMaterialOutputs({
        analyzeShapes,
        composePrompt,
        generateImage,
        recordResult,
        dependencies,
        normalizedCode: code,
        runId,
        publicBaseUrl,
        project: targetProject,
        sourceImages: selectedMaterialImages,
        sourceKind: 'material',
        sourceLabel: 'gallery material',
        unifiedSource: 'gallery_material_unified_cleanup',
        splitSource: 'gallery_material_split_cleanup',
        unifiedLabel: 'Unified gallery material',
        stageConcurrency,
      })) || currentRun;
    }

    if (generationDesignReferenceImages.length > 0) {
      currentRun = await runStep('reference', () => generateMaterialOutputs({
        analyzeShapes,
        composePrompt,
        generateImage,
        recordResult,
        dependencies,
        normalizedCode: code,
        runId,
        publicBaseUrl,
        project: targetProject,
        sourceImages: generationDesignReferenceImages,
        sourceKind: 'design_reference',
        sourceLabel: designReferenceSourceLabel(generationDesignReferenceImages),
        unifiedSource: 'company_design_reference_unified_split',
        splitSource: 'company_design_reference_split',
        unifiedLabel: 'Unified design reference material',
        stageConcurrency,
      })) || currentRun;
    }

    currentRun = latestOutputRunForCode(dependencies, code) ||
      latestProjectRunForCode(dependencies, code) ||
      currentRun;
    const currentOutputRun = generationOutputRun(currentRun);
    const elementImages = elementImagesForCategory(
      Array.isArray(currentOutputRun?.elementImages) ? currentOutputRun.elementImages : [],
      targetProject.category,
    );
    if (elementImages.length === 0) {
      const error = new Error(`Material image block was not recorded for category: ${targetProject.category}.`);
      error.statusCode = 502;
      error.code = 'EVIDENCE_AGENT_MATERIAL_RESULT_MISSING';
      error.retryable = true;
      throw error;
    }
    categoryMaterialGroups.push({
      target,
      targetProject,
      elementImages,
    });
  }

  const missingHistoryTargets = categoryMaterialGroups
    .filter((group) => !group.target.historyImage)
    .map((group) => group.target);
  const readyFinalGroups = categoryMaterialGroups.filter((group) => group.target.historyImage);
  if (readyFinalGroups.length === 0) {
    if (options.synchronous === true) {
      await reportProgress({
        stage: 'project_final_display',
        status: 'partial',
        runStatus: 'completed',
        attempt: 1,
        maxAttempts: 1,
      });
    }
    return buildTerminalProjectFinalDisplayResult({
      normalizedCode: code,
      publicBaseUrl,
      project,
      designReferenceImages,
      run: currentRun,
      runId,
      dataLayer,
      status: 'partial',
      reason: 'missing_history_layout_image',
      warnings: [
        'Default automatic final-display flow requires a category history layout image before final image generation.',
        `Missing category history layouts: ${missingHistoryTargets.map((target) => target.category).join(', ')}`,
        ...mediaWarnings,
      ],
    });
  }
  const partialHistoryWarnings = missingHistoryTargets.length > 0
    ? [
        'partial_history_layout_coverage',
        `Skipped categories without history layouts: ${missingHistoryTargets.map((target) => target.category).join(', ')}`,
      ]
    : [];

  const composedTargets = await runStep('prompt', async () => {
    return mapWithConcurrency(readyFinalGroups, stageConcurrency, async (group) => {
      const finalInputImages = [
        group.target.historyImage,
        ...imageInputsFromRunImages(group.elementImages, publicBaseUrl),
      ];
      const templatePrompt = buildFinalTemplatePrompt(
        group.targetProject,
        group.elementImages,
        true,
        finalInputImages,
      );
      const response = await composePrompt({
        template_prompt: templatePrompt,
        prompt_template_id: FINAL_DISPLAY_PROMPT_TEMPLATE_ID,
        project_code: code,
        category: group.targetProject.category,
        input_images: finalInputImages,
      });
      if (response.status !== 'success' || !response.final_prompt) {
        const error = new Error(response.ai_error?.message || `AI final prompt composition failed: ${response.status}`);
        error.statusCode = 502;
        error.code = 'EVIDENCE_AGENT_FINAL_PROMPT_FAILED';
        error.retryable = response.status !== 'missing_config';
        throw error;
      }
      return {
        target: group.target,
        targetProject: group.targetProject,
        elementImages: group.elementImages,
        inputImages: finalInputImages,
        composed: response,
      };
    });
  });
  currentRun = await runStep('generate', async () => {
    const generatedRuns = await mapWithConcurrency(composedTargets, stageConcurrency, async (item) => {
      const generationLabel = `Final generated design - ${item.target.category}`;
      const finalRequest = {
        prompt: item.composed.final_prompt,
        project_code: code,
        project_run_id: runId,
        generation_stage: 'final_design',
        generation_source: FINAL_DISPLAY_FINAL_GENERATION_SOURCE,
        generation_label: generationLabel,
        category: item.target.category,
        history_layout_lock_policy: item.composed.history_layout_lock_policy || 'layout_lock',
        history_layout_lock_reason: item.composed.history_layout_lock_reason || '',
        input_images: item.inputImages,
        defer_project_run_completion: options.synchronous !== true,
      };
      const latestOutputRun = latestOutputRunForCode(dependencies, code) || currentRun;
      if (!hasRecordedImageForRequest(
        latestOutputRun,
        'finalDesignImages',
        finalRequest.generation_source,
        finalRequest.generation_label,
      )) {
        return generateAndRecordImage({
          generateImage,
          recordResult,
          dependencies,
          normalizedCode: code,
          request: finalRequest,
        });
      }
      return latestOutputRun;
    });
    return latestOutputRunForCode(dependencies, code) ||
      generatedRuns.filter(Boolean).at(-1) ||
      currentRun;
  }) || currentRun;

  const completionStatus = missingHistoryTargets.length > 0 ? 'partial' : 'completed';
  if (options.synchronous === true) {
    await reportProgress({
      stage: 'project_final_display',
      status: completionStatus === 'partial' ? 'partial' : 'success',
      runStatus: 'completed',
      attempt: 1,
      maxAttempts: 1,
    });
  }
  const run = generationOutputRun(latestOutputRunForCode(dependencies, code) || latestProjectRunForCode(dependencies, code) || currentRun);
  const responseRun = runWithPublicUrls(run, publicBaseUrl);
  return {
    status: completionStatus,
    source: 'generated_project_final_display',
    project,
    designReferenceImages,
    run: responseRun,
    dataLayer,
    display: buildFinalDisplayView(responseRun, dataLayer),
    usage: { providerCost: true },
    warnings: [...partialHistoryWarnings, ...mediaWarnings],
  };
}

async function prepareProjectFinalDisplay({
  projectCode,
  request,
  dependencies = {},
  options = {},
} = {}) {
  const normalizedCode = normalizeProjectCode(projectCode);
  if (!normalizedCode) {
    const error = new Error('Invalid YXF project code.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_AGENT_INVALID_PROJECT_CODE';
    throw error;
  }

  const publicBaseUrl = dependencies.publicBaseUrlFromRequest?.(request) || '';
  const callerRequestId = finalDisplayRequestId(request);
  const requestedRunId = cleanString(options.runId);
  const requestedRun = projectRunById(dependencies, normalizedCode, requestedRunId);
  const requestedStatus = cleanString(requestedRun?.status).toLowerCase();
  if (requestedStatus === 'failed' || requestedStatus === 'cancelled') {
    throw terminalProjectRunError(requestedRun);
  }
  if (requestedStatus === 'blocked') {
    const outputRun = generationOutputRun(requestedRun) || requestedRun;
    const referenceMedia = await persistDesignReferenceMediaForRun({
      dependencies,
      runId: requestedRun.runId,
      designReferenceImages: requestedRun.designReferenceImages || [],
      dataLayer: requestedRun.projectDataLayer || null,
    });
    if (referenceMedia.changed) {
      recordProjectDataLayerForRun({
        dependencies,
        normalizedCode,
        runId: requestedRun.runId,
        project: requestedRun.project,
        designReferenceImages: referenceMedia.designReferenceImages,
        dataLayer: referenceMedia.dataLayer,
      });
    }
    return buildTerminalProjectFinalDisplayResult({
      normalizedCode,
      publicBaseUrl,
      project: requestedRun.project || { projectCode: normalizedCode },
      designReferenceImages: referenceMedia.designReferenceImages,
      run: outputRun,
      runId: requestedRun.runId,
      dataLayer: referenceMedia.dataLayer,
      reason: 'persisted_project_final_display_blocked',
      warnings: referenceMediaWarnings(referenceMedia.failureCount),
    });
  }

  const latestPersistedRun = latestProjectRunForCode(dependencies, normalizedCode);
  if (
    !requestedRunId &&
    callerRequestId &&
    cleanString(latestPersistedRun?.requestId) === callerRequestId &&
    ['failed', 'cancelled'].includes(cleanString(latestPersistedRun?.status).toLowerCase())
  ) {
    throw terminalProjectRunError(latestPersistedRun);
  }

  let activeJob = options.force ? null : activeJobForProject(normalizedCode);
  if (activeJob) {
    if (activeJob.status === 'failed') {
      const sameRun = requestedRunId && requestedRunId === cleanString(activeJob.runId);
      const sameRequest = callerRequestId && callerRequestId === cleanString(activeJob.requestId);
      if (sameRun || sameRequest || !callerRequestId) {
        throw activeJob.error;
      }
      activeFinalDisplayJobs.delete(normalizedCode);
      activeJob = null;
    }

    if (activeJob?.status === 'completed' && activeJob.result) {
      return activeJob.result;
    }

    if (activeJob) {
      const currentRun = latestOutputRunForCode(dependencies, normalizedCode) ||
        latestProjectRunForCode(dependencies, normalizedCode);
      return buildPendingProjectFinalDisplayResult({
        normalizedCode,
        publicBaseUrl,
        run: currentRun,
        runId: activeJob.runId,
        dataLayer: null,
        source: 'project_final_display_running',
      });
    }
  }

  const cachedRun = options.force ? null : latestReusableOutputRunForCode(dependencies, normalizedCode);
  if (cachedRun) {
    const lookupData = cachedRun.projectDataLayer || options.synchronous === true
      ? null
      : await lookupProjectDataLayerWithTimeout({ normalizedCode, request, dependencies });
    const sourceDataLayer = cachedRun.projectDataLayer || lookupData?.dataLayer || null;
    const sourceDesignReferenceImages = cachedRun.designReferenceImages ||
      (lookupData?.lookup ? designReferenceImagesFromLookup(lookupData.lookup) : []);
    const referenceMedia = await persistDesignReferenceMediaForRun({
      dependencies,
      runId: cachedRun.runId,
      designReferenceImages: sourceDesignReferenceImages,
      dataLayer: sourceDataLayer,
    });
    const dataLayer = referenceMedia.dataLayer;
    const safeDesignReferenceImages = referenceMedia.designReferenceImages;
    if (referenceMedia.changed || (!cachedRun.projectDataLayer && lookupData?.dataLayer)) {
      recordProjectDataLayerForRun({
        dependencies,
        normalizedCode,
        runId: cachedRun.runId,
        project: cachedRun.project || lookupData?.project,
        designReferenceImages: safeDesignReferenceImages,
        dataLayer,
      });
    }
    const responseRun = runWithPublicUrls({
      ...cachedRun,
      designReferenceImages: safeDesignReferenceImages,
      projectDataLayer: dataLayer,
    }, publicBaseUrl);
    return {
      status: cleanString(cachedRun.progress?.status) === 'partial' ? 'partial' : 'completed',
      source: 'cached_project_final_display',
      project: cachedRun.project || lookupData?.project || { projectCode: normalizedCode },
      designReferenceImages: safeDesignReferenceImages,
      run: responseRun,
      dataLayer,
      display: buildFinalDisplayView(responseRun, dataLayer),
      usage: { providerCost: false },
      warnings: referenceMediaWarnings(referenceMedia.failureCount),
    };
  }

  if (options.synchronous === true) {
    return generateProjectFinalDisplayNow({
      normalizedCode,
      request,
      dependencies,
      options: {
        ...options,
        jobDeadlineAt: createFinalDisplayJobDeadline(dependencies),
      },
    });
  }

  const partialRun = options.force ? null : latestOutputRunForCode(dependencies, normalizedCode);
  const runId = cleanString(options.runId) || cleanString(partialRun?.runId) || createRunId(normalizedCode);
  const lookupData = partialRun?.projectDataLayer
    ? null
    : await lookupProjectDataLayerWithTimeout({ normalizedCode, request, dependencies }, 5000);
  const sourceDataLayer = partialRun?.projectDataLayer || lookupData?.dataLayer || null;
  const sourceDesignReferenceImages = partialRun?.designReferenceImages ||
    (lookupData?.lookup ? designReferenceImagesFromLookup(lookupData.lookup) : []);
  const referenceMedia = await persistDesignReferenceMediaForRun({
    dependencies,
    runId,
    designReferenceImages: sourceDesignReferenceImages,
    dataLayer: sourceDataLayer,
  });
  const dataLayer = referenceMedia.dataLayer;
  if (referenceMedia.changed || (!partialRun?.projectDataLayer && lookupData?.dataLayer)) {
    recordProjectDataLayerForRun({
      dependencies,
      normalizedCode,
      runId,
      project: partialRun?.project || lookupData?.project,
      designReferenceImages: referenceMedia.designReferenceImages,
      dataLayer,
    });
  }

  startProjectFinalDisplayJob({
    normalizedCode,
    request,
    dependencies,
    options,
    runId,
  });

  return buildPendingProjectFinalDisplayResult({
    normalizedCode,
    publicBaseUrl,
    run: partialRun,
    runId,
    dataLayer,
    source: partialRun ? 'project_final_display_resuming' : 'project_final_display_started',
    warnings: [
      'project_final_display_running',
      ...referenceMediaWarnings(referenceMedia.failureCount),
    ],
  });
}

module.exports = {
  buildFallbackFinalPrompt,
  buildFinalTemplatePrompt,
  buildMaterialProcessingPrompt,
  collectDesignRequirementImageDirectives,
  prepareProjectFinalDisplay,
};
