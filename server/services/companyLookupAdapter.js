const {
  DATA_ORIGIN,
  DATA_SOURCE,
  ERROR_NOT_CONFIGURED,
  ERROR_PROJECT_NOT_FOUND,
  ERROR_QUERY_FAILED,
  LOOKUP_SOURCE,
  lookupCompanyProjectFromDb,
} = require('./companyDbLookupClient');
const {
  ensurePrimaryElementTerms,
  mapProposalElementTermsWithAi,
} = require('./aiElementMapper');
const {
  buildEmptyCategoryJudgment,
  classifyProposalCategoryWithAi,
} = require('./aiCategoryClassifier');
const { extractGraphicElementsFromProjectNameWithAi } = require('./aiGraphicElementExtractor');
const { inferTextElementsFromDesignRequirementWithAi } = require('./aiTextElementExtractor');
const {
  buildEmptyGalleryImageSelection,
  filterGalleryImagesForGraphicElements,
} = require('./aiGalleryImageFilter');
const {
  analyzeCompanyReferenceImagesForDesignText,
  buildEmptyReferenceDesignAnalysis,
} = require('./aiReferenceDesignAnalyzer');
const { lookupElementGalleryForAiMapping, emptyElementGallery } = require('./elementGalleryLookup');
const { extractElementTermsFromProposal } = require('./elementTermExtractor');

const PROJECT_CODE_PATTERN = /\b(yxf\d{10})\b/i;
const COMPANY_LOOKUP_SOURCE_DB_MINIMAL = DATA_SOURCE;
const REAL_COMPANY_LOOKUP_SOURCE = 'real_company_lookup';
const REAL_COMPANY_DATA_ORIGIN = 'real_company_db';
const ELEMENT_REQUIREMENT_SOURCE_REAL = 'real_company_element_requirement';
const ELEMENT_REQUIREMENT_SOURCE_UPLOADED = 'uploaded_proposal_graphic_elements';
const ELEMENT_REQUIREMENT_SOURCE_PROJECT_NAME = 'derived_from_project_name';
const UPLOADED_PROPOSAL_LOOKUP_SOURCE = 'uploaded_proposal_package';
const UPLOADED_PROPOSAL_DATA_ORIGIN = 'uploaded_development_proposal';
const PRESERVED_ELEMENT_REQUIREMENT_SOURCES = new Set([
  ELEMENT_REQUIREMENT_SOURCE_REAL,
  ELEMENT_REQUIREMENT_SOURCE_UPLOADED,
]);
const ERROR_PROJECT_CODE_UNRECOGNIZED = 'PROJECT_CODE_UNRECOGNIZED';
const ERROR_FIELD_MAPPING_EMPTY = 'FIELD_MAPPING_EMPTY';
const ERROR_MESSAGES = {
  [ERROR_PROJECT_CODE_UNRECOGNIZED]: '项目编号无法识别，请输入 YXF 开头的项目编号。',
  [ERROR_NOT_CONFIGURED]: '真实公司数据源未配置，请检查 COMPANY_DB_* 配置。',
  [ERROR_QUERY_FAILED]: '公司项目查询失败，请检查数据库连接和只读视图配置。',
  [ERROR_PROJECT_NOT_FOUND]: '项目编号不存在。',
  [ERROR_FIELD_MAPPING_EMPTY]: '字段映射为空，请检查公司只读视图字段。',
};

