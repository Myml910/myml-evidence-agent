const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeText } = require('./elementTermExtractor');

const DEFAULT_MAX_IMAGES_PER_TERM = 8;
const DEFAULT_MAX_GRAPH_IMAGES = 40;
const GALLERY_INDEX_RELATIVE_PATH = path.join('data', 'indexes', 'element-source-gallery-index.json');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function candidateKnowledgeBaseRoots(env = process.env) {
  return [
    cleanString(env.MYML_DESIGN_KNOWLEDGE_BASE_PATH),
    cleanString(env.DESIGN_KNOWLEDGE_BASE_PATH),
    path.join(
      os.homedir(),
      'Documents',
      'Codex',
      '2026-06-25',
      'myml-design-knowledge-base-github-myml',
      'myml-design-knowledge-base',
    ),
    path.resolve(__dirname, '..', '..', '..', 'myml-design-knowledge-base'),
  ].filter(Boolean);
}

function resolveGalleryIndexPath(env = process.env) {
  const explicitIndexPath = cleanString(env.ELEMENT_SOURCE_GALLERY_INDEX_PATH);
  if (explicitIndexPath) {
    return path.resolve(explicitIndexPath);
  }

  for (const root of candidateKnowledgeBaseRoots(env)) {
    const candidatePath = path.join(root, GALLERY_INDEX_RELATIVE_PATH);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  const preferredRoot = candidateKnowledgeBaseRoots(env)[0] || '';
  return preferredRoot ? path.join(preferredRoot, GALLERY_INDEX_RELATIVE_PATH) : '';
}

function readJsonArray(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('Element gallery index must be a JSON array.');
  }
  return parsed;
}

function buildGalleryByTerm(entries) {
  const byTerm = new Map();

  for (const entry of entries) {
    const normalizedTerm = normalizeText(entry?.normalized_term || entry?.element_term);
    if (!normalizedTerm) {
      continue;
    }
    if (!byTerm.has(normalizedTerm)) {
      byTerm.set(normalizedTerm, []);
    }
    byTerm.get(normalizedTerm).push(entry);
  }

  return byTerm;
}

