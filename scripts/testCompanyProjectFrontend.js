const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const COMPONENT_PATH = path.join(ROOT, 'src', 'components', 'ProposalAgentPanel.tsx');
const APP_PATH = path.join(ROOT, 'src', 'App.tsx');
const API_PATH = path.join(ROOT, 'src', 'api', 'proposalApi.ts');
const SERVER_PATH = path.join(ROOT, 'server', 'index.js');
const MATERIAL_SHAPE_ANALYZER_PATH = path.join(ROOT, 'server', 'services', 'aiMaterialShapeAnalyzer.js');

function loadTsxModule(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const loadedModule = new Module(filePath, module);

  loadedModule.filename = filePath;
  loadedModule.paths = Module._nodeModulePaths(path.dirname(filePath));
  const originalRequire = loadedModule.require.bind(loadedModule);
  loadedModule.require = (request) => {
    if (request === '../api/proposalApi') {
      return {
        addCategoryCatalogEntry: async () => ({
          candidate_count: 1,
          image_count: 1,
          entries: [],
        }),
        getCategoryCatalog: async () => ({
          candidate_count: 1,
          image_count: 0,
          history_image_count: 0,
          entries: [],
        }),
        composeFinalPrompt: async () => ({
          status: 'success',
          source: 'ai_final_prompt_composer',
          model: 'gpt-5.5',
          prompt_template_id: 'structured_ai',
          final_prompt: 'Final AI prompt',
          prompt_strategy: 'Mock strategy',
          history_layout_lock_policy: 'layout_lock',
          history_layout_lock_reason: 'Mock layout lock reason',
          warnings: [],
          input_image_count: 2,
          ai_error: null,
        }),
        deleteCategoryCatalogImage: async () => ({
          candidate_count: 1,
          image_count: 0,
          history_image_count: 0,
          entries: [],
        }),
        generatePatternImage: async () => ({
          status: 'success',
          source: 'ai_image_generator',
          model: 'gpt-image-2',
          request_mode: 'chat',
          input_image_count: 0,
          images: [],
          ai_error: null,
        }),
        prepareProposal: async () => ({}),
        uploadCategoryCatalogImage: async () => ({
          candidate_count: 1,
          image_count: 1,
          history_image_count: 1,
          entries: [],
        }),
      };
    }
    return originalRequire(request);
  };
  loadedModule._compile(compiled, filePath);
  return loadedModule.exports;
}

