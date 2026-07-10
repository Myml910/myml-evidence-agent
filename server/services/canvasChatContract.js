const express = require('express');

const SERVICE_NAME = 'myml-evidence-agent';
const DEFAULT_MAX_QUERY_LENGTH = 4000;
const DEFAULT_MAX_CANVAS_NODES = 50;
const DEFAULT_MAX_EVIDENCE_ITEMS = 8;
const PROJECT_CODE_PATTERN = /\bYXF\d{10}\b/gi;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function nowIso() {
  return new Date().toISOString();
}

function requestIdFrom(request, fallbackPrefix = 'evidence_req') {
  const body = request?.body && typeof request.body === 'object' ? request.body : {};
  return cleanString(body.requestId || body.request_id || request?.get?.('X-MYML-Request-Id')) ||
    `${fallbackPrefix}_${Date.now()}`;
}

function safeText(value, maxLength = 500) {
  const raw = cleanString(value);
  if (!raw) {
    return '';
  }

  return raw
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[redacted-base64-image]')
    .replace(/[a-z]:[\\/][^\s"'<>]+/gi, '[redacted-local-path]')
    .replace(/\\\\[^\\/\s]+\\[^\s"'<>]+/g, '[redacted-local-path]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .slice(0, maxLength);
}

function stripChineseFromVisibleTextElement(value) {
  const withoutChinese = cleanString(value)
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ')
    .replace(/[，。；、：：“”‘’（）【】《》？！]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,.!?'"()[\]{}<>_\-/|]+|[\s:;,.!?'"()[\]{}<>_\-/|]+$/g, '')
    .trim();

  return /[a-z0-9]/i.test(withoutChinese) ? withoutChinese : '';
}

function visibleTextElementSummary(value) {
  const items = String(value || '')
    .split(/[\n\r,;；，、]+/)
    .map(stripChineseFromVisibleTextElement)
    .filter(Boolean);
  return Array.from(new Set(items)).slice(0, 8).join('; ');
}

function stableId(prefix, parts) {
  return [prefix, ...parts.map((part) => cleanString(part).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80))]
    .filter(Boolean)
    .join('_')
    .replace(/_+/g, '_');
}

function safeFilename(value) {
  const filename = cleanString(value).split(/[\\/]/).filter(Boolean).pop() || '';
  return filename.replace(/[^a-z0-9._ -]+/gi, '_').slice(0, 160);
}

function safeAssetRef(prefix, projectCode, filename, index) {
  return stableId(prefix, [projectCode || 'project', `${index + 1}`, safeFilename(filename) || 'asset']);
}

function safeImageUrl(value) {
  const raw = cleanString(value);
  if (!raw || /^data:/i.test(raw) || /^javascript:/i.test(raw)) {
    return null;
  }
  if (/^[a-z]:[\\/]/i.test(raw) || /^\\\\/.test(raw)) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_error) {
    return null;
  }
}

function imagePreviewFields(value) {
  const imageUrl = safeImageUrl(value);
  return {
    imageUrl,
    thumbnailUrl: imageUrl,
  };
}

function extractProjectCodesFromText(value) {
  const text = cleanString(value);
  if (!text) {
    return [];
  }
  return Array.from(new Set((text.match(PROJECT_CODE_PATTERN) || []).map((code) => code.toUpperCase())));
}

function isValidProjectCode(value) {
  return /^YXF\d{10}$/i.test(cleanString(value));
}

function collectProjectCodesFromCanvasContext(value, options = {}) {
  const maxNodes = clampInteger(options.maxNodes, DEFAULT_MAX_CANVAS_NODES, 1, 200);
  const results = new Set();
  let visited = 0;

  function visit(node) {
    if (visited >= maxNodes || node == null) {
      return;
    }
    visited += 1;

    if (typeof node === 'string') {
      extractProjectCodesFromText(node).forEach((code) => results.add(code));
      return;
    }

    if (Array.isArray(node)) {
      node.slice(0, maxNodes).forEach(visit);
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    Object.entries(node).forEach(([key, child]) => {
      if (/cookie|token|api[_-]?key|password|base64|url|path/i.test(key)) {
        return;
      }
      if (typeof child === 'string' && /^(data:image\/|https?:\/\/|[a-z]:[\\/]|\\\\)/i.test(child)) {
        return;
      }
      visit(child);
    });
  }

  visit(value);
  return Array.from(results);
}

function buildSafeError(requestId, code, message, retryable = false) {
  return {
    requestId,
    status: 'failed',
    error: {
      code,
      message,
      retryable,
    },
  };
}

function bearerTokenFrom(request) {
  const header = cleanString(request.get('authorization') || request.get('Authorization'));
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireCanvasAuth(request, response, next) {
  const requestId = requestIdFrom(request);
  const expectedToken = cleanString(process.env.MYML_EVIDENCE_AGENT_TOKEN);
  if (!expectedToken) {
    response.status(503).json(buildSafeError(
      requestId,
      'EVIDENCE_AGENT_FORBIDDEN',
      'Evidence Agent token is not configured.',
      false,
    ));
    return;
  }

  const providedToken = bearerTokenFrom(request);
  if (!providedToken) {
    response.status(401).json(buildSafeError(
      requestId,
      'EVIDENCE_AGENT_UNAUTHORIZED',
      'Missing Evidence Agent bearer token.',
      false,
    ));
    return;
  }

  if (providedToken !== expectedToken) {
    response.status(403).json(buildSafeError(
      requestId,
      'EVIDENCE_AGENT_FORBIDDEN',
      'Invalid Evidence Agent bearer token.',
      false,
    ));
    return;
  }

  next();
}

function hasProviderCost(result) {
  const statuses = [
    result?.ai_element_mapping?.ai_status,
    result?.category_judgment?.status,
    result?.selected_gallery_images?.status,
    result?.reference_design_analysis?.status,
  ];
  return statuses.some((status) => status === 'success');
}

function projectBriefFromResult(result) {
  const proposal = result.proposal || {};
  const visibleTextElements = visibleTextElementSummary(proposal.text_elements);
  const parts = [
    proposal.project_name,
    proposal.design_requirement,
    proposal.ai_graphic_elements || proposal.element_requirement,
    visibleTextElements ? `Text: ${visibleTextElements}` : '',
  ].filter(Boolean);
  return safeText(parts.join(' | '), 700);
}

function mapSelectedGalleryMaterials(result, limit) {
  const projectCode = result.project_code || result.proposal?.project_code || '';
  const selected = Array.isArray(result.selected_gallery_images?.selected_images)
    ? result.selected_gallery_images.selected_images
    : [];
  return selected.slice(0, limit).map((image, index) => ({
    id: safeAssetRef('asset_material', projectCode, image.filename || image.image_id, index),
    title: safeText(image.filename || image.image_id || `Material ${index + 1}`, 120),
    category: 'material',
    source: 'internal',
    projectCode,
    ...imagePreviewFields(image.url),
    assetRef: safeAssetRef('gallery_material', projectCode, image.filename || image.image_id, index),
    description: safeText([
      image.match_score != null ? `match ${Math.round(Number(image.match_score) * 100)}%` : '',
      image.matched_graphic_elements?.length ? `elements: ${image.matched_graphic_elements.join(', ')}` : '',
      image.reason,
    ].filter(Boolean).join(' · '), 450),
    metadata: {
      imageId: safeText(image.image_id, 120),
      filename: safeFilename(image.filename),
      matchScore: Number.isFinite(Number(image.match_score)) ? Number(image.match_score) : null,
      usageScope: safeText(image.usage_scope, 80),
    },
  }));
}

function mapReferenceImages(result, limit) {
  const projectCode = result.project_code || result.proposal?.project_code || '';
  const images = Array.isArray(result.proposal?.reference_images)
    ? result.proposal.reference_images
    : [];
  return images
    .filter((image) => image?.source_field === 'design_img')
    .slice(0, limit)
    .map((image, index) => ({
      id: safeAssetRef('asset_design_reference', projectCode, image.filename, index),
      title: safeText(image.label || `Design reference ${index + 1}`, 120),
      category: 'reference',
      source: 'internal',
      projectCode,
      ...imagePreviewFields(image.url),
      assetRef: safeAssetRef('design_reference', projectCode, image.filename, index),
      description: safeText(`Design reference image ${index + 1}; used only as evidence/material extraction source.`, 260),
      metadata: {
        sourceField: 'design_img',
        filename: safeFilename(image.filename),
      },
    }));
}

function mapHistoryDesigns(result, limit) {
  const projectCode = result.project_code || result.proposal?.project_code || '';
  const categoryImage = result.category_judgment?.category_image;
  if (!categoryImage) {
    return [];
  }
  const historyImages = Array.isArray(categoryImage.history_images) && categoryImage.history_images.length > 0
    ? categoryImage.history_images
    : [categoryImage];
  return historyImages.slice(0, limit).map((image, index) => ({
    id: safeAssetRef('asset_history_design', projectCode, image.image_filename, index),
    title: safeText(`${categoryImage.category || result.category_judgment?.predicted_category || 'Category'} history layout ${index + 1}`, 120),
    category: 'history_design',
    source: 'internal',
    projectCode,
    ...imagePreviewFields(image.image_url),
    assetRef: safeAssetRef('history_design', projectCode, image.image_filename, index),
    description: safeText(image.note || 'History design or blank layout reference for final image generation.', 320),
    metadata: {
      category: safeText(categoryImage.category || result.category_judgment?.predicted_category, 120),
      filename: safeFilename(image.image_filename),
      hasHistoryLayout: true,
    },
  }));
}

function buildDesignTasks(result) {
  const selectedMaterialCount = result.selected_gallery_images?.selected_image_count || 0;
  const referenceImageCount = (result.proposal?.reference_images || [])
    .filter((image) => image.source_field === 'design_img')
    .length;
  const historyImage = result.category_judgment?.category_image;

  return [
    {
      id: 'material_image_block',
      title: 'Material image block',
      status: selectedMaterialCount > 0 || referenceImageCount > 0 ? 'available' : 'missing',
      description: safeText(
        selectedMaterialCount > 0
          ? `${selectedMaterialCount} selected gallery material image(s) are available.`
          : `${referenceImageCount} design reference image(s) can be used for material extraction if gallery materials are missing.`,
      ),
    },
    {
      id: 'history_layout_block',
      title: 'History layout block',
      status: historyImage ? 'available' : 'needs_blank_layout_input',
      description: historyImage
        ? 'A category history design is available as the layout reference.'
        : 'No category history design is available; Canvas should ask for a blank layout master before final generation.',
    },
    {
      id: 'final_image_generation',
      title: 'Final image generation',
      status: 'not_persisted_in_read_only_api',
      description: 'The current productized web flow exposes final image generation as the final user output, but this read-only Canvas API does not start or persist image generation.',
    },
  ];
}

function buildProjectPayload(result, options = {}) {
  const maxItems = clampInteger(options.maxItemsPerSection || options.max_items_per_section, 6, 1, 20);
  const proposal = result.proposal || {};
  const category = result.category_judgment?.predicted_category || proposal.category_label || proposal.category || '';
  const visibleTextElements = visibleTextElementSummary(proposal.text_elements);

  const materials = options.includeMaterials === false ? [] : mapSelectedGalleryMaterials(result, maxItems);
  const historyDesigns = options.includeHistory === false ? [] : mapHistoryDesigns(result, maxItems);
  const elementImages = options.includeDesignReferences === false ? [] : mapReferenceImages(result, maxItems);
  const finalDesigns = options.includeFinalDesigns === false ? [] : [];

  return {
    project: {
      projectCode: result.project_code || proposal.project_code || '',
      title: safeText(proposal.project_name, 220),
      productType: safeText(proposal.category_label || proposal.category, 120),
      category: safeText(category, 120),
      brief: projectBriefFromResult(result),
      graphicElements: safeText(proposal.ai_graphic_elements || proposal.element_requirement || proposal.real_graphic_elements, 260),
      textElements: safeText(visibleTextElements, 260),
      colorRequirement: safeText(proposal.color_requirement, 180),
      styleRequirement: safeText(proposal.style_requirement, 180),
    },
    materials,
    historyDesigns,
    elementImages,
    finalDesigns,
    designTasks: buildDesignTasks(result),
  };
}

function buildDisplayState(payload) {
  const hasFinalDesigns = Array.isArray(payload.finalDesigns) && payload.finalDesigns.length > 0;
  const hasDesignReferences = Array.isArray(payload.elementImages) && payload.elementImages.some((image) => image.imageUrl);

  return {
    status: hasFinalDesigns ? 'final_designs_ready' : 'thinking_design',
    message: hasFinalDesigns
      ? 'Final design images are available.'
      : hasDesignReferences
        ? '正在思考设计中，先展示公司数据中的设计参考图。'
        : '正在思考设计中，当前没有可展示的公司设计参考图。',
  };
}

function buildCanvasChatPreviewProject(project) {
  return {
    projectCode: project.projectCode,
    textElements: project.textElements,
    graphicElements: project.graphicElements,
  };
}

function buildCanvasChatPreviewImages(images) {
  return Array.isArray(images)
    ? images.map((image) => ({
      id: image.id,
      title: image.title,
      category: 'company_design_reference',
      source: 'company_project_data',
      projectCode: image.projectCode,
      imageUrl: image.imageUrl,
      thumbnailUrl: image.thumbnailUrl,
    })).filter((image) => image.imageUrl || image.thumbnailUrl)
    : [];
}

function buildCanvasChatPreviewEvidence(payload, result) {
  const project = buildCanvasChatPreviewProject(payload.project);
  const snippet = [
    project.textElements ? `Text elements: ${project.textElements}` : '',
    project.graphicElements ? `Graphic elements: ${project.graphicElements}` : '',
  ].filter(Boolean).join(' | ') || 'No text or graphic element fields were available in the company preview.';

  return [
    evidenceCard(
      stableId('ev_company_preview', [project.projectCode]),
      'company_project_preview',
      'Company design preview',
      snippet,
      0.95,
      {
        projectCode: project.projectCode,
        metadata: {
          found: Boolean(result.found),
          previewOnly: true,
        },
      },
    ),
  ];
}

function evidenceCard(id, type, title, snippet, score, extra = {}) {
  return {
    id,
    type,
    title: safeText(title, 160),
    source: 'internal',
    projectCode: extra.projectCode || null,
    snippet: safeText(snippet, 650),
    score,
    createdAt: nowIso(),
    metadata: extra.metadata || {},
  };
}

function buildEvidenceFromProjectPayload(payload, result, maxItems) {
  const projectCode = payload.project.projectCode;
  const evidence = [
    evidenceCard(
      stableId('ev_project', [projectCode]),
      'project',
      payload.project.title || projectCode,
      payload.project.brief || 'Project facts from company lookup.',
      0.95,
      {
        projectCode,
        metadata: {
          category: payload.project.category,
          productType: payload.project.productType,
          found: Boolean(result.found),
        },
      },
    ),
  ];

  if (payload.project.category) {
    evidence.push(evidenceCard(
      stableId('ev_category', [projectCode, payload.project.category]),
      'rule',
      'True category judgment',
      [
        `Category: ${payload.project.category}`,
        result.category_judgment?.confidence != null
          ? `confidence ${Math.round(Number(result.category_judgment.confidence) * 100)}%`
          : '',
        result.category_judgment?.reason || '',
      ].filter(Boolean).join(' · '),
      Number(result.category_judgment?.confidence) || 0.8,
      { projectCode, metadata: { category: payload.project.category } },
    ));
  }

  payload.materials.slice(0, maxItems).forEach((asset, index) => {
    evidence.push(evidenceCard(
      stableId('ev_material', [projectCode, asset.id || index]),
      'asset',
      asset.title,
      asset.description,
      asset.metadata?.matchScore || 0.82,
      { projectCode, metadata: { category: 'material', assetRef: asset.assetRef } },
    ));
  });

  payload.historyDesigns.slice(0, maxItems).forEach((asset, index) => {
    evidence.push(evidenceCard(
      stableId('ev_history', [projectCode, asset.id || index]),
      'design_case',
      asset.title,
      asset.description,
      0.86,
      { projectCode, metadata: { category: 'history_design', assetRef: asset.assetRef } },
    ));
  });

  return evidence.slice(0, maxItems);
}

async function lookupProjectForCanvas(projectCode, request, dependencies, options = {}) {
  const normalizedCode = cleanString(projectCode).toUpperCase();
  if (!isValidProjectCode(normalizedCode)) {
    const error = new Error('Invalid YXF project code.');
    error.statusCode = 400;
    error.code = 'EVIDENCE_AGENT_INVALID_PROJECT_CODE';
    error.retryable = false;
    throw error;
  }

  const result = await dependencies.prepareProposalFromCompanyLookup({
    projectCode: normalizedCode,
    publicBaseUrl: dependencies.publicBaseUrlFromRequest(request),
  });

  if (!result.found) {
    const error = new Error(result.error_code === 'COMPANY_PROJECT_NOT_FOUND'
      ? 'Project was not found.'
      : safeText(result.error_message || 'Project lookup failed.', 260));
    error.statusCode = result.error_code === 'COMPANY_PROJECT_NOT_FOUND' ? 404 : 502;
    error.code = result.error_code === 'COMPANY_PROJECT_NOT_FOUND'
      ? 'EVIDENCE_AGENT_PROJECT_NOT_FOUND'
      : 'EVIDENCE_AGENT_UPSTREAM_UNAVAILABLE';
    error.retryable = result.error_code !== 'COMPANY_PROJECT_NOT_FOUND';
    throw error;
  }

  return {
    raw: result,
    payload: buildProjectPayload(result, options),
  };
}

function projectCodeFromRequestBody(body = {}) {
  const explicitCode = cleanString(body.projectCode || body.project_code || body.filters?.projectCode);
  if (explicitCode) {
    return explicitCode.toUpperCase();
  }

  const messageText = cleanString(body.message?.text || body.query || body.text);
  const fromMessage = extractProjectCodesFromText(messageText);
  if (fromMessage.length > 0) {
    return fromMessage[0];
  }

  const fromCanvas = collectProjectCodesFromCanvasContext(body.canvasContext || body.canvas_context);
  return fromCanvas[0] || '';
}

async function handleProjectLookup(request, response, dependencies) {
  const startedAt = Date.now();
  const requestId = requestIdFrom(request, 'project_lookup');
  const body = request.body && typeof request.body === 'object' ? request.body : {};

  try {
    const projectCode = projectCodeFromRequestBody(body);
    const { raw, payload } = await lookupProjectForCanvas(
      projectCode,
      request,
      dependencies,
      body.options || {},
    );
    response.json({
      requestId,
      status: 'completed',
      ...payload,
      displayState: buildDisplayState(payload),
      usage: {
        providerCost: hasProviderCost(raw),
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    response.status(error.statusCode || 500).json(buildSafeError(
      requestId,
      error.code || 'EVIDENCE_AGENT_INTERNAL_ERROR',
      error.message || 'Evidence Agent project lookup failed.',
      Boolean(error.retryable),
    ));
  }
}

async function handleEvidenceSearch(request, response, dependencies) {
  const startedAt = Date.now();
  const requestId = requestIdFrom(request, 'search');
  const body = request.body && typeof request.body === 'object' ? request.body : {};
  const limit = clampInteger(body.filters?.limit || body.options?.maxEvidenceItems, 6, 1, DEFAULT_MAX_EVIDENCE_ITEMS);

  try {
    const projectCode = projectCodeFromRequestBody(body);
    if (!projectCode) {
      response.json({
        requestId,
        status: 'completed',
        results: [],
        usage: {
          providerCost: false,
          durationMs: Date.now() - startedAt,
        },
        warnings: ['No YXF project code was found in the query or sanitized canvas metadata.'],
      });
      return;
    }

    const { raw, payload } = await lookupProjectForCanvas(projectCode, request, dependencies, {
      includeMaterials: true,
      includeHistory: true,
      includeFinalDesigns: false,
      maxItemsPerSection: limit,
    });
    const evidence = buildEvidenceFromProjectPayload(payload, raw, limit);
    response.json({
      requestId,
      status: 'completed',
      results: evidence.map((item) => ({
        ...item,
        thumbnailUrl: null,
        assetRef: item.metadata?.assetRef || null,
      })),
      usage: {
        providerCost: hasProviderCost(raw),
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    response.status(error.statusCode || 500).json(buildSafeError(
      requestId,
      error.code || 'EVIDENCE_AGENT_INTERNAL_ERROR',
      error.message || 'Evidence Agent search failed.',
      Boolean(error.retryable),
    ));
  }
}

function handleProjectRunResult(request, response, dependencies) {
  const requestId = requestIdFrom(request, 'project_run');
  const run = dependencies.projectRunStore?.getProjectRun?.(request.params.runId);
  if (!run) {
    response.status(404).json(buildSafeError(
      requestId,
      'EVIDENCE_AGENT_PROJECT_RUN_NOT_FOUND',
      'Project run was not found.',
      false,
    ));
    return;
  }

  response.json({
    requestId,
    status: 'completed',
    run,
  });
}

function handleLatestProjectRunResult(request, response, dependencies) {
  const requestId = requestIdFrom(request, 'project_latest_result');
  const projectCode = cleanString(request.params.projectCode).toUpperCase();
  if (!isValidProjectCode(projectCode)) {
    response.status(400).json(buildSafeError(
      requestId,
      'EVIDENCE_AGENT_INVALID_PROJECT_CODE',
      'Invalid YXF project code.',
      false,
    ));
    return;
  }

  const run = dependencies.projectRunStore?.getLatestProjectRunForCode?.(projectCode);
  if (!run) {
    response.status(404).json(buildSafeError(
      requestId,
      'EVIDENCE_AGENT_PROJECT_RUN_NOT_FOUND',
      'No generated project result has been recorded for this project code.',
      false,
    ));
    return;
  }

  response.json({
    requestId,
    status: 'completed',
    run,
  });
}

async function handleProjectFinalDisplay(request, response, dependencies) {
  const requestId = requestIdFrom(request, 'project_final_display');
  const projectCode = cleanString(request.params.projectCode).toUpperCase();
  if (!isValidProjectCode(projectCode)) {
    response.status(400).json(buildSafeError(
      requestId,
      'EVIDENCE_AGENT_INVALID_PROJECT_CODE',
      'Invalid YXF project code.',
      false,
    ));
    return;
  }

  try {
    const result = await dependencies.prepareProjectFinalDisplay({
      projectCode,
      request,
      dependencies,
      options: {
        ...(request.body && typeof request.body === 'object' ? request.body.options || {} : {}),
        force: Boolean(request.body?.force),
        runId: request.body?.runId || request.body?.run_id,
      },
    });

    response.json({
      requestId,
      kind: 'project_final_display',
      ...result,
    });
  } catch (error) {
    response.status(error.statusCode || 500).json(buildSafeError(
      requestId,
      error.code || 'EVIDENCE_AGENT_FINAL_DISPLAY_FAILED',
      error.message || 'Project final display generation failed.',
      Boolean(error.retryable),
    ));
  }
}

async function handleCanvasChatRespond(request, response, dependencies) {
  const startedAt = Date.now();
  const requestId = requestIdFrom(request, 'chatreq');
  const body = request.body && typeof request.body === 'object' ? request.body : {};
  const messageText = safeText(body.message?.text, DEFAULT_MAX_QUERY_LENGTH);
  const maxEvidenceItems = clampInteger(
    body.options?.maxEvidenceItems || body.options?.max_evidence_items,
    6,
    1,
    DEFAULT_MAX_EVIDENCE_ITEMS,
  );

  if (!messageText) {
    response.status(400).json(buildSafeError(
      requestId,
      'EVIDENCE_AGENT_INTERNAL_ERROR',
      'message.text is required.',
      false,
    ));
    return;
  }

  try {
    const projectCode = projectCodeFromRequestBody(body);
    if (!projectCode) {
      response.json({
        requestId,
        status: 'completed',
        intent: 'unknown',
        draftAnswer: body.options?.includeDraftAnswer === false ? null : {
          text: 'I did not find a YXF project code in the message or sanitized canvas metadata. Ask with a project code to retrieve project evidence.',
          language: cleanString(body.conversation?.language) || 'zh',
          confidence: 0.45,
        },
        evidence: [],
        suggestions: [{
          type: 'follow_up_question',
          title: 'Provide a YXF project code',
          description: 'Evidence lookup is most reliable when the user message includes a YXF project code.',
          payload: {},
        }],
        usage: {
          providerCost: false,
          durationMs: Date.now() - startedAt,
        },
        warnings: ['No YXF project code was found.'],
      });
      return;
    }

    const { raw, payload } = await lookupProjectForCanvas(projectCode, request, dependencies, {
      includeMaterials: false,
      includeHistory: false,
      includeDesignReferences: true,
      includeFinalDesigns: false,
      maxItemsPerSection: maxEvidenceItems,
    });
    const previewProject = buildCanvasChatPreviewProject(payload.project);
    const previewImages = buildCanvasChatPreviewImages(payload.elementImages);
    const evidence = buildCanvasChatPreviewEvidence(payload, raw);
    const displayState = buildDisplayState(payload);
    response.json({
      requestId,
      status: 'completed',
      intent: 'project_lookup',
      project: previewProject,
      designReferenceImages: previewImages,
      displayState,
      draftAnswer: body.options?.includeDraftAnswer === false ? null : {
        text: safeText(
          [
            `${projectCode} company data preview is ready.`,
            previewProject.textElements ? `Text elements: ${previewProject.textElements}.` : '',
            previewProject.graphicElements ? `Graphic elements: ${previewProject.graphicElements}.` : '',
            `Only company design reference images are attached while split material images and final generated images are pending.`,
          ].filter(Boolean).join(' '),
          1200,
        ),
        language: cleanString(body.conversation?.language) || 'zh',
        confidence: 0.82,
      },
      evidence,
      suggestions: [],
      usage: {
        providerCost: hasProviderCost(raw),
        durationMs: Date.now() - startedAt,
      },
      warnings: [],
    });
  } catch (error) {
    response.status(error.statusCode || 500).json(buildSafeError(
      requestId,
      error.code || 'EVIDENCE_AGENT_INTERNAL_ERROR',
      error.message || 'Evidence Agent chat response failed.',
      Boolean(error.retryable),
    ));
  }
}

function createCanvasChatRouter(dependencies) {
  const router = express.Router();
  const version = dependencies.version || '0.1.0';
  const deps = {
    ...dependencies,
    publicBaseUrlFromRequest: dependencies.publicBaseUrlFromRequest || ((request) => (
      `${request.protocol}://${request.get('host')}`
    )),
  };

  router.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      service: SERVICE_NAME,
      version,
      time: nowIso(),
    });
  });

  router.get('/capabilities', requireCanvasAuth, (_request, response) => {
    response.json({
      service: SERVICE_NAME,
      capabilities: {
        chatAnswer: true,
        evidenceSearch: true,
        projectCodeLookup: true,
        projectRunResults: true,
        projectFinalDisplay: true,
        assetReferenceSearch: false,
        streaming: false,
      },
      limits: {
        maxQueryLength: DEFAULT_MAX_QUERY_LENGTH,
        maxCanvasNodes: DEFAULT_MAX_CANVAS_NODES,
        maxEvidenceItems: DEFAULT_MAX_EVIDENCE_ITEMS,
        timeoutMsRecommended: 30000,
      },
      productizedFlow: {
        input: 'project_code',
        userVisibleOutputs: ['material_image_block', 'final_image_generation'],
        hiddenAutomation: true,
      },
    });
  });

  router.post('/canvas-chat/respond', requireCanvasAuth, (request, response) => {
    void handleCanvasChatRespond(request, response, deps);
  });

  router.get('/project-runs/:runId', requireCanvasAuth, (request, response) => {
    handleProjectRunResult(request, response, deps);
  });

  router.get('/projects/:projectCode/latest-result', requireCanvasAuth, (request, response) => {
    handleLatestProjectRunResult(request, response, deps);
  });

  router.post('/projects/:projectCode/final-display', requireCanvasAuth, (request, response) => {
    void handleProjectFinalDisplay(request, response, deps);
  });

  router.post('/evidence/search', requireCanvasAuth, (request, response) => {
    void handleEvidenceSearch(request, response, deps);
  });

  router.post('/projects/lookup', requireCanvasAuth, (request, response) => {
    void handleProjectLookup(request, response, deps);
  });

  return router;
}

module.exports = {
  buildEvidenceFromProjectPayload,
  buildProjectPayload,
  buildSafeError,
  collectProjectCodesFromCanvasContext,
  createCanvasChatRouter,
  extractProjectCodesFromText,
  isValidProjectCode,
  safeText,
};
