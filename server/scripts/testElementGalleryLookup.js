const assert = require('assert');
const {
  collectAiTerms,
  lookupElementGalleryForAiMapping,
  resolveGalleryIndexPath,
} = require('../services/elementGalleryLookup');

const galleryEntries = [
  {
    element_term: 'Baby Shower',
    normalized_term: 'baby shower',
    term_type: 'OCCASION',
    candidate_source_design_images_via_sku: [
      {
        sku: 'A000001',
        source_title: 'Hidden internal product title',
        category_label: 'Party',
        source_image_url: 'https://assets.example.test/baby-shower.png',
        source_image_filename: 'baby-shower.png',
        found_local: true,
        usage_scope: 'designer_gallery_reference',
      },
      {
        sku: 'A000002',
        source_title: 'Hidden internal product title',
        category_label: 'Party',
        source_image_url: 'https://assets.example.test/shared.png',
        source_image_filename: 'shared.png',
        found_local: true,
        usage_scope: 'designer_gallery_reference',
      },
    ],
  },
  {
    element_term: 'Flower Bloom',
    normalized_term: 'flower bloom',
    term_type: 'PATTERN',
    candidate_source_design_images_via_sku: [
      {
        sku: 'A000003',
        source_title: 'Hidden internal product title',
        category_label: 'Party',
        source_image_url: 'https://assets.example.test/shared.png',
        source_image_filename: 'shared.png',
        found_local: true,
        usage_scope: 'designer_gallery_reference',
      },
    ],
  },
];

const aiMapping = {
  ai_status: 'success',
  primary_element_terms: [
    {
      term: 'baby shower',
      confidence: 0.91,
      source_fields: ['project_name'],
    },
  ],
  style_terms: [
    {
      term: 'flower bloom',
      confidence: 0.86,
      source_fields: ['development_keywords'],
    },
  ],
};

function main() {
  const terms = collectAiTerms(aiMapping);
  assert.deepStrictEqual(
    terms.map((term) => `${term.role}:${term.normalized_term}`),
    ['primary:baby shower', 'style:flower bloom'],
  );

  const result = lookupElementGalleryForAiMapping(aiMapping, {
    galleryEntries,
    env: {
      ELEMENT_SOURCE_GALLERY_INDEX_PATH: __filename,
    },
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.terms_count, 2);
  assert.strictEqual(result.primary_element_gallery_matches.length, 1);
  assert.strictEqual(result.scene_element_gallery_matches.length, 0);
  assert.strictEqual(result.style_element_gallery_matches.length, 1);
  assert.strictEqual(result.attribute_element_gallery_matches.length, 0);
  assert.strictEqual(result.other_element_gallery_matches.length, 1);
  assert.strictEqual(result.image_count, 2);
  assert.strictEqual(result.max_intersection_count, 2);

  const sharedNode = result.graph.nodes.find(
    (node) => node.node_type === 'gallery_image' && node.filename === 'shared.png',
  );
  assert(sharedNode);
  assert.strictEqual(sharedNode.term_count, 2);
  assert.strictEqual(sharedNode.is_top_intersection, true);

  const styleNode = result.graph.nodes.find(
    (node) => node.node_type === 'element_term' && node.role === 'style',
  );
  assert(styleNode);

  const sharedCandidate = result.style_element_gallery_matches[0].candidate_images.find(
    (image) => image.filename === 'shared.png',
  );
  assert(sharedCandidate);
  assert.strictEqual(sharedCandidate.intersection_count, 2);
  assert.strictEqual(sharedCandidate.is_top_intersection, true);

  const serialized = JSON.stringify(result);
  assert(!serialized.includes('A000001'));
  assert(!serialized.includes('Hidden internal product title'));
  assert(!Object.prototype.hasOwnProperty.call(result.primary_element_gallery_matches[0], 'source_skus'));

  const missing = lookupElementGalleryForAiMapping(aiMapping, {
    env: {
      ELEMENT_SOURCE_GALLERY_INDEX_PATH: 'C:/definitely/missing/element-source-gallery-index.json',
    },
  });
  assert.strictEqual(missing.status, 'missing_index');
  assert.strictEqual(missing.error.type, 'missing_index');

  assert(resolveGalleryIndexPath({
    ELEMENT_SOURCE_GALLERY_INDEX_PATH: 'C:/tmp/custom-gallery.json',
  }).endsWith('custom-gallery.json'));

  console.log('[test:element-gallery] Element gallery lookup tests passed.');
}

if (require.main === module) {
  main();
}