function assertSourceIsSlim() {
  const componentSource = fs.readFileSync(COMPONENT_PATH, 'utf8');
  const apiSource = fs.readFileSync(API_PATH, 'utf8');
  const appSource = fs.readFileSync(APP_PATH, 'utf8');
  const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');
  const materialShapeAnalyzerSource = fs.readFileSync(MATERIAL_SHAPE_ANALYZER_PATH, 'utf8');
  const requiredCompanyFieldKeys = ['text_elements', 'design_img', 'oper_img'];

  assert(componentSource.includes('公司真实开发数据'));
  assert(componentSource.includes('查询公司项目数据'));
  assert(componentSource.includes('项目编号'));
  requiredCompanyFieldKeys.forEach((fieldKey) => {
    assert(componentSource.includes(`key: '${fieldKey}'`), `${fieldKey} must be displayed.`);
  });
  assert(!componentSource.includes("key: 'element_requirement'"));
  assert(componentSource.includes('GraphicElementPanel'));
  assert(componentSource.includes('图案元素'));
  assert(componentSource.includes('TextElementPanel'));
  assert(componentSource.includes('文字元素'));
  assert(componentSource.includes('text_elements_source'));
  assert(componentSource.includes('stripChineseFromVisibleTextElement'));
  assert(componentSource.includes('中文内容会作为内部需求说明处理'));
  assert(componentSource.includes('AI 补全 / 开发思路'));
  assert(componentSource.includes('必须包含的文字元素'));
  assert(componentSource.includes('文字元素要求：当前文字元素板块为空'));
  assert(componentSource.includes('collectGenerationDesignRequirementDirectives'));
  assert(componentSource.includes('collectDesignRequirementReferenceIndices'));
  assert(componentSource.includes('开发思路设计指令'));
  assert(componentSource.includes('载体品类、尺寸、规格、cm/mm 信息由历史版式和真实品类图锁定'));
  assert(componentSource.includes('开发思路指定${sourceLabel}'));
  assert(componentSource.includes('selectedByDesignRequirement'));
  assert(componentSource.includes('MAX_DESIGN_REFERENCE_MATERIAL_IMAGES = 4'));
  assert(componentSource.includes('按开发思路指定的${referenceSourceLabel}${referenceIndices.join'));
  assert(componentSource.includes('分别判断形状、图案、排版、文字、配色和可用素材'));
  assert(componentSource.includes('不要只取其中一张'));
  assert(componentSource.includes('AI 提取'));
  assert(componentSource.includes('真实数据'));
  assert(componentSource.includes('ai_graphic_elements'));
  assert(componentSource.includes('real_graphic_elements'));
  assert(componentSource.includes('reference_images'));
  assert(componentSource.includes('<img'));
  assert(componentSource.includes('公司参考图'));
  assert(componentSource.includes('element_terms'));
  assert(componentSource.includes('内置元素词提取'));
  assert(componentSource.includes('ai_element_mapping'));
  assert(componentSource.includes('AI 元素词对应'));
  assert(componentSource.includes('element_gallery'));
  assert(componentSource.includes('DataLayerMapPanel'));
  assert(componentSource.includes('data-layer-card'));
  assert(componentSource.includes('data-layer-badge'));
  assert(componentSource.includes('Data Layer Map'));
  assert(componentSource.includes('CategoryCatalogManagerPanel'));
  assert(componentSource.includes('品类表维护 / 空版式管理'));
  assert(componentSource.includes('品类表维护'));
  assert(componentSource.includes('添加到品类表'));
  assert(componentSource.includes('展开品类表'));
  assert(componentSource.includes('拖拽多张历史设计图'));
  assert(componentSource.includes('multiple'));
  assert(componentSource.includes('categoryCatalogEntryImages'));
  assert(componentSource.includes('category-image-stack'));
  assert(componentSource.includes('deleteCategoryCatalogImage'));
  assert(componentSource.includes('category-image-delete-button'));
  assert(componentSource.includes('handleDeleteCategoryImage'));
  assert(componentSource.includes('prepareCategoryImageUpload'));
  assert(componentSource.includes('canvasToJpegBlob'));
  assert(componentSource.includes('resolveCategoryUploadCanvasSpec'));
  assert(componentSource.includes('drawContainedImage'));
  assert(componentSource.includes('2048x1024'));
  assert(componentSource.includes('1024x2048'));
  assert(componentSource.includes('等比补边'));
  assert(componentSource.includes('已自动压缩'));
  assert(componentSource.includes('uploadCategoryCatalogImage'));
  assert(componentSource.includes('category-catalog-table'));
  assert(componentSource.includes('category-dropzone'));
  assert(componentSource.includes('category-catalog-manager'));
  assert(componentSource.includes('category_image'));
  assert(componentSource.includes('category-judgment-image-card'));
  assert(componentSource.includes('SelectedGalleryImagesPanel'));
  assert(componentSource.includes('selected_gallery_images'));
  assert(componentSource.includes('AI 筛选符合图案元素的图片'));
  assert(componentSource.includes('visibleSelectedImages'));
  assert(componentSource.includes('slice(0, 2)'));
  assert(componentSource.includes('查看大图'));
  assert(componentSource.includes('image-lightbox'));
  assert(componentSource.includes('selected-image-preview-button'));
  assert(componentSource.includes('ImageToImageInputPanel'));
  assert(componentSource.includes('图生图输入准备'));
  assert(componentSource.includes('自动流程'));
  assert(componentSource.includes('最多重试'));
  assert(componentSource.includes('AGENT_FLOW_MAX_RETRIES = 3'));
  assert(componentSource.includes('素材图板块'));
  assert(componentSource.includes('缺少历史设计图：请上传空版式母版'));
  assert(componentSource.includes('只输出素材图'));
  assert(componentSource.includes('数据层与审计详情'));
  assert(componentSource.includes('外部提案包测试入口'));
  assert(componentSource.includes('GENERATION_MATERIAL_MIN_SCORE'));
  assert(componentSource.includes('match_score >= GENERATION_MATERIAL_MIN_SCORE'));
  assert(componentSource.includes('MATERIAL_SHAPE_CATEGORY_COUNT = 3'));
  assert(componentSource.includes('MATERIAL_SHAPE_LEVELS'));
  assert(componentSource.includes('一级形'));
  assert(componentSource.includes('二级形'));
  assert(componentSource.includes('三级形'));
  assert(componentSource.includes('图库素材和设计参考图都会进入判断；需要拆分时按一级形、二级形、三级形分类输出'));
  assert(componentSource.includes('不要把一级形、二级形、三级形混在同一张图里'));
  assert(componentSource.includes('一级形是最终设计中最优先被识别的核心主视觉，不是全量素材集合'));
  assert(componentSource.includes('二级形是支撑一级形的中等装饰结构，不是第二张全量素材集合'));
  assert(componentSource.includes('最多 1-3 个独立一级主体'));
  assert(componentSource.includes('二级形必须排除一级形中的大标题'));
  assert(componentSource.includes('载体剥离规则'));
  assert(componentSource.includes('分层互斥规则'));
  assert(componentSource.includes('不能保留载体外形、整件商品或完整展示版面'));
  assert(componentSource.includes('buildShapeLevelElementJudgment'));
  assert(componentSource.includes('主要图案元素判定锚点'));
  assert(componentSource.includes('文字元素判定锚点'));
  assert(componentSource.includes('主要图案元素判定依据'));
  assert(componentSource.includes('文字元素判定依据'));
  assert(componentSource.includes('工作模式：这是素材提取/抠图整理任务，不是重新设计、不是重绘、不是根据文字生成类似图案'));
  assert(componentSource.includes('原图提取边界'));
  assert(componentSource.includes('禁止重绘规则'));
  assert(componentSource.includes('如果输入图没有对应元素，宁可少提取，也不要补画'));
  assert(componentSource.includes('一级形只能从输入图已有元素中选择'));
  assert(componentSource.includes('二级形只能从输入图已有元素中选择'));
  assert(componentSource.includes('三级形只能从输入图已有元素中选择'));
  assert(componentSource.includes('materialShapeLevel'));
  assert(componentSource.includes('构图母版，真实品类随机 1 张'));
  assert(componentSource.includes('历史设计图负责最终图片的大体构图格式'));
  assert(componentSource.includes('buildHistoryLayoutExtractionPrompt'));
  assert(componentSource.includes('AI 提取空版式'));
  assert(componentSource.includes('AI 空版式母版'));
  assert(componentSource.includes('useHistoryLayoutExtraction'));
  assert(componentSource.includes('最终生成使用 AI 空版式母版'));
  assert(componentSource.includes('当前已关闭 AI 空版式母版'));
  assert(componentSource.includes('不会自动提取空版式'));
  assert(componentSource.includes('history_layout_source'));
  assert(componentSource.includes('历史内容禁用'));
  assert(componentSource.includes('不得复用历史图内容'));
  assert(componentSource.includes('不使用带旧内容的原始历史设计图'));
  assert(componentSource.includes('输入图顺序'));
  assert(componentSource.includes('图1 ='));
  assert(componentSource.includes('角色：历史设计图/构图母版'));
  assert(componentSource.includes('图${index + 2}'));
  assert(componentSource.includes('角色：素材图/素材本体来源'));
  assert(componentSource.includes('素材图负责提供可用素材本体'));
  assert(componentSource.includes('素材保真规则'));
  assert(componentSource.includes('素材图中已经存在的图案元素'));
  assert(componentSource.includes('只有素材图没有的必需元素才创新'));
  assert(componentSource.includes('禁止整张画面全新重画而忽略素材图'));
  assert(componentSource.includes('背景策略'));
  assert(componentSource.includes('历史构图母版中的白底或空白区域只代表版位和留白结构'));
  assert(componentSource.includes('素材图中的白底只代表抠图底或素材展示底'));
  assert(componentSource.includes('运营参考图不参与背景判断'));
  assert(componentSource.includes('背景只能应用在历史图已有版位内部'));
  assert(componentSource.includes('collectGenerationBackgroundDirectives'));
  assert(componentSource.includes('buildCompanyReferenceBackgroundTextSummary'));
  assert(componentSource.includes('背景执行要求'));
  assert(componentSource.includes('${referenceSourceLabel}背景分析'));
  assert(componentSource.includes('不得因为 AI 提取素材图或历史构图母版是白底就默认输出纯白底'));
  assert(componentSource.includes('细节稳定规则'));
  assert(componentSource.includes('Clean and polished image, controllable details, smooth and consistent textures'));
  assert(componentSource.includes('no over-sharpening, no color blotches, no noise, no broken patterns'));
  assert(componentSource.includes('历史图格式判定'));
  assert(componentSource.includes('历史版位锁定'));
  assert(componentSource.includes('历史单元数量锁定'));
  assert(componentSource.includes('设计融合规则'));
  assert(componentSource.includes('版位内设计要求'));
  assert(componentSource.includes('单个图案设计定义'));
  assert(componentSource.includes('单个图案设计不是整张输出画布'));
  assert(componentSource.includes('单个图案设计维度'));
  assert(componentSource.includes('**1. Core Subject & Theme (核心主体与主题):**'));
  assert(componentSource.includes('**2. Art Style & Medium (艺术风格与媒介):**'));
  assert(componentSource.includes('**3. Color Palette & Lighting (配色与光影):**'));
  assert(componentSource.includes('**4. Composition & Perspective (构图与视角):**'));
  assert(componentSource.includes('**5. Detailed Visual Elements (分层细节描述):**'));
  assert(componentSource.includes('**6. Text & Typography (If any):**'));
  assert(componentSource.includes('不要输出 Markdown'));
  assert(componentSource.includes('避免公式化'));
  assert(componentSource.includes('不是素材堆叠'));
  assert(componentSource.includes('版位外的白底、单元间隙、尺寸线、尺寸文字'));
  assert(componentSource.includes('不得增加中间大标题区、全宽横幅、上下花边或额外贴纸区'));
  assert(componentSource.includes('横向多单元版式'));
  assert(componentSource.includes('优先级规则：构图格式'));
  assert(componentSource.includes('构图锁定'));
  assert(componentSource.includes('输出画布约束'));
  assert(componentSource.includes('不要为了填满输出画布而放大、拉伸、裁切或移动历史版式'));
  assert(componentSource.includes('不要为了填满画布而放大、拉伸、裁切或移动历史版式'));
  assert(componentSource.includes('版式母版锁定策略判断'));
  assert(componentSource.includes('geometry_lock'));
  assert(componentSource.includes('layout_lock'));
  assert(componentSource.includes('flexible_reference'));
  assert(componentSource.includes('禁止把整张历史图拉伸、压扁、放大到铺满画布'));
  assert(componentSource.includes('公司参考图构图限制'));
  assert(componentSource.includes('不要输出单个圆形餐盘'));
  assert(componentSource.includes('低于 80% 匹配度的图片只保留在数据层'));
  assert(componentSource.includes('画面主导'));
  assert(componentSource.includes('reference_design_analysis'));
  assert(componentSource.includes('buildCompanyReferenceDesignTextSummary'));
  assert(componentSource.includes('公司参考图文字分析'));
  assert(componentSource.includes('不要把公司参考图原图作为图生图输入'));
  assert(componentSource.includes('真实品类随机 1 张'));
  assert(componentSource.includes('buildImageToImagePrompt'));
  assert(componentSource.includes('PromptTemplateId'));
  assert(componentSource.includes('PROMPT_TEMPLATE_BRANCHES'));
  assert(componentSource.includes('最终提示词模板板块'));
  assert(componentSource.includes('结构板'));
  assert(componentSource.includes('自然语言板'));
  assert(componentSource.includes('AI 编写最终提示词'));
  assert(componentSource.includes('AI 输出的真正最终提示词'));
  assert(componentSource.includes('最终提示词模板草稿'));
  assert(componentSource.includes('历史设计图怎么参考、背景策略怎么实施'));
  assert(componentSource.includes('用素材图替换掉历史设计图中的设计主题'));
  assert(componentSource.includes('当前最终提示词模板板块'));
  assert(componentSource.includes('真正最终提示词'));
  assert(componentSource.includes('composeFinalPrompt'));
  assert(componentSource.includes('proposalGraphicElements'));
  assert(componentSource.includes('chooseStableHistoryImage'));
  assert(componentSource.includes('复制提示词'));
  assert(componentSource.includes('主要图案元素'));
  assert(componentSource.includes('参考图配色'));
  assert(componentSource.includes('DESIGN_REFERENCE_SOURCE_FIELD'));
  assert(componentSource.includes('EXTERNAL_EVIDENCE_SOURCE_FIELD'));
  assert(componentSource.includes('外部竞品证据图'));
  assert(componentSource.includes('公司设计参考图'));
  assert(componentSource.includes('history_images'));
  assert(componentSource.includes('元素词图库关系图'));
  assert(componentSource.includes('Local Graph'));
  assert(componentSource.includes('buildObsidianLocalGraphLayout'));
  assert(componentSource.includes('场景词图库候选'));
  assert(componentSource.includes('风格词图库候选'));
  assert(componentSource.includes('属性词图库候选'));
  assert(!componentSource.includes('其他元素词图库候选'));
  assert(apiSource.includes('/api/proposal-agent/prepare'));
  assert(apiSource.includes('/api/category-catalog'));
  assert(apiSource.includes('/api/category-catalog/entries'));
  assert(apiSource.includes('/api/category-catalog/entries/image'));
  assert(apiSource.includes("method: 'DELETE'"));
  assert(apiSource.includes('/api/image-generation/generate'));
  assert(componentSource.includes('generatePatternImage'));
  assert(componentSource.includes('AI 生成图案'));
  assert(componentSource.includes('FinalGenerationInputInspector'));
  assert(componentSource.includes('最终生图实际输入'));
  assert(componentSource.includes('本次实际提交'));
  assert(componentSource.includes('当前待提交预览'));
  assert(componentSource.includes('请求 JSON'));
  assert(componentSource.includes('lastGenerationInput'));
  assert(componentSource.includes('buildFinalGenerationInputImages'));
  assert(componentSource.includes('AI 处理素材图'));
  assert(componentSource.includes('material_cleanup'));
  assert(componentSource.includes('AI 处理后素材'));
  assert(componentSource.includes('AI 拆分必要性判断'));
  assert(componentSource.includes('统一素材板处理方式'));
  assert(componentSource.includes('MATERIAL_BOARD_REVERSE_PROMPT_TEMPLATE_ID'));
  assert(componentSource.includes('material_board_reverse'));
  assert(componentSource.includes('Analyze the provided image and generate a detailed visual description'));
  assert(componentSource.includes('reverseAndRegenerateUnifiedMaterialBoard'));
  assert(componentSource.includes('material_board_reverse_source'));
  assert(componentSource.includes("request_mode: 'images'"));
  assert(componentSource.includes('文生图生成一张可用于后续图案设计的新统一素材板'));
  assert(componentSource.includes('最终提示词和最终生图直接使用内部图库统一素材板'));
  assert(componentSource.includes('内部图库素材不做提示词反推文生图'));
  assert(componentSource.includes('最终生成会使用反推重生成后的统一素材板，不使用原始${designReferenceSourceLabel}'));
  assert(componentSource.includes('split_required'));
  assert(componentSource.includes('single_material_guidance'));
  assert(componentSource.includes('原始渠道素材图不会进入最终提示词和最终图生图输入'));
  assert(componentSource.includes('先处理素材图'));
  assert(componentSource.includes('collectGenerationDesignReferenceImages'));
  assert(componentSource.includes('buildDesignReferenceMaterialSplitPrompt'));
  assert(componentSource.includes('design_reference_material_source'));
  assert(componentSource.includes('AI 提取设计素材'));
  assert(componentSource.includes('AI 提取后素材'));
  assert(componentSource.includes('提取素材并生成'));
  assert(componentSource.includes('提取版式并生成'));
  assert(componentSource.includes('提取版式和素材并生成'));
  assert(componentSource.includes('纯色背景素材图'));
  assert(componentSource.includes('不要只保留同名主要元素'));
  assert(componentSource.includes('不要把原始${materialReferenceSourceLabel}作为输入图'));
  assert(componentSource.includes('const combineFinalMaterialImages'));
  assert(componentSource.includes('hasDesignRequirementDesignReferences'));
  assert(componentSource.includes('开发思路指定${designReferenceSourceLabel}'));
  assert(componentSource.includes('提取成素材后进入最终输入'));
  assert(componentSource.includes('AI 生成结果'));
  assert(componentSource.includes('密钥只在后端读取'));
  assert(componentSource.includes('上游生图服务返回 HTTP'));
  assert(componentSource.includes('AI_IMAGE_GENERATOR_TIMEOUT_MS'));
  assert(componentSource.includes('ai-error-preview'));
  assert(serverSource.includes('generatePatternImage'));
  assert(materialShapeAnalyzerSource.includes('开发思路 design_requirement_directives 是高优先级判断依据'));
  assert(materialShapeAnalyzerSource.includes('形状见图1、图案见图2、排版见参考图3'));
  assert(materialShapeAnalyzerSource.includes('不能只取其中一张参考图'));
  assert(appSource.includes('MYML Evidence Agent'));
  assert(serverSource.includes("express.json({ limit: '60mb' })"));
  assert(serverSource.includes('entity.too.large'));

  [
    'AI 元素词判断',
    'AI 辅助映射',
    '九类元素词交集实验',
    '历史图候选',
    'Developer Debug',
    'ranked_images',
    'nine_type_terms',
    'matched_element_terms',
    'SKU',
  ].forEach((forbidden) => {
    assert(!componentSource.includes(forbidden), `Component must not include ${forbidden}.`);
  });
}

function assertInitialRender() {
  const panelModule = loadTsxModule(COMPONENT_PATH);
  const ProposalAgentPanel = panelModule.default;
  assert.strictEqual(typeof ProposalAgentPanel, 'function');
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(ProposalAgentPanel));

  assert(html.includes('公司真实开发数据'));
  assert(html.includes('品类表维护'));
  assert(html.includes('添加到品类表'));
  assert(html.includes('展开品类表'));
  assert(html.includes('查询公司项目数据'));
  assert(html.includes('项目编号'));
  assert(html.includes('YXF2603230144'));
  [
    'AI 元素词判断',
    'AI 辅助映射',
    '九类元素词交集实验',
    '历史图候选',
    'Developer Debug',
    'SKU',
  ].forEach((forbidden) => {
    assert(!html.includes(forbidden), `Rendered page must not include ${forbidden}.`);
  });
}

assertSourceIsSlim();
assertInitialRender();
console.log('[test:frontend] Company project frontend tests passed.');