function collectAiTerms(aiMapping = {}) {
  const groups = [
    {
      key: 'primary_element_terms',
      role: 'primary',
      label: '一级元素词',
    },
    {
      key: 'other_element_terms',
      role: 'other',
      label: '其他元素词',
    },
    {
      key: 'scene_terms',
      role: 'scene',
      label: '场景词',
    },
    {
      key: 'style_terms',
      role: 'style',
      label: '风格词',
    },
    {
      key: 'attribute_terms',
      role: 'attribute',
      label: '属性词',
    },
  ];
  const seen = new Set();
  const terms = [];

  for (const group of groups) {
    const items = Array.isArray(aiMapping[group.key]) ? aiMapping[group.key] : [];
    for (const item of items) {
      const rawTerm = cleanString(
        item.raw_term ||
          item.term ||
          item.matched_normalized_term ||
          item.matched_term ||
          item.normalized_term,
      );
      const normalizedTerm = normalizeText(item.matched_normalized_term || item.term || rawTerm);
      if (!normalizedTerm) {
        continue;
      }

      const dedupeKey = `${group.role}:${normalizedTerm}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      terms.push({
        raw_term: rawTerm || normalizedTerm,
        normalized_term: normalizedTerm,
        role: group.role,
        role_label: group.label,
        source_fields: Array.isArray(item.source_fields)
          ? item.source_fields.map(String).filter(Boolean)
          : [],
        confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
      });
    }
  }

  return terms;
}

function makeImageId(image = {}) {
  return cleanString(image.source_image_url || image.source_image_filename || image.source_image_path);
}

function safeImageCandidate(image = {}) {
  const id = makeImageId(image);
  if (!id) {
    return null;
  }

  return {
    image_id: id,
    url: cleanString(image.source_image_url),
    filename: cleanString(image.source_image_filename),
    category_label: cleanString(image.category_label),
    found_local: image.found_local === true,
    usage_scope: cleanString(image.usage_scope) || 'designer_gallery_reference',
  };
}

function uniqueImageCandidates(images) {
  const seen = new Set();
  const result = [];

  for (const image of images) {
    if (!image || seen.has(image.image_id)) {
      continue;
    }
    seen.add(image.image_id);
    result.push(image);
  }

  return result;
}

function emptyElementGallery(status = 'skipped', error = null) {
  return {
    status,
    source: 'element_source_gallery_index',
    terms_count: 0,
    matched_terms_count: 0,
    image_count: 0,
    max_intersection_count: 0,
    primary_element_gallery_matches: [],
    scene_element_gallery_matches: [],
    style_element_gallery_matches: [],
    attribute_element_gallery_matches: [],
    other_element_gallery_matches: [],
    graph: {
      nodes: [],
      edges: [],
    },
    error,
  };
}

function lookupElementGalleryForAiMapping(aiMapping = {}, options = {}) {
  const env = options.env || process.env;
  const maxImagesPerTerm = parsePositiveInteger(
    env.ELEMENT_GALLERY_MAX_IMAGES_PER_TERM,
    DEFAULT_MAX_IMAGES_PER_TERM,
  );
  const maxGraphImages = parsePositiveInteger(
    env.ELEMENT_GALLERY_MAX_GRAPH_IMAGES,
    DEFAULT_MAX_GRAPH_IMAGES,
  );
  const aiTerms = collectAiTerms(aiMapping);

  if (aiTerms.length === 0) {
    return emptyElementGallery('skipped');
  }

  const indexPath = resolveGalleryIndexPath(env);
  if (!indexPath || !fs.existsSync(indexPath)) {
    return emptyElementGallery('missing_index', {
      type: 'missing_index',
      message: 'Element source gallery index was not found.',
    });
  }

  try {
    const entries = options.galleryEntries || readJsonArray(indexPath);
    const galleryByTerm = buildGalleryByTerm(entries);
    const imageTerms = new Map();
    const termNodes = [];
    const edgeCandidates = [];
    const primaryMatches = [];
    const sceneMatches = [];
    const styleMatches = [];
    const attributeMatches = [];
    const otherMatches = [];

    for (const aiTerm of aiTerms) {
      const entriesForTerm = galleryByTerm.get(aiTerm.normalized_term) || [];
      const candidateImages = uniqueImageCandidates(
        entriesForTerm.flatMap((entry) =>
          (entry.candidate_source_design_images_via_sku || [])
            .map((image) => {
              const candidate = safeImageCandidate(image);
              return candidate
                ? {
                    ...candidate,
                    term_type: cleanString(entry.term_type),
                  }
                : null;
            })
            .filter(Boolean),
        ),
      ).slice(0, maxImagesPerTerm);

      const termNodeId = `term:${aiTerm.role}:${aiTerm.normalized_term}`;
      termNodes.push({
        id: termNodeId,
        node_type: 'element_term',
        role: aiTerm.role,
        label: aiTerm.normalized_term,
        raw_term: aiTerm.raw_term,
      });

      for (const image of candidateImages) {
        if (!imageTerms.has(image.image_id)) {
          imageTerms.set(image.image_id, new Set());
        }
        imageTerms.get(image.image_id).add(aiTerm.normalized_term);
        edgeCandidates.push({
          id: `${termNodeId}->image:${image.image_id}`,
          source: termNodeId,
          target: `image:${image.image_id}`,
        });
      }

      const match = {
        raw_term: aiTerm.raw_term,
        normalized_term: aiTerm.normalized_term,
        term_type: cleanString(entriesForTerm[0]?.term_type),
        role: aiTerm.role,
        role_label: aiTerm.role_label,
        source_fields: aiTerm.source_fields,
        confidence: aiTerm.confidence,
        gallery_candidate_count: candidateImages.length,
        candidate_images: candidateImages,
      };

      if (aiTerm.role === 'primary') {
        primaryMatches.push(match);
      } else if (aiTerm.role === 'scene') {
        sceneMatches.push(match);
      } else if (aiTerm.role === 'style') {
        styleMatches.push(match);
      } else if (aiTerm.role === 'attribute') {
        attributeMatches.push(match);
      } else {
        otherMatches.push(match);
      }
    }

    const imageEntries = [...imageTerms.entries()]
      .map(([imageId, terms]) => ({
        image_id: imageId,
        term_count: terms.size,
      }))
      .sort((left, right) => {
        if (right.term_count !== left.term_count) {
          return right.term_count - left.term_count;
        }
        return left.image_id.localeCompare(right.image_id, 'en');
      })
      .slice(0, maxGraphImages);
    const graphImageIds = new Set(imageEntries.map((entry) => entry.image_id));
    const maxIntersectionCount = imageEntries.reduce(
      (max, image) => Math.max(max, image.term_count),
      0,
    );

    const imageNodeDetails = new Map();
    const categorizedOtherMatches = [
      ...sceneMatches,
      ...styleMatches,
      ...attributeMatches,
      ...otherMatches,
    ];
    const allMatches = [...primaryMatches, ...categorizedOtherMatches];

    for (const match of allMatches) {
      match.candidate_images = match.candidate_images.map((image) => {
        const termCount = imageTerms.get(image.image_id)?.size || 0;
        const enriched = {
          ...image,
          intersection_count: termCount,
          is_top_intersection: termCount > 1 && termCount === maxIntersectionCount,
        };
        if (!imageNodeDetails.has(image.image_id)) {
          imageNodeDetails.set(image.image_id, enriched);
        }
        return enriched;
      });
    }

    const imageNodes = imageEntries.map((image) => {
      const detail = imageNodeDetails.get(image.image_id) || {};
      return {
        id: `image:${image.image_id}`,
        node_type: 'gallery_image',
        label: detail.filename || 'gallery image',
        url: detail.url || '',
        filename: detail.filename || '',
        term_count: image.term_count,
        is_top_intersection: image.term_count > 1 && image.term_count === maxIntersectionCount,
      };
    });
    const edges = edgeCandidates.filter((edge) =>
      graphImageIds.has(edge.target.replace(/^image:/, '')),
    );

    return {
      status: 'success',
      source: 'element_source_gallery_index',
      terms_count: aiTerms.length,
      matched_terms_count: allMatches.length,
      image_count: imageNodes.length,
      max_intersection_count: maxIntersectionCount,
      primary_element_gallery_matches: primaryMatches,
      scene_element_gallery_matches: sceneMatches,
      style_element_gallery_matches: styleMatches,
      attribute_element_gallery_matches: attributeMatches,
      other_element_gallery_matches: categorizedOtherMatches,
      graph: {
        nodes: [...termNodes, ...imageNodes],
        edges,
      },
      error: null,
    };
  } catch (error) {
    return emptyElementGallery('error', {
      type: 'gallery_lookup_error',
      message: error instanceof Error ? error.message : 'Element gallery lookup failed.',
    });
  }
}

module.exports = {
  collectAiTerms,
  emptyElementGallery,
  lookupElementGalleryForAiMapping,
  resolveGalleryIndexPath,
};
