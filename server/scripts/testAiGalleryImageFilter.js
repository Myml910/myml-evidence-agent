const assert = require('assert');
const {
  buildGalleryImageFilterRequestBody,
  collectGalleryImageCandidates,
  collectRequiredGraphicElements,
  filterGalleryImagesForGraphicElements,
  validateGalleryImageFilterPayload,
} = require('../services/aiGalleryImageFilter');

const TINY_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const proposal = {
  project_code: 'YXF2603230144',
  project_name: 'dinosaur party plates',
  ai_graphic_elements: 'dinosaur',
  real_graphic_elements: '',
  design_requirement: 'Use dinosaur pattern for the party design.',
  category_label: '餐盘',
};

const aiMapping = {
  primary_element_terms: [
    {
      term: 'dinosaur',
      confidence: 0.92,
      source_fields: ['project_name'],
    },
  ],
  style_terms: [
    {
      term: 'green',
      confidence: 0.72,
      source_fields: ['color_requirement'],
    },
  ],
};

const elementGallery = {
  status: 'success',
  primary_element_gallery_matches: [
    {
      raw_term: 'dinosaur',
      normalized_term: 'dinosaur',
      role: 'primary',
      role_label: 'primary',
      candidate_images: [
        {
          image_id: 'https://assets.example.test/dino.png',
          url: 'https://assets.example.test/dino.png',
          filename: 'dino.png',
          category_label: 'Party',
          found_local: true,
          usage_scope: 'designer_gallery_reference',
          intersection_count: 2,
          is_top_intersection: true,
        },
        {
          image_id: 'https://assets.example.test/plain.png',
          url: 'https://assets.example.test/plain.png',
          filename: 'plain.png',
          category_label: 'Party',
          found_local: true,
          usage_scope: 'designer_gallery_reference',
          intersection_count: 1,
          is_top_intersection: false,
        },
      ],
    },
  ],
  style_element_gallery_matches: [
    {
      raw_term: 'green',
      normalized_term: 'green',
      role: 'style',
      role_label: 'style',
      candidate_images: [
        {
          image_id: 'https://assets.example.test/dino.png',
          url: 'https://assets.example.test/dino.png',
          filename: 'dino.png',
          category_label: 'Party',
          found_local: true,
          usage_scope: 'designer_gallery_reference',
          intersection_count: 2,
          is_top_intersection: true,
        },
      ],
    },
  ],
};

async function main() {
  const required = collectRequiredGraphicElements(proposal, aiMapping);
  assert(required.includes('dinosaur'));
  assert(!required.includes('green'));

  const candidates = collectGalleryImageCandidates(elementGallery, 10);
  assert.strictEqual(candidates.length, 2);
  assert.strictEqual(candidates[0].filename, 'dino.png');
  assert.strictEqual(candidates[0].connected_terms.length, 2);
  assert.strictEqual(candidates[0].image_index, 1);

  const validated = validateGalleryImageFilterPayload({
    selected_images: [
      {
        image_index: 1,
        match_score: 0.94,
        matched_graphic_elements: ['dinosaur'],
        reason: 'Visible dinosaur motif.',
      },
      {
        image_index: 2,
        match_score: 0.4,
        matched_graphic_elements: ['green'],
        reason: 'Below threshold and should be filtered.',
      },
      {
        image_index: 999,
        match_score: 0.99,
      },
    ],
  }, candidates, {
    minScore: 0.62,
  });
  assert.strictEqual(validated.length, 1);
  assert.strictEqual(validated[0].filename, 'dino.png');
  assert.strictEqual(validated[0].match_score, 0.94);

  const requestBody = buildGalleryImageFilterRequestBody({
    model: 'gpt-5.5',
    maxTokens: 1200,
    minScore: 0.62,
    responseFormat: 'json_object',
  }, proposal, required, candidates);
  assert.strictEqual(requestBody.stream, false);
  assert.strictEqual(requestBody.response_format.type, 'json_object');
  assert(requestBody.messages[1].content.some((part) => part.type === 'image_url'));
  assert(JSON.stringify(requestBody.messages).includes('candidate_images'));

  let requestSent = null;
  const aiResult = await filterGalleryImagesForGraphicElements(proposal, aiMapping, elementGallery, {
    env: {
      AI_GALLERY_IMAGE_FILTER_BASE_URL: 'https://ai.example.test/v1',
      AI_GALLERY_IMAGE_FILTER_API_KEY: 'test-key',
      AI_GALLERY_IMAGE_FILTER_TIMEOUT_MS: '5000',
      AI_GALLERY_IMAGE_FILTER_MIN_SCORE: '0.62',
    },
    fetchImpl: async (_url, options = {}) => {
      if (!options.body) {
        return {
          ok: true,
          status: 200,
          headers: {
            get() {
              return 'application/octet-stream';
            },
          },
          async arrayBuffer() {
            return TINY_PNG_BUFFER;
          },
        };
      }

      requestSent = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: {
          get() {
            return 'application/json';
          },
        },
        async text() {
          return JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    selected_images: [
                      {
                        image_index: 1,
                        match_score: 0.95,
                        matched_graphic_elements: ['dinosaur'],
                        reason: 'The dinosaur is visible and matches the motif.',
                      },
                    ],
                  }),
                },
              },
            ],
          });
        },
      };
    },
  });

  assert.strictEqual(requestSent.model, 'gpt-5.5');
  assert(!JSON.stringify(requestSent).includes('test-key'));
  assert(JSON.stringify(requestSent).includes('data:image/png;base64,'));
  assert.strictEqual(aiResult.status, 'success');
  assert.strictEqual(aiResult.candidate_image_count, 2);
  assert.strictEqual(aiResult.selected_image_count, 1);
  assert.strictEqual(aiResult.rejected_image_count, 1);
  assert.strictEqual(aiResult.selected_images[0].filename, 'dino.png');

  const missingConfig = await filterGalleryImagesForGraphicElements(proposal, aiMapping, elementGallery, {
    env: {},
  });
  assert.strictEqual(missingConfig.status, 'missing_config');
  assert.strictEqual(missingConfig.selected_images.length, 0);

  console.log('[test:ai-gallery-image-filter] AI gallery image filter tests passed.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
