export interface PrepareProposalRequest {
  message?: string;
  projectCode?: string;
  project_code?: string;
}

export interface PrepareProposalPackageRequest {
  packagePath: string;
  projectCode?: string;
  project_code?: string;
}

export interface CompanyProjectProposal {
  project_code: string;
  project_name: string;
  category: string;
  category_label: string;
  development_keywords: string[];
  core_prompt: string;
  design_requirement: string;
  element_requirement: string;
  element_requirement_source: string;
  ai_graphic_elements: string;
  ai_graphic_elements_source: string;
  ai_graphic_elements_status: string;
  ai_graphic_elements_error: {
    type?: string;
    stage?: string;
    message?: string;
    http_status?: number | null;
    content_type?: string | null;
  } | null;
  real_graphic_elements: string;
  real_graphic_elements_source: string;
  text_elements: string;
  text_elements_source: string;
  text_elements_status: string;
  text_elements_error: {
    type?: string;
    stage?: string;
    message?: string;
    http_status?: number | null;
    content_type?: string | null;
  } | null;
  design_img: string;
  oper_img: string;
  reference_images: CompanyReferenceImage[];
  color_requirement: string;
  style_requirement: string;
  craft_requirement: string;
  material: string;
  market: string;
  audience: string;
  scene: string;
  quantity: string;
  size: string;
  specification: string;
  source_row_id: string;
  updated_at: string;
  created_at: string;
}

export interface CompanyReferenceImage {
  source_field: 'design_img' | 'oper_img' | string;
  label: string;
  raw_path: string;
  url: string;
  filename: string;
}

export interface CompanyProjectFieldSummary {
  field_count: number;
  non_empty_field_count: number;
  development_keywords_count: number;
}

export interface BuiltinElementTermMatch {
  term: string;
  source_fields: string[];
  match_type: 'exact' | 'contains' | string;
}

export interface BuiltinElementTermsResult {
  source: 'builtin_element_terms' | string;
  term_count: number;
  matched_term_count: number;
  matched_terms: BuiltinElementTermMatch[];
}

export interface AiElementTermMatch {
  term: string;
  confidence: number;
  reason: string;
  source_fields: string[];
  reference_index?: number;
  image_filename?: string;
}

export interface AiElementMappingError {
  type?: string;
  stage?: string;
  message?: string;
  http_status?: number | null;
  content_type?: string | null;
  response_preview?: string;
  duration_ms?: number;
  timeout_ms?: number;
  recall_candidates_count?: number;
  estimated_prompt_size_chars?: number;
}

export interface AiElementMappingResult {
  ai_status: 'success' | 'error' | 'missing_config' | 'disabled' | 'skipped' | string;
  model: string;
  source: 'ai_element_mapper' | string;
  basis: 'builtin_element_terms' | string;
  primary_element_terms: AiElementTermMatch[];
  scene_terms: AiElementTermMatch[];
  style_terms: AiElementTermMatch[];
  attribute_terms: AiElementTermMatch[];
  unmatched_terms: Array<{
    input: string;
    source: string;
    reason: string;
  }>;
  summary: {
    primary_count: number;
    scene_count: number;
    style_count: number;
    attribute_count: number;
    unmatched_count: number;
  };
  ai_error: AiElementMappingError | null;
}

export interface ElementGalleryImageCandidate {
  image_id: string;
  url: string;
  filename: string;
  category_label: string;
  found_local: boolean;
  usage_scope: string;
  term_type?: string;
  intersection_count: number;
  is_top_intersection: boolean;
}

export interface ElementGalleryTermMatch {
  raw_term: string;
  normalized_term: string;
  term_type: string;
  role: 'primary' | 'scene' | 'style' | 'attribute' | 'other' | string;
  role_label: string;
  source_fields: string[];
  confidence: number | null;
  gallery_candidate_count: number;
  candidate_images: ElementGalleryImageCandidate[];
}

export interface ElementGalleryGraphNode {
  id: string;
  node_type: 'element_term' | 'gallery_image' | string;
  role?: 'primary' | 'scene' | 'style' | 'attribute' | 'other' | string;
  label: string;
  raw_term?: string;
  url?: string;
  filename?: string;
  term_count?: number;
  is_top_intersection?: boolean;
}

export interface ElementGalleryGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface ElementGalleryLookupResult {
  status: 'success' | 'skipped' | 'missing_index' | 'error' | string;
  source: 'element_source_gallery_index' | string;
  terms_count: number;
  matched_terms_count: number;
  image_count: number;
  max_intersection_count: number;
  primary_element_gallery_matches: ElementGalleryTermMatch[];
  scene_element_gallery_matches: ElementGalleryTermMatch[];
  style_element_gallery_matches: ElementGalleryTermMatch[];
  attribute_element_gallery_matches: ElementGalleryTermMatch[];
  other_element_gallery_matches: ElementGalleryTermMatch[];
  graph: {
    nodes: ElementGalleryGraphNode[];
    edges: ElementGalleryGraphEdge[];
  };
  error: {
    type?: string;
    message?: string;
  } | null;
}

