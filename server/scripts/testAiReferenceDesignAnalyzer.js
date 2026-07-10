const assert = require('assert');
const {
  analyzeCompanyReferenceImagesForDesignText,
  buildReferenceDesignAnalysisRequestBody,
  collectReferenceImageCandidates,
  hasQualifiedGalleryImage,
  validateReferenceDesignPayload,
  hasDesignReferenceOrBackgroundDirective,
} = require('../services/aiReferenceDesignAnalyzer');

const proposal = {
  project_code: 'YXF2603230144',
  project_name: 'dragon flame dice party plates',
  ai_graphic_elements: 'dragon; flame dice',
  real_graphic_elements: '',
  category_label: '餐盘',
  color_requirement: 'black and red',
  reference_images: [
    {
      source_field: 'design_img',
      label: '设计参考图',
      raw_path: 'temp/dragon-reference.png',
      url: 'https://assets.example.test/static/temp/dragon-reference.png',
      filename: 'dragon-reference.png',
    },
    {
      source_field: 'oper_img',
      label: '运营参考图',
      raw_path: 'temp/plain-reference.png',
      url: 'https://assets.example.test/static/temp/plain-reference.png',
      filename: 'plain-reference.png',
    },
  ],
};

const aiMapping = {
  primary_element_terms: [
    {
      term: 'dragon',
      confidence: 0.92,
      source_fields: ['project_name'],
    },
  ],
  style_terms: [],
};