const FIELD_ALIASES = {
  project_name: ['project_name', 'projectName', 'name', 'title', 'project_title'],
  category: ['category', 'category_code', 'categoryCode', 'rawCategory', 'product_category'],
  category_label: ['category_label', 'categoryLabel', 'category_name', 'categoryName', 'category'],
  core_prompt: ['core_prompt', 'brief', 'projectBrief', 'prompt', 'main_prompt'],
  design_requirement: [
    'design_requirement',
    'designRequirement',
    'design_required',
    'developmentRequirement',
    'development_requirement',
    'developmentIdea',
    'development_idea',
    'objective',
    'brief',
  ],
  element_requirement: [
    'element_requirement',
    'elementRequirement',
    'graphicElements',
    'graphic_elements',
    'assetHints',
    'asset_hints',
    'designRequirementElementTerms',
    'design_requirement_element_terms',
  ],
  text_elements: [
    'text_elements',
    'textElements',
    'textElement',
    'copywriting',
    'copy',
    'slogan',
    '\u6587\u5b57\u5143\u7d20',
    '\u6587\u6848',
    '\u6587\u5b57',
  ],
  design_img: [
    'design_img',
    'designImg',
    'design_image',
    'design_images',
    'reference_image',
    'reference_images',
    'referenceImages',
    'ref_img',
    'ref_images',
    '\u53c2\u8003\u56fe',
    '\u53c2\u8003\u56fe\u7247',
    '\u8bbe\u8ba1\u53c2\u8003\u56fe',
  ],
  oper_img: [
    'oper_img',
    'operImg',
    'operation_img',
    'operation_image',
    'operation_images',
    'oper_image',
    'oper_images',
    '\u8fd0\u8425\u56fe',
    '\u8fd0\u8425\u53c2\u8003\u56fe',
  ],
  color_requirement: [
    'color_requirement',
    'colorRequirement',
    'color',
    'colors',
    'colorKeywords',
    'color_keywords',
  ],
  style_requirement: [
    'style_requirement',
    'styleRequirement',
    'style',
    'styles',
    'styleReferences',
    'style_references',
  ],
  craft_requirement: ['craft_requirement', 'craftRequirement', 'craft', 'process', 'technology'],
  material: ['material', 'materials', 'material_requirement', 'materialRequirement'],
  market: ['market', 'saleMarket', 'sales_market', 'target_market'],
  audience: ['audience', 'crowd', 'user_group', 'userGroup', 'target_audience'],
  scene: ['scene', 'occasion', 'usage_scene', 'usageScenario', 'usage_scenario'],
  quantity: ['quantity', 'quantityRequirement', 'quantity_requirement', 'qty'],
  size: ['size', 'sizeRequirement', 'size_requirement', 'spec_size'],
  specification: ['specification', 'specifications', 'spec', '规格'],
  source_row_id: ['source_row_id', 'id', 'projectId', 'project_id', 'confirmed_run_id'],
  updated_at: ['updated_at', 'updatedAt', 'modified_at', 'confirmed_exported_at'],
  created_at: ['created_at', 'createdAt', 'create_time'],
};

const DEVELOPMENT_KEYWORD_FIELDS = [
  '开发关键字',
  'devKeywords',
  'dev_keywords',
  'developmentKeywords',
  'development_keywords',
  'designKeywords',
  'design_keywords',
  'keywords',
  'keyword',
  'proposal_keywords',
  'product_keywords',
  'rawDevelopmentKeywords',
  'design_keyword',
];

function cleanString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeProjectCode(value) {
  const cleaned = cleanString(String(value || ''));
  if (!cleaned || !/^yxf\d{10}$/i.test(cleaned)) {
    return null;
  }
  return cleaned.toUpperCase();
}

