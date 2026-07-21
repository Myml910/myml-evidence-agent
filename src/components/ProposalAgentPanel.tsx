import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import {
  addCategoryCatalogEntry,
  analyzeMaterialShapeLevels,
  composeFinalPrompt,
  deleteCategoryCatalogImage,
  generatePatternImage,
  getCategoryCatalog,
  prepareProposal,
  prepareProposalPackage,
  uploadCategoryCatalogImage,
} from '../api/proposalApi';
import type {
  CategoryCatalogEntry,
  CategoryCatalogImage,
  CategoryCatalogResponse,
  CompanyProjectProposal,
  ComposeFinalPromptResponse,
  GeneratePatternImageInputImage,
  GeneratePatternImageResponse,
  MaterialShapeAnalysisResponse,
  ProposalAgentPrepareResponse,
} from '../types/proposal';

const initialProjectCode = 'YXF2603230144';
const defaultProposalPackagePath = 'C:\\Users\\admin\\Downloads\\SLP_blanket_proposal_upload_package.zip';
const MATERIAL_SHAPE_CATEGORY_COUNT = 3;
const MAX_DESIGN_REFERENCE_MATERIAL_IMAGES = 4;
const MATERIAL_BOARD_REVERSE_PROMPT_TEMPLATE_ID = 'material_board_reverse';
const DESIGN_REFERENCE_SOURCE_FIELD = 'design_img';
const EXTERNAL_EVIDENCE_SOURCE_FIELD = 'external_evidence_img';
const AGENT_FLOW_MAX_RETRIES = 3;

const AGENT_FLOW_STEP_DEFINITIONS = [
  { id: 'material', label: '素材图处理' },
  { id: 'reference', label: '设计参考图素材提取' },
  { id: 'layout', label: '历史版式/空版式母版' },
  { id: 'prompt', label: '最终提示词编写' },
  { id: 'generate', label: '最终图生图' },
] as const;

type AgentFlowStepId = (typeof AGENT_FLOW_STEP_DEFINITIONS)[number]['id'];
type AgentFlowStepStatus = 'pending' | 'running' | 'success' | 'skipped' | 'blocked' | 'error';

type AgentFlowStep = {
  id: AgentFlowStepId;
  label: string;
  status: AgentFlowStepStatus;
  attempts: number;
  message: string;
};

function createAgentFlowSteps(): AgentFlowStep[] {
  return AGENT_FLOW_STEP_DEFINITIONS.map((step) => ({
    ...step,
    status: 'pending',
    attempts: 0,
    message: '',
  }));
}

const MATERIAL_BOARD_REVERSE_PROMPT_TEMPLATE = `Analyze the provided image and generate a detailed visual description by filling out the following template strictly.

Instructions:
1. Output strictly in the requested Markdown format.
2. Keep the bold headers and English/Chinese labels exactly as shown.
3. Provide detailed, high-quality English descriptions for each section based on the visual analysis of the image.

Template:
## Image Prompt Description

**1. Core Subject & Theme (核心主体与主题):**
[Summarize the main content in one sentence]

**2. Art Style & Medium (艺术风格与媒介):**
[Describe the art style, medium, lines, and aesthetic]

**3. Color Palette & Lighting (配色与光影):**
[Describe colors, lighting quality, and atmosphere]

**4. Composition & Perspective (构图与视角):**
[Describe layout, balance, and view angle]

**5. Detailed Visual Elements (分层细节描述):**

*   **Main Focus (Center/Midground):** [Describe the core elements]
*   **Background & Atmosphere:** [Describe the setting and environment]
*   **Foreground & Framing:** [Describe foreground elements]
*   **Specific Details/Props:** [Describe specific objects, patterns]

**6. Text & Typography (If any):**
[Describe text content and font style if applicable. If none, write "None".]`;

type PromptTemplateId =
  | 'structured_ai'
  | 'minimal_natural';

type MaterialShapeLevel = {
  key: 'primary' | 'secondary' | 'tertiary';
  label: '一级形' | '二级形' | '三级形';
  title: string;
  focus: string;
  output: string;
  countRule: string;
  hardBoundary: string;
  forbidden: string;
};

type PromptTemplateBranch = {
  id: PromptTemplateId;
  label: string;
  shortLabel: string;
  goal: string;
  useCase: string;
  aiMethod: string;
};

const PROMPT_TEMPLATE_BRANCHES: PromptTemplateBranch[] = [
  {
    id: 'structured_ai',
    label: '结构板',
    shortLabel: '结构板',
    goal: '保留所有结构化设计维度，让 AI 结合素材图和版式母版输出真正最终提示词。',
    useCase: '用于验证完整结构化控制是否能稳定地产出可用图案。',
    aiMethod:
      'AI 先读取图1版式母版和图2+素材，再按完整结构化模板重组为真正可提交给生图模型的最终提示词。',
  },
  {
    id: 'minimal_natural',
    label: '自然语言板',
    shortLabel: '自然语言板',
    goal: '只把历史图参考方式和背景策略做成结构化规则，其余用自然语言表达。',
    useCase: '当结构化提示词过度控制、结果显得僵硬或公式化时使用，用来判断提示词泛用性问题。',
    aiMethod:
      'AI 结合素材图和版式母版，输出“历史图怎么参考、背景怎么实施”两块结构化策略，其余改写成自然语言最终提示词。',
  },
];

const MATERIAL_SHAPE_LEVELS: MaterialShapeLevel[] = [
  {
    key: 'primary',
    label: '一级形',
    title: '一级形 / 主体核心素材',
    focus:
      '一级形是最终设计中最优先被识别的核心主视觉，不是全量素材集合。只提取最能代表主题的核心主体、大标题字形、主图标、主视觉符号或最大视觉块。',
    output:
      '输出一张一级形素材图：主体要大、清晰、完整，元素数量少，方便后续放入历史版位作为主视觉。',
    countRule: '最多 1-3 个独立一级主体；宁可少而明确，不要为了“完整”把参考图中所有元素都放进来。',
    hardBoundary:
      '如果参考图里有多个完整产品版面，只选择最能代表主题的核心主视觉或主题字形；不要输出整套产品组合、完整餐盘/纸巾/杯子/包装版面、整排素材板或多个版位全集。',
    forbidden:
      '禁止出现商品载体和展示结构，包括餐盘、纸巾、杯子、叉勺、包装袋、产品卡片、商品列表截图、价格/评分/店铺信息、完整产品组合、重复小条带、边框素材板、三级散点。',
  },
  {
    key: 'secondary',
    label: '二级形',
    title: '二级形 / 辅助结构素材',
    focus:
      '二级形是支撑一级形的中等装饰结构，不是第二张全量素材集合。提取辅助图形、次级图标、边框片段、角花、装饰带、承托主视觉的局部纹样和中等体量元素。',
    output:
      '输出一张二级形素材图：元素体量中等、可组合、可用于版位边缘、主视觉周围和系列化装饰。',
    countRule: '输出 4-12 个中等体量元素或片段；不要输出一级形大主体，也不要收纳大量三级小点缀。',
    hardBoundary:
      '二级形必须排除一级形中的大标题、主徽章、主角色、最大图标和完整主视觉；只保留能够辅助主视觉的边框、角花、图标、局部装饰和中等结构。',
    forbidden:
      '禁止出现商品载体和展示结构，包括餐盘、纸巾、杯子、叉勺、包装袋、产品卡片、商品列表截图、价格/评分/店铺信息；禁止重复一级形完整主视觉、完整产品组合、长条全量素材板。',
  },
  {
    key: 'tertiary',
    label: '三级形',
    title: '三级形 / 点缀底纹素材',
    focus:
      '提取小点缀、小星点、小花纹、小符号、轻量背景纹理、散点、光点、细小重复纹样和氛围装饰。不要输出主标题、主角色或大主体。',
    output:
      '输出一张三级形素材图：小元素要分散清楚、数量适中、适合做背景点缀、边缘节奏和细节补充。',
    countRule: '可以输出较多小元素，但它们必须是低权重细节；不要包含大标题、主徽章、主角色或中等装饰组。',
    hardBoundary:
      '三级形只用于氛围、底纹、重复节奏和细节补充；允许小点缀、小图标、小纹样、小光点、小线条，但不能承担主视觉。',
    forbidden:
      '禁止出现商品载体、完整产品组合、一级主视觉、二级边框大组、商品列表截图、价格/评分/店铺信息。',
  },
];

const fieldRows: Array<{
  key: keyof CompanyProjectProposal;
  label: string;
  wide?: boolean;
}> = [
  { key: 'project_code', label: '项目编号' },
  { key: 'project_name', label: '项目名称' },
  { key: 'category', label: '产品品类' },
  { key: 'category_label', label: '品类名称' },
  { key: 'development_keywords', label: '开发关键字', wide: true },
  { key: 'core_prompt', label: '核心提示词', wide: true },
  { key: 'design_requirement', label: '开发思路', wide: true },
  { key: 'text_elements', label: '文字元素', wide: true },
  { key: 'design_img', label: '设计参考图', wide: true },
  { key: 'oper_img', label: '运营参考图', wide: true },
  { key: 'color_requirement', label: '颜色要求' },
  { key: 'style_requirement', label: '风格要求' },
  { key: 'craft_requirement', label: '工艺要求' },
  { key: 'material', label: '材质' },
  { key: 'market', label: '市场' },
  { key: 'audience', label: '人群' },
  { key: 'scene', label: '场景' },
  { key: 'quantity', label: '数量' },
  { key: 'size', label: '尺寸' },
  { key: 'specification', label: '规格' },
  { key: 'source_row_id', label: 'source_row_id' },
  { key: 'updated_at', label: 'updated_at' },
  { key: 'created_at', label: 'created_at' },
];

function displayValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join('、') : '—';
  }
  if (value === undefined || value === null || value === '') {
    return '—';
  }
  return String(value);
}

function splitDisplayTerms(value: unknown) {
  return String(value || '')
    .split(/[\n\r,;，；、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stripChineseFromVisibleTextElement(value: string) {
  const withoutChinese = value
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ')
    .replace(/[，。；、：：“”‘’（）【】《》？！]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,.!?'"()[\]{}<>_\-/|]+|[\s:;,.!?'"()[\]{}<>_\-/|]+$/g, '')
    .trim();

  return /[a-z0-9]/i.test(withoutChinese) ? withoutChinese : '';
}

function graphicElementSourceLabel(source: string, mode: 'ai' | 'real') {
  if (source === 'ai_project_name') {
    return 'AI 模型 / 项目名称';
  }
  if (source === 'derived_from_project_name') {
    return '规则 fallback / 项目名称';
  }
  if (source === 'real_company_element_requirement') {
    return '真实数据 / 公司图形元素';
  }
  if (mode === 'ai') {
    return 'AI 提取';
  }
  return '真实数据';
}

function textElementSourceLabel(source: string) {
  if (source === 'real_company_text_elements') {
    return '真实数据 / 文字元素字段';
  }
  if (source === 'ai_design_requirement_text_elements') {
    return 'AI 补全 / 开发思路';
  }
  return source || '暂无来源';
}

function getErrorMessage(response: ProposalAgentPrepareResponse | null, fallback: string | null) {
  if (fallback) {
    return fallback;
  }
  if (!response || response.found) {
    return null;
  }
  return response.error_message || '查询失败。';
}

function DataLayerBadge({ label = '数据层' }: { label?: string }) {
  return <span className="data-layer-badge">{label}</span>;
}

type DataLayerSection = {
  id: string;
  title: string;
  source: string;
  current: string;
  data: string[];
  scenario: string;
  useLayer: string;
};

function countAiMappedTerms(mapping: ProposalAgentPrepareResponse['ai_element_mapping']) {
  return (
    (mapping?.summary?.primary_count || 0) +
    (mapping?.summary?.scene_count || 0) +
    (mapping?.summary?.style_count || 0) +
    (mapping?.summary?.attribute_count || 0)
  );
}

function buildDataLayerSections(result: ProposalAgentPrepareResponse): DataLayerSection[] {
  const proposal = result.proposal;
  const categoryJudgment = result.category_judgment;
  const aiGraphicTerms = splitDisplayTerms(proposal.ai_graphic_elements || proposal.element_requirement);
  const realGraphicTerms = splitDisplayTerms(proposal.real_graphic_elements);
  const referenceImageCount = proposal.reference_images?.length || 0;
  const galleryImageCount = result.element_gallery?.image_count || 0;
  const selectedGalleryImages = result.selected_gallery_images;

  return [
    {
      id: 'company-fields',
      title: '公司真实开发数据',
      source: result.data_origin || result.source,
      current: `${result.field_summary.non_empty_field_count}/${result.field_summary.field_count} 个字段已填充`,
      data: [
        '项目编号、项目名称、品类字段',
        '开发关键词、核心提示、开发思路',
        '文字元素、颜色、风格、材质、场景、规格',
      ],
      scenario: '作为所有后续判断的事实底座，用于复盘真实开发提案、解释 AI 判断来源、对齐公司原始数据。',
      useLayer: '后续可生成提案摘要、任务拆解、设计需求卡、人工复核表。',
    },
    {
      id: 'category-catalog',
      title: '测试品类候选目录',
      source: categoryJudgment?.catalog_source || '2026-6月测试品类表',
      current: `${categoryJudgment?.candidate_count || 0} 个可用品类`,
      data: ['餐盘、冰箱贴邮轮门贴、DTF杯贴等候选品类', '可补充品类图 URL', '模型只能在候选目录中选择一个真实品类'],
      scenario: '限定真实品类判断的搜索范围，避免模型自由发散或生成表外品类。',
      useLayer: '后续可作为品类筛选、品类看板、批量校验、开发优先级入口。',
    },
    {
      id: 'category-judgment',
      title: '真实品类判断结果',
      source: categoryJudgment?.match_source === 'ai' ? 'AI 模型判断' : '规则兜底判断',
      current: categoryJudgment?.predicted_category
        ? `${categoryJudgment.predicted_category} / ${Math.round((categoryJudgment.confidence || 0) * 100)}%${
            categoryJudgment.category_image?.image_url ? ' / 有品类图' : ''
          }`
        : '暂无判断',
      data: ['预测品类、置信度、判断原因、依据字段、备选品类、命中品类图'],
      scenario: '把开发提案归入真实品类，用于后续统计、筛选、复核和自动分流。',
      useLayer: '后续可做品类确认按钮、批量审核队列、低置信度人工复核入口。',
    },
    {
      id: 'reference-images',
      title: '公司参考图数据',
      source: 'design_img / oper_img',
      current: `${referenceImageCount} 张参考图`,
      data: ['设计参考图、运营参考图、原始路径、展示 URL、文件名'],
      scenario: '提供视觉证据，用于理解开发需求、辅助风格判断、对照公司原始素材。',
      useLayer: '后续可做图片预览、图片证据选择、视觉相似检索入口。',
    },
    {
      id: 'graphic-elements',
      title: '图案元素数据',
      source: '项目名称 AI 提取 + 公司真实图形元素字段',
      current: `AI ${aiGraphicTerms.length} 个 / 真实 ${realGraphicTerms.length} 个`,
      data: ['AI 图案元素、真实图形元素、来源标记、提取状态'],
      scenario: '识别提案中的核心视觉主题，用于连接元素词库和图库候选。',
      useLayer: '后续可做图案主题确认、设计素材召回、元素缺口分析。',
    },
    {
      id: 'element-vocabulary',
      title: '内置元素词库命中',
      source: result.element_terms?.source || 'builtin_element_terms',
      current: `${result.element_terms?.matched_term_count || 0}/${result.element_terms?.term_count || 0} 个词命中`,
      data: ['命中词、来源字段、命中方式'],
      scenario: '把原始提案文本落到统一元素词标准，降低字段表述差异。',
      useLayer: '后续可做标准词过滤、元素标签管理、词库覆盖率分析。',
    },
    {
      id: 'ai-element-mapping',
      title: 'AI 元素映射数据',
      source: `${result.ai_element_mapping?.source || 'ai_element_mapper'} / ${result.ai_element_mapping?.model || ''}`,
      current: `${countAiMappedTerms(result.ai_element_mapping)} 个结构化元素词`,
      data: ['一级元素词、场景词、风格词、属性词、置信度、判断理由'],
      scenario: '把元素词拆分成可消费的语义维度，用于后续设计、检索和分析。',
      useLayer: '后续可做多维筛选、设计标签面板、自动推荐规则输入。',
    },
    {
      id: 'gallery-relationship',
      title: '元素图库关系数据',
      source: result.element_gallery?.source || 'element_source_gallery_index',
      current: `${galleryImageCount} 张图库候选图`,
      data: ['元素词节点、图库图片节点、词图关系、交集数量'],
      scenario: '展示元素词与图库图片的连接关系，用于素材召回和候选图解释。',
      useLayer: '后续可做图库推荐、素材挑选、关系图钻取和设计参考包。',
    },
    {
      id: 'selected-gallery-images',
      title: 'AI 筛选图库图片',
      source: selectedGalleryImages?.source || 'ai_gallery_image_filter',
      current: `${selectedGalleryImages?.selected_image_count || 0}/${selectedGalleryImages?.candidate_image_count || 0} 张入选`,
      data: ['入选图片、匹配分数、匹配图案元素、AI 筛选理由、连接元素词'],
      scenario: '从图库候选图中筛出真正符合图案元素需求的图片，减少人工在候选图里二次查找。',
      useLayer: '后续可作为设计参考包、图片确认队列、素材下载/投喂生成模型入口。',
    },
  ];
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('图片读取失败。'));
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('图片压缩结果读取失败。'));
    reader.readAsDataURL(blob);
  });
}

function loadUploadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败，无法上传。'));
    image.src = dataUrl;
  });
}

type CategoryUploadLayoutKind = 'square' | 'landscape' | 'portrait';

type CategoryUploadCanvasSpec = {
  kind: CategoryUploadLayoutKind;
  width: number;
  height: number;
  label: string;
};

const CATEGORY_UPLOAD_CANVAS_SPECS: Record<CategoryUploadLayoutKind, CategoryUploadCanvasSpec> = {
  square: {
    kind: 'square',
    width: 2048,
    height: 2048,
    label: 'square 2048x2048',
  },
  landscape: {
    kind: 'landscape',
    width: 2048,
    height: 1024,
    label: 'landscape 2048x1024',
  },
  portrait: {
    kind: 'portrait',
    width: 1024,
    height: 2048,
    label: 'portrait 1024x2048',
  },
};

function resolveCategoryUploadCanvasSpec(width: number, height: number): CategoryUploadCanvasSpec {
  const ratio = width / Math.max(1, height);
  if (ratio > 1.08) {
    return CATEGORY_UPLOAD_CANVAS_SPECS.landscape;
  }
  if (ratio < 0.92) {
    return CATEGORY_UPLOAD_CANVAS_SPECS.portrait;
  }
  return CATEGORY_UPLOAD_CANVAS_SPECS.square;
}

function drawContainedImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
) {
  const scale = Math.min(targetWidth / Math.max(1, sourceWidth), targetHeight / Math.max(1, sourceHeight));
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
  const drawX = Math.round((targetWidth - drawWidth) / 2);
  const drawY = Math.round((targetHeight - drawHeight) / 2);

  context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality = 0.84) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('图片压缩失败。'));
        }
      },
      'image/jpeg',
      quality,
    );
  });
}

async function canvasToBoundedJpegBlob(canvas: HTMLCanvasElement) {
  const uploadMaxBytes = 7.5 * 1024 * 1024;
  const qualities = [0.88, 0.82, 0.76, 0.7, 0.64];
  let fallbackBlob: Blob | null = null;

  for (const quality of qualities) {
    const blob = await canvasToJpegBlob(canvas, quality);
    fallbackBlob = blob;
    if (blob.size <= uploadMaxBytes) {
      return blob;
    }
  }

  return fallbackBlob || canvasToJpegBlob(canvas, 0.64);
}

function processedCategoryFilename(filename: string, canvasSpec: CategoryUploadCanvasSpec) {
  const baseName = filename.replace(/\.[^.]+$/, '') || 'category-image';
  return `${baseName}-${canvasSpec.kind}-${canvasSpec.width}x${canvasSpec.height}.jpg`;
}