async function main() {
  assert.strictEqual(hasQualifiedGalleryImage({
    selected_images: [{ match_score: 0.81 }],
  }, 0.8), true);
  assert.strictEqual(hasQualifiedGalleryImage({
    selected_images: [{ match_score: 0.79 }],
  }, 0.8), false);
  assert.strictEqual(hasDesignReferenceOrBackgroundDirective({
    design_requirement: '图案风格见参考图1，紫色底',
  }), true);
  assert.strictEqual(hasDesignReferenceOrBackgroundDirective({
    design_requirement: '大餐盘尺寸23cm',
  }), false);

  const candidates = collectReferenceImageCandidates(proposal, 4);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].reference_index, 1);
  assert.strictEqual(candidates[0].source_field, 'design_img');
  assert.strictEqual(candidates[0].filename, 'dragon-reference.png');

  const requestBody = buildReferenceDesignAnalysisRequestBody({
    model: 'gpt-5.5',
    maxTokens: 1000,
    minMatchScore: 0.72,
    responseFormat: 'json_object',
  }, proposal, ['dragon', 'flame dice'], candidates);
  assert.strictEqual(requestBody.stream, false);
  assert.strictEqual(requestBody.response_format.type, 'json_object');
  assert(requestBody.messages[1].content.some((part) => part.type === 'image_url'));
  assert(JSON.stringify(requestBody.messages).includes('company_reference_images'));
  assert(JSON.stringify(requestBody.messages).includes('Do not return image URLs'));
  assert(JSON.stringify(requestBody.messages).includes('background_treatment'));
  assert(!JSON.stringify(requestBody.messages).includes('plain-reference.png'));
  assert(!JSON.stringify(requestBody.messages).includes('oper_img'));

  const validated = validateReferenceDesignPayload({
    matched_references: [
      {
        reference_index: 1,
        is_match: true,
        match_score: 0.88,
        matched_graphic_elements: ['dragon'],
        design_information: {
          motif_treatment: 'Use a curled dragon silhouette with small flame accents.',
          composition: 'Central badge composition with supporting corner details.',
          color_palette: 'Black base with red flame contrast.',
          background_treatment: 'Deep black smoky base with sparse red spark accents.',
          style_texture: 'Clean vector edges and light scale texture.',
          usable_details: ['small sparks around the main motif'],
        },
        reason: 'The dragon motif is visible.',
      },
      {
        reference_index: 2,
        is_match: true,
        match_score: 0.31,
      },
    ],
    design_reference_summary: 'Text-only dragon composition and black-red palette.',
    prompt_notes: ['Use a central dragon badge.', 'Keep flame accents secondary.'],
  }, candidates, {
    minMatchScore: 0.72,
  });
  assert.strictEqual(validated.matched_references.length, 1);
  assert.strictEqual(validated.matched_references[0].filename, 'dragon-reference.png');
  assert.strictEqual(
    validated.matched_references[0].design_information.background_treatment,
    'Deep black smoky base with sparse red spark accents.',
  );
  assert(!Object.prototype.hasOwnProperty.call(validated.matched_references[0], 'url'));

  let requestSent = null;
  const aiResult = await analyzeCompanyReferenceImagesForDesignText(proposal, aiMapping, {
    selected_images: [{ match_score: 0.66 }],
  }, {
    env: {
      AI_REFERENCE_DESIGN_ANALYZER_BASE_URL: 'https://ai.example.test/v1',
      AI_REFERENCE_DESIGN_ANALYZER_API_KEY: 'test-key',
      AI_REFERENCE_DESIGN_ANALYZER_TIMEOUT_MS: '5000',
    },
    fetchImpl: async (_url, options) => {
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
                    matched_references: [
                      {
                        reference_index: 1,
                        is_match: true,
                        match_score: 0.91,
                        matched_graphic_elements: ['dragon', 'flame dice'],
                        design_information: {
                          motif_treatment: 'Dragon head and flame details can inform the new motif.',
                          composition: 'Use centered main art with small surrounding icons.',
                          color_palette: 'Black, red, and warm orange contrast.',
                          background_treatment: 'Dark warm gradient base with small ember dots behind the motif.',
                          style_texture: 'Sharp illustrated edges with light glow.',
                          usable_details: ['flame outline rhythm', 'secondary dice accents'],
                        },
                        reason: 'Matches the requested dragon/fire visual language.',
                      },
                    ],
                    design_reference_summary: 'Borrow the black-red fire contrast and centered dragon motif as text guidance only.',
                    prompt_notes: [
                      'Use the company reference only as text guidance.',
                      'Do not use the original reference image as an input image.',
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
  assert(requestSent.messages[1].content.some((part) => part.type === 'image_url'));
  assert(!JSON.stringify(requestSent).includes('test-key'));
  assert.strictEqual(aiResult.status, 'success');
  assert.strictEqual(aiResult.triggered_by_no_qualified_gallery_images, true);
  assert.strictEqual(aiResult.matched_reference_count, 1);
  assert.strictEqual(aiResult.matched_references[0].filename, 'dragon-reference.png');
  assert.strictEqual(
    aiResult.matched_references[0].design_information.background_treatment,
    'Dark warm gradient base with small ember dots behind the motif.',
  );
  assert(!JSON.stringify(aiResult).includes('https://assets.example.test/static/temp/dragon-reference.png'));
  assert(aiResult.prompt_notes.some((note) => note.includes('text guidance')));

  let directiveRequestSent = null;
  const directiveResult = await analyzeCompanyReferenceImagesForDesignText({
    ...proposal,
    design_requirement: '图案风格见参考图1，紫色底',
  }, aiMapping, {
    selected_images: [{ match_score: 0.9 }],
  }, {
    env: {
      AI_REFERENCE_DESIGN_ANALYZER_BASE_URL: 'https://ai.example.test/v1',
      AI_REFERENCE_DESIGN_ANALYZER_API_KEY: 'test-key',
    },
    fetchImpl: async (_url, options) => {
      directiveRequestSent = JSON.parse(options.body);
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
                    matched_references: [
                      {
                        reference_index: 1,
                        is_match: true,
                        match_score: 0.9,
                        matched_graphic_elements: ['dragon'],
                        design_information: {
                          background_treatment: 'Purple gradient background with tiny gold dots.',
                          color_palette: 'Purple and gold.',
                        },
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
  assert(directiveRequestSent);
  assert.strictEqual(directiveResult.status, 'success');
  assert.strictEqual(directiveResult.triggered_by_no_qualified_gallery_images, false);
  assert.strictEqual(
    directiveResult.matched_references[0].design_information.background_treatment,
    'Purple gradient background with tiny gold dots.',
  );

  const skipped = await analyzeCompanyReferenceImagesForDesignText(proposal, aiMapping, {
    selected_images: [{ match_score: 0.9 }],
  }, {
    env: {
      AI_REFERENCE_DESIGN_ANALYZER_BASE_URL: 'https://ai.example.test/v1',
      AI_REFERENCE_DESIGN_ANALYZER_API_KEY: 'test-key',
    },
  });
  assert.strictEqual(skipped.status, 'skipped_qualified_gallery_images');

  console.log('[test:ai-reference-design-analysis] AI reference design analyzer tests passed.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