function extractProjectCodeFromMessage(message) {
  const match = String(message || '').match(PROJECT_CODE_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

function resolveProjectCode(input = {}) {
  return (
    normalizeProjectCode(input.projectCode || input.project_code) ||
    extractProjectCodeFromMessage(input.message)
  );
}

function isEmptyValue(value) {
  return value === undefined || value === null || value === '';
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function valueToString(value) {
  if (isEmptyValue(value)) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(valueToString).filter(Boolean).join('; ');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return stripHtml(String(value));
}

function firstValue(source, aliases) {
  for (const alias of aliases) {
    if (!isEmptyValue(source[alias])) {
      return source[alias];
    }
  }
  return '';
}

function splitKeywordValue(value) {
  if (Array.isArray(value)) {
    return value.flatMap(splitKeywordValue);
  }
  if (isEmptyValue(value)) {
    return [];
  }
  if (typeof value !== 'string') {
    return [String(value).trim()].filter(Boolean);
  }

  const text = stripHtml(value);
  if (!text) {
    return [];
  }

  if (
    (text.startsWith('[') && text.endsWith(']')) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    try {
      return splitKeywordValue(JSON.parse(text));
    } catch (_error) {
      // Keep delimiter parsing for non-JSON strings.
    }
  }

  return text
    .split(/[\n\r,;，；、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

const GRAPHIC_ELEMENT_CARRIER_TERMS = new Set([
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
  'supply',
  'supplies',
  'party',
  'set',
  'pack',
  'pcs',
  'piece',
  'pieces',
]);

const GRAPHIC_ELEMENT_CJK_STOP_TERMS = [
  '冰箱贴',
  '厨房',
  '圆形',
  '方形',
  '以内',
  '手工材料包',
  '手工材料',
  '手工艺',
  '绘画类',
  '绘画',
  '钻石面',
  '钻石画',
  '水箱贴',
  '生日派对装饰',
  '派对装饰',
  '派对用品',
  '生日派对',
  '餐盘套装',
  '小餐盘',
  '大餐盘',
  '餐巾纸',
  '纸巾',
  '叉子',
  '杯子',
  '餐盘',
  '盘子',
  '套装',
  '装饰',
  '派对',
  '件套',
];

const GRAPHIC_ELEMENT_CJK_COLOR_TERMS = [
  '\u9ed1\u91d1',
  '\u9ed1\u767d',
  '\u7ea2\u7eff',
  '\u84dd\u767d',
  '\u7c89\u91d1',
  '\u73ab\u7470\u91d1',
  '\u9ed1\u8272',
  '\u767d\u8272',
  '\u7ea2\u8272',
  '\u7eff\u8272',
  '\u84dd\u8272',
  '\u7c89\u8272',
  '\u7d2b\u8272',
  '\u9ec4\u8272',
  '\u91d1\u8272',
  '\u94f6\u8272',
  '\u68d5\u8272',
  '\u6a59\u8272',
  '\u7070\u8272',
  '\u5f69\u8272',
];

function normalizeForGraphicElement(value) {
  return stripHtml(String(value || ''))
    .replace(/[_/|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCjkGraphicSegment(value) {
  let text = normalizeForGraphicElement(value)
    .replace(/\d+\s*(个|件|张|只|套|pcs)?/gi, '')
    .replace(/[（）()【】[\]{}]/g, ' ')
    .replace(/\s+/g, '')
    .trim();

  for (const stopTerm of GRAPHIC_ELEMENT_CJK_STOP_TERMS) {
    const index = text.indexOf(stopTerm);
    if (index > 0) {
      text = text.slice(0, index);
      break;
    }
    if (index === 0) {
      text = text.slice(stopTerm.length);
    }
  }

  return text
    .replace(/^[\s\-+，,;；、]+|[\s\-+，,;；、]+$/g, '')
    .trim();
}

function extractCjkGraphicElementCandidate(value) {
  const normalized = normalizeForGraphicElement(value);
  if (!/[\u4e00-\u9fff]/.test(normalized)) {
    return '';
  }

  const candidates = normalized
    .split(/[-–—_+/|,，;；、]+/)
    .map(cleanCjkGraphicSegment)
    .filter((item) => item && /[\u4e00-\u9fff]/.test(item))
    .filter((item) => item.length >= 2)
    .filter((item) => !GRAPHIC_ELEMENT_CJK_STOP_TERMS.includes(item))
    .filter((item) => item.length <= 16);

  return candidates.sort((left, right) => {
    if (left.length !== right.length) {
      return left.length - right.length;
    }
    return left.localeCompare(right, 'zh-Hans-CN');
  })[0] || '';
}

function extractCjkColorElementCandidates(value) {
  const normalized = normalizeForGraphicElement(value);
  return GRAPHIC_ELEMENT_CJK_COLOR_TERMS.filter((term) => normalized.includes(term));
}

function extractCjkGraphicElementCandidates(value) {
  return unique([
    extractCjkGraphicElementCandidate(value),
    ...extractCjkColorElementCandidates(value),
  ]);
}

function removeTrailingGraphicCarrierTerms(value) {
  const normalized = normalizeForGraphicElement(value);
  if (!normalized) {
    return '';
  }

  const parts = normalized.split(/\s+/);
  let end = parts.length;
  while (end > 0) {
    const token = parts[end - 1].toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (!GRAPHIC_ELEMENT_CARRIER_TERMS.has(token)) {
      break;
    }
    end -= 1;
  }

  if (end === 0 || end === parts.length) {
    return normalized;
  }

  return parts.slice(0, end).join(' ').trim();
}

function isCarrierOnlyGraphicElement(value) {
  const tokens = normalizeForGraphicElement(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  return tokens.length > 0 && tokens.every((token) => GRAPHIC_ELEMENT_CARRIER_TERMS.has(token));
}

function cleanGraphicElementCandidates(value) {
  const cjkCandidates = extractCjkGraphicElementCandidates(value);
  if (cjkCandidates.length > 0) {
    return cjkCandidates;
  }

  const cleaned = removeTrailingGraphicCarrierTerms(value);
  if (!cleaned || isCarrierOnlyGraphicElement(cleaned)) {
    return [];
  }
  return [cleaned];
}

function derivedGraphicElementCandidates(projectName) {
  const projectNameCandidates = cleanGraphicElementCandidates(projectName);
  if (projectNameCandidates.length > 0) {
    return {
      candidates: projectNameCandidates,
      source: ELEMENT_REQUIREMENT_SOURCE_PROJECT_NAME,
    };
  }

  return {
    candidates: [],
    source: '',
  };
}

function deriveGraphicElementRequirement({ projectName }) {
  const derived = derivedGraphicElementCandidates(projectName);
  return {
    value: derived.candidates.join('; '),
    source: derived.source,
  };
}

function deriveGraphicElementsFromProjectFields({ projectName }) {
  return deriveGraphicElementRequirement({ projectName }).value;
}

function parseJsonLikeText(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const text = stripHtml(value);
  if (
    !(
      (text.startsWith('[') && text.endsWith(']')) ||
      (text.startsWith('{') && text.endsWith('}')) ||
      (text.startsWith('"') && text.endsWith('"'))
    )
  ) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

function collectReferenceImagePaths(value) {
  const parsed = parseJsonLikeText(value);
  if (Array.isArray(parsed)) {
    return parsed.flatMap(collectReferenceImagePaths);
  }
  if (!parsed) {
    return [];
  }
  if (typeof parsed === 'object') {
    const preferred = [
      parsed.url,
      parsed.src,
      parsed.path,
      parsed.file,
      parsed.filename,
      parsed.name,
    ].filter(Boolean);
    return preferred.length > 0
      ? preferred.flatMap(collectReferenceImagePaths)
      : Object.values(parsed).flatMap(collectReferenceImagePaths);
  }

  return stripHtml(String(parsed))
    .split(/[\n\r,;锛岋紱]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function buildReferenceImageUrl(rawPath, env = process.env) {
  const pathValue = cleanString(rawPath);
  if (!pathValue || /^data:/i.test(pathValue) || /^javascript:/i.test(pathValue)) {
    return '';
  }
  if (isHttpUrl(pathValue)) {
    return pathValue;
  }

  const baseUrl = cleanString(env.COMPANY_REFERENCE_IMAGE_BASE_URL || '');
  if (!baseUrl || !isHttpUrl(baseUrl)) {
    return '';
  }

  return `${baseUrl.replace(/\/+$/, '')}/${pathValue.replace(/^\/+/, '')}`;
}

function filenameFromPath(rawPath) {
  const pathValue = cleanString(rawPath).split(/[?#]/)[0];
  return pathValue.split(/[\\/]/).filter(Boolean).pop() || pathValue;
}

function buildReferenceImageEntries(value, sourceField, label, env = process.env) {
  return unique(collectReferenceImagePaths(value)).map((rawPath) => ({
    source_field: sourceField,
    label,
    raw_path: rawPath,
    url: buildReferenceImageUrl(rawPath, env),
    filename: filenameFromPath(rawPath),
  }));
}

function normalizeDevelopmentKeywords(source = {}) {
  for (const field of DEVELOPMENT_KEYWORD_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      const keywords = unique(splitKeywordValue(source[field]));
      if (keywords.length > 0) {
        return {
          keywords,
          fieldAliasUsed: field,
        };
      }
    }
  }

  return {
    keywords: [],
    fieldAliasUsed: null,
  };
}

function normalizeMinimalCompanyFields(raw = {}, options = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const env = options.env || process.env;
  const keywords = normalizeDevelopmentKeywords(source);
  const category = valueToString(firstValue(source, FIELD_ALIASES.category));
  const categoryLabel = valueToString(firstValue(source, FIELD_ALIASES.category_label));
  const designImageValue = firstValue(source, FIELD_ALIASES.design_img);
  const operationImageValue = firstValue(source, FIELD_ALIASES.oper_img);
  const projectName = valueToString(firstValue(source, FIELD_ALIASES.project_name));
  const rawElementRequirement = valueToString(firstValue(source, FIELD_ALIASES.element_requirement));
  const derivedElementRequirement = deriveGraphicElementRequirement({
    projectName,
  });
  const elementRequirement = derivedElementRequirement.value;

  return {
    project_name: projectName,
    category,
    category_label: categoryLabel && categoryLabel !== category ? categoryLabel : categoryLabel,
    development_keywords: keywords.keywords,
    development_keywords_source_field: keywords.fieldAliasUsed,
    core_prompt: valueToString(firstValue(source, FIELD_ALIASES.core_prompt)),
    design_requirement: valueToString(firstValue(source, FIELD_ALIASES.design_requirement)),
    element_requirement: elementRequirement,
    element_requirement_source: derivedElementRequirement.source,
    ai_graphic_elements: elementRequirement,
    ai_graphic_elements_source: derivedElementRequirement.source,
    ai_graphic_elements_status: elementRequirement ? 'fallback' : '',
    ai_graphic_elements_error: null,
    real_graphic_elements: rawElementRequirement,
    real_graphic_elements_source: rawElementRequirement ? ELEMENT_REQUIREMENT_SOURCE_REAL : '',
    text_elements: valueToString(firstValue(source, FIELD_ALIASES.text_elements)),
    text_elements_source: valueToString(firstValue(source, FIELD_ALIASES.text_elements))
      ? 'real_company_text_elements'
      : '',
    text_elements_status: valueToString(firstValue(source, FIELD_ALIASES.text_elements))
      ? 'real_data'
      : '',
    text_elements_error: null,
    design_img: valueToString(designImageValue),
    oper_img: valueToString(operationImageValue),
    reference_images: [
      ...buildReferenceImageEntries(designImageValue, 'design_img', '设计参考图', env),
      ...buildReferenceImageEntries(operationImageValue, 'oper_img', '运营参考图', env),
    ],
    color_requirement: valueToString(firstValue(source, FIELD_ALIASES.color_requirement)),
    style_requirement: valueToString(firstValue(source, FIELD_ALIASES.style_requirement)),
    craft_requirement: valueToString(firstValue(source, FIELD_ALIASES.craft_requirement)),
    material: valueToString(firstValue(source, FIELD_ALIASES.material)),
    market: valueToString(firstValue(source, FIELD_ALIASES.market)),
    audience: valueToString(firstValue(source, FIELD_ALIASES.audience)),
    scene: valueToString(firstValue(source, FIELD_ALIASES.scene)),
    quantity: valueToString(firstValue(source, FIELD_ALIASES.quantity)),
    size: valueToString(firstValue(source, FIELD_ALIASES.size)),
    specification: valueToString(firstValue(source, FIELD_ALIASES.specification)),
    source_row_id: valueToString(firstValue(source, FIELD_ALIASES.source_row_id)),
    updated_at: valueToString(firstValue(source, FIELD_ALIASES.updated_at)),
    created_at: valueToString(firstValue(source, FIELD_ALIASES.created_at)),
  };
}

function emptyProposal(projectCode) {
  return {
    project_code: projectCode || '',
    project_name: '',
    category: '',
    category_label: '',
    development_keywords: [],
    core_prompt: '',
    design_requirement: '',
    element_requirement: '',
    element_requirement_source: '',
    ai_graphic_elements: '',
    ai_graphic_elements_source: '',
    ai_graphic_elements_status: '',
    ai_graphic_elements_error: null,
    real_graphic_elements: '',
    real_graphic_elements_source: '',
    text_elements: '',
    text_elements_source: '',
    text_elements_status: '',
    text_elements_error: null,
    design_img: '',
    oper_img: '',
    reference_images: [],
    color_requirement: '',
    style_requirement: '',
    craft_requirement: '',
    material: '',
    market: '',
    audience: '',
    scene: '',
    quantity: '',
    size: '',
    specification: '',
    source_row_id: '',
    updated_at: '',
    created_at: '',
  };
}

function buildProposal(projectCode, minimalFields = {}) {
  return {
    ...emptyProposal(projectCode),
    ...minimalFields,
    project_code: projectCode || '',
    development_keywords: Array.isArray(minimalFields.development_keywords)
      ? minimalFields.development_keywords
      : [],
    reference_images: Array.isArray(minimalFields.reference_images)
      ? minimalFields.reference_images
      : [],
  };
}

function hasPreservedGraphicElements(proposal = {}) {
  const source = cleanString(proposal.element_requirement_source || proposal.real_graphic_elements_source);
  return (
    PRESERVED_ELEMENT_REQUIREMENT_SOURCES.has(source) &&
    Boolean(cleanString(proposal.real_graphic_elements || proposal.element_requirement))
  );
}

function preserveProvidedGraphicElements(proposal = {}) {
  const value = cleanString(proposal.real_graphic_elements || proposal.element_requirement);
  if (!value) {
    return proposal;
  }

  const source =
    cleanString(proposal.real_graphic_elements_source) ||
    cleanString(proposal.element_requirement_source) ||
    ELEMENT_REQUIREMENT_SOURCE_REAL;

  return {
    ...proposal,
    element_requirement: proposal.element_requirement || value,
    element_requirement_source: proposal.element_requirement_source || source,
    ai_graphic_elements: proposal.ai_graphic_elements || value,
    ai_graphic_elements_source: proposal.ai_graphic_elements_source || source,
    ai_graphic_elements_status: proposal.ai_graphic_elements_status || 'provided_graphic_elements',
    ai_graphic_elements_error: proposal.ai_graphic_elements_error || null,
  };
}

function summarizeFields(proposal) {
  const ignored = new Set(['project_code', 'reference_images']);
  const fieldEntries = Object.entries(proposal || {}).filter(([key]) => !ignored.has(key));
  const nonEmptyFieldCount = fieldEntries.filter(([, value]) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return !isEmptyValue(value);
  }).length;

  return {
    field_count: fieldEntries.length,
    non_empty_field_count: nonEmptyFieldCount,
    development_keywords_count: Array.isArray(proposal?.development_keywords)
      ? proposal.development_keywords.length
      : 0,
  };
}

function resolveErrorMessage(errorCode) {
  return ERROR_MESSAGES[errorCode] || '查询失败。';
}

async function buildResponse({
  projectCode,
  found,
  proposal,
  errorCode = null,
  lookupStatus = null,
  env,
  fetchImpl,
  publicBaseUrl,
  source = REAL_COMPANY_LOOKUP_SOURCE,
  dataOrigin = REAL_COMPANY_DATA_ORIGIN,
  mock = false,
}) {
  const initialFieldSummary = summarizeFields(proposal);
  const finalErrorCode =
    found && initialFieldSummary.non_empty_field_count === 0 ? ERROR_FIELD_MAPPING_EMPTY : errorCode;
  const textElementProposal = found && !finalErrorCode
    ? await inferTextElementsFromDesignRequirementWithAi(proposal, {
        env,
        fetchImpl,
      })
    : proposal;
  const responseProposal = found && !finalErrorCode
    ? hasPreservedGraphicElements(textElementProposal)
      ? preserveProvidedGraphicElements(textElementProposal)
      : await extractGraphicElementsFromProjectNameWithAi(textElementProposal, {
          env,
          fetchImpl,
          fallbackExtractor: deriveGraphicElementsFromProjectFields,
        })
    : textElementProposal;
  const skippedAiElementMapping = {
    ai_status: 'skipped',
    model: 'gpt-5.5',
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
    ai_error: null,
  };
  const [rawAiElementMapping, category_judgment] = found && !finalErrorCode
    ? await Promise.all([
        mapProposalElementTermsWithAi(responseProposal, { env, fetchImpl }),
        classifyProposalCategoryWithAi(responseProposal, { env, fetchImpl, publicBaseUrl }),
      ])
    : [
        skippedAiElementMapping,
        buildEmptyCategoryJudgment('skipped'),
      ];
  const ai_element_mapping = found && !finalErrorCode
    ? ensurePrimaryElementTerms(rawAiElementMapping, responseProposal)
    : rawAiElementMapping;
  const fieldSummary = summarizeFields(responseProposal);
  const elementTermProposal =
    responseProposal.element_requirement_source &&
    !PRESERVED_ELEMENT_REQUIREMENT_SOURCES.has(responseProposal.element_requirement_source)
      ? { ...responseProposal, element_requirement: '' }
      : responseProposal;
  const element_terms = found ? extractElementTermsFromProposal(elementTermProposal) : {
    source: 'builtin_element_terms',
    term_count: 0,
    matched_term_count: 0,
    matched_terms: [],
  };
  const element_gallery = found && !finalErrorCode
    ? lookupElementGalleryForAiMapping(ai_element_mapping, { env })
    : emptyElementGallery('skipped');
  const selected_gallery_images = found && !finalErrorCode
    ? await filterGalleryImagesForGraphicElements(responseProposal, ai_element_mapping, element_gallery, {
        env,
        fetchImpl,
      })
    : buildEmptyGalleryImageSelection('skipped');
  const reference_design_analysis = found && !finalErrorCode
    ? await analyzeCompanyReferenceImagesForDesignText(
        responseProposal,
        ai_element_mapping,
        selected_gallery_images,
        {
          env,
          fetchImpl,
        },
      )
    : buildEmptyReferenceDesignAnalysis('skipped');

  return {
    project_code: projectCode || '',
    found: Boolean(found && !finalErrorCode),
    source,
    data_origin: dataOrigin,
    mock,
    proposal: responseProposal,
    category_judgment,
    element_terms,
    ai_element_mapping,
    element_gallery,
    selected_gallery_images,
    reference_design_analysis,
    field_summary: fieldSummary,
    lookup_status: lookupStatus,
    error_code: finalErrorCode,
    error_message: finalErrorCode ? resolveErrorMessage(finalErrorCode) : '',
  };
}

async function prepareProposalFromMinimalFields(input = {}, options = {}) {
  const projectCode = cleanString(input.projectCode || input.project_code) || '';
  const proposal = buildProposal(projectCode, input.minimalFields || input.proposal || {});

  return buildResponse({
    projectCode,
    found: true,
    proposal,
    lookupStatus: input.lookupStatus || 'provided_fields',
    env: options.env,
    fetchImpl: options.fetchImpl,
    publicBaseUrl: input.publicBaseUrl || options.publicBaseUrl,
    source: input.source || UPLOADED_PROPOSAL_LOOKUP_SOURCE,
    dataOrigin: input.dataOrigin || UPLOADED_PROPOSAL_DATA_ORIGIN,
    mock: Boolean(input.mock),
  });
}

async function prepareProposalFromCompanyLookup(input = {}, options = {}) {
  const projectCode = resolveProjectCode(input);
  if (!projectCode) {
    return buildResponse({
      projectCode: '',
      found: false,
      proposal: emptyProposal(''),
      errorCode: ERROR_PROJECT_CODE_UNRECOGNIZED,
      lookupStatus: 'invalid_project_code',
      env: options.env,
      fetchImpl: options.fetchImpl,
      publicBaseUrl: input.publicBaseUrl || options.publicBaseUrl,
    });
  }

  const lookup = await lookupCompanyProjectFromDb(projectCode, {
    env: options.env,
    mysql: options.mysql,
    normalizeMinimalCompanyFields,
  });
  const proposal = lookup.found
    ? buildProposal(projectCode, lookup.minimalFields)
    : emptyProposal(projectCode);

  return buildResponse({
    projectCode,
    found: lookup.found,
    proposal,
    errorCode: lookup.errorCode,
    lookupStatus: lookup.lookupStatus,
    env: options.env,
    fetchImpl: options.fetchImpl,
    publicBaseUrl: input.publicBaseUrl || options.publicBaseUrl,
  });
}

async function prepareCompanyProjectDataLayerLookup(input = {}, options = {}) {
  const projectCode = resolveProjectCode(input);
  if (!projectCode) {
    return {
      project_code: '',
      found: false,
      source: COMPANY_LOOKUP_SOURCE_DB_MINIMAL,
      data_origin: REAL_COMPANY_DATA_ORIGIN,
      proposal: emptyProposal(''),
      category_judgment: buildEmptyCategoryJudgment('invalid_project_code'),
      lookup_status: 'invalid_project_code',
      error_code: ERROR_PROJECT_CODE_UNRECOGNIZED,
      error_message: resolveErrorMessage(ERROR_PROJECT_CODE_UNRECOGNIZED),
    };
  }

  const lookup = await lookupCompanyProjectFromDb(projectCode, {
    env: options.env,
    mysql: options.mysql,
    normalizeMinimalCompanyFields,
  });
  const proposal = lookup.found
    ? buildProposal(projectCode, lookup.minimalFields)
    : emptyProposal(projectCode);

  return {
    project_code: projectCode,
    found: Boolean(lookup.found),
    source: COMPANY_LOOKUP_SOURCE_DB_MINIMAL,
    data_origin: REAL_COMPANY_DATA_ORIGIN,
    proposal,
    category_judgment: {
      ...buildEmptyCategoryJudgment(lookup.found ? 'db_minimal' : 'skipped'),
      predicted_category: proposal.category_label || proposal.category || '',
      status: lookup.found ? 'db_minimal' : 'skipped',
      source: COMPANY_LOOKUP_SOURCE_DB_MINIMAL,
    },
    lookup_status: lookup.lookupStatus,
    error_code: lookup.errorCode,
    error_message: lookup.errorCode ? resolveErrorMessage(lookup.errorCode) : '',
  };
}

module.exports = {
  COMPANY_LOOKUP_SOURCE_DB_MINIMAL,
  DATA_ORIGIN,
  DATA_SOURCE,
  DEVELOPMENT_KEYWORD_FIELDS,
  ERROR_FIELD_MAPPING_EMPTY,
  ERROR_MESSAGES,
  ERROR_PROJECT_CODE_UNRECOGNIZED,
  ELEMENT_REQUIREMENT_SOURCE_UPLOADED,
  LOOKUP_SOURCE,
  REAL_COMPANY_DATA_ORIGIN,
  REAL_COMPANY_LOOKUP_SOURCE,
  UPLOADED_PROPOSAL_DATA_ORIGIN,
  UPLOADED_PROPOSAL_LOOKUP_SOURCE,
  buildProposal,
  deriveGraphicElementsFromProjectFields,
  emptyProposal,
  extractProjectCodeFromMessage,
  normalizeDevelopmentKeywords,
  normalizeMinimalCompanyFields,
  prepareCompanyProjectDataLayerLookup,
  prepareProposalFromCompanyLookup,
  prepareProposalFromMinimalFields,
  resolveProjectCode,
  summarizeFields,
};