export interface CategoryJudgmentAlternative {
  category: string;
  confidence: number;
  reason: string;
}

export interface CategoryCatalogEntry {
  category: string;
  image_url: string;
  image_filename: string;
  note: string;
  source: string;
  created_at: string;
  updated_at: string;
  history_images: CategoryCatalogImage[];
}

export interface CategoryCatalogImage {
  image_url: string;
  image_filename: string;
  note: string;
  source: string;
  created_at: string;
}

export interface CategoryCatalogResponse {
  source: string;
  source_path: string;
  overrides_path: string;
  raw_count: number;
  manual_count: number;
  candidate_count: number;
  image_count: number;
  history_image_count: number;
  candidates: string[];
  entries: CategoryCatalogEntry[];
}

export interface AddCategoryCatalogEntryRequest {
  category: string;
  image_url?: string;
  note?: string;
}

export interface UploadCategoryCatalogImageRequest {
  category: string;
  image_data: string;
  filename: string;
  mime_type: string;
  note?: string;
}

export interface DeleteCategoryCatalogImageRequest {
  category: string;
  image_url: string;
}

export interface GeneratePatternImageInputImage {
  id: string;
  role: 'material' | 'history' | string;
  label: string;
  filename: string;
  url: string;
  detail?: string;
}

export interface GeneratePatternImageRequest {
  prompt: string;
  project_code?: string;
  project_run_id?: string;
  generation_stage?: 'element_image' | 'final_design' | string;
  generation_source?: string;
  generation_label?: string;
  category?: string;
  history_layout_lock_policy?: 'geometry_lock' | 'layout_lock' | 'flexible_reference' | string;
  history_layout_lock_reason?: string;
  request_mode?: 'edits' | 'images' | 'chat' | string;
  endpoint_path?: string;
  input_images: GeneratePatternImageInputImage[];
}

export interface ComposeFinalPromptRequest {
  template_prompt: string;
  prompt_template_id: string;
  project_code?: string;
  category?: string;
  input_images: GeneratePatternImageInputImage[];
}

export interface MaterialShapeAnalysisRequest {
  source_kind: 'material' | 'design_reference' | string;
  project_code?: string;
  category?: string;
  graphic_elements: string[];
  text_elements: string[];
  design_requirement_directives?: string[];
  input_images: GeneratePatternImageInputImage[];
}

export interface GeneratedPatternImage {
  url?: string;
  b64_json?: string;
  mime_type?: string;
  revised_prompt?: string;
}

export interface GeneratePatternImageError {
  type?: string;
  stage?: string;
  message?: string;
  http_status?: number | null;
  content_type?: string | null;
  response_preview?: string;
  duration_ms?: number;
  timeout_ms?: number;
}

export interface GeneratePatternImageResponse {
  status:
    | 'success'
    | 'missing_prompt'
    | 'missing_input_images'
    | 'missing_config'
    | 'disabled'
    | 'error'
    | 'no_images'
    | string;
  source: 'ai_image_generator' | string;
  model: string;
  request_mode: string;
  input_image_count: number;
  images: GeneratedPatternImage[];
  ai_error: GeneratePatternImageError | null;
  project_run?: {
    runId: string;
    projectCode: string;
    status: string;
    elementImageCount: number;
    finalDesignImageCount: number;
  };
}

export interface ComposeFinalPromptResponse {
  status:
    | 'success'
    | 'missing_template_prompt'
    | 'missing_input_images'
    | 'missing_config'
    | 'disabled'
    | 'missing_fetch'
    | 'timeout'
    | 'http_error'
    | 'json_parse_error'
    | 'empty_ai_result'
    | 'empty_final_prompt'
    | 'error'
    | string;
  source: 'ai_final_prompt_composer' | string;
  model: string;
  prompt_template_id: string;
  final_prompt: string;
  prompt_strategy: string;
  history_layout_lock_policy: 'geometry_lock' | 'layout_lock' | 'flexible_reference' | string;
  history_layout_lock_reason: string;
  warnings: string[];
  input_image_count: number;
  ai_error: GeneratePatternImageError | null;
}

export interface MaterialShapeAnalysisLevel {
  level: 'primary' | 'secondary' | 'tertiary' | string;
  extraction_targets: string[];
  preserve_details: string[];
  exclude_items: string[];
  source_reasoning: string;
  prompt_guidance: string;
}

export interface MaterialShapeAnalysisResponse {
  status:
    | 'success'
    | 'missing_input_images'
    | 'missing_config'
    | 'disabled'
    | 'missing_fetch'
    | 'timeout'
    | 'http_error'
    | 'json_parse_error'
    | 'empty_ai_result'
    | 'empty_levels'
    | 'error'
    | string;
  source: 'ai_material_shape_analyzer' | string;
  model: string;
  source_kind: string;
  input_image_count: number;
  split_required: boolean;
  split_mode: 'split_by_level' | 'single_material_board' | string;
  split_reason: string;
  single_material_guidance: string;
  levels: {
    primary: MaterialShapeAnalysisLevel;
    secondary: MaterialShapeAnalysisLevel;
    tertiary: MaterialShapeAnalysisLevel;
  };
  global_notes: string[];
  ai_error: GeneratePatternImageError | null;
}