async function prepareCategoryImageUpload(file: File) {
  const originalDataUrl = await fileToDataUrl(file);
  const directUploadMaxBytes = 2 * 1024 * 1024;

  if (file.type === 'image/gif') {
    return {
      imageData: originalDataUrl,
      filename: file.name,
      mimeType: file.type || 'image/png',
      compressed: false,
      padded: false,
      layoutLabel: 'original gif',
    };
  }

  const image = await loadUploadImage(originalDataUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const canvasSpec = resolveCategoryUploadCanvasSpec(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = canvasSpec.width;
  canvas.height = canvasSpec.height;

  const context = canvas.getContext('2d');
  if (!context) {
    return {
      imageData: originalDataUrl,
      filename: file.name,
      mimeType: file.type || 'image/png',
      compressed: false,
      padded: false,
      layoutLabel: 'original',
    };
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  drawContainedImage(context, image, width, height, canvas.width, canvas.height);

  const compressedBlob = await canvasToBoundedJpegBlob(canvas);

  return {
    imageData: await blobToDataUrl(compressedBlob),
    filename: processedCategoryFilename(file.name, canvasSpec),
    mimeType: 'image/jpeg',
    compressed: compressedBlob.size < file.size || file.size > directUploadMaxBytes,
    padded: true,
    layoutLabel: canvasSpec.label,
  };
}

function categoryCatalogEntryImages(entry: CategoryCatalogEntry): CategoryCatalogImage[] {
  const images = new Map<string, CategoryCatalogImage>();

  if (entry.image_url) {
    images.set(entry.image_url, {
      image_url: entry.image_url,
      image_filename: entry.image_filename,
      note: entry.note,
      source: entry.source,
      created_at: entry.updated_at || entry.created_at,
    });
  }

  (entry.history_images || []).forEach((image) => {
    if (image.image_url) {
      images.set(image.image_url, image);
    }
  });

  return Array.from(images.values());
}

type ImageToImageInputImage = {
  id: string;
  url: string;
  filename: string;
  label: string;
  detail: string;
  note?: string;
  score?: number;
  matchedElements?: string[];
  selectedByDesignRequirement?: boolean;
  designReferenceIndex?: number;
  sourceField?: string;
  materialShapeLevel?: MaterialShapeLevel['key'];
  category?: string;
};

type CategoryGenerationTarget = {
  category: string;
  confidence: number;
  reason: string;
  categoryImage: ProposalAgentPrepareResponse['category_judgment']['category_image'];
  historyImage: ImageToImageInputImage | null;
};

type FinalGenerationRequestSnapshot = {
  category: string;
  prompt: string;
  inputImages: GeneratePatternImageInputImage[];
  historyLayoutLockPolicy?: string;
  historyLayoutLockReason?: string;
};

type FinalGenerationInputSnapshot = {
  projectCode: string;
  category: string;
  categoryTargets?: string[];
  prompt: string;
  inputImages: GeneratePatternImageInputImage[];
  requests?: FinalGenerationRequestSnapshot[];
  historyLayoutLockPolicy?: string;
  historyLayoutLockReason?: string;
  createdAt: string;
};

const GENERATION_MATERIAL_MIN_SCORE = 0.8;

function uniqueDisplayTerms(values: string[]) {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLocaleLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function promptTemplateBranchById(id: PromptTemplateId) {
  return PROMPT_TEMPLATE_BRANCHES.find((branch) => branch.id === id) || PROMPT_TEMPLATE_BRANCHES[0];
}

function buildPromptBranchInstruction(
  templateId: PromptTemplateId,
  hasMaterialImages: boolean,
  hasHistoryImage: boolean,
) {
  const branch = promptTemplateBranchById(templateId);
  const commonBoundary = [
    `当前最终提示词模板板块：${branch.label}。`,
    `验证目标：${branch.goal}`,
    `AI 执行方式：${branch.aiMethod}`,
    '这个模板板块不会直接提交给生图模型；它会先交给 AI，结合素材图和历史版式母版输出真正最终提示词。最终生图实际输入仍只能由历史设计图板块、参考图/素材图板块、AI 输出的最终提示词三块组成。',
  ];

  if (templateId === 'minimal_natural') {
    return [
      ...commonBoundary,
      hasHistoryImage
        ? '自然语言板结构策略 1：图1 是历史构图母版，结构化说明它怎么被参考：保留版位结构、比例、密度和留白；历史图里的旧主题、旧文字、旧图案和旧配色不进入新设计。'
        : '自然语言板结构策略 1：当前没有历史构图母版，只能按真实品类通用版式生成。',
      hasMaterialImages
        ? '自然语言板自然语言任务：用素材图替换掉历史设计图中的设计主题，生成一张新的设计图。'
        : '极简素材规则：当前没有素材图，使用主要图案元素文本替换历史主题。',
      '自然语言板结构策略 2：背景策略需要结构化说明，明确白底只代表留白或抠图底，不代表最终背景；背景只能进入历史版位内部。',
    ].join('\n');
  }

  return [
    ...commonBoundary,
    '结构板执行：所有维度都可以结构化表达，包括输入图角色、历史版式、素材复用、背景策略、文字元素、单个版位设计维度、质量规则和禁止偏离。',
    '结构板边界：这些结构不是直接生图提示词，而是让 AI 结合图1版式母版和图2+素材图，输出真正最终提示词。',
  ].join('\n');
}

function collectGenerationGraphicElements(result: ProposalAgentPrepareResponse) {
  const proposalGraphicElements = uniqueDisplayTerms([
    ...splitDisplayTerms(result.proposal.ai_graphic_elements || result.proposal.element_requirement),
    ...splitDisplayTerms(result.proposal.real_graphic_elements),
  ]);
  if (proposalGraphicElements.length > 0) {
    return proposalGraphicElements.slice(0, 12);
  }

  return uniqueDisplayTerms([
    ...(result.ai_element_mapping?.primary_element_terms || []).map((item) => item.term),
    ...(result.selected_gallery_images?.required_graphic_elements || []),
  ]).slice(0, 12);
}

function collectGenerationTextElements(result: ProposalAgentPrepareResponse) {
  return uniqueDisplayTerms(
    splitDisplayTerms(result.proposal.text_elements)
      .map(stripChineseFromVisibleTextElement)
      .filter(Boolean),
  ).slice(0, 8);
}

function parseChineseReferenceNumber(value: string) {
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  const digitMap: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };

  if (normalized.length === 1) {
    return digitMap[normalized] || 0;
  }
  if (normalized === '十一') {
    return 11;
  }
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

function referenceIndicesFromRequirementText(value: string) {
  const indices = new Set<number>();
  const numberGroupPattern = /[0-9]+|[一二两三四五六七八九十]+/g;
  const patterns = [
    /(?:公司)?(?:设计)?(?:参考)?\s*(?:图|图片)\s*[:：#-]?\s*([0-9一二两三四五六七八九十、,，和及\s]+)/g,
    /第\s*([0-9一二两三四五六七八九十]+)\s*(?:张)?\s*(?:公司)?(?:设计)?(?:参考)?\s*(?:图|图片)/g,
  ];

  patterns.forEach((pattern) => {
    let match = pattern.exec(value);
    while (match) {
      const numberMatches = (match[1] || '').match(numberGroupPattern) || [];
      numberMatches.forEach((numberText) => {
        const parsed = parseChineseReferenceNumber(numberText);
        if (parsed > 0) {
          indices.add(parsed);
        }
      });
      match = pattern.exec(value);
    }
  });

  return Array.from(indices).sort((left, right) => left - right);
}

function collectDesignRequirementReferenceIndices(proposal: CompanyProjectProposal) {
  return referenceIndicesFromRequirementText(String(proposal.design_requirement || ''));
}

function removeCarrierSizePhrases(value: string) {
  return value
    .replace(
      /(?:大|小)?(?:餐盘|盘|纸巾|餐巾|纸盘|纸杯|杯子|碗|叉|勺)?\s*(?:设计)?\s*(?:尺寸|规格|直径)\s*[:：]?\s*\d+(?:\.\d+)?\s*(?:[*xX×]\s*\d+(?:\.\d+)?)?\s*(?:cm|厘米|mm|毫米)?/gi,
      ' ',
    )
    .replace(
      /\d+(?:\.\d+)?\s*(?:[*xX×]\s*\d+(?:\.\d+)?)?\s*(?:cm|厘米|mm|毫米)/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function collectGenerationDesignRequirementDirectives(result: ProposalAgentPrepareResponse) {
  const designRequirement = String(result.proposal.design_requirement || '');
  if (!designRequirement.trim()) {
    return [];
  }

  const signalPattern =
    /(文案|文字|字体|字形|标题|主题|风格|形状|外形|轮廓|排版|布局|版式|一面|另一面|可爱|卡通|童趣|复古|简约|高端|酷|温馨|配色|颜色|色系|底色|紫色|蓝色|粉色|红色|绿色|黑色|白色|黄色|橙色|纯白|黑色底|图案风格|参考图|见图)/i;
  const carrierOnlyPattern =
    /^(?:大|小)?(?:餐盘|盘|纸巾|餐巾|纸盘|纸杯|杯子|碗|叉|勺|品类|载体|尺寸|规格|直径|设计|\s|[:：])*$/i;
  const fragments = designRequirement
    .replace(/\r?\n/g, '，')
    .split(/[，,；;。.!！?？]+/)
    .map((fragment) => removeCarrierSizePhrases(fragment))
    .map((fragment) => fragment.replace(/^(?:和|及|以及|其中|有关)\s*/, '').trim())
    .filter(Boolean)
    .filter((fragment) => signalPattern.test(fragment))
    .filter((fragment) => !carrierOnlyPattern.test(fragment));

  const referenceIndices = collectDesignRequirementReferenceIndices(result.proposal);
  const referenceSourceLabel = proposalReferenceSourceLabel(result.proposal);
  const referenceDirective =
    referenceIndices.length > 0
      ? `按开发思路指定的${referenceSourceLabel}${referenceIndices.join('、')}分别判断形状、图案、排版、文字、配色和可用素材，不要只取其中一张`
      : '';

  return uniqueDisplayTerms([...fragments, referenceDirective].filter(Boolean)).slice(0, 10);
}

function collectGenerationMaterialImages(result: ProposalAgentPrepareResponse): ImageToImageInputImage[] {
  return (result.selected_gallery_images?.selected_images || [])
    .filter((image) => image.url)
    .filter((image) => image.match_score >= GENERATION_MATERIAL_MIN_SCORE)
    .slice(0, 2)
    .map((image, index) => ({
      id: image.image_id || `gallery-${index}`,
      url: image.url,
      filename: image.filename || `素材图 ${index + 1}`,
      label: `素材图 ${index + 1}`,
      detail:
        image.matched_graphic_elements.length > 0
          ? `匹配元素：${image.matched_graphic_elements.join('、')}`
          : `图库连接词：${image.connected_terms.map((term) => term.term).join('、') || '-'}`,
      note: image.reason || image.concerns,
      score: image.match_score,
      matchedElements: image.matched_graphic_elements,
    }));
}

function categoryImageToHistoryImages(
  categoryImage: ProposalAgentPrepareResponse['category_judgment']['category_image'],
): ImageToImageInputImage[] {
  if (!categoryImage) {
    return [];
  }

  const historyImages =
    categoryImage.history_images && categoryImage.history_images.length > 0
      ? categoryImage.history_images
      : [
          {
            image_url: categoryImage.image_url,
            image_filename: categoryImage.image_filename,
            note: categoryImage.note,
            source: categoryImage.source,
            created_at: '',
          },
        ];

  return historyImages
    .filter((image) => image.image_url)
    .map((image, index) => ({
      id: image.image_url || `history-${index}`,
      url: image.image_url,
      filename: image.image_filename || `${categoryImage.category} 历史设计图 ${index + 1}`,
      label: `${categoryImage.category} 历史设计图`,
      detail: image.note || image.source || '真实品类历史设计图',
      note: image.created_at ? `上传时间：${image.created_at}` : undefined,
    }));
}

function collectGenerationCategoryTargets(result: ProposalAgentPrepareResponse): CategoryGenerationTarget[] {
  const judgment = result.category_judgment;
  const categoryImageByName = new Map(
    (judgment?.category_images || [])
      .filter((image) => image?.category)
      .map((image) => [image.category, image]),
  );
  const rawTargets =
    Array.isArray(judgment?.predicted_categories) && judgment.predicted_categories.length > 0
      ? judgment.predicted_categories
      : judgment?.predicted_category
        ? [{
            category: judgment.predicted_category,
            confidence: judgment.confidence,
            reason: judgment.reason,
            evidence_fields: judgment.evidence_fields,
            category_image: judgment.category_image,
          }]
        : [];
  const seen = new Set<string>();

  return rawTargets
    .map((target) => {
      const category = target.category || '';
      const key = category.toLocaleLowerCase();
      if (!category || seen.has(key)) {
        return null;
      }
      seen.add(key);
      const categoryImage =
        target.category_image ||
        categoryImageByName.get(category) ||
        (judgment?.category_image?.category === category ? judgment.category_image : null);
      const historyImages = categoryImageToHistoryImages(categoryImage);
      const seed = [
        result.project_code,
        category,
        ...historyImages.map((image) => image.url),
      ].join('|');
      const historyImage = historyImages.length > 0
        ? historyImages[hashString(seed) % historyImages.length]
        : null;

      return {
        category,
        confidence: target.confidence || 0,
        reason: target.reason || '',
        categoryImage,
        historyImage,
      };
    })
    .filter(Boolean) as CategoryGenerationTarget[];
}

function collectGenerationHistoryImages(result: ProposalAgentPrepareResponse): ImageToImageInputImage[] {
  const categoryTarget = collectGenerationCategoryTargets(result)[0];
  return categoryImageToHistoryImages(categoryTarget?.categoryImage || result.category_judgment?.category_image);
}

function chooseStableHistoryImage(result: ProposalAgentPrepareResponse): ImageToImageInputImage | null {
  return collectGenerationCategoryTargets(result)[0]?.historyImage || null;
}

function isCompanyDesignReferenceImage(image: CompanyProjectProposal['reference_images'][number]) {
  return image.source_field === DESIGN_REFERENCE_SOURCE_FIELD;
}

function isExternalEvidenceReferenceImage(image: CompanyProjectProposal['reference_images'][number]) {
  return image.source_field === EXTERNAL_EVIDENCE_SOURCE_FIELD;
}

function generationReferenceSourceLabel(images: ImageToImageInputImage[]) {
  return images.some((image) => image.sourceField === EXTERNAL_EVIDENCE_SOURCE_FIELD)
    ? '外部竞品证据图'
    : '公司设计参考图';
}

function proposalReferenceSourceLabel(proposal: CompanyProjectProposal) {
  const referenceImages = proposal.reference_images || [];
  if (referenceImages.some(isCompanyDesignReferenceImage)) {
    return '公司设计参考图';
  }
  if (referenceImages.some(isExternalEvidenceReferenceImage)) {
    return '外部竞品证据图';
  }
  return '公司设计参考图';
}

function buildGenerationReferenceColorSummary(proposal: CompanyProjectProposal) {
  const color = proposal.color_requirement || '以公司参考图中的主色、辅助色和整体色彩氛围为准';
  const style = proposal.style_requirement ? `风格：${proposal.style_requirement}` : '';
  const designImages = (proposal.reference_images || []).filter(isCompanyDesignReferenceImage);
  const externalEvidenceImages = (proposal.reference_images || []).filter(isExternalEvidenceReferenceImage);
  const colorReferenceImages = designImages.length > 0 ? designImages : externalEvidenceImages;
  const colorReferenceLabel = designImages.length > 0 ? '公司设计参考图' : '外部竞品证据图';
  const referenceImages = colorReferenceImages
    .filter((image) => image.filename || image.raw_path)
    .map((image, index) => `${index + 1}. ${image.label}：${image.filename || image.raw_path}`)
    .join('；');

  return [
    `配色：${color}`,
    style,
    referenceImages ? `${colorReferenceLabel}：${referenceImages}` : '',
  ].filter(Boolean);
}

function buildCompanyReferenceDesignTextSummary(
  analysis: ProposalAgentPrepareResponse['reference_design_analysis'],
  graphicElements: string[] = [],
) {
  if (!analysis || analysis.status !== 'success' || analysis.matched_reference_count === 0) {
    return '';
  }

  const graphicElementBoundary =
    graphicElements.length > 0 ? graphicElements.join('、') : '当前主要图案元素';
  const matchedReferenceText = analysis.matched_references
    .map((reference) => {
      const info = reference.design_information;
      const details = [
        info.composition ? `构图：${info.composition}` : '',
        info.color_palette ? `配色关系：${info.color_palette}` : '',
        info.style_texture ? `风格质感：${info.style_texture}` : '',
      ].filter(Boolean);
      return `参考图 ${reference.reference_index}（${reference.filename}，匹配 ${Math.round(
        reference.match_score * 100,
      )}%）：${details.join('；')}`;
    })
    .join('；');

  return [
    '公司参考图仅作为 AI 文本分析来源，不作为图生图输入图，也不要复制原图。',
    `使用边界：只借鉴配色、元素层级、线条质感、局部装饰和风格氛围；构图、留白比例和排版节奏只能作为文字灵感，不得覆盖历史设计图版式；新画面主体只允许由主要图案元素决定：${graphicElementBoundary}。`,
    matchedReferenceText,
  ].filter(Boolean).join('；');
}

function collectGenerationBackgroundDirectives(proposal: CompanyProjectProposal) {
  const designRequirement = String(proposal.design_requirement || '');
  if (!designRequirement.trim()) {
    return [];
  }

  return designRequirement
    .replace(/\r?\n/g, '，')
    .split(/[，,；;。.!！?？]+/)
    .map((fragment) => removeCarrierSizePhrases(fragment))
    .map((fragment) => fragment.replace(/^(?:和|及|以及|其中|有关)\s*/, '').trim())
    .filter(Boolean)
    .filter((fragment) => /(背景|底色|底纹|色系|渐变|紫色|蓝色|粉色|红色|绿色|黑色|白色|黄色|橙色|金色|银色|点缀|光感|星点|烟花|图案风格|参考图)/i.test(fragment))
    .slice(0, 6);
}

function buildCompanyReferenceBackgroundTextSummary(
  analysis: ProposalAgentPrepareResponse['reference_design_analysis'],
  proposal: CompanyProjectProposal,
) {
  const referenceSourceLabel = proposalReferenceSourceLabel(proposal);
  const backgroundDirectives = collectGenerationBackgroundDirectives(proposal);
  const matchedBackgroundText =
    analysis && analysis.status === 'success' && analysis.matched_reference_count > 0
      ? analysis.matched_references
          .map((reference) => {
            const info = reference.design_information;
            const details = [
              info.background_treatment ? `背景层：${info.background_treatment}` : '',
              info.color_palette ? `底色/配色：${info.color_palette}` : '',
              info.style_texture ? `背景相关风格质感：${info.style_texture}` : '',
              ...((info.usable_details || [])
                .filter((detail) => /(background|base|gradient|texture|accent|dot|spark|star|light|背景|底色|底纹|渐变|点缀|星点|光感|纹理)/i.test(detail))
                .map((detail) => `背景细节：${detail}`)),
            ].filter(Boolean);

            if (details.length === 0) {
              return '';
            }

            return `参考图 ${reference.reference_index}（${reference.filename}）：${details.join('；')}`;
          })
          .filter(Boolean)
          .join('；')
      : '';

  if (backgroundDirectives.length === 0 && !matchedBackgroundText) {
    return '';
  }

  return [
    `背景执行要求：以下背景信息以文字方式进入最终提示词，不把原始${referenceSourceLabel}作为图生图输入图。`,
    backgroundDirectives.length > 0
      ? `开发思路背景/色系要求：${uniqueDisplayTerms(backgroundDirectives).join('；')}。`
      : '',
    matchedBackgroundText ? `${referenceSourceLabel}背景分析：${matchedBackgroundText}。` : '',
    '执行边界：不得因为 AI 提取素材图或历史构图母版是白底就默认输出纯白底；白色只允许作为文字可读性留白、局部高光或历史版位外的结构留白。背景底色、渐变、底纹和小点缀只能应用在历史图已有版位内部。若开发思路或设计参考图明确了深色、紫色、渐变、点缀或氛围背景，最终图案必须体现这些背景信息。',
  ].filter(Boolean).join(' ');
}

function buildImageToImagePrompt(
  result: ProposalAgentPrepareResponse,
  materialImages: ImageToImageInputImage[],
  historyImage: ImageToImageInputImage | null,
  promptTemplateId: PromptTemplateId = 'structured_ai',
  categoryOverride = '',
) {
  const proposal = result.proposal;
  const referenceSourceLabel = proposalReferenceSourceLabel(proposal);
  const trueCategory =
    categoryOverride ||
    result.category_judgment?.predicted_category ||
    proposal.category_label ||
    proposal.category ||
    '当前真实品类';
  const graphicElements = collectGenerationGraphicElements(result);
  const referenceColorSummary = buildGenerationReferenceColorSummary(proposal);
  const hasQualifiedMaterialImages = materialImages.length > 0;
  const promptBranchInstruction = buildPromptBranchInstruction(
    promptTemplateId,
    hasQualifiedMaterialImages,
    Boolean(historyImage),
  );
  const companyReferenceDesignText = !hasQualifiedMaterialImages
    ? buildCompanyReferenceDesignTextSummary(result.reference_design_analysis, graphicElements)
    : '';
  const companyReferenceBackgroundText = buildCompanyReferenceBackgroundTextSummary(
    result.reference_design_analysis,
    proposal,
  );
  const graphicElementSummary =
    graphicElements.length > 0 ? graphicElements.join('、') : '以项目开发需求中的图案元素为准';
  const textElements = collectGenerationTextElements(result);
  const textElementSummary = textElements.join('、');
  const designRequirementDirectives = collectGenerationDesignRequirementDirectives(result);
  const designRequirementDirectiveSummary =
    designRequirementDirectives.length > 0
      ? `开发思路设计指令：${designRequirementDirectives.join('；')}。这些信息需要进入最终图案设计；开发思路中的载体品类、尺寸、规格、cm/mm 信息由历史版式和真实品类图锁定，不作为独立生成要求。`
      : '';
  const materialSummary = hasQualifiedMaterialImages
    ? materialImages
        .map((image, index) => `${index + 1}. ${image.filename}（${image.detail}）。这张图是最终可用素材本体来源；优先保持其中可识别素材的元素造型、文字字形、线条、纹理、局部装饰、边框语言和配色关系基本不变，只允许为适配历史版式做缩放、裁切、旋转、重排、层级组合和局部衔接；不要把素材板整体构图、产品组合、横向色带或画布比例搬到最终画布`)
        .join('；')
    : `当前没有匹配度达到 80% 的元素素材图，不使用图库图片作为生成参考；画面主体由主要图案元素文本主导：${graphicElementSummary}。`;
  const materialPreservationSummary = hasQualifiedMaterialImages
    ? '素材保真规则：AI 处理/提取素材是最终素材来源，不是只看风格的参考图。素材图中已经存在的图案元素、文字字形、线条、纹理、局部装饰、边框语言和配色关系应尽量保持不变；最终提示词中要求但素材图没有的新设计元素才可以创新补充。禁止整张画面全新重画而忽略素材图。'
    : '';
  const layoutSummary = historyImage
    ? `${historyImage.filename}（${historyImage.detail}）。它是最终产出的构图母版，必须优先保持它的大体构图格式、画布比例、设计单元数量、主体占位、版式在整张画布中的缩放比例、位置、边缘区域、白边/留白比例、图案密度和重复节奏；不要为了填满输出画布而放大、拉伸、裁切或移动历史版式。`
    : '当前没有可用历史设计图，采用该真实品类常见的居中主体、清晰层级和生产友好的留白。';
  const imageRoleSummary = historyImage
    ? '历史设计图负责最终图片的大体构图格式、密度、占位和留白；素材图负责提供可用素材本体，素材里已有的图案元素应尽量保持外观不变后放入历史版位。'
    : '没有历史设计图时，素材图负责提供主要图案元素本体，最终构图采用真实品类通用版式。';
  const inputOrderSummary = historyImage
    ? [
        `图1 = ${historyImage.filename}，角色：历史设计图/构图母版，只参考版式结构、设计单元、画布比例、主体占位、留白、边缘区域、密度和重复节奏。`,
        ...materialImages.map((image, index) => (
          `图${index + 2} = ${image.filename}，角色：素材图/素材本体来源，保持其中可用素材的外观、字体/线条风格、纹理、局部装饰和配色关系基本不变；只为适配历史版位做缩放、裁切、旋转和重排，不参考素材图的构图和画布比例。`
        )),
      ].join('；')
    : materialImages.length > 0
      ? materialImages
          .map((image, index) => (
            `图${index + 1} = ${image.filename}，角色：素材图/素材本体来源，保持其中可用素材的外观、字体/线条风格、纹理、局部装饰和配色关系基本不变。`
          ))
          .join('；')
      : '当前没有输入图顺序可分配。';
  const historyLayoutPolicySummary = historyImage
    ? '历史图格式判定：历史设计图是版式/刀模母版，不是风格参考图或单个产品效果图；如果历史图呈横向多设计单元、多个版面或多个裁切区域，最终输出必须保持同类横向多单元版式，不得改成单个圆形餐盘、单个中心徽章或单个产品展示图。'
    : '';
  const historyContentBanSummary = historyImage
    ? `历史内容禁用：历史设计图里的旧文字、旧图案、旧主题、旧角色、旧场景、旧边框花纹、旧底纹和旧配色全部禁止进入最终设计；它们只能帮助识别版位结构。最终画面中的新文字必须来自文字元素板块，图案主体和装饰必须来自主要图案元素与素材图视觉语言，配色参考${referenceSourceLabel}，不得复用历史图内容。`
    : '';
  const historyLayoutLockDecisionSummary = historyImage
    ? '版式母版锁定策略判断：AI 必须先根据真实品类和图1历史设计图判断版式锁定强度。若图1是杯套、刀模、包装、纸巾、餐盘、固定裁切版位等生产结构，选择 geometry_lock，并在真正最终提示词中强制保持刀模外轮廓、红色刀线位置、中心收腰缺口、上下印刷版位关系、单元间距、上下/左右留白和版位外白底比例；若只需要保留设计单元数量、相对位置、画布比例和留白，选择 layout_lock；若是异形贴纸、异形轮廓或历史图只是方向参考，选择 flexible_reference，不要强行锁死每条外轮廓。无论选择哪种策略，都禁止把整张历史图拉伸、压扁、放大到铺满画布或改变原始画布比例。'
    : '';
  const historySlotLockSummary = historyImage
    ? '历史版位锁定：先识别历史设计图里的每一个闭合设计单元、刀模区域、圆形/方形/矩形版位和尺寸标注关系；最终图只能在这些已有版位内部重绘新图案。版位外的白底、单元间隙、尺寸线、尺寸文字、裁切标注区和外围背景必须保持为空白或原有结构，不得新增任何图案、雪花、散点、边框、横向装饰带或独立素材。'
    : '';
  const historySlotCountSummary = historyImage
    ? '历史单元数量锁定：最终输出必须保持历史设计图中设计单元的数量、相对大小、相对位置和外轮廓形状；如果历史图是两个圆形加一个方形/矩形版位，就仍然输出两个圆形加一个方形/矩形版位，不得增加中间大标题区、全宽横幅、上下花边或额外贴纸区。'
    : '';
  const prioritySummary = historyImage
    ? '优先级规则：构图格式、画布比例、主体位置、图案密度、留白和边缘节奏冲突时，以历史设计图为准；素材图已有元素的造型、字形、线条质感、局部装饰和配色关系冲突时，以合格素材图为准并尽量不改造；必须包含的主要图案元素始终以文本为准，只有素材图没有的必需元素才创新。'
    : '优先级规则：素材图已有元素的造型、字形、线条质感和局部装饰应尽量保持；必须包含的主要图案元素始终以文本为准，只有素材图没有的必需元素才创新。';
  const compositionLockSummary = historyImage
    ? `构图锁定：在历史设计图每个版位内部围绕“${graphicElementSummary}”组织素材图中的现成素材；不要让素材图的完整画面格式、素材板排列方式、横向色带或产品组合替代历史设计图，也不要把素材图已有素材重画成完全不同的新元素。`
    : '';
  const materialPlacementSummary = hasQualifiedMaterialImages && historyImage
    ? '设计融合规则：素材图是可用素材库，不是单纯风格参考。需要把素材图中已经提取出的主体、辅助图形、文字字形、边框、点缀和配色按历史版位重新组织；允许调整比例、方向、裁切和层级，但不要改变核心造型。不得把素材图整排小元素、底部色带、完整素材板或散装贴纸直接铺到历史图上。'
    : '';
  const backgroundStrategySummary = [
    '背景策略：历史构图母版中的白底或空白区域只代表版位和留白结构，不代表最终背景必须为白色；AI 处理/提取素材图中的白底只代表抠图底或素材展示底，不作为最终背景参考。',
    '背景信息优先来自开发思路中明确的底色、背景色、背景风格、图案风格和指定设计参考图；开发思路中的载体尺寸、规格和品类尺寸仍由历史版式锁定，不作为背景要求。',
    `若开发思路没有明确背景要求，则从${referenceSourceLabel}中提取底色、背景纹理、背景小元素、边缘底纹、渐变关系、背景密度和整体氛围；运营参考图不参与背景判断。`,
    historyImage
      ? '历史设计图只负责锁定哪些版位需要背景、背景区域占多大、哪里必须留白；最终背景只能应用在历史图已有版位内部，版位外白底、单元间隙、尺寸线、尺寸文字、裁切标注区和外围背景必须保持为空白或原有结构。'
      : `没有历史设计图时，背景仍应服从开发思路和${referenceSourceLabel}，不要因为素材图是白底就默认生成白色背景。`,
  ].join(' ');
  const slotDesignQualitySummary = historyImage
    ? '版位内设计要求：每个历史版位都要有清晰主次关系、完整边框或装饰节奏、自然的文字与图形融合、足够呼吸感和生产友好的细节密度；不同版位应形成同一主题系列，但根据版位大小和形状做差异化排版，不要所有版位都套同一个公式。'
    : '';
  const detailStabilitySummary =
    '细节稳定规则：Clean and polished image, controllable details, smooth and consistent textures, clear subject-background separation, no over-sharpening, no color blotches, no noise, no broken patterns, no artifacts, and no distortion.';
  const singlePatternDesignDefinitionSummary = historyImage
    ? '单个图案设计定义：单个图案设计不是整张输出画布；它指历史构图母版中的一个独立闭合版位/刀模区域/裁切区域，例如一个圆形盘面、一个方形纸巾版位、一个矩形标签。若一张历史构图母版包含多个版位，必须分别把每个版位当作一个单个图案设计来细化。'
    : '单个图案设计定义：当前没有历史版式时，单个图案设计指最终输出中的一个完整、可落地的品类图案单元。';
  const singlePatternDesignDimensionSummary = [
    '单个图案设计维度：以下模板只作为每个版位生成前的内部设计检查清单，不要输出 Markdown，不要把这些标题或说明文字画到图里。',
    '**1. Core Subject & Theme (核心主体与主题):** 每个版位都要有一句清晰主题，主题必须来自主要图案元素、文字元素和开发思路设计指令。',
    '**2. Art Style & Medium (艺术风格与媒介):** 明确每个版位的绘画风格、媒介感、线条粗细、边缘处理和整体审美；优先沿用素材图已有元素的风格语言。',
    `**3. Color Palette & Lighting (配色与光影):** 明确主色、辅助色、底色、点缀色、明暗关系和氛围；遵循${referenceSourceLabel}配色与开发思路中的颜色要求。`,
    '**4. Composition & Perspective (构图与视角):** 每个版位内部都要有主次布局、视角、平衡关系、留白、边框节奏和密度控制；外轮廓、位置和比例必须服从历史构图母版。',
    '**5. Detailed Visual Elements (分层细节描述):** 分层安排 Main Focus、Background & Atmosphere、Foreground & Framing、Specific Details/Props；已有素材优先复用，缺失且被提示词要求的元素才创新补充。',
    '**6. Text & Typography (If any):** 如果文字元素存在，明确文字内容、字体风格、字重、层级、弧形/居中/环绕等排版方式；如果没有文字元素，不要额外添加核心文字。',
  ].join('\n');
  const antiTemplateSummary = hasQualifiedMaterialImages
    ? '避免公式化：不要做成“历史图版位 + 素材图机械贴片”的模板效果；需要像设计师把素材图中已有素材排进历史版式里，形成一套完整新品图案。不要抛弃素材图重新画一套全新元素。'
    : '';
  const outputCanvasSummary = historyImage
    ? '输出画布约束：最终生成接口会按历史图所属的方/横/竖比例输出；必须在画面内部保留历史设计图的原始版式缩放比例、位置、上下/左右白边、横向/纵向版式关系和设计单元分布，不要把历史设计图改造成方形单主体构图，也不要为了填满画布而放大、拉伸、裁切或移动历史版式。'
    : '';
  const companyReferenceCompositionLimitSummary = historyImage && companyReferenceDesignText
    ? '公司参考图构图限制：公司参考图文字分析只用于配色、线条、风格质感和局部图案语言；其中任何圆盘中心构图、产品陈列、单品效果图、开放中心文字区等描述都不得覆盖历史设计图的版式母版。'
    : '';
  if (promptTemplateId === 'minimal_natural') {
    return [
      `请基于输入图生成适合【${trueCategory}】的新图案设计。`,
      '',
      '当前最终提示词模板板块：自然语言板。',
      '验证目标：AI 需要结合素材图和版式母版，输出“历史设计图怎么参考、背景策略怎么实施”为结构化内容，其余为自然语言的真正最终提示词。',
      `输入图顺序：${inputOrderSummary}`,
      '',
      `历史设计图使用策略：${historyImage
        ? '图1 是历史设计图/构图母版。AI 需要先判断它属于 geometry_lock、layout_lock 还是 flexible_reference：固定生产刀模和固定裁切版位才锁死几何坐标；异形设计或历史图只是方向参考时不能强行锁死外轮廓。任何情况下都保留历史图的原始画布比例、版式在画布中的缩放关系和主要留白，禁止把整张历史图拉伸、压扁、放大到铺满画布；历史图里的旧文字、旧图案、旧主题、旧角色、旧场景、旧边框花纹、旧底纹和旧配色全部禁止进入最终设计。'
        : '当前没有可用历史设计图，使用真实品类常见版式，并保持清晰层级、生产友好的留白和可落地的图案密度。'}`,
      '',
      backgroundStrategySummary,
      companyReferenceBackgroundText,
      '',
      hasQualifiedMaterialImages
        ? `自然语言生成任务：用素材图替换掉历史设计图中的设计主题，生成一张新的设计图。保持历史设计图的构图结构和版位关系，把素材图中的主题视觉、文字/图案外观、局部装饰和配色关系放入历史版位内部；只做适配版位所需的缩放、裁切、旋转、重排和局部衔接。`
        : `自然语言生成任务：用“${graphicElementSummary}”替换掉历史设计图中的设计主题，生成一张新的设计图。保持历史设计图的构图结构和版位关系；如果需要文字，只使用文字元素“${textElementSummary || '无'}”，不要额外添加未要求的核心文字。`,
      textElements.length > 0
        ? `文字要求：必须包含 ${textElementSummary}，保持准确拼写、清晰可读，并放入适合历史版位的位置。`
        : '文字要求：当前文字元素为空，不要额外添加核心文字、标语或口号。',
      '最终画面需要像真实商品图案设计，主题明确、元素协调、图案清晰，适合真实品类落地生产。',
    ].filter(Boolean).join('\n');
  }
  const sceneLeadSummary = hasQualifiedMaterialImages && historyImage
    ? '以历史设计图的版式骨架为画面主导，以素材图中已经提取出的实际素材为画面元素主体；素材图没有但文本明确要求的元素才创新补充。'
    : hasQualifiedMaterialImages
      ? '以合格素材图中的实际素材为画面元素主体，并服从主要图案元素文本。'
      : historyImage
        ? '以历史设计图的版式母版和主要图案元素文本共同主导；不参考低于 80% 匹配度的图库图片，不把公司参考图构图当作最终构图。'
        : '以主要图案元素文本为画面主导，不参考低于 80% 匹配度的图库图片。';
  const generationRequirementSummary = hasQualifiedMaterialImages
    ? '生成要求：先按历史设计图建立版位模板，再把合格素材图中已有的主体、文字字形、边框、点缀、纹理和配色关系排入各个历史版位；素材本体应尽量保持原样，只做版位适配、缩放、裁切、旋转、组合和局部衔接。只有最终提示词明确要求、但素材图里没有的新设计元素，才可以进行创新补充。保持历史设计图的大体格式、单元数量、密度、占位、间隙和留白，不要直接复制旧图，也不要整张全新重画而忽略素材图。'
    : historyImage
      ? '生成要求：根据主要图案元素文本重新组织画面主体，并填入历史设计图的版式母版；公司参考图文字分析只辅助配色、线条和局部风格，不参与最终构图；不要把公司参考图原图、低匹配图库图片或单个圆盘效果图作为素材或造型依据。'
      : '生成要求：根据主要图案元素文本重新组织画面主体；可以吸收公司参考图文字分析中的构图、配色和风格信息，但不要把公司参考图原图或低匹配图库图片作为素材或造型依据。';
  const branchGenerationRequirementSummary =
    '模板板块要求：这是结构板。AI 编写真正最终提示词时，需要结合输入图，把所有结构化维度重组为清晰、可执行、去冗余的最终生图提示词。';

  return [
    `请基于输入图生成适合【${trueCategory}】的新图案设计。`,
    '',
    promptBranchInstruction,
    '',
    `必须包含的主要图案元素：${graphicElementSummary}`,
    textElements.length > 0
      ? `必须包含的文字元素：${textElementSummary}。这些文字必须作为最终图案中的可见文字出现，保持准确拼写、可读性和与版位适配的排版。`
      : '文字元素要求：当前文字元素板块为空；不要额外添加未要求的核心文字、标语或口号。',
    designRequirementDirectiveSummary,
    `输入图分工：${imageRoleSummary}`,
    `输入图顺序：${inputOrderSummary}`,
    `画面主导：${sceneLeadSummary}`,
    `素材图使用：${materialSummary}`,
    materialPreservationSummary,
    `历史构图参考：${layoutSummary}`,
    historyLayoutPolicySummary,
    historyContentBanSummary,
    historyLayoutLockDecisionSummary,
    historySlotLockSummary,
    historySlotCountSummary,
    prioritySummary,
    compositionLockSummary,
    materialPlacementSummary,
    backgroundStrategySummary,
    companyReferenceBackgroundText,
    slotDesignQualitySummary,
    detailStabilitySummary,
    singlePatternDesignDefinitionSummary,
    singlePatternDesignDimensionSummary,
    antiTemplateSummary,
    outputCanvasSummary,
    `参考图配色：${referenceColorSummary.join('；') || '以公司参考图的配色关系为准'}`,
    companyReferenceCompositionLimitSummary,
    companyReferenceDesignText
      ? `公司参考图文字分析：${companyReferenceDesignText}`
      : !hasQualifiedMaterialImages
        ? '公司参考图文字分析：当前没有可用的匹配分析结果；不要把公司参考图原图作为图生图输入。'
        : '',
    '',
    generationRequirementSummary,
    branchGenerationRequirementSummary,
    '画面需要主体明确、元素协调、图案清晰，适合真实品类落地生产。',
    '画面需要有真实商品图案设计感：主题文字、装饰元素、边框、色彩和留白应像一套完成的系列设计，而不是素材堆叠。',
    textElements.length > 0
      ? '文字要求：不得遗漏、误拼、替换或改写必须包含的文字元素；可以根据历史版位大小调整字体层级和排版，但不能改变文字含义。'
      : '',
    '避免加入未提到的核心图案元素，避免改变真实品类，避免过度复杂、过于平均、过于模板化或偏离公司参考图配色。',
    historyImage
      ? '禁止偏离：不要输出单个圆形餐盘、单个中心徽章、单个产品效果图或素材图产品组合展示，除非历史设计图本身就是这种格式；不要在历史图版位外新增大标题、横向花边、散点装饰、贴纸阵列或素材板色带；不要让公司参考图或素材图的构图替代历史设计图；不要复用历史设计图中的任何旧内容。'
      : '',
  ].join('\n');
}

function CategoryCatalogManagerPanel() {
  const [catalog, setCatalog] = useState<CategoryCatalogResponse | null>(null);
  const [category, setCategory] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [note, setNote] = useState('');
  const [catalogExpanded, setCatalogExpanded] = useState(false);
  const [dragOverCategory, setDragOverCategory] = useState('');
  const [uploadingCategory, setUploadingCategory] = useState('');
  const [deletingImageUrl, setDeletingImageUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState('');

  useEffect(() => {
    let active = true;

    getCategoryCatalog()
      .then((response) => {
        if (active) {
          setCatalog(response);
          setError(null);
        }
      })
      .catch((caught) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : '品类表读取失败。');
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  async function handleAddCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSavedMessage('');

    try {
      const nextCatalog = await addCategoryCatalogEntry({
        category: category.trim(),
        image_url: imageUrl.trim() || undefined,
        note,
      });
      setCatalog(nextCatalog);
      setCategory('');
      setImageUrl('');
      setNote('');
      setSavedMessage(imageUrl.trim() ? '已写入品类表。' : '已写入品类表，可后续拖拽补图。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '品类表保存失败。');
    } finally {
      setSaving(false);
    }
  }

  async function handleCategoryImageFiles(targetCategory: string, fileList: FileList | File[] | null) {
    const files = Array.from(fileList || []);
    if (files.length === 0) {
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      setError('只能上传图片文件。');
      return;
    }

    setUploadingCategory(targetCategory);
    setError(null);
    setSavedMessage('');

    try {
      let nextCatalog = catalog;
      let compressedCount = 0;
      let paddedCount = 0;
      for (const file of imageFiles) {
        const preparedImage = await prepareCategoryImageUpload(file);
        if (preparedImage.compressed) {
          compressedCount += 1;
        }
        if (preparedImage.padded) {
          paddedCount += 1;
        }
        nextCatalog = await uploadCategoryCatalogImage({
          category: targetCategory,
          image_data: preparedImage.imageData,
          filename: preparedImage.filename,
          mime_type: preparedImage.mimeType,
          note: preparedImage.padded
            ? `历史设计图 · ${preparedImage.layoutLabel} · 等比补边`
            : '历史设计图',
        });
      }
      if (nextCatalog) {
        setCatalog(nextCatalog);
      }
      setSavedMessage(
        `已给「${targetCategory}」放入 ${imageFiles.length} 张历史设计图${
          compressedCount > 0 ? `，其中 ${compressedCount} 张已自动压缩` : ''
        }${paddedCount > 0 ? `，${paddedCount} 张已按 2K 方/横/竖比例等比补边` : ''}。`,
      );
      if (imageFiles.length < files.length) {
        setError(`已跳过 ${files.length - imageFiles.length} 个非图片文件。`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '历史设计图上传失败。');
    } finally {
      setUploadingCategory('');
      setDragOverCategory('');
    }
  }

  function handleCategoryImageDrop(event: DragEvent<HTMLLabelElement>, targetCategory: string) {
    event.preventDefault();
    void handleCategoryImageFiles(targetCategory, event.dataTransfer.files || null);
  }

  async function handleDeleteCategoryImage(targetCategory: string, image: CategoryCatalogImage) {
    const confirmed = window.confirm(`删除「${targetCategory}」下的这张历史设计图？`);
    if (!confirmed) {
      return;
    }

    setDeletingImageUrl(image.image_url);
    setError(null);
    setSavedMessage('');

    try {
      const nextCatalog = await deleteCategoryCatalogImage({
        category: targetCategory,
        image_url: image.image_url,
      });
      setCatalog(nextCatalog);
      setSavedMessage(`已删除「${targetCategory}」下的 1 张历史设计图。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '历史设计图删除失败。');
    } finally {
      setDeletingImageUrl('');
    }
  }

  const entries = catalog?.entries || [];
  const completedCount = entries.filter((entry) => categoryCatalogEntryImages(entry).length > 0).length;
  const pendingCount = Math.max(0, entries.length - completedCount);
  const imageEntries = (catalog?.entries || [])
    .filter((entry) => categoryCatalogEntryImages(entry).length > 0)
    .slice()
    .reverse()
    .slice(0, 8);
  const visibleTableEntries = catalogExpanded ? entries : imageEntries;

  return (
    <section className="category-catalog-manager" aria-label="品类表维护">
      <div className="data-layer-map-heading">
        <div>
          <p className="eyebrow">Data Layer / Category Catalog</p>
          <h3>品类表维护</h3>
        </div>
        <DataLayerBadge
          label={
            loading
              ? '读取中'
              : `${catalog?.candidate_count || 0} 品类 / ${catalog?.image_count || 0} 图`
          }
        />
      </div>

      <div className="category-catalog-status-grid">
        <div>
          <span>已配图</span>
          <strong>{completedCount}</strong>
        </div>
        <div>
          <span>待补图</span>
          <strong>{pendingCount}</strong>
        </div>
        <div>
          <span>历史设计图</span>
          <strong>{catalog?.history_image_count || 0}</strong>
        </div>
      </div>

      <form className="category-catalog-form" onSubmit={handleAddCategory}>
        <label className="field">
          <span>品类名称</span>
          <input
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="新品类名称"
            required
          />
        </label>
        <label className="field">
          <span>品类图 URL（可后补）</span>
          <input
            type="url"
            value={imageUrl}
            onChange={(event) => setImageUrl(event.target.value)}
            placeholder="可选，后续也可拖拽上传"
          />
        </label>
        <label className="field">
          <span>备注</span>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="可选"
          />
        </label>
        <button type="submit" disabled={saving}>
          {saving ? '写入中...' : '添加到品类表'}
        </button>
      </form>

      {error ? (
        <div className="notice error-notice" role="alert">
          {error}
        </div>
      ) : null}
      {savedMessage ? <div className="notice success-notice">{savedMessage}</div> : null}

      <div className="category-catalog-toolbar">
        <button
          type="button"
          className="secondary-button"
          onClick={() => setCatalogExpanded((expanded) => !expanded)}
        >
          {catalogExpanded ? '收起品类表' : '展开品类表'}
        </button>
        <span>
          {catalogExpanded
            ? '全量品类都可以拖拽多张历史设计图'
            : imageEntries.length > 0
              ? '当前仅显示已配图品类'
              : '展开后可查看全部待补图品类'}
        </span>
      </div>

      {visibleTableEntries.length > 0 ? (
        <div className="category-catalog-table" aria-label="品类配图状态表">
          {visibleTableEntries.map((entry) => {
            const entryImages = categoryCatalogEntryImages(entry);
            const shownImages = entryImages.slice(0, 4);
            const hiddenImageCount = Math.max(0, entryImages.length - shownImages.length);
            const imageCount = entryImages.length;
            const isUploading = uploadingCategory === entry.category;
            return (
              <div
                className={imageCount > 0 ? 'category-catalog-row done' : 'category-catalog-row pending'}
                key={entry.category}
              >
                <div className="category-catalog-row-main">
                  {imageCount > 0 ? (
                    <div className="category-image-stack" aria-label={`${entry.category} 历史设计图`}>
                      {shownImages.map((image) => (
                        <div className="category-image-thumb" key={image.image_url}>
                          <img
                            src={image.image_url}
                            alt={`${entry.category} 历史设计图`}
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                          <button
                            type="button"
                            className="category-image-delete-button"
                            onClick={() => {
                              void handleDeleteCategoryImage(entry.category, image);
                            }}
                            disabled={Boolean(deletingImageUrl)}
                            aria-label={`删除 ${entry.category} 历史设计图`}
                          >
                            {deletingImageUrl === image.image_url ? '...' : '删'}
                          </button>
                        </div>
                      ))}
                      {hiddenImageCount > 0 ? <span>+{hiddenImageCount}</span> : null}
                    </div>
                  ) : (
                    <div className="category-catalog-image-placeholder">待补图</div>
                  )}
                  <div>
                    <strong>{entry.category}</strong>
                    <small>{entry.image_filename || entry.source}</small>
                    {entry.note ? <small>{entry.note}</small> : null}
                    <small>{imageCount > 0 ? `${imageCount} 张历史设计图` : '暂无历史设计图'}</small>
                  </div>
                </div>
                <span className={imageCount > 0 ? 'catalog-status done' : 'catalog-status pending'}>
                  {imageCount > 0 ? '已配图' : '待补图'}
                </span>
                <label
                  className={
                    dragOverCategory === entry.category
                      ? 'category-dropzone active'
                      : 'category-dropzone'
                  }
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOverCategory(entry.category);
                  }}
                  onDragLeave={() => setDragOverCategory('')}
                  onDrop={(event) => handleCategoryImageDrop(event, entry.category)}
                >
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(event) => {
                      void handleCategoryImageFiles(entry.category, event.currentTarget.files || null);
                      event.currentTarget.value = '';
                    }}
                    disabled={Boolean(uploadingCategory)}
                  />
                  <span>{isUploading ? '上传中...' : '拖拽多张历史设计图'}</span>
                  <small>或点击选择多张图片</small>
                </label>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="empty-note">当前品类表还没有品类图；展开品类表后可以从待补图品类开始拖拽上传。</p>
      )}
    </section>
  );
}

function DataLayerMapPanel({ result }: { result: ProposalAgentPrepareResponse }) {
  const sections = buildDataLayerSections(result);

  return (
    <section className="data-layer-map" aria-label="数据层地图">
      <div className="data-layer-map-heading">
        <div>
          <p className="eyebrow">Data Layer Map</p>
          <h3>项目数据分层与使用场景</h3>
        </div>
        <DataLayerBadge label={`${sections.length} 类数据`} />
      </div>
      <div className="data-layer-grid">
        {sections.map((section) => (
          <article className="data-layer-card" key={section.id}>
            <div className="data-layer-card-heading">
              <div>
                <DataLayerBadge />
                <h4>{section.title}</h4>
              </div>
              <span>{section.current}</span>
            </div>
            <dl className="data-layer-card-meta">
              <div>
                <dt>来源</dt>
                <dd>{section.source}</dd>
              </div>
              <div>
                <dt>数据项</dt>
                <dd>{section.data.join('；')}</dd>
              </div>
              <div>
                <dt>当前使用场景</dt>
                <dd>{section.scenario}</dd>
              </div>
              <div>
                <dt>后续使用层</dt>
                <dd>{section.useLayer}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function ReferenceImageGallery({
  images,
}: {
  images: CompanyProjectProposal['reference_images'];
}) {
  if (!images || images.length === 0) {
    return null;
  }

  return (
    <section className="reference-gallery" aria-label="公司参考图">
      <div className="reference-gallery-heading">
        <DataLayerBadge label="参考图数据" />
        <h3>公司参考图</h3>
        <span>{images.length} 张</span>
      </div>
      <div className="reference-image-grid">
        {images.map((image, index) => (
          <figure className="reference-image-card" key={`${image.source_field}-${image.raw_path}`}>
            {image.url ? (
              <img
                src={image.url}
                alt={`${image.label} ${index + 1}`}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="reference-image-missing">未配置图片地址</div>
            )}
            <figcaption>
              <span>{image.label}</span>
              <code>{image.filename || image.raw_path}</code>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

function GraphicElementPanel({
  proposal,
}: {
  proposal: CompanyProjectProposal;
}) {
  const aiTerms = splitDisplayTerms(proposal.ai_graphic_elements || proposal.element_requirement);
  const realTerms = splitDisplayTerms(proposal.real_graphic_elements);
  const renderTerms = (terms: string[], source: string, mode: 'ai' | 'real', emptyText: string) =>
    terms.length > 0 ? (
      <div className="term-chip-list">
        {terms.map((term) => (
          <div className="term-chip ai-term-chip" key={`${source}-${term}`}>
            <strong>{term}</strong>
            <small>{graphicElementSourceLabel(source, mode)}</small>
          </div>
        ))}
      </div>
    ) : (
      <p className="empty-note">{emptyText}</p>
    );

  return (
    <section className="graphic-element-panel" aria-label="图案元素">
      <DataLayerBadge label="图案元素数据" />
      <div className="element-terms-heading">
        <h3>图案元素</h3>
        <span>AI {aiTerms.length} 个 · 真实 {realTerms.length} 个</span>
      </div>
      <p className="gallery-note">
        默认使用 AI 提取的图案关键词路径；公司真实图形元素原始字段保留为对照，不与一级元素词混用。
      </p>
      <div className="ai-term-group">
        <h4>AI 提取</h4>
        {renderTerms(
          aiTerms,
          proposal.ai_graphic_elements_source || proposal.element_requirement_source || 'ai_graphic_elements',
          'ai',
          '暂无 AI 提取图案元素。',
        )}
      </div>
      <div className="ai-term-group">
        <h4>真实数据</h4>
        {renderTerms(
          realTerms,
          proposal.real_graphic_elements_source || 'real_company_graphic_elements',
          'real',
          '真实公司图形元素字段为空。',
        )}
      </div>
    </section>
  );
}

function TextElementPanel({
  proposal,
}: {
  proposal: CompanyProjectProposal;
}) {
  const rawTextTerms = splitDisplayTerms(proposal.text_elements);
  const textTerms = uniqueDisplayTerms(
    rawTextTerms.map(stripChineseFromVisibleTextElement).filter(Boolean),
  );
  const filteredChineseTextCount = Math.max(0, rawTextTerms.length - textTerms.length);
  const sourceLabel = textElementSourceLabel(proposal.text_elements_source);
  const status = proposal.text_elements_status || (textTerms.length > 0 ? 'real_data' : 'empty');

  return (
    <section className="graphic-element-panel" aria-label="文字元素">
      <DataLayerBadge label="文字元素数据" />
      <div className="element-terms-heading">
        <h3>文字元素</h3>
        <span>{textTerms.length} 个 / {status}</span>
      </div>
      <p className="gallery-note">
        真实文字元素为空时，AI 会重点分析开发思路；如果开发思路没有明确文字要求，则保持为空。
      </p>
      {filteredChineseTextCount > 0 ? (
        <p className="gallery-note">
          中文内容会作为内部需求说明处理，不会作为必须出现在图案中的可见文字进入最终提示词。
        </p>
      ) : null}
      {textTerms.length > 0 ? (
        <div className="term-chip-list">
          {textTerms.map((term) => (
            <div className="term-chip ai-term-chip" key={`${proposal.text_elements_source}-${term}`}>
              <strong>{term}</strong>
              <small>{sourceLabel}</small>
            </div>
          ))}
        </div>
      ) : (
        <p className="empty-note">
          当前文字元素为空；最终提示词不会要求额外添加文字。
        </p>
      )}
      {proposal.text_elements_error ? (
        <div className="ai-error-summary material-refinement-status">
          <strong>{proposal.text_elements_error.type || 'text_elements_error'}</strong>
          <p>{proposal.text_elements_error.message || '文字元素 AI 补全失败。'}</p>
        </div>
      ) : null}
    </section>
  );
}

function CategoryJudgmentPanel({
  judgment,
}: {
  judgment: ProposalAgentPrepareResponse['category_judgment'];
}) {
  if (!judgment) {
    return null;
  }

  const confidence = Math.round((judgment.confidence || 0) * 100);
  const hasError = judgment.status !== 'success' && judgment.ai_error;
  const sourceLabel = judgment.match_source === 'ai' ? 'AI 判断' : '规则兜底';

  return (
    <section className="category-judgment-panel" aria-label="真实品类判断">
      <DataLayerBadge label="品类判断数据" />
      <div className="element-terms-heading">
        <h3>真实品类判断</h3>
        <span>
          {judgment.status} / {judgment.model}
        </span>
      </div>
      <div className="category-result-card">
        <div>
          <small>{sourceLabel}</small>
          <strong>{judgment.predicted_category || '暂无判断'}</strong>
        </div>
        <span>{confidence}%</span>
      </div>
      {judgment.category_image?.image_url ? (
        <figure className="category-judgment-image-card">
          <img
            src={judgment.category_image.image_url}
            alt={`${judgment.category_image.category} 品类图`}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
          <figcaption>
            <strong>{judgment.category_image.category}</strong>
            <small>{judgment.category_image.image_filename || judgment.category_image.source}</small>
            {judgment.category_image.note ? <small>{judgment.category_image.note}</small> : null}
          </figcaption>
        </figure>
      ) : null}
      <dl className="category-meta-grid">
        <div>
          <dt>候选品类</dt>
          <dd>{judgment.candidate_count}</dd>
        </div>
        <div>
          <dt>候选来源</dt>
          <dd>{judgment.catalog_source || '测试品类表'}</dd>
        </div>
        <div>
          <dt>依据字段</dt>
          <dd>{judgment.evidence_fields.length > 0 ? judgment.evidence_fields.join(', ') : '-'}</dd>
        </div>
        <div>
          <dt>判断说明</dt>
          <dd>{judgment.reason || '-'}</dd>
        </div>
      </dl>
      {hasError ? (
        <div className="ai-error-summary">
          <strong>{judgment.ai_error?.type || 'ai_error'}</strong>
          <span>{judgment.ai_error?.stage || 'unknown_stage'}</span>
          <p>{judgment.ai_error?.message || 'AI 品类判断失败。'}</p>
        </div>
      ) : null}
      {judgment.predicted_categories?.length > 1 ? (
        <div className="category-alternatives">
          <h4>组合品类拆分</h4>
          <div className="term-chip-list">
            {judgment.predicted_categories.map((item) => (
              <div className="term-chip" key={item.category}>
                <strong>{item.category}</strong>
                <small>{Math.round(item.confidence * 100)}%</small>
                {item.category_image?.history_images?.length ? (
                  <small>{item.category_image.history_images.length} 张历史模板</small>
                ) : (
                  <small>暂无历史模板</small>
                )}
                {item.reason ? <small>{item.reason}</small> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {judgment.alternatives.length > 0 ? (
        <div className="category-alternatives">
          <h4>备选品类</h4>
          <div className="term-chip-list">
            {judgment.alternatives.map((item) => (
              <div className="term-chip" key={item.category}>
                <strong>{item.category}</strong>
                <small>{Math.round(item.confidence * 100)}%</small>
                {item.reason ? <small>{item.reason}</small> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BuiltinElementTermsPanel({
  elementTerms,
}: {
  elementTerms: ProposalAgentPrepareResponse['element_terms'];
}) {
  if (!elementTerms) {
    return null;
  }

  return (
    <section className="element-terms-panel" aria-label="内置元素词提取">
      <DataLayerBadge label="元素词库数据" />
      <div className="element-terms-heading">
        <h3>内置元素词提取</h3>
        <span>
          {elementTerms.matched_term_count} / {elementTerms.term_count}
        </span>
      </div>
      {elementTerms.matched_terms.length > 0 ? (
        <div className="term-chip-list">
          {elementTerms.matched_terms.map((match) => (
            <div className="term-chip" key={match.term}>
              <strong>{match.term}</strong>
              <small>
                {match.match_type} · {match.source_fields.join(', ')}
              </small>
            </div>
          ))}
        </div>
      ) : (
        <p className="empty-note">未命中内置元素词。</p>
      )}
    </section>
  );
}

function AiTermList({
  title,
  terms,
}: {
  title: string;
  terms: ProposalAgentPrepareResponse['ai_element_mapping']['primary_element_terms'];
}) {
  return (
    <div className="ai-term-group">
      <h4>{title}</h4>
      {terms.length > 0 ? (
        <div className="term-chip-list">
          {terms.map((match) => (
            <div className="term-chip ai-term-chip" key={`${title}-${match.term}`}>
              <strong>{match.term}</strong>
              <small>
                confidence {match.confidence.toFixed(2)}
                {match.source_fields.length > 0 ? ` · ${match.source_fields.join(', ')}` : ''}
                {match.image_filename ? ` · ${match.image_filename}` : ''}
              </small>
              {match.reason ? <small>{match.reason}</small> : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="empty-note">暂无命中。</p>
      )}
    </div>
  );
}

function AiElementMappingPanel({
  mapping,
}: {
  mapping: ProposalAgentPrepareResponse['ai_element_mapping'];
}) {
  if (!mapping) {
    return null;
  }

  const hasError = mapping.ai_status !== 'success' && mapping.ai_error;

  return (
    <section className="ai-element-panel" aria-label="AI 元素词对应">
      <DataLayerBadge label="AI 映射数据" />
      <div className="element-terms-heading">
        <h3>AI 元素词对应</h3>
        <span>
          {mapping.ai_status} · {mapping.model}
        </span>
      </div>
      {hasError ? (
        <div className="ai-error-summary">
          <strong>{mapping.ai_error?.type || 'ai_error'}</strong>
          <span>{mapping.ai_error?.stage || 'unknown_stage'}</span>
          <p>{mapping.ai_error?.message || 'AI 元素词对应失败。'}</p>
        </div>
      ) : null}
      <AiTermList title="一级元素词" terms={mapping.primary_element_terms} />
      <AiTermList title="场景词" terms={mapping.scene_terms} />
      <AiTermList title="风格词" terms={mapping.style_terms} />
      <AiTermList title="属性词" terms={mapping.attribute_terms} />
    </section>
  );
}

function shortLabel(value: string, maxLength = 28) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

const OBSIDIAN_GRAPH_WIDTH = 980;
const OBSIDIAN_GRAPH_HEIGHT = 560;

type GalleryGraphNode = ProposalAgentPrepareResponse['element_gallery']['graph']['nodes'][number];
type GalleryGraphEdge = ProposalAgentPrepareResponse['element_gallery']['graph']['edges'][number];

type PositionedGraphNode = GalleryGraphNode & {
  x: number;
  y: number;
  radius: number;
  degree: number;
};

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function graphNodeRadius(node: GalleryGraphNode) {
  if (node.node_type === 'proposal') {
    return 18;
  }
  if (node.node_type === 'gallery_image' && node.is_top_intersection) {
    return 15;
  }
  if (node.node_type === 'gallery_image') {
    return 11;
  }
  return node.role === 'primary' ? 12 : 10;
}

function graphNodeClassName(node: GalleryGraphNode, selected: boolean) {
  const parts = ['obsidian-graph-node'];
  if (node.node_type === 'proposal') {
    parts.push('proposal');
  } else if (node.node_type === 'gallery_image') {
    parts.push('image');
    if (node.is_top_intersection) {
      parts.push('top');
    }
  } else {
    parts.push('term');
    if (node.role === 'primary') {
      parts.push('primary');
    } else if (node.role === 'scene') {
      parts.push('scene');
    } else if (node.role === 'style') {
      parts.push('style');
    } else if (node.role === 'attribute') {
      parts.push('attribute');
    }
  }
  if (selected) {
    parts.push('selected');
  }
  return parts.join(' ');
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function buildObsidianLocalGraphLayout(
  projectCode: string,
  inputNodes: GalleryGraphNode[],
  inputEdges: GalleryGraphEdge[],
) {
  const proposalId = `proposal:${projectCode || 'current'}`;
  const nodeMap = new Map<string, GalleryGraphNode>();
  const edges: GalleryGraphEdge[] = [];

  nodeMap.set(proposalId, {
    id: proposalId,
    node_type: 'proposal',
    label: projectCode || '当前提案',
  });

  inputNodes.forEach((node) => {
    nodeMap.set(node.id, node);
  });
  inputEdges.forEach((edge) => {
    if (nodeMap.has(edge.source) && nodeMap.has(edge.target)) {
      edges.push(edge);
    }
  });
  inputNodes
    .filter((node) => node.node_type === 'element_term')
    .forEach((node) => {
      edges.push({
        id: `${proposalId}->${node.id}`,
        source: proposalId,
        target: node.id,
      });
    });

  const nodes = [...nodeMap.values()];
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  edges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  });

  const positioned = nodes.map((node, index) => {
    const seed = hashString(`${node.id}:${index}`);
    const angle = (seed / 0xffffffff) * Math.PI * 2;
    const isProposal = node.node_type === 'proposal';
    const isTerm = node.node_type === 'element_term';
    const orbit = isProposal ? 0 : isTerm ? 145 : 245 + ((seed % 90) - 45);
    return {
      ...node,
      degree: degree.get(node.id) || 0,
      radius: graphNodeRadius(node),
      x: OBSIDIAN_GRAPH_WIDTH / 2 + Math.cos(angle) * orbit,
      y: OBSIDIAN_GRAPH_HEIGHT / 2 + Math.sin(angle) * orbit,
      vx: 0,
      vy: 0,
    };
  });

  const byId = new Map(positioned.map((node) => [node.id, node]));

  for (let iteration = 0; iteration < 260; iteration += 1) {
    for (let leftIndex = 0; leftIndex < positioned.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < positioned.length; rightIndex += 1) {
        const left = positioned[leftIndex];
        const right = positioned[rightIndex];
        let dx = right.x - left.x;
        let dy = right.y - left.y;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < 0.01) {
          dx = 0.01;
          dy = 0.01;
          distanceSquared = 0.02;
        }
        const distance = Math.sqrt(distanceSquared);
        const force = 3400 / distanceSquared;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        left.vx -= fx;
        left.vy -= fy;
        right.vx += fx;
        right.vy += fy;
      }
    }

    for (const edge of edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) {
        continue;
      }
      const isProposalEdge = source.node_type === 'proposal' || target.node_type === 'proposal';
      const desiredDistance = isProposalEdge ? 135 : target.is_top_intersection ? 145 : 175;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (distance - desiredDistance) * (isProposalEdge ? 0.026 : 0.018);
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }

    for (const node of positioned) {
      const centerPull = node.node_type === 'proposal' ? 0.08 : 0.006;
      node.vx += (OBSIDIAN_GRAPH_WIDTH / 2 - node.x) * centerPull;
      node.vy += (OBSIDIAN_GRAPH_HEIGHT / 2 - node.y) * centerPull;
      node.vx *= 0.82;
      node.vy *= 0.82;
      node.x = clamp(node.x + node.vx, 34, OBSIDIAN_GRAPH_WIDTH - 34);
      node.y = clamp(node.y + node.vy, 34, OBSIDIAN_GRAPH_HEIGHT - 34);
    }
  }

  return {
    nodes: positioned.map(({ vx: _vx, vy: _vy, ...node }) => node),
    edges,
  };
}

function graphNodeSummary(node: PositionedGraphNode | null) {
  if (!node) {
    return '点击节点查看关系信息。';
  }
  if (node.node_type === 'proposal') {
    return `当前提案连接 ${node.degree} 个元素词。`;
  }
  if (node.node_type === 'gallery_image') {
    return `${node.filename || node.label} 连接 ${node.term_count || node.degree} 个元素词。`;
  }
  return `${node.raw_term || node.label} 连接 ${node.degree} 个图库节点。`;
}

function ElementGalleryRelationshipGraph({
  gallery,
  projectCode,
}: {
  gallery: ProposalAgentPrepareResponse['element_gallery'];
  projectCode: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const layout = useMemo(
    () => buildObsidianLocalGraphLayout(projectCode, gallery.graph?.nodes || [], gallery.graph?.edges || []),
    [gallery.graph?.edges, gallery.graph?.nodes, projectCode],
  );
  const nodeById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes],
  );
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) || null : null;
  const termNodes = layout.nodes.filter((node) => node.node_type === 'element_term');
  const imageNodes = layout.nodes.filter((node) => node.node_type === 'gallery_image');
  const viewWidth = OBSIDIAN_GRAPH_WIDTH / zoom;
  const viewHeight = OBSIDIAN_GRAPH_HEIGHT / zoom;
  const viewX = (OBSIDIAN_GRAPH_WIDTH - viewWidth) / 2;
  const viewY = (OBSIDIAN_GRAPH_HEIGHT - viewHeight) / 2;

  if (termNodes.length === 0) {
    return <p className="empty-note">暂无可绘制的图库关系。</p>;
  }

  return (
    <div className="obsidian-graph-shell">
      <div className="obsidian-graph-toolbar" aria-label="图谱控制">
        <button type="button" onClick={() => setZoom((value) => Math.min(1.8, value + 0.15))}>
          放大
        </button>
        <button type="button" onClick={() => setZoom((value) => Math.max(0.72, value - 0.15))}>
          缩小
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setSelectedNodeId(null);
          }}
        >
          重置
        </button>
        <span>Local Graph · depth 2</span>
      </div>
      <div className="obsidian-graph" role="img" aria-label="Obsidian 风格元素词图库关系图">
        <svg
          viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`}
          preserveAspectRatio="xMidYMid meet"
          onClick={() => setSelectedNodeId(null)}
        >
          {layout.edges.map((edge) => {
          const source = nodeById.get(edge.source);
          const target = nodeById.get(edge.target);
          if (!source || !target) {
            return null;
          }
          const selected =
            selectedNodeId === edge.source ||
            selectedNodeId === edge.target ||
            selectedNodeId === null;
          return (
            <line
              className={selected ? 'obsidian-graph-edge' : 'obsidian-graph-edge muted'}
              key={edge.id}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
            />
          );
        })}
          {layout.nodes.map((node) => {
          const isSelected = selectedNodeId === node.id;
          const isDimmed =
            selectedNodeId !== null &&
            !isSelected &&
            !layout.edges.some(
              (edge) =>
                (edge.source === selectedNodeId && edge.target === node.id) ||
                (edge.target === selectedNodeId && edge.source === node.id),
            );
          return (
            <g
              className={`${graphNodeClassName(node, isSelected)}${isDimmed ? ' dimmed' : ''}`}
              key={node.id}
              onClick={(event) => {
                event.stopPropagation();
                setSelectedNodeId(node.id);
              }}
              tabIndex={0}
              role="button"
            >
              <circle cx={node.x} cy={node.y} r={node.radius} />
              <text x={node.x + node.radius + 7} y={node.y + 4}>
                {shortLabel(node.filename || node.label, node.node_type === 'gallery_image' ? 24 : 30)}
              </text>
              {node.node_type === 'gallery_image' && node.term_count ? (
                <text className="obsidian-graph-count" x={node.x - 4} y={node.y + 4}>
                  {node.term_count}
                </text>
              ) : null}
              <title>{graphNodeSummary(node)}</title>
            </g>
          );
        })}
        </svg>
      </div>
      <div className="obsidian-graph-status">
        <span>{layout.nodes.length} 个节点</span>
        <span>{layout.edges.length} 条关系</span>
        <span>{graphNodeSummary(selectedNode)}</span>
      </div>
    </div>
  );
}

function ElementGalleryMatchGroup({
  title,
  matches,
}: {
  title: string;
  matches: ProposalAgentPrepareResponse['element_gallery']['primary_element_gallery_matches'];
}) {
  return (
    <div className="gallery-match-group">
      <h4>{title}</h4>
      {matches.length > 0 ? (
        <div className="gallery-term-grid">
          {matches.map((match) => (
            <article className="gallery-term-card" key={`${title}-${match.normalized_term}`}>
              <div className="gallery-term-card-heading">
                <div>
                  <strong>{match.normalized_term}</strong>
                  <small>{match.raw_term}</small>
                </div>
                <span>{match.gallery_candidate_count} 张</span>
              </div>
              {match.candidate_images.length > 0 ? (
                <div className="gallery-candidate-grid">
                  {match.candidate_images.map((image) => (
                    <figure
                      className={
                        image.is_top_intersection
                          ? 'gallery-candidate-card top-intersection'
                          : 'gallery-candidate-card'
                      }
                      key={`${match.normalized_term}-${image.image_id}`}
                    >
                      {image.url ? (
                        <img
                          src={image.url}
                          alt={`${match.normalized_term} gallery candidate`}
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="reference-image-missing">未配置图片地址</div>
                      )}
                      <figcaption>
                        <span>{image.is_top_intersection ? '交集最多图片' : '图库候选图片'}</span>
                        <code>{image.filename || '未命名图片'}</code>
                        <small>连接 {image.intersection_count} 个元素词</small>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              ) : (
                <p className="empty-note">
                  该元素词已保留为新图案设计主题标准；当前没有图库候选图片。
                </p>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p className="empty-note">暂无命中。</p>
      )}
    </div>
  );
}

function SelectedGalleryImagesPanel({
  selection,
}: {
  selection: ProposalAgentPrepareResponse['selected_gallery_images'];
}) {
  const [previewImage, setPreviewImage] = useState<
    ProposalAgentPrepareResponse['selected_gallery_images']['selected_images'][number] | null
  >(null);

  if (!selection || selection.status === 'skipped') {
    return null;
  }

  const hasError = selection.status !== 'success' && selection.ai_error;
  const visibleSelectedImages = selection.selected_images.slice(0, 2);
  const qualifiedSelectedImageCount = selection.selected_images.filter(
    (image) => image.match_score >= GENERATION_MATERIAL_MIN_SCORE,
  ).length;

  return (
    <section className="selected-gallery-panel" aria-label="AI 筛选符合图案元素的图片">
      <DataLayerBadge label="AI 筛选图片数据" />
      <div className="element-terms-heading">
        <h3>AI 筛选符合图案元素的图片</h3>
        <span>
          生成可用 {Math.min(qualifiedSelectedImageCount, 2)} 张 / 入选 {selection.selected_image_count} 张 · {selection.model}
        </span>
      </div>
      <p className="gallery-note">
        这一步只看已经召回的图库候选图，由 AI 判断哪些图片真正符合图案元素需求；低于 80% 匹配度的图片只保留在数据层，不进入最终生成参考。
      </p>
      {selection.required_graphic_elements.length > 0 ? (
        <div className="selected-image-requirements">
          <span>图案元素需求</span>
          <div className="term-chip-list">
            {selection.required_graphic_elements.map((term) => (
              <div className="term-chip" key={term}>
                <strong>{term}</strong>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {hasError ? (
        <div className="ai-error-summary">
          <strong>{selection.ai_error?.type || 'ai_error'}</strong>
          <span>{selection.ai_error?.stage || 'unknown_stage'}</span>
          <p>{selection.ai_error?.message || 'AI 图片筛选失败。'}</p>
          {selection.ai_error?.http_status ? (
            <small>HTTP {selection.ai_error.http_status}</small>
          ) : null}
          {selection.ai_error?.response_preview ? (
            <pre className="ai-error-preview">{selection.ai_error.response_preview}</pre>
          ) : null}
        </div>
      ) : null}
      {visibleSelectedImages.length > 0 ? (
        <div className="selected-image-grid">
          {visibleSelectedImages.map((image) => (
            <figure className="selected-image-card" key={image.image_id}>
              {image.url ? (
                <button
                  type="button"
                  className="selected-image-preview-button"
                  onClick={() => setPreviewImage(image)}
                  aria-label={`查看大图 ${image.filename || 'selected gallery image'}`}
                >
                  <img
                    src={image.url}
                    alt={`${image.filename || 'selected gallery image'} AI selected`}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                  <span>查看大图</span>
                </button>
              ) : (
                <div className="reference-image-missing">未配置图片地址</div>
              )}
              <figcaption>
                <div className="selected-image-card-heading">
                  <strong>{image.filename || '未命名图片'}</strong>
                  <span>{Math.round(image.match_score * 100)}%</span>
                </div>
                {image.matched_graphic_elements.length > 0 ? (
                  <small>匹配元素：{image.matched_graphic_elements.join(', ')}</small>
                ) : null}
                {image.connected_terms.length > 0 ? (
                  <small>
                    连接词：{image.connected_terms.map((term) => `${term.role}:${term.term}`).join(', ')}
                  </small>
                ) : null}
                {image.reason ? <p>{image.reason}</p> : null}
                {image.concerns ? <small>注意：{image.concerns}</small> : null}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p className="empty-note">
          当前没有图片通过 AI 筛选；可以查看下方图库候选关系，或调整图案元素需求后重新判断。
        </p>
      )}
      {previewImage ? (
        <div
          className="image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="筛选图片大图预览"
          onClick={() => setPreviewImage(null)}
        >
          <div className="image-lightbox-content" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="image-lightbox-close"
              onClick={() => setPreviewImage(null)}
            >
              关闭
            </button>
            <img
              src={previewImage.url}
              alt={`${previewImage.filename || 'selected gallery image'} large preview`}
              referrerPolicy="no-referrer"
            />
            <div className="image-lightbox-meta">
              <div className="selected-image-card-heading">
                <strong>{previewImage.filename || '未命名图片'}</strong>
                <span>{Math.round(previewImage.match_score * 100)}%</span>
              </div>
              {previewImage.matched_graphic_elements.length > 0 ? (
                <small>匹配元素：{previewImage.matched_graphic_elements.join(', ')}</small>
              ) : null}
              {previewImage.connected_terms.length > 0 ? (
                <small>
                  连接词：{previewImage.connected_terms.map((term) => `${term.role}:${term.term}`).join(', ')}
                </small>
              ) : null}
              {previewImage.reason ? <p>{previewImage.reason}</p> : null}
              {previewImage.concerns ? <small>注意：{previewImage.concerns}</small> : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function GenerationInputImageCard({
  image,
}: {
  image: ImageToImageInputImage;
}) {
  return (
    <figure className="generation-input-image-card">
      <img src={image.url} alt={image.filename} loading="lazy" referrerPolicy="no-referrer" />
      <figcaption>
        <div className="selected-image-card-heading">
          <strong>{image.filename}</strong>
          {typeof image.score === 'number' ? <span>{Math.round(image.score * 100)}%</span> : null}
        </div>
        <small>{image.detail}</small>
        {image.note ? <p>{image.note}</p> : null}
      </figcaption>
    </figure>
  );
}

function FinalGenerationInputInspector({
  snapshot,
  mode,
  note,
}: {
  snapshot: FinalGenerationInputSnapshot;
  mode: 'submitted' | 'preview';
  note: string;
}) {
  const requestJson = JSON.stringify(
    {
      project_code: snapshot.projectCode,
      category: snapshot.category,
      category_targets: snapshot.categoryTargets || [snapshot.category],
      history_layout_lock_policy: snapshot.historyLayoutLockPolicy || '',
      history_layout_lock_reason: snapshot.historyLayoutLockReason || '',
      input_images: snapshot.inputImages,
      prompt: snapshot.prompt,
      generation_requests: snapshot.requests,
    },
    null,
    2,
  );

  return (
    <div className="final-generation-input-panel">
      <div className="generation-input-block-heading">
        <h4>最终生图实际输入</h4>
        <span>{mode === 'submitted' ? '本次实际提交' : '当前待提交预览'}</span>
      </div>
      <div className="generation-submission-meta">
        <span>项目：{snapshot.projectCode}</span>
        <span>品类：{snapshot.category}</span>
        {snapshot.categoryTargets && snapshot.categoryTargets.length > 1 ? (
          <span>组合品类：{snapshot.categoryTargets.join(' / ')}</span>
        ) : null}
        <span>输入图：{snapshot.inputImages.length} 张</span>
        {snapshot.historyLayoutLockPolicy ? (
          <span>版式策略：{snapshot.historyLayoutLockPolicy}</span>
        ) : null}
        {mode === 'submitted' ? <span>记录：{snapshot.createdAt}</span> : null}
      </div>
      <p className="generation-submission-note">{note}</p>
      {snapshot.inputImages.length > 0 ? (
        <div className="generation-submission-image-grid">
          {snapshot.inputImages.map((image, index) => (
            <figure className="generation-submission-image-card" key={`${image.role}-${image.id}-${index}`}>
              <img src={image.url} alt={image.filename} loading="lazy" referrerPolicy="no-referrer" />
              <figcaption>
                <div className="selected-image-card-heading">
                  <strong>
                    {index + 1}. {image.filename}
                  </strong>
                  <span>{image.role}</span>
                </div>
                <small>{image.label}</small>
                {image.detail ? <p>{image.detail}</p> : null}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p className="empty-note">当前没有可提交的输入图。</p>
      )}
      <details className="generation-submission-json" open={mode === 'submitted'}>
        <summary>请求 JSON</summary>
        <textarea className="generation-prompt-textarea" readOnly value={requestJson} />
      </details>
    </div>
  );
}

function AgentFlowStatusPanel({
  status,
  steps,
  error,
}: {
  status: 'idle' | 'running' | 'blocked' | 'success' | 'materials_only' | 'error';
  steps: AgentFlowStep[];
  error: string;
}) {
  const statusText = {
    idle: '等待项目编码',
    running: '自动流程运行中',
    blocked: '流程需要确认',
    success: '已完成',
    materials_only: '已只输出素材图',
    error: '流程失败',
  }[status];

  return (
    <section className={`agent-flow-panel ${status}`} aria-label="自动流程状态">
      <div className="generation-input-block-heading">
        <h4>自动流程</h4>
        <span>最多重试 {AGENT_FLOW_MAX_RETRIES} 次 · {statusText}</span>
      </div>
      <div className="agent-flow-steps">
        {steps.map((step) => (
          <div className={`agent-flow-step ${step.status}`} key={step.id}>
            <strong>{step.label}</strong>
            <span>
              {step.status}
              {step.attempts > 0 ? ` · ${step.attempts}/${AGENT_FLOW_MAX_RETRIES}` : ''}
            </span>
            {step.message ? <small>{step.message}</small> : null}
          </div>
        ))}
      </div>
      {error ? <p className="generation-prep-note error-text">{error}</p> : null}
    </section>
  );
}

function generatedImageUrl(image: GeneratePatternImageResponse['images'][number]) {
  if (image.url) {
    return image.url;
  }
  if (image.b64_json) {
    return `data:${image.mime_type || 'image/png'};base64,${image.b64_json}`;
  }
  return '';
}

function sourceImageSummary(images: ImageToImageInputImage[]) {
  return images
    .map((image, index) => `${index + 1}. ${image.filename}（${image.detail || image.label}）`)
    .join('；');
}

function materialExtractionInputImages(
  images: ImageToImageInputImage[],
  role: string,
): GeneratePatternImageInputImage[] {
  return images.map((image) => ({
    id: image.id,
    role,
    label: image.label,
    filename: image.filename,
    url: image.url,
    detail: image.detail,
  }));
}

function buildShapeLevelElementJudgment(
  shapeLevel: MaterialShapeLevel,
  graphicElementSummary: string,
  textElementSummary: string,
) {
  const textRule = textElementSummary
    ? `文字元素判定锚点：${textElementSummary}。这些文字只用于判断输入图中已有字形属于哪一层级，不是让模型重新绘制或生成这些文字；如果输入图没有对应文字或近似字形，不要凭空生成。`
    : '文字元素判定锚点：当前文字元素为空，不要从参考图或素材图里额外提取、重绘或生成新的可读主题文字。';

  const baseRule = [
    `主要图案元素判定锚点：${graphicElementSummary}。这些词只用于判断输入图中哪些现有元素属于一级形、二级形、三级形，不是让模型按文字重新设计类似图案；如果输入图没有对应元素，宁可少提取，也不要补画。`,
    textRule,
    '原图提取边界：只能从输入图中已经存在的元素做抠取、清理、分组和整理；不得重绘、改画、风格化生成、相似创作或根据锚点文字补全新元素。',
  ];

  if (shapeLevel.key === 'primary') {
    return [
      ...baseRule,
      '当前层级判定：一级形只能从输入图已有元素中选择与主要图案元素对应的核心主体，以及输入图中已经存在、且承担主题识别的主标题/主文案字形；不要因为餐盘、纸巾、杯子、包装或商品组合面积大，就把载体当成一级形。',
    ].join(' ');
  }

  if (shapeLevel.key === 'secondary') {
    return [
      ...baseRule,
      '当前层级判定：二级形只能从输入图已有元素中选择服务于主要图案元素和文字元素的辅助结构，例如边框、角花、次级图标、局部装饰和承托主文案的中等元素；不得重复完整一级主体、完整主标题或整套产品版面。',
    ].join(' ');
  }

  return [
    ...baseRule,
    '当前层级判定：三级形只能从输入图已有元素中选择围绕主要图案元素和文字元素的轻量点缀、底纹、散点、光点、小符号和重复节奏；不得包含可读主题主文案、完整主图标、完整主徽章或中等边框组。',
  ].join(' ');
}

function materialShapeAnalysisLevel(
  analysis: MaterialShapeAnalysisResponse | null,
  shapeLevel: MaterialShapeLevel,
) {
  if (!analysis || analysis.status !== 'success') {
    return null;
  }
  return analysis.levels?.[shapeLevel.key] || null;
}

function buildMaterialShapeAnalysisInstruction(
  analysis: MaterialShapeAnalysisResponse | null,
  shapeLevel: MaterialShapeLevel,
) {
  const levelAnalysis = materialShapeAnalysisLevel(analysis, shapeLevel);
  if (!levelAnalysis) {
    return 'AI 分层判断结果：当前尚未获得 AI 对输入图的一二三级形判断；只能按通用层级规则提取。';
  }
  const globalNotes = analysis?.global_notes || [];

  return [
    `AI 分层判断结果（必须优先执行）：本次${shapeLevel.label}提取对象由 AI 看图判断，不由固定模板自由猜测。`,
    levelAnalysis.extraction_targets.length > 0
      ? `本层应该提取：${levelAnalysis.extraction_targets.join('；')}。`
      : '本层应该提取：AI 未给出明确目标，宁可少提取，不要补画。',
    levelAnalysis.preserve_details.length > 0
      ? `本层需要保留：${levelAnalysis.preserve_details.join('；')}。`
      : '',
    levelAnalysis.exclude_items.length > 0
      ? `本层必须排除：${levelAnalysis.exclude_items.join('；')}。`
      : '',
    levelAnalysis.source_reasoning ? `判断依据：${levelAnalysis.source_reasoning}。` : '',
    levelAnalysis.prompt_guidance ? `执行补充：${levelAnalysis.prompt_guidance}。` : '',
    globalNotes.length > 0 ? `全局注意：${globalNotes.join('；')}。` : '',
  ].filter(Boolean).join('\n');
}

function materialShapeAnalysisRequiresSplit(analysis: MaterialShapeAnalysisResponse | null) {
  return !analysis || analysis.status !== 'success' || analysis.split_required !== false;
}

function materialShapeAnalysisSummary(analysis: MaterialShapeAnalysisResponse | null) {
  if (!analysis || analysis.status !== 'success') {
    return '';
  }

  if (analysis.split_required === false) {
    return `不需要拆分：${analysis.split_reason || analysis.single_material_guidance || '输入图更适合作为统一素材板清理。'}`;
  }

  return MATERIAL_SHAPE_LEVELS
    .map((shapeLevel) => {
      const level = materialShapeAnalysisLevel(analysis, shapeLevel);
      const targets = level?.extraction_targets || [];
      return `${shapeLevel.label}：${targets.length > 0 ? targets.join('、') : '未给出明确目标'}`;
    })
    .join('；');
}

function buildFinalGenerationInputImages(
  historyImage: ImageToImageInputImage | null,
  materialImages: ImageToImageInputImage[],
): GeneratePatternImageInputImage[] {
  return [
    ...(historyImage
      ? [
          {
            id: historyImage.id,
            role: 'history',
            label: historyImage.label,
            filename: historyImage.filename,
            url: historyImage.url,
            detail: historyImage.detail,
          },
        ]
      : []),
    ...materialImages.map((image) => ({
      id: image.id,
      role: 'material',
      label: image.label,
      filename: image.filename,
      url: image.url,
      detail: image.detail,
    })),
  ];
}

function imageGenerationStatusHint(result: GeneratePatternImageResponse) {
  if (result.status === 'missing_config') {
    return '请在本地 .env 配置 AI_IMAGE_GENERATOR_BASE_URL 和 AI_IMAGE_GENERATOR_API_KEY 后重启后端。';
  }
  if (result.ai_error?.type === 'http_error') {
    return `上游生图服务返回 HTTP ${result.ai_error.http_status ?? '-'}，这通常表示服务繁忙、模型不可用、额度/权限限制，或该端点暂时不能处理当前请求。`;
  }
  if (result.ai_error?.type === 'timeout') {
    const seconds = result.ai_error.timeout_ms ? Math.round(result.ai_error.timeout_ms / 1000) : null;
    return `上游生图服务在${seconds ? ` ${seconds} 秒` : ''}内没有返回结果；这通常是生成排队或模型处理时间过长，不是 key 未读取。可以重试，或继续增大 AI_IMAGE_GENERATOR_TIMEOUT_MS。`;
  }
  if (result.status === 'no_images') {
    return '请求已完成，但返回体里没有可展示的图片 URL 或 base64 图片。';
  }
  return '请求已到达后端；请根据下面的错误阶段和预览判断上游服务状态。';
}

function materialShapeAnalysisErrorMessage(response: MaterialShapeAnalysisResponse, fallback: string) {
  const message = response.ai_error?.message || fallback;
  const preview = response.ai_error?.response_preview;
  return preview ? `${message}\n上游返回：${preview}` : message;
}

function buildMaterialRefinementPrompt(
  images: ImageToImageInputImage[],
  graphicElements: string[],
  textElements: string[],
  shapeLevel: MaterialShapeLevel,
  shapeAnalysis: MaterialShapeAnalysisResponse | null,
) {
  const graphicElementSummary =
    graphicElements.length > 0 ? graphicElements.join('、') : '输入图中与开发需求匹配的主要图案元素';
  const textElementSummary = textElements.length > 0 ? textElements.join('、') : '';

  return [
    `请基于输入图只提取【${shapeLevel.title}】，生成一张可直接用于后续图案设计的${shapeLevel.label}干净素材图。`,
    '工作模式：这是素材提取/抠图整理任务，不是重新设计、不是重绘、不是根据文字生成类似图案。',
    '',
    `主要图案元素判定依据：${graphicElementSummary}`,
    textElementSummary
      ? `文字元素判定依据：${textElementSummary}`
      : '文字元素为空：不要提取、重绘或新增未要求的可读主题文字。',
    `来源素材：${sourceImageSummary(images)}。`,
    buildMaterialShapeAnalysisInstruction(shapeAnalysis, shapeLevel),
    `元素/文字分层判定：${buildShapeLevelElementJudgment(shapeLevel, graphicElementSummary, textElementSummary)}`,
    `层级定义：${shapeLevel.focus}`,
    `数量边界：${shapeLevel.countRule}`,
    `硬边界：${shapeLevel.hardBoundary}`,
    `禁止内容：${shapeLevel.forbidden}`,
    `处理目标：${shapeLevel.output}`,
    '只保留输入图中已经存在、且当前层级中与主要图案元素一致的图案主体、线条、纹理、局部装饰和必要配色关系；没有出现在输入图里的元素不要画出来。',
    '不要把一级形、二级形、三级形混在同一张图里；本次只输出当前层级素材，其他层级会由独立步骤提取。',
    '禁止重绘规则：不得根据主要图案元素或文字元素重新设计类似图案；不得把输入图里的元素改画成新的造型；不得生成输入图中没有的新文字、新图标、新主体或新装饰。',
    '载体剥离规则：餐盘、纸巾、杯子、叉勺、包装、产品卡片和商品截图都只是展示载体，不是素材本体；即使载体上印有图案，也只能剥离其可复用的字形、符号、线条和局部装饰，不能保留载体外形、整件商品或完整展示版面。',
    '分层互斥规则：同一个完整产品版面、同一组大标题或同一个主徽章不能同时出现在一级形和二级形；二级形必须比一级形更局部、更辅助，三级形必须比二级形更轻、更碎。',
    '必须去除：商品载体、餐盘/杯子/衣服/包装/叉勺等承载物，渠道图排版，尺寸标注，水印，价格/平台/店铺信息，说明文字，背景场景，阴影摄影质感，多余边框和产品组合展示。',
    '输出形式：白底或干净透明感背景上的单层级图案素材，边缘完整，主体清晰，元素之间留出清楚间距，方便后续移植到历史设计图版式里。',
    '不要生成最终成品构图，不要改变输入图中已有元素造型，不要加入未提到或输入图中不存在的新核心元素。',
  ].join('\n');
}

function buildUnifiedMaterialBoardPrompt(
  images: ImageToImageInputImage[],
  graphicElements: string[],
  textElements: string[],
  shapeAnalysis: MaterialShapeAnalysisResponse | null,
  sourceLabel = '输入素材图',
) {
  const graphicElementSummary =
    graphicElements.length > 0 ? graphicElements.join('、') : '输入图中与开发需求匹配的主要图案元素';
  const textElementSummary = textElements.length > 0 ? textElements.join('、') : '';

  return [
    `请基于输入的${sourceLabel}，整理成一张可用于后续图案设计的统一素材板。`,
    '工作模式：这是素材清理/抠图整理任务，不是重新设计、不是重绘、不是根据文字生成类似图案，也不是强行拆分一级形、二级形、三级形。',
    '',
    'AI 拆分必要性判断：当前输入图更适合作为统一素材板处理，不需要强行拆成一级形、二级形、三级形。',
    shapeAnalysis?.split_reason ? `不拆分原因：${shapeAnalysis.split_reason}。` : '',
    shapeAnalysis?.single_material_guidance
      ? `统一素材板处理方式：${shapeAnalysis.single_material_guidance}。`
      : '统一素材板处理方式：保留每个独立可用图案素材，去除所有尺寸线、尺寸文字、红色框选、截图标注、渠道信息和背景噪声。',
    `主要图案元素判定依据：${graphicElementSummary}`,
    textElementSummary
      ? `文字元素判定依据：${textElementSummary}`
      : '文字元素为空：不要新增未要求的可读主题文字。',
    `来源图片：${sourceImageSummary(images)}。`,
    '保留规则：保留输入图中已经存在的独立贴图、成品小图案、主题字形、角色、图标、边框和局部装饰；元素外观、配色、线条和水彩/纹理质感尽量不变。',
    '清理规则：必须去除尺寸标注、红色尺寸线、红色框选、cm/mm 数字、商品截图界面、下载/查看按钮、价格/平台/店铺信息、背景场景、阴影摄影质感和无关空白。',
    '排版规则：输出为干净白底或透明感背景上的素材板；每个独立素材之间留出清楚间距，方便后续移植到历史设计图版式中；不要把素材重新组织成最终成品构图。',
    '禁止规则：不要新增输入图中不存在的新恐龙、新角色、新文字或新装饰；不要把多个小图案合并成一个新主视觉；不要改变原有素材的主题和造型。',
  ].filter(Boolean).join('\n');
}

function buildMaterialBoardReversePrompt(
  sourceLabel: string,
  sourceNames: string,
  shapeAnalysis: MaterialShapeAnalysisResponse | null,
  materialKind = '素材图',
) {
  return [
    `请对输入的${materialKind}做提示词反推，只分析图中已经存在的视觉内容。`,
    `素材来源：${sourceLabel}；来源图片：${sourceNames}。`,
    shapeAnalysis ? `上一步 AI 判断：${materialShapeAnalysisSummary(shapeAnalysis)}。` : '',
    '这一步只输出图像视觉描述，不要输出生成建议、流程解释或额外标题。',
    '',
    MATERIAL_BOARD_REVERSE_PROMPT_TEMPLATE,
  ].filter(Boolean).join('\n');
}

function buildMaterialBoardRegenerationPrompt(
  reverseDescription: string,
  sourceLabel: string,
  sourceNames: string,
  materialKind = '素材图',
) {
  return [
    `请只基于下方反推视觉描述，文生图生成一张可用于后续图案设计的新${materialKind}。`,
    '',
    `素材来源：${sourceLabel}；来源图片：${sourceNames}。`,
    `工作模式：这是${materialKind}的反推重生成，不是最终成品设计，不是按照文字另行创作新主题。`,
    '保真规则：必须保留反推描述中记录的素材本体，包括元素造型、文字字形、线条、纹理、局部装饰、边框语言和配色关系；只允许修复压缩瑕疵、边缘瑕疵、噪点、粘连和排版不清。',
    '禁止新增：不要新增反推描述以外的新主体、新文字、新图标、新角色或新装饰；不要把素材重新组合成最终产品图、完整餐具/纸巾/包装展示或历史版式构图。',
    '清理规则：继续去除载体、尺寸标注、商品截图界面、平台/价格/店铺信息、背景场景、摄影阴影和无关说明。',
    `输出形式：纯色背景上的干净${materialKind}，每个独立素材之间留出清楚间距，边缘完整，主体清晰，方便后续进入最终输入。`,
    '',
    '反推视觉描述：',
    reverseDescription,
  ].join('\n');
}

function collectGenerationDesignReferenceImages(result: ProposalAgentPrepareResponse): ImageToImageInputImage[] {
  const requestedReferenceIndices = collectDesignRequirementReferenceIndices(result.proposal);
  const requestedReferenceIndexSet = new Set(requestedReferenceIndices);
  const designImages = (result.proposal.reference_images || []).filter(isCompanyDesignReferenceImage);
  const externalEvidenceImages = (result.proposal.reference_images || []).filter(isExternalEvidenceReferenceImage);
  const sourceImages = designImages.length > 0 ? designImages : externalEvidenceImages;
  const sourceLabel = designImages.length > 0 ? '公司设计参考图' : '外部竞品证据图';
  const indexedDesignImages = sourceImages
    .filter((image) => image.url)
    .map((image, index) => ({
      image,
      referenceIndex: index + 1,
    }));
  const selectedDesignImages =
    requestedReferenceIndices.length > 0
      ? indexedDesignImages.filter((item) => requestedReferenceIndexSet.has(item.referenceIndex))
      : indexedDesignImages.slice(0, MAX_DESIGN_REFERENCE_MATERIAL_IMAGES);
  const finalDesignImages =
    requestedReferenceIndices.length > 0
      ? selectedDesignImages
      : indexedDesignImages.slice(0, MAX_DESIGN_REFERENCE_MATERIAL_IMAGES);

  return finalDesignImages
    .slice(0, MAX_DESIGN_REFERENCE_MATERIAL_IMAGES)
    .map(({ image, referenceIndex }) => ({
        id: `design-reference-${referenceIndex}-${image.url}`,
        url: image.url,
        filename: image.filename || image.raw_path || `${sourceLabel} ${referenceIndex}`,
        label: requestedReferenceIndexSet.has(referenceIndex)
          ? `开发思路指定${sourceLabel} ${referenceIndex}`
          : `${sourceLabel} ${referenceIndex}`,
        detail: requestedReferenceIndexSet.has(referenceIndex)
          ? `开发思路指定使用${sourceLabel}${referenceIndex}进入素材流程；开发思路只负责选图，不作为素材判断或素材生成提示词。原图不进入最终图生图。`
          : `${sourceLabel}，仅用于 AI 提取可用图案素材，不作为原图进入最终图生图。`,
        note: image.raw_path,
        selectedByDesignRequirement: requestedReferenceIndexSet.has(referenceIndex),
        designReferenceIndex: referenceIndex,
        sourceField: image.source_field,
      }));
}

function buildDesignReferenceMaterialSplitPrompt(
  images: ImageToImageInputImage[],
  graphicElements: string[],
  textElements: string[],
  shapeLevel: MaterialShapeLevel,
  shapeAnalysis: MaterialShapeAnalysisResponse | null = null,
) {
  const sourceLabel = generationReferenceSourceLabel(images);
  const graphicElementSummary =
    graphicElements.length > 0 ? graphicElements.join('、') : '输入图中与开发需求匹配的主要图案元素';
  const textElementSummary = textElements.length > 0 ? textElements.join('、') : '';

  return [
    `请基于输入的${sourceLabel}，只提取【${shapeLevel.title}】，整理成一张可用于后续图案设计的${shapeLevel.label}纯色背景素材图。`,
    '工作模式：这是素材提取/抠图整理任务，不是重新设计、不是重绘、不是根据文字生成类似图案。',
    '',
    `主要图案元素判定依据：${graphicElementSummary}`,
    textElementSummary
      ? `文字元素判定依据：${textElementSummary}`
      : '文字元素为空：不要提取、重绘或新增未要求的可读主题文字。',
    `来源${sourceLabel}：${sourceImageSummary(images)}。`,
    buildMaterialShapeAnalysisInstruction(shapeAnalysis, shapeLevel),
    `元素/文字分层判定：${buildShapeLevelElementJudgment(shapeLevel, graphicElementSummary, textElementSummary)}`,
    `层级定义：${shapeLevel.focus}`,
    `数量边界：${shapeLevel.countRule}`,
    `硬边界：${shapeLevel.hardBoundary}`,
    `禁止内容：${shapeLevel.forbidden}`,
    `处理目标：${shapeLevel.output}`,
    '提取范围：不要只保留同名主要元素；只能从输入图中已经存在的视觉内容里，按层级提取主体、辅助元素、边框、角花、重复纹样、散点、底纹、线条语言、纹理、配色关系、局部符号和文字装饰语言。',
    '不要把一级形、二级形、三级形混在同一张图里；本次只输出当前层级素材，其他层级会由独立步骤提取。',
    '禁止重绘规则：不得根据主要图案元素、文字元素或开发思路重新设计类似图案；不得把输入图里的元素改画成新的造型；不得生成输入图中没有的新文字、新图标、新主体或新装饰。',
    '载体剥离规则：餐盘、纸巾、杯子、叉勺、包装、产品卡片和商品截图都只是展示载体，不是素材本体；即使载体上印有图案，也只能剥离其可复用的字形、符号、线条和局部装饰，不能保留载体外形、整件商品或完整展示版面。',
    '分层互斥规则：同一个完整产品版面、同一组大标题或同一个主徽章不能同时出现在一级形和二级形；二级形必须比一级形更局部、更辅助，三级形必须比二级形更轻、更碎。',
    `处理目标：从${sourceLabel}中提取当前层级的图案素材，而不是最终产品图或完整构图；把可复用元素整理成素材板，元素之间留出清楚间距，方便后续移植到历史设计图版式里。`,
    '必须去除：商品载体、产品摄影展示和透视、包装、尺寸标注、渠道排版、水印、价格/平台/店铺信息、销售说明文字、背景场景、阴影和非图案层信息。',
    '文字处理：如果文字本身属于图案设计的一部分，可以保留字形风格、装饰结构或可替换文字占位；不要保留渠道说明、商品说明或平台文案。',
    '输出形式：单张纯色背景素材板，优先白色背景；如果白色元素较多，可用浅灰或高对比纯色背景。当前层级素材完整清晰，边缘干净，不要输出完整成品构图。',
    '不要输出原始参考图的完整产品构图，不要复刻原图成品，不要生成最终成品设计，不要加入输入图中没有的新核心元素。',
  ].filter(Boolean).join('\n');
}

function buildHistoryLayoutExtractionPrompt(image: ImageToImageInputImage) {
  return [
    '请基于输入的历史设计图，生成一张用于后续图案设计的“空版式母版”。',
    '',
    `来源历史设计图：${image.filename}。`,
    '只保留：画布横竖比例、设计单元数量、圆形/方形/矩形版位外轮廓、相对位置、相对大小、版位间距、留白比例、尺寸标注关系和裁切/刀模结构。',
    '必须清空并禁止保留：历史图中的所有旧文字、旧主题、旧图案元素、人物/动物/植物/场景、节日符号、装饰细节、原有配色、旧边框花纹、旧底纹、图案主体和任何可识别内容。',
    '输出形式：纯白或浅灰背景上的干净版式线框/空白版位图；版位内部保持空白或极淡占位，不要填入任何新图案，不要生成最终设计。',
    '目标：让后续生图模型只能读取版式结构，不能复制历史设计图里的具体内容。',
  ].join('\n');
}

function materialImageSignature(images: ImageToImageInputImage[]) {
  return images.map((image) => `${image.id}|${image.url}|${image.score ?? ''}`).join('||');
}

function materialShapeLevelIndex(image: ImageToImageInputImage) {
  if (!image.materialShapeLevel) {
    return MATERIAL_SHAPE_LEVELS.length;
  }

  const index = MATERIAL_SHAPE_LEVELS.findIndex((level) => level.key === image.materialShapeLevel);
  return index >= 0 ? index : MATERIAL_SHAPE_LEVELS.length;
}

function finalMaterialSourceIndex(image: ImageToImageInputImage) {
  if (image.id.startsWith('split-design-reference-')) {
    return 0;
  }
  if (image.id.startsWith('refined-')) {
    return 1;
  }
  return 2;
}

function sortFinalMaterialImagesByCategory(images: ImageToImageInputImage[]) {
  return [...images].sort((first, second) => {
    const levelDifference = materialShapeLevelIndex(first) - materialShapeLevelIndex(second);
    if (levelDifference !== 0) {
      return levelDifference;
    }

    const sourceDifference = finalMaterialSourceIndex(first) - finalMaterialSourceIndex(second);
    if (sourceDifference !== 0) {
      return sourceDifference;
    }

    return first.id.localeCompare(second.id);
  });
}

function materialImagesForCategory(images: ImageToImageInputImage[], category: string) {
  const normalizedCategory = category.trim().toLocaleLowerCase();
  const scopedImages = images.filter((image) => (
    image.category?.trim().toLocaleLowerCase() === normalizedCategory
  ));
  if (scopedImages.length > 0) {
    return sortFinalMaterialImagesByCategory(scopedImages);
  }
  return sortFinalMaterialImagesByCategory(images.filter((image) => !image.category));
}

function ImageToImageInputPanel({
  result,
}: {
  result: ProposalAgentPrepareResponse;
}) {
  const projectRunId = useMemo(() => (
    `prun-${result.project_code}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  ), [result.project_code]);
  const generationRunFields = (
    generationStage: 'element_image' | 'final_design',
    generationSource: string,
    generationLabel: string,
  ) => ({
    project_run_id: projectRunId,
    generation_stage: generationStage,
    generation_source: generationSource,
    generation_label: generationLabel,
  });
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationResult, setGenerationResult] = useState<GeneratePatternImageResponse | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [lastGenerationInput, setLastGenerationInput] = useState<FinalGenerationInputSnapshot | null>(null);
  const [finalPromptResult, setFinalPromptResult] = useState<ComposeFinalPromptResponse | null>(null);
  const [finalPromptError, setFinalPromptError] = useState<string | null>(null);
  const [composingFinalPrompt, setComposingFinalPrompt] = useState(false);
  const [refiningMaterials, setRefiningMaterials] = useState(false);
  const [refinedMaterialImages, setRefinedMaterialImages] = useState<ImageToImageInputImage[]>([]);
  const [materialRefinementError, setMaterialRefinementError] = useState<string | null>(null);
  const [splittingDesignReferences, setSplittingDesignReferences] = useState(false);
  const [splitDesignReferenceMaterials, setSplitDesignReferenceMaterials] = useState<ImageToImageInputImage[]>([]);
  const [designReferenceSplitError, setDesignReferenceSplitError] = useState<string | null>(null);
  const [analyzingMaterialShapes, setAnalyzingMaterialShapes] = useState(false);
  const [materialShapeAnalysisResult, setMaterialShapeAnalysisResult] =
    useState<MaterialShapeAnalysisResponse | null>(null);
  const [materialShapeAnalysisError, setMaterialShapeAnalysisError] = useState<string | null>(null);
  const [analyzingDesignReferenceShapes, setAnalyzingDesignReferenceShapes] = useState(false);
  const [designReferenceShapeAnalysisResult, setDesignReferenceShapeAnalysisResult] =
    useState<MaterialShapeAnalysisResponse | null>(null);
  const [designReferenceShapeAnalysisError, setDesignReferenceShapeAnalysisError] = useState<string | null>(null);
  const [extractingHistoryLayout, setExtractingHistoryLayout] = useState(false);
  const [useHistoryLayoutExtraction, setUseHistoryLayoutExtraction] = useState(false);
  const [extractedHistoryLayoutImage, setExtractedHistoryLayoutImage] = useState<ImageToImageInputImage | null>(null);
  const [historyLayoutExtractionError, setHistoryLayoutExtractionError] = useState<string | null>(null);
  const [promptTemplateId, setPromptTemplateId] = useState<PromptTemplateId>('structured_ai');
  const [manualLayoutImage, setManualLayoutImage] = useState<ImageToImageInputImage | null>(null);
  const [missingHistoryDecision, setMissingHistoryDecision] =
    useState<'pending' | 'continue_without_layout' | 'materials_only'>('pending');
  const [agentFlowStatus, setAgentFlowStatus] =
    useState<'idle' | 'running' | 'blocked' | 'success' | 'materials_only' | 'error'>('idle');
  const [agentFlowSteps, setAgentFlowSteps] = useState<AgentFlowStep[]>(() => createAgentFlowSteps());
  const [agentFlowError, setAgentFlowError] = useState('');
  const autoFlowRunKeyRef = useRef('');
  const selectedPromptTemplate = promptTemplateBranchById(promptTemplateId);
  const materialImages = useMemo(() => collectGenerationMaterialImages(result), [result]);
  const materialSignature = useMemo(() => materialImageSignature(materialImages), [materialImages]);
  const designReferenceImages = useMemo(() => collectGenerationDesignReferenceImages(result), [result]);
  const designReferenceSourceLabel = generationReferenceSourceLabel(designReferenceImages);
  const designReferenceSignature = useMemo(
    () => materialImageSignature(designReferenceImages),
    [designReferenceImages],
  );
  const categoryTargets = useMemo(() => collectGenerationCategoryTargets(result), [result]);
  const historyImage = useMemo(() => categoryTargets[0]?.historyImage || chooseStableHistoryImage(result), [categoryTargets, result]);
  const historySignature = useMemo(
    () => materialImageSignature(historyImage ? [historyImage] : []),
    [historyImage],
  );
  const sourceHistoryImage = historyImage || manualLayoutImage;
  const finalHistoryImage = useHistoryLayoutExtraction
    ? extractedHistoryLayoutImage || sourceHistoryImage
    : sourceHistoryImage;
  const requiresHistoryLayoutExtraction = Boolean(
    useHistoryLayoutExtraction && sourceHistoryImage && !extractedHistoryLayoutImage,
  );
  const graphicElements = useMemo(() => collectGenerationGraphicElements(result), [result]);
  const textElements = useMemo(() => collectGenerationTextElements(result), [result]);
  const designRequirementDirectives = useMemo(
    () => collectGenerationDesignRequirementDirectives(result),
    [result],
  );
  const hasDesignRequirementDesignReferences = designReferenceImages.some(
    (image) => image.selectedByDesignRequirement,
  );
  const shouldUseDesignReferenceMaterials = designReferenceImages.length > 0;
  const combineFinalMaterialImages = (
    refinedImages: ImageToImageInputImage[],
    designReferenceMaterials: ImageToImageInputImage[],
  ) => sortFinalMaterialImagesByCategory([
    ...designReferenceMaterials,
    ...refinedImages,
  ]);
  const finalMaterialImages = combineFinalMaterialImages(refinedMaterialImages, splitDesignReferenceMaterials);
  const finalMaterialSignature = materialImageSignature(finalMaterialImages);
  const finalHistorySignature = materialImageSignature(finalHistoryImage ? [finalHistoryImage] : []);
  const requiresMaterialCleanup = materialImages.length > 0 && refinedMaterialImages.length === 0;
  const canSplitDesignReferences = shouldUseDesignReferenceMaterials;
  const canAnalyzeMaterialShapes = materialImages.length > 0;
  const canAnalyzeDesignReferenceShapes = canSplitDesignReferences;
  const requiresDesignReferenceSplit =
    shouldUseDesignReferenceMaterials && splitDesignReferenceMaterials.length === 0;
  const promptMaterialStatus = requiresMaterialCleanup
    ? requiresDesignReferenceSplit
      ? `素材图状态：当前已有渠道素材图但尚未 AI 处理，同时${designReferenceSourceLabel}尚未提取；原始渠道素材图和原始${designReferenceSourceLabel}都不会进入最终图生图输入。`
      : '素材图状态：当前已有渠道素材图，但尚未完成 AI 处理；原始渠道素材图不会进入最终提示词和最终图生图输入。最终生成前必须先点击“AI 处理素材图”，并使用“AI 处理后素材”作为素材图。'
    : requiresDesignReferenceSplit && finalMaterialImages.length > 0
      ? `素材图状态：当前已使用 AI 处理后图库素材，同时${designReferenceSourceLabel}尚未提取；点击“AI 生成图案”时会先自动提取${designReferenceSourceLabel}，并按一级形、二级形、三级形分类合并到最终素材输入。`
    : finalMaterialImages.length > 0
      ? splitDesignReferenceMaterials.length > 0 && refinedMaterialImages.length > 0
        ? `素材图状态：最终提示词和最终图生图输入同时使用 AI 处理后图库素材、${designReferenceSourceLabel} AI 提取素材；不使用任何原始渠道素材图或原始${designReferenceSourceLabel}。`
        : splitDesignReferenceMaterials.length > 0
          ? `素材图状态：最终提示词和最终图生图输入使用${designReferenceSourceLabel} AI 提取后的图案素材，不使用原始${designReferenceSourceLabel}。`
          : '素材图状态：最终提示词和最终图生图输入使用 AI 处理后素材，不使用原始渠道素材图。'
      : requiresDesignReferenceSplit
        ? hasDesignRequirementDesignReferences
          ? `素材图状态：开发思路指定的${designReferenceSourceLabel}尚未提取图案素材。点击“AI 生成图案”时会先自动提取指定${designReferenceSourceLabel}，并把提取后的图片作为素材图加入最终生成。`
          : `素材图状态：当前没有可用图库素材；${designReferenceSourceLabel}尚未提取图案素材。点击“AI 生成图案”时会先自动提取${designReferenceSourceLabel}，并把提取后的图片作为素材图加入最终生成。`
        : '';
  const promptHistoryLayoutStatus = historyImage
    ? useHistoryLayoutExtraction
      ? requiresHistoryLayoutExtraction
        ? '历史图状态：当前已启用 AI 空版式母版，但历史设计图尚未提取为空版式；点击“AI 生成图案”时会先自动清空历史图旧内容，只保留版式结构，再进入最终生成。'
        : extractedHistoryLayoutImage
          ? '历史图状态：最终图生图输入使用 AI 提取后的历史空版式母版，不使用带旧内容的原始历史设计图。'
          : ''
      : extractedHistoryLayoutImage
        ? '历史图状态：当前已关闭 AI 空版式母版；虽然页面已有 AI 提取后的历史空版式母版，但本次最终图生图输入使用原始历史设计图作为构图母版，仍只参考版式结构，禁止复用历史图旧内容。'
        : '历史图状态：当前已关闭 AI 空版式母版；最终图生图输入使用原始历史设计图作为构图母版，不会自动提取空版式，仍只参考版式结构，禁止复用历史图旧内容。'
    : '';
  const templatePrompt = useMemo(
    () => [
      buildImageToImagePrompt(result, finalMaterialImages, finalHistoryImage, promptTemplateId),
      promptHistoryLayoutStatus,
      promptMaterialStatus,
      promptTemplateId,
    ].filter(Boolean).join('\n'),
    [
      extractedHistoryLayoutImage,
      finalHistoryImage,
      finalMaterialImages,
      promptHistoryLayoutStatus,
      promptMaterialStatus,
      requiresDesignReferenceSplit,
      requiresHistoryLayoutExtraction,
      requiresMaterialCleanup,
      result,
      useHistoryLayoutExtraction,
    ],
  );
  const aiComposedFinalPrompt =
    finalPromptResult?.status === 'success' ? finalPromptResult.final_prompt : '';
  const prompt = aiComposedFinalPrompt || templatePrompt;
  const trueCategory =
    result.category_judgment?.predicted_category ||
    result.proposal.category_label ||
    result.proposal.category ||
    '暂无真实品类';
  const visibleCategoryTargets = categoryTargets.length > 0
    ? categoryTargets
    : [{
        category: trueCategory,
        confidence: result.category_judgment?.confidence || 0,
        reason: result.category_judgment?.reason || '',
        categoryImage: result.category_judgment?.category_image || null,
        historyImage,
      }];
  const categoryTargetSummary = visibleCategoryTargets.map((target) => target.category);
  const previewGenerationInput = useMemo<FinalGenerationInputSnapshot>(
    () => ({
      projectCode: result.project_code,
      category: trueCategory,
      categoryTargets: categoryTargetSummary,
      prompt,
      inputImages: buildFinalGenerationInputImages(finalHistoryImage, finalMaterialImages),
      createdAt: 'preview',
    }),
    [categoryTargetSummary, finalHistoryImage, finalMaterialImages, prompt, result.project_code, trueCategory],
  );
  const visibleGenerationInput = lastGenerationInput || previewGenerationInput;
  const generationInputMode = lastGenerationInput ? 'submitted' : 'preview';
  const generationInputNote = lastGenerationInput
    ? '这是最近一次点击 AI 生成图案时实际提交给后端生图接口的输入。'
    : !aiComposedFinalPrompt
      ? '当前预览中的提示词仍是模板草稿，不是真正最终提示词；点击“AI 编写最终提示词”后，这里会更新为 AI 输出的最终提示词。'
    : !useHistoryLayoutExtraction && historyImage && requiresDesignReferenceSplit
      ? '当前预览使用原始历史设计图作为构图母版，不会自动提取 AI 空版式；设计素材仍会在点击生成后先提取，并记录真正提交的输入。'
    : !useHistoryLayoutExtraction && historyImage
      ? '当前预览使用原始历史设计图作为构图母版，不会自动提取 AI 空版式。'
    : requiresHistoryLayoutExtraction && requiresDesignReferenceSplit
      ? '当前预览尚未包含 AI 提取后的历史空版式母版和设计素材；点击生成后会先完成两步提取，并记录真正提交的输入。'
      : requiresHistoryLayoutExtraction
        ? '当前预览尚未包含 AI 提取后的历史空版式母版；点击生成后会先清空历史图旧内容，并记录真正提交的输入。'
        : requiresDesignReferenceSplit
          ? '当前预览尚未包含 AI 提取后的设计素材；点击生成后会先提取素材，并记录真正提交的输入。'
      : '这是按当前页面状态计算的待提交输入预览。';
  const visibleMaterialCount =
    finalMaterialImages.length ||
    (requiresMaterialCleanup ? materialImages.length : 0) ||
    (requiresDesignReferenceSplit ? designReferenceImages.length : 0);
  useEffect(() => {
    setRefinedMaterialImages([]);
    setMaterialRefinementError(null);
    setMaterialShapeAnalysisResult(null);
    setMaterialShapeAnalysisError(null);
    setSplitDesignReferenceMaterials([]);
    setDesignReferenceSplitError(null);
    setDesignReferenceShapeAnalysisResult(null);
    setDesignReferenceShapeAnalysisError(null);
    setUseHistoryLayoutExtraction(false);
    setExtractedHistoryLayoutImage(null);
    setHistoryLayoutExtractionError(null);
    setLastGenerationInput(null);
    setPromptTemplateId('structured_ai');
    setFinalPromptResult(null);
    setFinalPromptError(null);
    setManualLayoutImage(null);
    setMissingHistoryDecision('pending');
    setAgentFlowStatus('idle');
    setAgentFlowSteps(createAgentFlowSteps());
    setAgentFlowError('');
    autoFlowRunKeyRef.current = '';
  }, [designReferenceSignature, historySignature, materialSignature, result.project_code]);

  useEffect(() => {
    setFinalPromptResult(null);
    setFinalPromptError(null);
    setLastGenerationInput(null);
  }, [
    extractedHistoryLayoutImage,
    finalHistorySignature,
    finalMaterialSignature,
    promptTemplateId,
    promptMaterialStatus,
    promptHistoryLayoutStatus,
  ]);

  async function handleCopyPrompt() {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function analyzeMaterialSourceShapes(force = false, categoryOverride = trueCategory) {
    if (materialImages.length === 0) {
      throw new Error('当前没有可分析的图库/渠道素材图。');
    }
    if (!force && categoryOverride === trueCategory && materialShapeAnalysisResult?.status === 'success') {
      return materialShapeAnalysisResult;
    }

    setAnalyzingMaterialShapes(true);
    setMaterialShapeAnalysisError(null);

    try {
      const response = await analyzeMaterialShapeLevels({
        source_kind: 'material',
        project_code: result.project_code,
        category: categoryOverride,
        graphic_elements: graphicElements,
        text_elements: textElements,
        input_images: materialExtractionInputImages(materialImages, 'material_shape_analysis_source'),
      });

      if (response.status !== 'success') {
        throw new Error(materialShapeAnalysisErrorMessage(response, 'AI 一二三级形判断失败。'));
      }

      setMaterialShapeAnalysisResult(response);
      return response;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'AI 一二三级形判断失败。';
      setMaterialShapeAnalysisError(message);
      throw new Error(message);
    } finally {
      setAnalyzingMaterialShapes(false);
    }
  }

  async function analyzeDesignReferenceShapes(force = false, categoryOverride = trueCategory) {
    if (designReferenceImages.length === 0) {
      throw new Error(`当前没有可分析的${designReferenceSourceLabel}。`);
    }
    if (!force && categoryOverride === trueCategory && designReferenceShapeAnalysisResult?.status === 'success') {
      return designReferenceShapeAnalysisResult;
    }

    setAnalyzingDesignReferenceShapes(true);
    setDesignReferenceShapeAnalysisError(null);

    try {
      const response = await analyzeMaterialShapeLevels({
        source_kind: 'design_reference',
        project_code: result.project_code,
        category: categoryOverride,
        graphic_elements: graphicElements,
        text_elements: textElements,
        input_images: materialExtractionInputImages(
          designReferenceImages,
          'design_reference_shape_analysis_source',
        ),
      });

      if (response.status !== 'success') {
        throw new Error(materialShapeAnalysisErrorMessage(response, 'AI 一二三级形判断失败。'));
      }

      setDesignReferenceShapeAnalysisResult(response);
      return response;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'AI 一二三级形判断失败。';
      setDesignReferenceShapeAnalysisError(message);
      throw new Error(message);
    } finally {
      setAnalyzingDesignReferenceShapes(false);
    }
  }

  async function handleAnalyzeMaterialSourceShapes() {
    try {
      await analyzeMaterialSourceShapes(true);
      setLastGenerationInput(null);
    } catch (_caught) {
      // Visible error state is set by analyzeMaterialSourceShapes.
    }
  }

  async function handleAnalyzeDesignReferenceShapes() {
    try {
      await analyzeDesignReferenceShapes(true);
      setLastGenerationInput(null);
    } catch (_caught) {
      // Visible error state is set by analyzeDesignReferenceShapes.
    }
  }

  async function reverseAndRegenerateDesignReferenceMaterial({
    sourceImage,
    sourceLabel,
    sourceNames,
    shapeAnalysis,
    outputId,
    outputFilename,
    outputLabel,
    outputDetail,
    fallbackNote,
    category,
    materialKind,
    generationSource,
  }: {
    sourceImage: ImageToImageInputImage;
    sourceLabel: string;
    sourceNames: string;
    shapeAnalysis: MaterialShapeAnalysisResponse | null;
    outputId: string;
    outputFilename: string;
    outputLabel: string;
    outputDetail: string;
    fallbackNote: string;
    category?: string;
    materialKind: string;
    generationSource: string;
  }) {
    const targetCategory = category || trueCategory;
    const reverseResponse = await composeFinalPrompt({
      template_prompt: buildMaterialBoardReversePrompt(
        sourceLabel,
        sourceNames,
        shapeAnalysis,
        materialKind,
      ),
      prompt_template_id: MATERIAL_BOARD_REVERSE_PROMPT_TEMPLATE_ID,
      project_code: result.project_code,
      category: targetCategory,
      input_images: materialExtractionInputImages([sourceImage], 'material_board_reverse_source'),
    });

    if (reverseResponse.status !== 'success' || !reverseResponse.final_prompt) {
      throw new Error(reverseResponse.ai_error?.message || `AI ${materialKind}提示词反推失败。`);
    }

    const reverseDescription = reverseResponse.final_prompt;
    const regenerationResponse = await generatePatternImage({
      prompt: buildMaterialBoardRegenerationPrompt(
        reverseDescription,
        sourceLabel,
        sourceNames,
        materialKind,
      ),
      project_code: result.project_code,
      category: targetCategory,
      ...generationRunFields('element_image', generationSource, outputLabel),
      request_mode: 'images',
      input_images: [],
    });

    if (regenerationResponse.status !== 'success' || regenerationResponse.images.length === 0) {
      throw new Error(regenerationResponse.ai_error?.message || imageGenerationStatusHint(regenerationResponse));
    }

    const regeneratedUrl = generatedImageUrl(regenerationResponse.images[0]);
    if (!regeneratedUrl) {
      throw new Error(`AI ${materialKind}反推重生成没有返回可用图片。`);
    }

    return {
      ...sourceImage,
      id: outputId,
      url: regeneratedUrl,
      filename: outputFilename,
      label: outputLabel,
      detail: `${outputDetail}；已对统一素材板做提示词反推并重生成，再作为最终素材图使用。反推摘要：${shortLabel(reverseDescription.replace(/\s+/g, ' '), 260)}`,
      note: regenerationResponse.images[0].revised_prompt || fallbackNote,
    };
  }

  async function handleRefineMaterialImages(
    throwOnError = false,
    categoryOverride = trueCategory,
    updateVisibleState = true,
    forceShapeAnalysis = false,
  ): Promise<ImageToImageInputImage[]> {
    if (materialImages.length === 0) {
      return [];
    }

    setRefiningMaterials(true);
    setMaterialRefinementError(null);
    if (updateVisibleState) {
      setRefinedMaterialImages([]);
    }

    try {
      const shapeAnalysis = await analyzeMaterialSourceShapes(forceShapeAnalysis, categoryOverride);
      if (!materialShapeAnalysisRequiresSplit(shapeAnalysis)) {
        const response = await generatePatternImage({
          prompt: [
            `目标真实品类：${categoryOverride}。本轮素材板只服务于该品类的完整设计任务。`,
            buildUnifiedMaterialBoardPrompt(
              materialImages,
              graphicElements,
              textElements,
              shapeAnalysis,
              '图库/渠道素材图',
            ),
          ].join('\n'),
          project_code: result.project_code,
          category: categoryOverride,
          ...generationRunFields(
            'element_image',
            'gallery_material_unified_cleanup',
            `${categoryOverride} · Unified material image`,
          ),
          input_images: materialExtractionInputImages(materialImages, 'material_cleanup'),
        });

        if (response.status !== 'success' || response.images.length === 0) {
          throw new Error(response.ai_error?.message || imageGenerationStatusHint(response));
        }

        const cleanedUrl = generatedImageUrl(response.images[0]);
        if (!cleanedUrl) {
          throw new Error('AI 素材处理没有返回可用图片。');
        }

        const sourceNames = materialImages.map((image) => image.filename).join('、');
        const unifiedImage: ImageToImageInputImage = {
          ...materialImages[0],
          id: `refined-unified-source-${result.project_code}-${categoryOverride}`,
          url: cleanedUrl,
          filename: `AI处理素材-${categoryOverride}-统一素材板-${result.project_code}.png`,
          label: `AI处理素材-${categoryOverride}-统一素材板`,
          detail: `${categoryOverride}品类统一素材板；AI 判断不需要拆分一级形/二级形/三级形，仅清理标注和载体信息；来源：${sourceNames}；判断：${materialShapeAnalysisSummary(shapeAnalysis)}；内部图库素材不做提示词反推文生图，直接作为该品类最终素材图使用。`,
          note: response.images[0].revised_prompt || '最终生成将直接使用这张统一清理后的内部素材板。',
          category: categoryOverride,
        };
        const nextRefinedImages = [unifiedImage];
        if (updateVisibleState) {
          setRefinedMaterialImages(nextRefinedImages);
        }
        return nextRefinedImages;
      }

      const refinedImages: ImageToImageInputImage[] = [];
      for (const [levelIndex, shapeLevel] of MATERIAL_SHAPE_LEVELS.entries()) {
        const response = await generatePatternImage({
          prompt: [
            `目标真实品类：${categoryOverride}。本轮${shapeLevel.label}素材只服务于该品类的完整设计任务。`,
            buildMaterialRefinementPrompt(
              materialImages,
              graphicElements,
              textElements,
              shapeLevel,
              shapeAnalysis,
            ),
          ].join('\n'),
          project_code: result.project_code,
          category: categoryOverride,
          ...generationRunFields(
            'element_image',
            'gallery_material_split_cleanup',
            `${categoryOverride} · ${shapeLevel.label}`,
          ),
          input_images: materialExtractionInputImages(materialImages, 'material_cleanup'),
        });

        if (response.status !== 'success' || response.images.length === 0) {
          throw new Error(response.ai_error?.message || imageGenerationStatusHint(response));
        }

        const cleanedUrl = generatedImageUrl(response.images[0]);
        if (!cleanedUrl) {
          throw new Error('AI 素材处理没有返回可用图片。');
        }

        const sourceNames = materialImages.map((image) => image.filename).join('、');
        refinedImages.push({
          ...materialImages[0],
          id: `refined-${shapeLevel.key}-${result.project_code}-${categoryOverride}-${levelIndex}`,
          url: cleanedUrl,
          filename: `AI处理素材-${categoryOverride}-${shapeLevel.label}-${result.project_code}.png`,
          label: `AI处理素材-${categoryOverride}-${shapeLevel.label}`,
          detail: `${categoryOverride}品类${shapeLevel.label}分层素材；AI 已先判断一二三级形并去除载体、标注和渠道信息；来源：${sourceNames}；判断：${materialShapeAnalysisSummary(shapeAnalysis)}；只作为该品类最终素材图使用。`,
          note: response.images[0].revised_prompt || '最终生成将优先使用这张处理后的素材图。',
          materialShapeLevel: shapeLevel.key,
          category: categoryOverride,
        });
      }

      if (updateVisibleState) {
        setRefinedMaterialImages(refinedImages);
      }
      return refinedImages;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'AI 素材处理失败。';
      setMaterialRefinementError(message);
      if (throwOnError) {
        throw new Error(message);
      }
      return [];
    } finally {
      setRefiningMaterials(false);
    }
  }

  async function splitDesignReferenceImages(
    categoryOverride = trueCategory,
    updateVisibleState = true,
    forceShapeAnalysis = false,
  ) {
    if (!canSplitDesignReferences) {
      return [];
    }

    setSplittingDesignReferences(true);
    setDesignReferenceSplitError(null);

    try {
      const shapeAnalysis = await analyzeDesignReferenceShapes(forceShapeAnalysis, categoryOverride);
      if (!materialShapeAnalysisRequiresSplit(shapeAnalysis)) {
        const referenceSourceLabel = generationReferenceSourceLabel(designReferenceImages);
        const response = await generatePatternImage({
          prompt: [
            `目标真实品类：${categoryOverride}。本轮素材板只服务于该品类的完整设计任务。`,
            buildUnifiedMaterialBoardPrompt(
              designReferenceImages,
              graphicElements,
              textElements,
              shapeAnalysis,
              referenceSourceLabel,
            ),
          ].join('\n'),
          project_code: result.project_code,
          category: categoryOverride,
          ...generationRunFields(
            'element_image',
            'company_design_reference_unified_split',
            `${categoryOverride} · Unified design reference material`,
          ),
          input_images: materialExtractionInputImages(
            designReferenceImages,
            'design_reference_material_source',
          ),
        });

        if (response.status !== 'success' || response.images.length === 0) {
          throw new Error(response.ai_error?.message || imageGenerationStatusHint(response));
        }

        const splitUrl = generatedImageUrl(response.images[0]);
        if (!splitUrl) {
          throw new Error('AI 设计参考图素材提取没有返回可用图片。');
        }

        const sourceNames = designReferenceImages.map((image) => image.filename).join('、');
        const unifiedImage: ImageToImageInputImage = {
          ...designReferenceImages[0],
          id: `split-design-reference-unified-source-${result.project_code}-${categoryOverride}`,
          url: splitUrl,
          filename: `AI提取素材-${categoryOverride}-统一素材板-${result.project_code}.png`,
          label: `AI提取素材-${categoryOverride}-统一素材板`,
          detail: `${categoryOverride}品类统一素材板；AI 判断不需要拆分一级形/二级形/三级形，并从${referenceSourceLabel}提取可用图案素材；来源：${sourceNames}；判断：${materialShapeAnalysisSummary(shapeAnalysis)}。只作为该品类最终素材图使用。`,
          note: response.images[0].revised_prompt || `最终生成会使用这张统一清理后的素材板，不使用原始${referenceSourceLabel}。`,
          category: categoryOverride,
        };
        const regeneratedUnifiedImage = await reverseAndRegenerateDesignReferenceMaterial({
          sourceImage: unifiedImage,
          sourceLabel: `${referenceSourceLabel}统一素材板`,
          sourceNames,
          shapeAnalysis,
          outputId: `split-design-reference-unified-regenerated-${result.project_code}-${categoryOverride}`,
          outputFilename: `AI提取素材-${categoryOverride}-反推重生成统一素材板-${result.project_code}.png`,
          outputLabel: `${categoryOverride} · AI提取素材-反推统一素材板`,
          outputDetail: `${categoryOverride}品类统一素材板；AI 判断不需要拆分一级形/二级形/三级形，已从${referenceSourceLabel}提取可用素材并完成提示词反推重生成；来源：${sourceNames}；判断：${materialShapeAnalysisSummary(shapeAnalysis)}。只作为该品类最终素材图使用。`,
          fallbackNote: `最终生成会使用这张反推重生成后的统一素材板，不使用原始${referenceSourceLabel}。`,
          category: categoryOverride,
          materialKind: '统一素材板',
          generationSource: 'design_reference_unified_regeneration',
        });
        regeneratedUnifiedImage.category = categoryOverride;
        if (updateVisibleState) {
          setSplitDesignReferenceMaterials([regeneratedUnifiedImage]);
        }
        return [regeneratedUnifiedImage];
      }

      const splitImages: ImageToImageInputImage[] = [];
      for (const [levelIndex, shapeLevel] of MATERIAL_SHAPE_LEVELS.entries()) {
        const referenceSourceLabel = generationReferenceSourceLabel(designReferenceImages);
        const response = await generatePatternImage({
          prompt: [
            `目标真实品类：${categoryOverride}。本轮${shapeLevel.label}素材只服务于该品类的完整设计任务。`,
            buildDesignReferenceMaterialSplitPrompt(
              designReferenceImages,
              graphicElements,
              textElements,
              shapeLevel,
              shapeAnalysis,
            ),
          ].join('\n'),
          project_code: result.project_code,
          category: categoryOverride,
          ...generationRunFields(
            'element_image',
            'company_design_reference_split',
            `${categoryOverride} · ${shapeLevel.label}`,
          ),
          input_images: materialExtractionInputImages(
            designReferenceImages,
            'design_reference_material_source',
          ),
        });

        if (response.status !== 'success' || response.images.length === 0) {
          throw new Error(response.ai_error?.message || imageGenerationStatusHint(response));
        }

        const splitUrl = generatedImageUrl(response.images[0]);
        if (!splitUrl) {
          throw new Error('AI 设计参考图素材提取没有返回可用图片。');
        }

        const sourceNames = designReferenceImages.map((image) => image.filename).join('、');
        const extractedLayerImage: ImageToImageInputImage = {
          ...designReferenceImages[0],
          id: `split-design-reference-${shapeLevel.key}-${result.project_code}-${categoryOverride}-${levelIndex}`,
          url: splitUrl,
          filename: `AI提取素材-${categoryOverride}-${shapeLevel.label}-${result.project_code}.png`,
          label: `AI提取素材-${categoryOverride}-${shapeLevel.label}`,
          detail: `${categoryOverride}品类${shapeLevel.label}分层素材；AI 已先判断一二三级形，并从${referenceSourceLabel}提取可用图案素材；来源：${sourceNames}；判断：${materialShapeAnalysisSummary(shapeAnalysis)}。只作为该品类最终素材图使用。`,
          note: response.images[0].revised_prompt || `最终生成会使用这张提取后的素材图，不使用原始${referenceSourceLabel}。`,
          materialShapeLevel: shapeLevel.key,
          category: categoryOverride,
        };
        const regeneratedLayerImage = await reverseAndRegenerateDesignReferenceMaterial({
          sourceImage: extractedLayerImage,
          sourceLabel: `${referenceSourceLabel}${shapeLevel.label}`,
          sourceNames,
          shapeAnalysis,
          outputId: `split-design-reference-regenerated-${shapeLevel.key}-${result.project_code}-${categoryOverride}-${levelIndex}`,
          outputFilename: `AI提取素材-${categoryOverride}-反推重生成-${shapeLevel.label}-${result.project_code}.png`,
          outputLabel: `${categoryOverride} · AI提取素材-反推${shapeLevel.label}`,
          outputDetail: `${categoryOverride}品类${shapeLevel.label}分层素材；已从${referenceSourceLabel}提取素材、逐张反推视觉描述并使用纯文本重新生成；来源：${sourceNames}；判断：${materialShapeAnalysisSummary(shapeAnalysis)}。最终只使用反推重生成图片。`,
          fallbackNote: `最终生成会使用这张反推重生成后的${shapeLevel.label}素材图，不使用原始${referenceSourceLabel}或第一次提取图。`,
          category: categoryOverride,
          materialKind: `${shapeLevel.label}素材图`,
          generationSource: 'design_reference_split_regeneration',
        });
        regeneratedLayerImage.materialShapeLevel = shapeLevel.key;
        regeneratedLayerImage.category = categoryOverride;
        splitImages.push(regeneratedLayerImage);
      }

      const nextSplitImages = splitImages;
      if (updateVisibleState) {
        setSplitDesignReferenceMaterials(nextSplitImages);
      }
      return nextSplitImages;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'AI 设计参考图素材提取失败。';
      setDesignReferenceSplitError(message);
      throw new Error(message);
    } finally {
      setSplittingDesignReferences(false);
    }
  }

  async function handleSplitDesignReferenceImages() {
    try {
      await splitDesignReferenceImages();
    } catch (_caught) {
      // The visible error state is set by the design reference extraction step.
    }
  }

  async function extractHistoryLayoutImage(
    historySourceOverride: ImageToImageInputImage | null = sourceHistoryImage,
    categoryOverride = trueCategory,
    updateVisibleState = true,
    force = false,
  ) {
    if (!historySourceOverride) {
      return null;
    }
    const canReuseVisibleLayout = Boolean(
      !force &&
      extractedHistoryLayoutImage &&
      extractedHistoryLayoutImage.category === categoryOverride &&
      extractedHistoryLayoutImage.id === `layout-only-${historySourceOverride.id}-${categoryOverride}`,
    );
    if (canReuseVisibleLayout) {
      return extractedHistoryLayoutImage;
    }

    setExtractingHistoryLayout(true);
    setHistoryLayoutExtractionError(null);

    try {
      const response = await generatePatternImage({
        prompt: buildHistoryLayoutExtractionPrompt(historySourceOverride),
        project_code: result.project_code,
        category: categoryOverride,
        ...generationRunFields(
          'element_image',
          'history_layout_extraction',
          `${categoryOverride} · AI 空版式母版`,
        ),
        input_images: [
          {
            id: historySourceOverride.id,
            role: 'history_layout_source',
            label: historySourceOverride.label,
            filename: historySourceOverride.filename,
            url: historySourceOverride.url,
            detail: historySourceOverride.detail,
          },
        ],
      });

      if (response.status !== 'success' || response.images.length === 0) {
        throw new Error(response.ai_error?.message || imageGenerationStatusHint(response));
      }

      const layoutUrl = generatedImageUrl(response.images[0]);
      if (!layoutUrl) {
        throw new Error('AI 历史空版式提取没有返回可用图片。');
      }

      const nextHistoryLayoutImage: ImageToImageInputImage = {
        ...historySourceOverride,
        id: `layout-only-${historySourceOverride.id}-${categoryOverride}`,
        url: layoutUrl,
        filename: `AI空版式母版-${categoryOverride}-${historySourceOverride.filename}`,
        label: `AI历史空版式母版-${categoryOverride}`,
        detail: `AI 已为${categoryOverride}品类清空历史设计图旧文字、旧图案、旧主题和旧配色；来源：${historySourceOverride.filename}。只保留版式结构作为该品类最终构图母版。`,
        note: response.images[0].revised_prompt || '最终生成会使用这张空版式母版，不使用带旧内容的原始历史设计图。',
        category: categoryOverride,
      };

      if (updateVisibleState) {
        setExtractedHistoryLayoutImage(nextHistoryLayoutImage);
      }
      return nextHistoryLayoutImage;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'AI 历史空版式提取失败。';
      setHistoryLayoutExtractionError(message);
      throw new Error(message);
    } finally {
      setExtractingHistoryLayout(false);
    }
  }

  async function handleExtractHistoryLayoutImage() {
    try {
      await extractHistoryLayoutImage();
    } catch (_caught) {
      // The visible error state is set by extractHistoryLayoutImage.
    }
  }

  function updateAgentFlowStep(
    stepId: AgentFlowStepId,
    status: AgentFlowStepStatus,
    message = '',
    attempts?: number,
  ) {
    setAgentFlowSteps((currentSteps) => currentSteps.map((step) => (
      step.id === stepId
        ? {
            ...step,
            status,
            message,
            attempts: attempts ?? step.attempts,
          }
        : step
    )));
  }

  async function runAgentStep<T>(
    stepId: AgentFlowStepId,
    skippedMessage: string,
    action: () => Promise<T>,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= AGENT_FLOW_MAX_RETRIES; attempt += 1) {
      updateAgentFlowStep(stepId, 'running', `第 ${attempt} 次尝试`, attempt);
      try {
        const value = await action();
        updateAgentFlowStep(stepId, 'success', '完成', attempt);
        return value;
      } catch (caught) {
        lastError = caught instanceof Error ? caught : new Error(String(caught));
        updateAgentFlowStep(stepId, 'running', lastError.message, attempt);
      }
    }

    updateAgentFlowStep(
      stepId,
      'error',
      lastError?.message || `${skippedMessage}失败。`,
      AGENT_FLOW_MAX_RETRIES,
    );
    throw lastError || new Error(`${skippedMessage}失败。`);
  }

  function skipAgentStep(stepId: AgentFlowStepId, message: string) {
    updateAgentFlowStep(stepId, 'skipped', message, 0);
  }

  async function handleManualLayoutUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      setHistoryLayoutExtractionError('空版式母版只能上传图片文件。');
      return;
    }

    try {
      const preparedImage = await prepareCategoryImageUpload(file);
      const nextManualLayoutImage: ImageToImageInputImage = {
        id: `manual-layout-${result.project_code}-${Date.now()}`,
        label: '手动空版式母版',
        filename: `手动空版式母版-${preparedImage.filename}`,
        url: preparedImage.imageData,
        detail: `用户上传空版式母版；${preparedImage.layoutLabel}，已等比补边，不拉伸图片。`,
      };
      setManualLayoutImage(nextManualLayoutImage);
      setMissingHistoryDecision('continue_without_layout');
      setHistoryLayoutExtractionError(null);
      setLastGenerationInput(null);
      void runAutomatedAgentFlow({
        manualHistoryImage: nextManualLayoutImage,
        continueWithoutHistory: false,
      });
    } catch (caught) {
      setHistoryLayoutExtractionError(caught instanceof Error ? caught.message : '空版式母版读取失败。');
    }
  }

  function buildFinalGenerationTemplatePrompt(
    materials: ImageToImageInputImage[],
    generationHistoryImage: ImageToImageInputImage | null,
    categoryForPrompt = trueCategory,
  ) {
    const usesRefinedGalleryMaterial = materials.some((image) => image.id.startsWith('refined-'));
    const usesDesignReferenceMaterial = materials.some((image) => image.id.startsWith('split-design-reference-'));
    const materialReferenceSourceLabel = generationReferenceSourceLabel(
      materials.filter((image) => image.id.startsWith('split-design-reference-')),
    );
    const finalMaterialStatus = usesRefinedGalleryMaterial && usesDesignReferenceMaterial
      ? `素材图状态：本次最终图生图输入同时使用 AI 处理后图库素材、${materialReferenceSourceLabel} AI 提取素材；不要把原始渠道素材图或原始${materialReferenceSourceLabel}作为输入图。`
      : usesDesignReferenceMaterial
        ? `素材图状态：本次最终图生图输入使用${materialReferenceSourceLabel} AI 提取后的图案素材图；不要把原始${materialReferenceSourceLabel}作为输入图或完整构图参考。`
        : usesRefinedGalleryMaterial
          ? '素材图状态：本次最终图生图输入使用 AI 处理后素材图；不要把原始渠道素材图作为输入图。'
          : '';

    return [
      buildImageToImagePrompt(result, materials, generationHistoryImage, promptTemplateId, categoryForPrompt),
      generationHistoryImage && generationHistoryImage.id.startsWith('layout-only-')
        ? '历史图状态：本次最终图生图输入使用 AI 提取后的历史空版式母版；禁止复用原始历史设计图中的任何旧文字、旧图案、旧主题、旧角色、旧场景、旧边框花纹、旧底纹和旧配色。'
        : generationHistoryImage
          ? '历史图状态：当前使用原始历史图作为构图母版；仍必须只参考版式结构，禁止复用历史图旧内容。'
          : '',
      finalMaterialStatus,
    ].filter(Boolean).join('\n');
  }

  async function composeTrueFinalPrompt(
    materials: ImageToImageInputImage[],
    generationHistoryImage: ImageToImageInputImage | null,
    templatePromptForGeneration: string,
    categoryForPrompt = trueCategory,
  ) {
    const inputImages = buildFinalGenerationInputImages(generationHistoryImage, materials);
    if (inputImages.length === 0) {
      throw new Error('AI 最终提示词编写需要历史设计图或素材图作为输入。');
    }

    setComposingFinalPrompt(true);
    setFinalPromptError(null);

    try {
      const response = await composeFinalPrompt({
        template_prompt: templatePromptForGeneration,
        prompt_template_id: promptTemplateId,
        project_code: result.project_code,
        category: categoryForPrompt,
        input_images: inputImages,
      });

      if (response.status !== 'success' || !response.final_prompt) {
        throw new Error(response.ai_error?.message || `AI 最终提示词编写失败：${response.status}`);
      }

      setFinalPromptResult(response);
      return response;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'AI 最终提示词编写失败。';
      setFinalPromptError(message);
      throw new Error(message);
    } finally {
      setComposingFinalPrompt(false);
    }
  }

  function finalCategoryTargetsForGeneration(
    primaryHistoryImage: ImageToImageInputImage | null,
  ): CategoryGenerationTarget[] {
    const primaryCategory = visibleCategoryTargets[0]?.category || trueCategory;
    return visibleCategoryTargets.map((target, index) => ({
      ...target,
      historyImage: index === 0 || target.category === primaryCategory
        ? primaryHistoryImage || target.historyImage
        : target.historyImage,
    }));
  }

  async function prepareFinalPromptInputs(overrides: {
    refinedMaterialImages?: ImageToImageInputImage[];
    designReferenceMaterials?: ImageToImageInputImage[];
    historyImage?: ImageToImageInputImage | null;
  } = {}) {
    const generationHistoryImage = requiresHistoryLayoutExtraction
      ? await extractHistoryLayoutImage()
      : overrides.historyImage !== undefined
        ? overrides.historyImage
        : finalHistoryImage;
    const generationDesignReferenceMaterials = overrides.designReferenceMaterials !== undefined
      ? overrides.designReferenceMaterials
      : requiresDesignReferenceSplit
      ? await splitDesignReferenceImages()
      : splitDesignReferenceMaterials;
    const generationRefinedMaterialImages = overrides.refinedMaterialImages !== undefined
      ? overrides.refinedMaterialImages
      : refinedMaterialImages;
    const generationMaterialImages = combineFinalMaterialImages(
      generationRefinedMaterialImages,
      generationDesignReferenceMaterials,
    );
    const generationTemplatePrompt = buildFinalGenerationTemplatePrompt(
      generationMaterialImages,
      generationHistoryImage,
    );
    const generationCategoryTargets = finalCategoryTargetsForGeneration(generationHistoryImage);

    return {
      generationHistoryImage,
      generationCategoryTargets,
      generationMaterialImages,
      generationTemplatePrompt,
      inputImages: buildFinalGenerationInputImages(generationHistoryImage, generationMaterialImages),
    };
  }

  async function runAutomatedAgentFlow(options: {
    continueWithoutHistory?: boolean;
    materialsOnly?: boolean;
    manualHistoryImage?: ImageToImageInputImage | null;
  } = {}) {
    setAgentFlowStatus('running');
    setAgentFlowError('');
    setGenerationError(null);
    setGenerationResult(null);
    setGenerating(true);
    setAgentFlowSteps(createAgentFlowSteps());

    try {
      const primaryHistoryImage = options.manualHistoryImage || sourceHistoryImage;
      const generationCategoryTargets = finalCategoryTargetsForGeneration(primaryHistoryImage || null);
      const categoryMaterialGroups: Array<{
        target: CategoryGenerationTarget;
        materials: ImageToImageInputImage[];
      }> = [];
      const allRefinedImages: ImageToImageInputImage[] = [];
      const allDesignReferenceMaterials: ImageToImageInputImage[] = [];

      for (const target of generationCategoryTargets) {
        const nextRefinedImages = materialImages.length > 0
          ? await runAgentStep(
            'material',
            `${target.category} 素材图处理`,
            () => handleRefineMaterialImages(true, target.category, false, true),
          )
          : [];
        const nextDesignReferenceMaterials = canSplitDesignReferences
          ? await runAgentStep(
            'reference',
            `${target.category} 设计参考图素材提取`,
            () => splitDesignReferenceImages(target.category, false, true),
          )
          : [];
        const generationMaterialImages = combineFinalMaterialImages(
          nextRefinedImages,
          nextDesignReferenceMaterials,
        );

        if (generationMaterialImages.length === 0) {
          updateAgentFlowStep('material', 'blocked', `${target.category} 没有可输出的素材图，流程无法继续。`);
          setAgentFlowStatus('blocked');
          setAgentFlowError(
            `${target.category} 没有可用素材图：图库素材和设计参考图都没有形成最终素材。`,
          );
          return;
        }

        allRefinedImages.push(...nextRefinedImages);
        allDesignReferenceMaterials.push(...nextDesignReferenceMaterials);
        categoryMaterialGroups.push({ target, materials: generationMaterialImages });
      }

      setRefinedMaterialImages(allRefinedImages);
      setSplitDesignReferenceMaterials(allDesignReferenceMaterials);
      if (materialImages.length === 0) {
        skipAgentStep('material', '没有命中的内部图库素材。');
      } else {
        updateAgentFlowStep(
          'material',
          'success',
          `已按 ${generationCategoryTargets.length} 个品类分别完成图库素材处理。`,
        );
      }
      if (!canSplitDesignReferences) {
        skipAgentStep('reference', '没有需要进入素材池的设计参考图。');
      } else {
        updateAgentFlowStep(
          'reference',
          'success',
          `已按 ${generationCategoryTargets.length} 个品类分别完成设计参考图素材提取。`,
        );
      }

      if (options.materialsOnly) {
        updateAgentFlowStep('layout', 'skipped', '用户选择只输出素材图。');
        skipAgentStep('prompt', '只输出素材图，不生成最终提示词。');
        skipAgentStep('generate', '只输出素材图，不生成最终图案。');
        setAgentFlowStatus('materials_only');
        setAgentFlowError('');
        return;
      }

      const missingHistoryTargets = generationCategoryTargets.filter((target) => !target.historyImage);
      if (missingHistoryTargets.length > 0 && !options.continueWithoutHistory) {
        updateAgentFlowStep(
          'layout',
          'blocked',
          `以下品类没有对应历史设计图：${missingHistoryTargets.map((target) => target.category).join('、')}。需要补充空版式母版，或选择只输出素材图/无版式继续。`,
        );
        skipAgentStep('prompt', '等待版式母版确认。');
        skipAgentStep('generate', '等待版式母版确认。');
        setAgentFlowStatus('blocked');
        setAgentFlowError(
          `缺少历史设计图：请上传空版式母版，或选择只输出素材图。缺少品类：${missingHistoryTargets.map((target) => target.category).join('、')}。`,
        );
        return;
      }

      if (useHistoryLayoutExtraction) {
        let firstExtractedHistoryImage: ImageToImageInputImage | null = null;
        for (const group of categoryMaterialGroups) {
          if (!group.target.historyImage) {
            continue;
          }
          const extractedLayout = await runAgentStep(
            'layout',
            `${group.target.category} AI 空版式母版提取`,
            () => extractHistoryLayoutImage(
              group.target.historyImage,
              group.target.category,
              false,
              group.target.category !== trueCategory,
            ),
          );
          group.target = {
            ...group.target,
            historyImage: extractedLayout,
          };
          firstExtractedHistoryImage ||= extractedLayout;
        }
        if (firstExtractedHistoryImage) {
          setExtractedHistoryLayoutImage(firstExtractedHistoryImage);
        }
      }

      if (generationCategoryTargets.some((target) => target.historyImage)) {
        updateAgentFlowStep(
          'layout',
          'success',
          generationCategoryTargets.length > 1
            ? `已匹配 ${generationCategoryTargets.filter((target) => target.historyImage).length}/${generationCategoryTargets.length} 个品类历史设计图。`
            : primaryHistoryImage?.id.startsWith('manual-layout-')
              ? '已使用手动上传空版式母版。'
              : '已使用品类历史设计图。',
          1,
        );
      } else {
        updateAgentFlowStep('layout', 'skipped', '用户选择无版式继续生成。', 0);
      }

      const composedRequests: Array<{
        target: CategoryGenerationTarget;
        finalPromptResponse: ComposeFinalPromptResponse;
        inputImages: GeneratePatternImageInputImage[];
      }> = [];
      const generationResponses: Array<{
        target: CategoryGenerationTarget;
        response: GeneratePatternImageResponse;
      }> = [];

      for (const group of categoryMaterialGroups) {
        const targetHistoryImage = group.target.historyImage || null;
        const generationTemplatePrompt = buildFinalGenerationTemplatePrompt(
          group.materials,
          targetHistoryImage,
          group.target.category,
        );
        const finalPromptResponse = await runAgentStep(
          'prompt',
          `${group.target.category} 最终提示词编写`,
          () => composeTrueFinalPrompt(
            group.materials,
            targetHistoryImage,
            generationTemplatePrompt,
            group.target.category,
          ),
        );
        const inputImages = buildFinalGenerationInputImages(targetHistoryImage, group.materials);
        composedRequests.push({
          target: group.target,
          finalPromptResponse,
          inputImages,
        });

        const generationResponse = await runAgentStep(
          'generate',
          `${group.target.category} 最终图生图`,
          async () => {
            const response = await generatePatternImage({
              prompt: finalPromptResponse.final_prompt,
              project_code: result.project_code,
              category: group.target.category,
              ...generationRunFields(
                'final_design',
                'automated_flow_final_generation',
                `Final generated design - ${group.target.category}`,
              ),
              history_layout_lock_policy: finalPromptResponse.history_layout_lock_policy,
              history_layout_lock_reason: finalPromptResponse.history_layout_lock_reason,
              input_images: inputImages,
            });
            if (response.status !== 'success') {
              throw new Error(response.ai_error?.message || imageGenerationStatusHint(response));
            }
            return response;
          },
        );
        generationResponses.push({ target: group.target, response: generationResponse });
      }

      updateAgentFlowStep(
        'prompt',
        'success',
        `已按 ${composedRequests.length} 个品类分别完成最终提示词。`,
      );
      updateAgentFlowStep(
        'generate',
        'success',
        `已按 ${generationResponses.length} 个品类分别完成最终生图。`,
      );
      const submittedRequests = composedRequests.map((item) => ({
        category: item.target.category,
        prompt: item.finalPromptResponse.final_prompt,
        inputImages: item.inputImages,
        historyLayoutLockPolicy: item.finalPromptResponse.history_layout_lock_policy,
        historyLayoutLockReason: item.finalPromptResponse.history_layout_lock_reason,
      }));
      setLastGenerationInput({
        projectCode: result.project_code,
        category: submittedRequests.map((item) => item.category).join(' / ') || trueCategory,
        categoryTargets: submittedRequests.map((item) => item.category),
        prompt: submittedRequests
          .map((item) => `【${item.category}】\n${item.prompt}`)
          .join('\n\n---\n\n'),
        inputImages: submittedRequests.flatMap((item) => item.inputImages),
        requests: submittedRequests,
        historyLayoutLockPolicy: submittedRequests[0]?.historyLayoutLockPolicy,
        historyLayoutLockReason: submittedRequests[0]?.historyLayoutLockReason,
        createdAt: new Date().toISOString(),
      });
      const firstResponse = generationResponses[0]?.response;
      if (!firstResponse) {
        throw new Error('最终图生图没有返回任何品类结果。');
      }
      setGenerationResult({
        ...firstResponse,
        input_image_count: generationResponses.reduce(
          (total, item) => total + (item.response.input_image_count || 0),
          0,
        ),
        images: generationResponses.flatMap((item) => (
          item.response.images.map((image) => ({
            ...image,
            revised_prompt: [
              `品类：${item.target.category}`,
              image.revised_prompt || '',
            ].filter(Boolean).join('；'),
          }))
        )),
      });
      setAgentFlowStatus('success');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '自动流程失败。';
      setAgentFlowStatus('error');
      setAgentFlowError(message);
      setGenerationError(message);
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => {
    const nextRunKey = [
      result.project_code,
      materialSignature,
      designReferenceSignature,
      historyImage?.id || 'no-history',
    ].join('|');
    if (autoFlowRunKeyRef.current === nextRunKey || manualLayoutImage) {
      return;
    }
    autoFlowRunKeyRef.current = nextRunKey;
    const timeoutId = window.setTimeout(() => {
      void runAutomatedAgentFlow();
    }, 80);
    return () => window.clearTimeout(timeoutId);
  }, [
    designReferenceSignature,
    historyImage,
    manualLayoutImage,
    materialSignature,
    result.project_code,
  ]);

  async function handleComposeFinalPrompt() {
    if (requiresMaterialCleanup) {
      setFinalPromptError('请先点击“AI 处理素材图”，生成去除载体、标注和渠道信息后的素材，再编写最终提示词。');
      return;
    }

    try {
      const {
        generationHistoryImage,
        generationCategoryTargets,
        generationMaterialImages,
      } = await prepareFinalPromptInputs();
      const composedRequests = [];
      for (const target of generationCategoryTargets) {
        const targetHistoryImage = target.historyImage || generationHistoryImage;
        const targetMaterialImages = materialImagesForCategory(
          generationMaterialImages,
          target.category,
        );
        const generationTemplatePrompt = buildFinalGenerationTemplatePrompt(
          targetMaterialImages,
          targetHistoryImage,
          target.category,
        );
        const finalPromptResponse = await composeTrueFinalPrompt(
          targetMaterialImages,
          targetHistoryImage,
          generationTemplatePrompt,
          target.category,
        );
        composedRequests.push({
          category: target.category,
          prompt: finalPromptResponse.final_prompt,
          inputImages: buildFinalGenerationInputImages(targetHistoryImage, targetMaterialImages),
          historyLayoutLockPolicy: finalPromptResponse.history_layout_lock_policy,
          historyLayoutLockReason: finalPromptResponse.history_layout_lock_reason,
        });
      }
      setLastGenerationInput({
        projectCode: result.project_code,
        category: composedRequests.map((item) => item.category).join(' / ') || trueCategory,
        categoryTargets: composedRequests.map((item) => item.category),
        prompt: composedRequests
          .map((item) => `【${item.category}】\n${item.prompt}`)
          .join('\n\n---\n\n'),
        inputImages: composedRequests.flatMap((item) => item.inputImages),
        requests: composedRequests,
        historyLayoutLockPolicy: composedRequests[0]?.historyLayoutLockPolicy,
        historyLayoutLockReason: composedRequests[0]?.historyLayoutLockReason,
        createdAt: 'ai-final-prompt-preview',
      });
    } catch (_caught) {
      // Visible error state is set by the failing step.
    }
  }

  async function handleGeneratePatternImage() {
    if (requiresMaterialCleanup) {
      setGenerationError('请先点击“AI 处理素材图”，生成去除载体、标注和渠道信息后的素材，再进入最终 AI 生成图案。');
      setGenerationResult(null);
      return;
    }

    setGenerating(true);
    setGenerationError(null);
    setGenerationResult(null);

    try {
      const {
        generationHistoryImage,
        generationCategoryTargets,
        generationMaterialImages,
      } = await prepareFinalPromptInputs();
      const composedRequests = [];
      for (const target of generationCategoryTargets) {
        const targetHistoryImage = target.historyImage || generationHistoryImage;
        const targetMaterialImages = materialImagesForCategory(
          generationMaterialImages,
          target.category,
        );
        const generationTemplatePrompt = buildFinalGenerationTemplatePrompt(
          targetMaterialImages,
          targetHistoryImage,
          target.category,
        );
        const finalPromptResponse = await composeTrueFinalPrompt(
          targetMaterialImages,
          targetHistoryImage,
          generationTemplatePrompt,
          target.category,
        );
        composedRequests.push({
          target,
          finalPromptResponse,
          inputImages: buildFinalGenerationInputImages(targetHistoryImage, targetMaterialImages),
        });
      }
      setLastGenerationInput({
        projectCode: result.project_code,
        category: composedRequests.map((item) => item.target.category).join(' / ') || trueCategory,
        categoryTargets: composedRequests.map((item) => item.target.category),
        prompt: composedRequests
          .map((item) => `【${item.target.category}】\n${item.finalPromptResponse.final_prompt}`)
          .join('\n\n---\n\n'),
        inputImages: composedRequests.flatMap((item) => item.inputImages),
        requests: composedRequests.map((item) => ({
          category: item.target.category,
          prompt: item.finalPromptResponse.final_prompt,
          inputImages: item.inputImages,
          historyLayoutLockPolicy: item.finalPromptResponse.history_layout_lock_policy,
          historyLayoutLockReason: item.finalPromptResponse.history_layout_lock_reason,
        })),
        historyLayoutLockPolicy: composedRequests[0]?.finalPromptResponse.history_layout_lock_policy,
        historyLayoutLockReason: composedRequests[0]?.finalPromptResponse.history_layout_lock_reason,
        createdAt: new Date().toISOString(),
      });
      const responses = [];
      for (const item of composedRequests) {
        const response = await generatePatternImage({
          prompt: item.finalPromptResponse.final_prompt,
          project_code: result.project_code,
          category: item.target.category,
          ...generationRunFields(
            'final_design',
            'manual_final_generation',
            `Final generated design - ${item.target.category}`,
          ),
          history_layout_lock_policy: item.finalPromptResponse.history_layout_lock_policy,
          history_layout_lock_reason: item.finalPromptResponse.history_layout_lock_reason,
          input_images: item.inputImages,
        });
        if (response.status !== 'success') {
          throw new Error(response.ai_error?.message || imageGenerationStatusHint(response));
        }
        responses.push({ target: item.target, response });
      }
      const firstResponse = responses[0]?.response;
      if (!firstResponse) {
        throw new Error('AI 生图没有返回任何品类结果。');
      }
      setGenerationResult({
        ...firstResponse,
        input_image_count: responses.reduce((total, item) => total + (item.response.input_image_count || 0), 0),
        images: responses.flatMap((item) => item.response.images.map((image) => ({
          ...image,
          revised_prompt: [`品类：${item.target.category}`, image.revised_prompt || ''].filter(Boolean).join('；'),
        }))),
      });
    } catch (caught) {
      setGenerationError(caught instanceof Error ? caught.message : 'AI 生图失败。');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className="image-to-image-input-panel" aria-label="图生图输入准备">
      <DataLayerBadge label="使用层输入" />
      <div className="element-terms-heading">
        <h3>图生图输入准备</h3>
        <span>
          素材图 {visibleMaterialCount} 张 · 层级分类 {MATERIAL_SHAPE_CATEGORY_COUNT} 类 · 版式母版 {sourceHistoryImage ? '1' : '0'}/1
        </span>
      </div>

      <AgentFlowStatusPanel status={agentFlowStatus} steps={agentFlowSteps} error={agentFlowError} />

      <div className="generation-action-row agent-primary-actions">
        <button
          type="button"
          onClick={() => void runAutomatedAgentFlow({
            continueWithoutHistory: missingHistoryDecision === 'continue_without_layout',
            materialsOnly: missingHistoryDecision === 'materials_only',
          })}
          disabled={agentFlowStatus === 'running' || generating || refiningMaterials || splittingDesignReferences}
        >
          {agentFlowStatus === 'running' ? '自动流程运行中...' : '重新运行自动流程'}
        </button>
      </div>

      {!sourceHistoryImage && agentFlowStatus === 'blocked' ? (
        <section className="workflow-blocker-panel" aria-label="缺少空版式母版">
          <div>
            <strong>当前品类没有对应历史设计图</strong>
            <p>
              要继续生成最终图案，需要输入空版式母版；也可以选择无版式继续生成，
              或只输出已完成的素材图板块。
            </p>
          </div>
          <div className="workflow-blocker-actions">
            <label className="secondary-button upload-button">
              上传空版式母版
              <input type="file" accept="image/*" onChange={handleManualLayoutUpload} />
            </label>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setMissingHistoryDecision('continue_without_layout');
                void runAutomatedAgentFlow({ continueWithoutHistory: true });
              }}
            >
              无版式继续生成
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setMissingHistoryDecision('materials_only');
                void runAutomatedAgentFlow({ materialsOnly: true });
              }}
            >
              只输出素材图
            </button>
          </div>
        </section>
      ) : null}

      <section className="user-output-panel" aria-label="素材图板块">
        <div className="generation-input-block-heading">
          <h4>素材图板块</h4>
          <span>最终会进入图生图的素材图</span>
        </div>
        {finalMaterialImages.length > 0 ? (
          <div className="generation-input-image-grid">
            {finalMaterialImages.map((image) => (
              <GenerationInputImageCard image={image} key={image.id} />
            ))}
          </div>
        ) : materialImages.length > 0 || designReferenceImages.length > 0 ? (
          <>
            <p className="generation-prep-note">素材正在自动处理，下面先展示候选来源。</p>
            <div className="generation-input-image-grid">
              {[...materialImages, ...designReferenceImages].map((image) => (
                <GenerationInputImageCard image={image} key={image.id} />
              ))}
            </div>
          </>
        ) : (
          <p className="empty-note">当前还没有可展示的素材图。</p>
        )}
      </section>

      <details className="agent-debug-details">
        <summary>自动化与审计详情</summary>
      <div className="generation-prep-actions-panel" aria-label="运行步骤">
        <div className="generation-input-block-heading">
          <h4>运行步骤</h4>
          <span>只保留需要手动触发的按钮；最终输入以下方“最终生图实际输入”为准</span>
        </div>
        <div className="generation-prep-action-row">
          {canAnalyzeMaterialShapes ? (
            <>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleAnalyzeMaterialSourceShapes()}
                disabled={analyzingMaterialShapes || refiningMaterials || generating}
              >
                {analyzingMaterialShapes ? '判断中...' : 'AI 判断图库素材层级'}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleRefineMaterialImages()}
                disabled={analyzingMaterialShapes || refiningMaterials}
              >
                {refiningMaterials ? '素材处理中...' : 'AI 处理素材图'}
              </button>
            </>
          ) : null}
          {canSplitDesignReferences ? (
            <>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleAnalyzeDesignReferenceShapes()}
                disabled={analyzingDesignReferenceShapes || splittingDesignReferences || generating}
              >
                {analyzingDesignReferenceShapes ? '判断中...' : 'AI 判断参考图层级'}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleSplitDesignReferenceImages()}
                disabled={analyzingDesignReferenceShapes || splittingDesignReferences || generating}
              >
                {splittingDesignReferences ? '设计素材提取中...' : 'AI 提取设计素材'}
              </button>
            </>
          ) : null}
          {historyImage ? (
            <>
              <label className="generation-prep-toggle">
                <input
                  type="checkbox"
                  checked={useHistoryLayoutExtraction}
                  onChange={(event) => {
                    setUseHistoryLayoutExtraction(event.target.checked);
                    setLastGenerationInput(null);
                  }}
                  disabled={generating || extractingHistoryLayout}
                />
                <span>使用 AI 空版式母版</span>
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleExtractHistoryLayoutImage()}
                disabled={!useHistoryLayoutExtraction || extractingHistoryLayout || generating}
                title={!useHistoryLayoutExtraction ? '已关闭 AI 空版式母版，开启后可提取。' : undefined}
              >
                {extractingHistoryLayout ? '空版式提取中...' : 'AI 提取空版式'}
              </button>
            </>
          ) : null}
        </div>
        <p className="generation-prep-note">
          {[
            materialImages.length > 0
              ? refinedMaterialImages.length > 0
                ? '图库素材已处理'
                : materialShapeAnalysisResult?.status === 'success'
                  ? '图库素材层级已判断'
                  : '图库素材层级待判断'
              : '',
            canSplitDesignReferences
              ? splitDesignReferenceMaterials.length > 0
                ? '设计参考图素材已提取'
                : designReferenceShapeAnalysisResult?.status === 'success'
                  ? `${designReferenceSourceLabel}层级已判断`
                  : `${designReferenceSourceLabel}层级待判断`
              : '',
            historyImage
              ? useHistoryLayoutExtraction
                ? extractedHistoryLayoutImage
                  ? '历史空版式已提取'
                  : '历史空版式待提取'
                : '当前使用原始历史图作为构图母版'
              : '无历史设计图',
          ].filter(Boolean).join(' · ')}
        </p>
        {materialRefinementError ? (
          <div className="ai-error-summary material-refinement-status">
            <strong>material_cleanup_error</strong>
            <p>{materialRefinementError}</p>
          </div>
        ) : null}
        {materialShapeAnalysisError ? (
          <div className="ai-error-summary material-refinement-status">
            <strong>material_shape_analysis_error</strong>
            <p>{materialShapeAnalysisError}</p>
          </div>
        ) : null}
        {designReferenceSplitError ? (
          <div className="ai-error-summary material-refinement-status">
            <strong>design_reference_extract_error</strong>
            <p>{designReferenceSplitError}</p>
          </div>
        ) : null}
        {designReferenceShapeAnalysisError ? (
          <div className="ai-error-summary material-refinement-status">
            <strong>design_reference_shape_analysis_error</strong>
            <p>{designReferenceShapeAnalysisError}</p>
          </div>
        ) : null}
        {historyLayoutExtractionError ? (
          <div className="ai-error-summary material-refinement-status">
            <strong>history_layout_extract_error</strong>
            <p>{historyLayoutExtractionError}</p>
          </div>
        ) : null}
      </div>

      <div className="generation-input-grid generation-input-source-details">
        <div className="generation-input-block">
          <div className="generation-input-block-heading">
            <h4>素材图</h4>
            <span>图库素材和设计参考图都会进入判断；需要拆分时按一级形、二级形、三级形分类输出</span>
          </div>
          {materialImages.length > 0 ? (
            <>
              <div className="material-refinement-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleAnalyzeMaterialSourceShapes()}
                  disabled={analyzingMaterialShapes || refiningMaterials || generating}
                >
                  {analyzingMaterialShapes ? '判断中...' : 'AI 判断层级'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRefineMaterialImages()}
                  disabled={analyzingMaterialShapes || refiningMaterials}
                >
                  {refiningMaterials ? '处理中...' : 'AI 处理素材图'}
                </button>
                <span>
                  {refinedMaterialImages.length > 0
                    ? materialShapeAnalysisResult?.split_required === false
                      ? '最终提示词和最终生图直接使用内部图库统一素材板'
                      : '最终提示词和最终生图使用一级形、二级形、三级形处理后素材'
                    : '原始渠道素材图不会进入最终生成，需先判断是否需要拆分，再处理成可用素材'}
                  </span>
                </div>
                {materialShapeAnalysisResult?.status === 'success' ? (
                  <p className="generation-prep-note">
                    AI 分层判断：{materialShapeAnalysisSummary(materialShapeAnalysisResult)}
                  </p>
                ) : null}
                <div className="generation-input-image-grid">
                {materialImages.map((image) => (
                  <GenerationInputImageCard image={image} key={image.id} />
                ))}
              </div>
              {materialRefinementError ? (
                <div className="ai-error-summary material-refinement-status">
                  <strong>material_cleanup_error</strong>
                  <p>{materialRefinementError}</p>
                </div>
              ) : null}
              {refinedMaterialImages.length > 0 ? (
                <div className="refined-material-panel">
                  <div className="generation-input-block-heading">
                    <h4>AI 处理后素材</h4>
                    <span>去载体后的最终输入素材</span>
                  </div>
                  <div className="generation-input-image-grid">
                    {refinedMaterialImages.map((image) => (
                      <GenerationInputImageCard image={image} key={image.id} />
                    ))}
                  </div>
                </div>
              ) : null}
              {canSplitDesignReferences ? (
                <div className="refined-material-panel">
                  <div className="generation-input-block-heading">
                    <h4>{hasDesignRequirementDesignReferences ? `开发思路指定${designReferenceSourceLabel}` : designReferenceSourceLabel}</h4>
                    <span>提取成素材后进入最终输入</span>
                  </div>
                  <div className="material-refinement-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void handleAnalyzeDesignReferenceShapes()}
                      disabled={analyzingDesignReferenceShapes || splittingDesignReferences || generating}
                    >
                      {analyzingDesignReferenceShapes ? '判断中...' : 'AI 判断层级'}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void handleSplitDesignReferenceImages()}
                      disabled={analyzingDesignReferenceShapes || splittingDesignReferences || generating}
                    >
                      {splittingDesignReferences ? '提取中...' : 'AI 提取设计素材'}
                    </button>
                    <span>
                      {splitDesignReferenceMaterials.length > 0
                        ? designReferenceShapeAnalysisResult?.split_required === false
                          ? `最终生成会使用反推重生成后的统一素材板，不使用原始${designReferenceSourceLabel}`
                          : `最终生成会使用一级形、二级形、三级形提取素材，不使用原始${designReferenceSourceLabel}`
                        : `开发思路指定的${designReferenceSourceLabel}会先判断是否需要拆分，再提取成素材`}
                    </span>
                  </div>
                  {designReferenceShapeAnalysisResult?.status === 'success' ? (
                    <p className="generation-prep-note">
                      AI 分层判断：{materialShapeAnalysisSummary(designReferenceShapeAnalysisResult)}
                    </p>
                  ) : null}
                  <div className="generation-input-image-grid">
                    {designReferenceImages.map((image) => (
                      <GenerationInputImageCard image={image} key={image.id} />
                    ))}
                  </div>
                  {designReferenceSplitError ? (
                    <div className="ai-error-summary material-refinement-status">
                      <strong>design_reference_extract_error</strong>
                      <p>{designReferenceSplitError}</p>
                    </div>
                  ) : null}
                  {splitDesignReferenceMaterials.length > 0 ? (
                    <div className="extracted-material-result">
                      <div className="generation-input-block-heading">
                        <h4>AI 提取后素材</h4>
                        <span>
                          {designReferenceShapeAnalysisResult?.split_required === false
                            ? `反推重生成统一素材板，不使用原始${designReferenceSourceLabel}`
                            : `一级形 / 二级形 / 三级形，不使用原始${designReferenceSourceLabel}`}
                        </span>
                      </div>
                      <div className="generation-input-image-grid">
                        {splitDesignReferenceMaterials.map((image) => (
                          <GenerationInputImageCard image={image} key={image.id} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : canSplitDesignReferences ? (
            <>
              <div className="material-refinement-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleAnalyzeDesignReferenceShapes()}
                  disabled={analyzingDesignReferenceShapes || splittingDesignReferences || generating}
                >
                  {analyzingDesignReferenceShapes ? '判断中...' : 'AI 判断层级'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleSplitDesignReferenceImages()}
                  disabled={analyzingDesignReferenceShapes || splittingDesignReferences || generating}
                >
                  {splittingDesignReferences ? '提取中...' : 'AI 提取设计素材'}
                </button>
                <span>
                  {splitDesignReferenceMaterials.length > 0
                    ? designReferenceShapeAnalysisResult?.split_required === false
                      ? `最终生成会使用反推重生成后的统一素材板，不使用原始${designReferenceSourceLabel}`
                      : `最终生成会使用一级形、二级形、三级形提取素材，不使用原始${designReferenceSourceLabel}`
                    : `图库素材不可用时，从${designReferenceSourceLabel}先判断是否需要拆分，再提取素材`}
                </span>
              </div>
              {designReferenceShapeAnalysisResult?.status === 'success' ? (
                <p className="generation-prep-note">
                  AI 分层判断：{materialShapeAnalysisSummary(designReferenceShapeAnalysisResult)}
                </p>
              ) : null}
              <div className="generation-input-image-grid">
                {designReferenceImages.map((image) => (
                  <GenerationInputImageCard image={image} key={image.id} />
                ))}
              </div>
              {designReferenceSplitError ? (
                <div className="ai-error-summary material-refinement-status">
                  <strong>design_reference_extract_error</strong>
                  <p>{designReferenceSplitError}</p>
                </div>
              ) : null}
              {splitDesignReferenceMaterials.length > 0 ? (
                <div className="refined-material-panel">
                  <div className="generation-input-block-heading">
                    <h4>AI 提取后素材</h4>
                    <span>
                      {designReferenceShapeAnalysisResult?.split_required === false
                        ? `反推重生成统一素材板，不使用原始${designReferenceSourceLabel}`
                        : `一级形 / 二级形 / 三级形，不使用原始${designReferenceSourceLabel}`}
                    </span>
                  </div>
                  <div className="generation-input-image-grid">
                    {splitDesignReferenceMaterials.map((image) => (
                      <GenerationInputImageCard image={image} key={image.id} />
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <p className="empty-note">
              暂无匹配度达到 80% 的 AI 筛选素材图，最终生成以主要图案元素文本作为画面主导。
            </p>
          )}
        </div>

        <div className="generation-input-block">
          <div className="generation-input-block-heading">
            <h4>历史设计图</h4>
            <span>构图母版，真实品类随机 1 张</span>
          </div>
          {historyImage ? (
            <>
              <label className="history-layout-option">
                <input
                  type="checkbox"
                  checked={useHistoryLayoutExtraction}
                  onChange={(event) => {
                    setUseHistoryLayoutExtraction(event.target.checked);
                    setLastGenerationInput(null);
                  }}
                  disabled={generating || extractingHistoryLayout}
                />
                <span>
                  <strong>最终生成使用 AI 空版式母版</strong>
                  <small>
                    打开：生成前自动提取/使用空版式母版；关闭：直接使用原始历史设计图作为构图母版。
                  </small>
                </span>
              </label>
              <div className="material-refinement-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleExtractHistoryLayoutImage()}
                  disabled={!useHistoryLayoutExtraction || extractingHistoryLayout || generating}
                  title={!useHistoryLayoutExtraction ? '已关闭 AI 空版式母版，开启后可提取。' : undefined}
                >
                  {extractingHistoryLayout ? '提取中...' : 'AI 提取空版式'}
                </button>
                <span>
                  {!useHistoryLayoutExtraction
                    ? '当前关闭：最终生成直接使用原始历史设计图，不会自动提取空版式'
                    : extractedHistoryLayoutImage
                      ? '当前开启：最终生成使用空版式母版，不使用原始历史内容'
                      : '当前开启：可先清空旧文字、旧图案、旧主题，只保留历史版式结构'}
                </span>
              </div>
              <div className="generation-input-image-grid single">
                <GenerationInputImageCard image={historyImage} />
              </div>
              {historyLayoutExtractionError ? (
                <div className="ai-error-summary material-refinement-status">
                  <strong>history_layout_extract_error</strong>
                  <p>{historyLayoutExtractionError}</p>
                </div>
              ) : null}
              {extractedHistoryLayoutImage ? (
                <div className="refined-material-panel">
                  <div className="generation-input-block-heading">
                    <h4>AI 空版式母版</h4>
                    <span>
                      {useHistoryLayoutExtraction
                        ? '当前会作为最终构图输入，不含历史旧内容'
                        : '已生成但当前未启用，最终仍使用原始历史设计图'}
                    </span>
                  </div>
                  <div className="generation-input-image-grid single">
                    <GenerationInputImageCard image={extractedHistoryLayoutImage} />
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <p className="empty-note">当前真实品类还没有可用历史设计图。</p>
          )}
        </div>
      </div>

      <div className="prompt-branch-panel" aria-label="最终提示词分支验证">
        <div className="generation-input-block-heading">
          <h4>最终提示词模板板块</h4>
          <span>模板先交给 AI，结合素材图和版式母版输出真正最终提示词</span>
        </div>
        <div className="prompt-branch-grid" role="radiogroup" aria-label="选择最终提示词模板分支">
          {PROMPT_TEMPLATE_BRANCHES.map((branch) => {
            const isActive = branch.id === promptTemplateId;
            return (
              <button
                type="button"
                className={isActive ? 'prompt-branch-card active' : 'prompt-branch-card'}
                key={branch.id}
                role="radio"
                aria-checked={isActive}
                onClick={() => {
                  setPromptTemplateId(branch.id);
                  setLastGenerationInput(null);
                  setFinalPromptResult(null);
                  setFinalPromptError(null);
                }}
              >
                <strong>{branch.label}</strong>
                <span>{branch.goal}</span>
                <small>{branch.useCase}</small>
              </button>
            );
          })}
        </div>
        <div className="prompt-branch-current">
          <strong>当前分支执行方式</strong>
          <p>{selectedPromptTemplate.aiMethod}</p>
        </div>
      </div>

      <div className="generation-prompt-shell">
        <div className="generation-input-block-heading">
          <h4>{aiComposedFinalPrompt ? 'AI 输出的真正最终提示词' : '最终提示词模板草稿'}</h4>
          <div className="generation-action-row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void handleComposeFinalPrompt()}
              disabled={
                composingFinalPrompt ||
                generating ||
                extractingHistoryLayout ||
                analyzingMaterialShapes ||
                analyzingDesignReferenceShapes ||
                refiningMaterials ||
                splittingDesignReferences ||
                requiresMaterialCleanup
              }
              title={requiresMaterialCleanup ? '请先点击“AI 处理素材图”' : undefined}
            >
              {composingFinalPrompt ? '编写中...' : 'AI 编写最终提示词'}
            </button>
            <button type="button" className="secondary-button" onClick={() => void handleCopyPrompt()}>
              {copied ? '已复制' : '复制提示词'}
            </button>
            <button
              type="button"
              onClick={() => void handleGeneratePatternImage()}
              disabled={
                generating ||
                composingFinalPrompt ||
                extractingHistoryLayout ||
                analyzingMaterialShapes ||
                analyzingDesignReferenceShapes ||
                refiningMaterials ||
                splittingDesignReferences ||
                requiresMaterialCleanup
              }
              title={requiresMaterialCleanup ? '请先点击“AI 处理素材图”' : undefined}
            >
              {extractingHistoryLayout
                ? '提取版式中...'
                : analyzingMaterialShapes || analyzingDesignReferenceShapes
                  ? '判断层级中...'
                : splittingDesignReferences
                  ? '提取中...'
                : composingFinalPrompt
                  ? '编写提示词中...'
                : generating
                  ? '生成中...'
                  : requiresMaterialCleanup
                    ? '先处理素材图'
                    : requiresHistoryLayoutExtraction && requiresDesignReferenceSplit
                      ? '提取版式和素材并生成'
                    : requiresDesignReferenceSplit
                      ? '提取素材并生成'
                      : requiresHistoryLayoutExtraction
                        ? '提取版式并生成'
                      : 'AI 生成图案'}
            </button>
          </div>
        </div>
        {finalPromptResult?.status === 'success' ? (
          <div className="final-prompt-status success">
            <strong>AI 最终提示词已生成</strong>
            {finalPromptResult.prompt_strategy ? <span>{finalPromptResult.prompt_strategy}</span> : null}
            {finalPromptResult.history_layout_lock_policy ? (
              <small>
                版式母版策略：{finalPromptResult.history_layout_lock_policy}
                {finalPromptResult.history_layout_lock_reason
                  ? ` · ${finalPromptResult.history_layout_lock_reason}`
                  : ''}
              </small>
            ) : null}
            {finalPromptResult.warnings.length > 0 ? (
              <small>{finalPromptResult.warnings.join('；')}</small>
            ) : null}
          </div>
        ) : (
          <p className="generation-prep-note">
            当前显示的是模板草稿；点击“AI 编写最终提示词”后，会把当前最终生图实际输入图和所选模板板块交给 AI，输出真正用于生图的最终提示词。
          </p>
        )}
        {finalPromptError ? (
          <div className="ai-error-summary material-refinement-status">
            <strong>final_prompt_compose_error</strong>
            <p>{finalPromptError}</p>
          </div>
        ) : null}
        <textarea className="generation-prompt-textarea" readOnly value={prompt} />
      </div>

      <FinalGenerationInputInspector
        snapshot={visibleGenerationInput}
        mode={generationInputMode}
        note={generationInputNote}
      />
      </details>

      {missingHistoryDecision === 'materials_only' ? null : (
      <div className="generation-output-panel">
        <div className="generation-input-block-heading">
          <h4>AI 生成结果</h4>
          <span>密钥只在后端读取，不进入浏览器</span>
        </div>
        {generationError ? (
          <div className="ai-error-summary">
            <strong>image_generation_error</strong>
            <p>{generationError}</p>
            <small>这是前端到本地后端之间的请求错误；如果是模型返回错误，会显示在下方结果状态里。</small>
          </div>
        ) : null}
        {generationResult?.status === 'success' && generationResult.images.length > 0 ? (
          <div className="generated-image-grid">
            {generationResult.images.map((image, index) => {
              const imageUrl = generatedImageUrl(image);
              return (
                <figure className="generated-image-card" key={`${imageUrl}-${index}`}>
                  {imageUrl ? (
                    <img src={imageUrl} alt={`AI generated pattern ${index + 1}`} />
                  ) : (
                    <div className="reference-image-missing">未解析到图片</div>
                  )}
                  <figcaption>
                    <strong>生成图 {index + 1}</strong>
                    {image.revised_prompt ? <small>{image.revised_prompt}</small> : null}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        ) : generationResult ? (
          <div className="ai-error-summary">
            <strong>{generationResult.status}</strong>
            <p>{generationResult.ai_error?.message || 'AI 生图没有返回可展示图片。'}</p>
            <small>{imageGenerationStatusHint(generationResult)}</small>
            {generationResult.ai_error?.stage ? (
              <small>阶段：{generationResult.ai_error.stage}</small>
            ) : null}
            {generationResult.ai_error?.response_preview ? (
              <pre className="ai-error-preview">{generationResult.ai_error.response_preview}</pre>
            ) : null}
          </div>
        ) : (
          <p className="empty-note">
            {requiresMaterialCleanup
              ? '当前有渠道素材图待处理；完成“AI 处理素材图”后，处理后的素材会作为最终素材图进入提示词和图生图输入。'
              : !useHistoryLayoutExtraction && historyImage
                ? '当前已关闭 AI 空版式母版；点击“AI 生成图案”时会直接把原始历史设计图作为图1构图母版提交。'
              : requiresHistoryLayoutExtraction
                ? '点击“AI 生成图案”时会先把历史设计图清空成空版式母版，再把空版式母版作为历史构图输入。'
              : requiresDesignReferenceSplit
                ? `点击“AI 生成图案”时会先把${designReferenceSourceLabel}提取成纯色背景图案素材，再把提取后的素材图加入最终图生图输入。`
              : '点击“AI 生成图案”后，会把当前输入图和最终提示词提交给后端生图模型。'}
          </p>
        )}
      </div>
      )}
    </section>
  );
}

function ElementGalleryPanel({
  gallery,
  projectCode,
}: {
  gallery: ProposalAgentPrepareResponse['element_gallery'];
  projectCode: string;
}) {
  if (!gallery) {
    return null;
  }

  if (gallery.status === 'skipped') {
    return null;
  }

  const hasError = gallery.status !== 'success';

  return (
    <section className="element-gallery-panel" aria-label="元素词图库关系图">
      <DataLayerBadge label="图库关系数据" />
      <div className="element-terms-heading">
        <h3>元素词图库关系图</h3>
        <span>
          {gallery.terms_count} 个元素词 · {gallery.image_count} 张图库候选图片
        </span>
      </div>
      <p className="gallery-note">
        根据 AI 元素词直接读取图库索引，在页面内查看元素词与图库候选图片的关系；颜色会标出元素词、图片和交集最多的图片。
      </p>
      {hasError ? (
        <div className="ai-error-summary">
          <strong>{gallery.error?.type || gallery.status}</strong>
          <p>{gallery.error?.message || '图库索引读取失败。'}</p>
        </div>
      ) : (
        <>
          <div className="gallery-legend" aria-label="图例">
            <span className="legend-item primary">一级元素词</span>
            <span className="legend-item scene">场景词</span>
            <span className="legend-item style">风格词</span>
            <span className="legend-item attribute">属性词</span>
            <span className="legend-item image">图库图片</span>
            <span className="legend-item top">交集最多图片</span>
          </div>
          <ElementGalleryRelationshipGraph gallery={gallery} projectCode={projectCode} />
          <ElementGalleryMatchGroup
            title="一级元素词图库候选"
            matches={gallery.primary_element_gallery_matches}
          />
          <ElementGalleryMatchGroup
            title="场景词图库候选"
            matches={gallery.scene_element_gallery_matches || []}
          />
          <ElementGalleryMatchGroup
            title="风格词图库候选"
            matches={gallery.style_element_gallery_matches || []}
          />
          <ElementGalleryMatchGroup
            title="属性词图库候选"
            matches={gallery.attribute_element_gallery_matches || []}
          />
        </>
      )}
    </section>
  );
}

export default function ProposalAgentPanel() {
  const [projectInput, setProjectInput] = useState(initialProjectCode);
  const [packageInput, setPackageInput] = useState(defaultProposalPackagePath);
  const [result, setResult] = useState<ProposalAgentPrepareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [packageLoading, setPackageLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await prepareProposal({
        message: projectInput,
        projectCode: projectInput,
      });
      setResult(response);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : '查询失败。');
    } finally {
      setLoading(false);
    }
  }

  async function handlePackageSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPackageLoading(true);
    setError(null);

    try {
      const response = await prepareProposalPackage({
        packagePath: packageInput,
        projectCode: 'UPLOAD-SLP-BLANKET',
      });
      setResult(response);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : 'Proposal package prepare failed.');
    } finally {
      setPackageLoading(false);
    }
  }

  const visibleError = getErrorMessage(result, error);

  return (
    <section className="company-project-viewer">
      <form className="lookup-panel" onSubmit={handleSubmit}>
        <label className="field">
          <span>项目编号</span>
          <input
            value={projectInput}
            onChange={(event) => setProjectInput(event.target.value)}
            placeholder="例如：YXF2603230144"
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? '查询中...' : '查询公司项目数据'}
        </button>
      </form>

      <details className="agent-debug-details catalog-debug-details">
        <summary>品类表维护 / 空版式管理</summary>
        <CategoryCatalogManagerPanel />
      </details>

      <details className="agent-debug-details proposal-package-debug">
        <summary>外部提案包测试入口</summary>
        <form className="lookup-panel proposal-package-panel" onSubmit={handlePackageSubmit}>
          <label className="field">
            <span>Proposal package path</span>
            <input
              value={packageInput}
              onChange={(event) => setPackageInput(event.target.value)}
              placeholder="C:\\Users\\admin\\Downloads\\proposal.zip"
            />
          </label>
          <button type="submit" disabled={packageLoading}>
            {packageLoading ? 'Preparing package...' : 'Load proposal package flow'}
          </button>
        </form>
      </details>

      {visibleError ? (
        <div className="notice error-notice" role="alert">
          {visibleError}
        </div>
      ) : null}

      {result ? (
        <section className="result-panel" aria-label="公司真实开发数据">
          <div className="section-heading">
            <div>
              <p className="eyebrow">MYML Evidence Agent</p>
              <h2>项目生成结果</h2>
            </div>
            <span className={result.found ? 'status-badge ok' : 'status-badge'}>
              {result.found ? '已命中' : '未命中'}
            </span>
          </div>

          <dl className="summary-grid compact-summary-grid">
            <div>
              <dt>项目编号</dt>
              <dd>{displayValue(result.project_code)}</dd>
            </div>
            <div>
              <dt>真实品类</dt>
              <dd>{displayValue(result.category_judgment?.predicted_category || result.proposal.category_label || result.proposal.category)}</dd>
            </div>
          </dl>

          <ImageToImageInputPanel result={result} />

          <details className="agent-debug-details">
            <summary>数据层与审计详情</summary>
          <DataLayerMapPanel result={result} />
          <ReferenceImageGallery images={result.proposal.reference_images} />
          <GraphicElementPanel proposal={result.proposal} />
          <TextElementPanel proposal={result.proposal} />
          <CategoryJudgmentPanel judgment={result.category_judgment} />
          <BuiltinElementTermsPanel elementTerms={result.element_terms} />
          <AiElementMappingPanel mapping={result.ai_element_mapping} />
          <SelectedGalleryImagesPanel selection={result.selected_gallery_images} />
          <ElementGalleryPanel gallery={result.element_gallery} projectCode={result.project_code} />

          <div className="field-detail-heading">
            <div>
              <DataLayerBadge label="原始字段数据" />
              <h3>项目字段明细</h3>
            </div>
            <span>用于审计每个数据点的原始展示值</span>
          </div>
          <dl className="data-grid">
            {fieldRows.map((row) => (
              <div className={row.wide ? 'field-card wide' : 'field-card'} key={row.key}>
                <dt>{row.label}</dt>
                <dd>{displayValue(result.proposal[row.key])}</dd>
              </div>
            ))}
          </dl>
          </details>
        </section>
      ) : (
        <section className="empty-panel">
          <h2>公司真实开发数据</h2>
          <p>输入项目编号后查询真实公司数据源。字段为空时会显示 “—”。</p>
        </section>
      )}
    </section>
  );
}