export interface CategoryJudgmentImage {
  category: string;
  image_url: string;
  image_filename: string;
  note: string;
  source: string;
  history_images: CategoryCatalogImage[];
}

export interface CategoryJudgmentTarget {
  category: string;
  confidence: number;
  reason: string;
  evidence_fields: string[];
  category_image: CategoryJudgmentImage | null;
}

export interface CategoryJudgmentError {
  type?: string;
  stage?: string;
  message?: string;
  http_status?: number | null;
  content_type?: string | null;
  response_preview?: string;
  duration_ms?: number;
  timeout_ms?: number;
}

export interface CategoryJudgmentResult {
  status: 'success' | 'missing_config' | 'disabled' | 'skipped' | 'missing_catalog' | 'error' | string;
  source: 'ai_category_classifier' | string;
  basis: 'test_category_catalog' | string;
  model: string;
  catalog_source: string;
  candidate_count: number;
  predicted_category: string;
  confidence: number;
  reason: string;
  evidence_fields: string[];
  alternatives: CategoryJudgmentAlternative[];
  category_image: CategoryJudgmentImage | null;
  predicted_categories: CategoryJudgmentTarget[];
  category_images: CategoryJudgmentImage[];
  match_source: 'ai' | 'rule_fallback' | 'none' | string;
  ai_error: CategoryJudgmentError | null;
}

export interface SelectedGalleryImageConnectedTerm {
  term: string;
  raw_term: string;
  role: 'primary' | 'scene' | 'style' | 'attribute' | 'other' | string;
  role_label: string;
}

export interface SelectedGalleryImage {
  image_index: number;
  image_id: string;
  url: string;
  filename: string;
  category_label: string;
  usage_scope: string;
  found_local: boolean;
  term_type: string;
  intersection_count: number;
  is_top_intersection: boolean;
  connected_terms: SelectedGalleryImageConnectedTerm[];
  match_score: number;
  matched_graphic_elements: string[];
  reason: string;
  concerns: string;
}

export interface GalleryImageSelectionError {
  type?: string;
  stage?: string;
  message?: string;
  http_status?: number | null;
  content_type?: string | null;
  response_preview?: string;
  duration_ms?: number;
  timeout_ms?: number;
}

export interface GalleryImageSelectionResult {
  status:
    | 'success'
    | 'skipped'
    | 'missing_config'
    | 'disabled'
    | 'no_candidates'
    | 'no_graphic_elements'
    | 'error'
    | string;
  source: 'ai_gallery_image_filter' | string;
  basis: 'graphic_element_requirement' | string;
  model: string;
  required_graphic_elements: string[];
  candidate_image_count: number;
  selected_image_count: number;
  selected_images: SelectedGalleryImage[];
  rejected_image_count: number;
  min_score: number;
  ai_error: GalleryImageSelectionError | null;
}

export interface ReferenceDesignAnalysisError {
  type?: string;
  stage?: string;
  message?: string;
  http_status?: number | null;
  content_type?: string | null;
  response_preview?: string;
  duration_ms?: number;
  timeout_ms?: number;
}

export interface ReferenceDesignInformation {
  motif_treatment: string;
  composition: string;
  color_palette: string;
  background_treatment?: string;
  style_texture: string;
  usable_details: string[];
}

export interface ReferenceDesignAnalysisMatch {
  reference_index: number;
  source_field: string;
  label: string;
  filename: string;
  match_score: number;
  matched_graphic_elements: string[];
  design_information: ReferenceDesignInformation;
  reason: string;
}

export interface ReferenceDesignAnalysisResult {
  status:
    | 'success'
    | 'skipped'
    | 'skipped_qualified_gallery_images'
    | 'missing_config'
    | 'disabled'
    | 'no_reference_images'
    | 'no_graphic_elements'
    | 'error'
    | string;
  source: 'ai_company_reference_design_analysis' | string;
  basis: 'company_reference_images_and_graphic_elements' | string;
  model: string;
  triggered_by_no_qualified_gallery_images: boolean;
  required_graphic_elements: string[];
  reference_image_count: number;
  matched_reference_count: number;
  matched_references: ReferenceDesignAnalysisMatch[];
  design_reference_summary: string;
  prompt_notes: string[];
  min_match_score: number;
  ai_error: ReferenceDesignAnalysisError | null;
}

export interface ProposalAgentPrepareResponse {
  project_code: string;
  found: boolean;
  source: 'real_company_lookup' | string;
  data_origin: 'real_company_db' | string;
  mock: boolean;
  proposal: CompanyProjectProposal;
  category_judgment: CategoryJudgmentResult;
  element_terms: BuiltinElementTermsResult;
  ai_element_mapping: AiElementMappingResult;
  element_gallery: ElementGalleryLookupResult;
  selected_gallery_images: GalleryImageSelectionResult;
  reference_design_analysis: ReferenceDesignAnalysisResult;
  field_summary: CompanyProjectFieldSummary;
  lookup_status: string | null;
  error_code: string | null;
  error_message: string;
}
