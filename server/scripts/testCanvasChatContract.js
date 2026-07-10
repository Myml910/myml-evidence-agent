const assert = require('assert');
const http = require('http');
const express = require('express');
const { createCanvasChatRouter } = require('../services/canvasChatContract');

function mockPrepareProposalFromCompanyLookup(input) {
  const projectCode = input.projectCode;
  if (projectCode === 'YXF2600000000') {
    return Promise.resolve({
      project_code: projectCode,
      found: false,
      error_code: 'COMPANY_PROJECT_NOT_FOUND',
      error_message: 'not found',
    });
  }

  return Promise.resolve({
    project_code: projectCode,
    found: true,
    proposal: {
      project_code: projectCode,
      project_name: 'baby in bloom plates',
      category: '125',
      category_label: '餐盘',
      design_requirement: 'Use soft watercolor floral design.',
      element_requirement: 'baby in bloom',
      ai_graphic_elements: 'baby in bloom',
      real_graphic_elements: '',
      text_elements: '文案 Baby in Bloom；中文说明不是设计文字',
      color_requirement: 'pink, sage green',
      style_requirement: 'soft watercolor',
      reference_images: [
        {
          source_field: 'design_img',
          label: '设计参考图',
          raw_path: 'C:/secret/local/path/design.png',
          url: 'https://assets.example.test/design.png?token=secret#fragment',
          filename: 'design.png',
        },
      ],
    },
    category_judgment: {
      status: 'success',
      predicted_category: '餐盘',
      confidence: 0.99,
      reason: 'Project title and development requirement mention plates.',
      category_image: {
        category: '餐盘',
        image_filename: 'plate-history.png',
        image_url: 'https://assets.example.test/plate-history.png',
        note: 'history layout',
        source: 'manual',
        history_images: [
          {
            image_filename: 'plate-history-1.png',
            image_url: 'https://assets.example.test/plate-history-1.png',
            note: 'history layout 1',
            source: 'manual',
            created_at: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
    },
    selected_gallery_images: {
      status: 'success',
      selected_image_count: 1,
      selected_images: [
        {
          image_id: 'gallery-image-1',
          filename: 'baby-in-bloom.png',
          url: 'https://assets.example.test/baby-in-bloom.png',
          category_label: 'baby shower',
          usage_scope: 'material',
          match_score: 0.96,
          matched_graphic_elements: ['baby in bloom'],
          reason: 'Matches the required motif.',
        },
      ],
    },
    reference_design_analysis: {
      status: 'skipped',
    },
    ai_element_mapping: {
      ai_status: 'success',
    },
  });
}

async function withServer(callback) {
  const previousToken = process.env.MYML_EVIDENCE_AGENT_TOKEN;
  process.env.MYML_EVIDENCE_AGENT_TOKEN = 'test-evidence-token';

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/v1', createCanvasChatRouter({
    prepareProposalFromCompanyLookup: mockPrepareProposalFromCompanyLookup,
    prepareProjectFinalDisplay: async ({ projectCode }) => ({
      status: 'completed',
      source: 'generated_project_final_display',
      project: {
        projectCode,
        graphicElements: 'baby in bloom',
        textElements: 'Baby in Bloom',
      },
      designReferenceImages: [{ id: 'ref_1', imageUrl: 'https://assets.example.test/design.png' }],
      run: {
        runId: 'run_test_final',
        projectCode,
        status: 'completed',
        elementImages: [{ id: 'element_1', imageUrl: 'https://assets.example.test/element.png' }],
        finalDesignImages: [{ id: 'final_1', imageUrl: 'https://assets.example.test/final.png' }],
      },
      usage: { providerCost: true },
    }),
    projectRunStore: {
      getProjectRun: (runId) => (runId === 'run_test_1'
        ? {
            runId,
            projectCode: 'YXF2603230144',
            status: 'completed',
            createdAt: '2026-07-07T00:00:00.000Z',
            updatedAt: '2026-07-07T00:01:00.000Z',
            elementImages: [{ id: 'element_1', imageUrl: 'https://assets.example.test/element.png' }],
            finalDesignImages: [{ id: 'final_1', imageUrl: 'https://assets.example.test/final.png' }],
          }
        : null),
      getLatestProjectRunForCode: (projectCode) => (projectCode === 'YXF2603230144'
        ? {
            runId: 'run_test_1',
            projectCode,
            status: 'completed',
            createdAt: '2026-07-07T00:00:00.000Z',
            updatedAt: '2026-07-07T00:01:00.000Z',
            elementImages: [{ id: 'element_1', imageUrl: 'https://assets.example.test/element.png' }],
            finalDesignImages: [{ id: 'final_1', imageUrl: 'https://assets.example.test/final.png' }],
          }
        : null),
    },
    publicBaseUrlFromRequest: (request) => `${request.protocol}://${request.get('host')}`,
    version: '0.1.0-test',
  }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await callback(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousToken === undefined) {
      delete process.env.MYML_EVIDENCE_AGENT_TOKEN;
    } else {
      process.env.MYML_EVIDENCE_AGENT_TOKEN = previousToken;
    }
  }
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

function authHeaders() {
  return {
    Authorization: 'Bearer test-evidence-token',
    'X-MYML-Caller': 'myml-canvas',
  };
}

function assertSafeJson(body) {
  const serialized = JSON.stringify(body);
  assert(!serialized.includes('token=secret'));
  assert(!serialized.includes('C:/secret'));
  assert(!serialized.includes('base64'));
  assert(!serialized.includes('test-evidence-token'));
}

async function main() {
  await withServer(async (baseUrl) => {
    const health = await requestJson(baseUrl, '/v1/health');
    assert.strictEqual(health.response.status, 200);
    assert.strictEqual(health.body.status, 'ok');
    assert.strictEqual(health.body.service, 'myml-evidence-agent');

    const unauthorized = await requestJson(baseUrl, '/v1/projects/lookup', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'missing_auth', projectCode: 'YXF2603230144' }),
    });
    assert.strictEqual(unauthorized.response.status, 401);
    assert.strictEqual(unauthorized.body.error.code, 'EVIDENCE_AGENT_UNAUTHORIZED');

    const capabilities = await requestJson(baseUrl, '/v1/capabilities', {
      headers: authHeaders(),
    });
    assert.strictEqual(capabilities.response.status, 200);
    assert.strictEqual(capabilities.body.capabilities.projectCodeLookup, true);
    assert.strictEqual(capabilities.body.capabilities.projectRunResults, true);
    assert.strictEqual(capabilities.body.productizedFlow.input, 'project_code');

    const projectRun = await requestJson(baseUrl, '/v1/project-runs/run_test_1', {
      headers: authHeaders(),
    });
    assert.strictEqual(projectRun.response.status, 200);
    assert.strictEqual(projectRun.body.run.runId, 'run_test_1');
    assert.strictEqual(projectRun.body.run.elementImages.length, 1);
    assert.strictEqual(projectRun.body.run.finalDesignImages.length, 1);

    const latestRun = await requestJson(baseUrl, '/v1/projects/YXF2603230144/latest-result', {
      headers: authHeaders(),
    });
    assert.strictEqual(latestRun.response.status, 200);
    assert.strictEqual(latestRun.body.run.runId, 'run_test_1');

    const finalDisplay = await requestJson(baseUrl, '/v1/projects/YXF2603230144/final-display', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ requestId: 'final_display_ok', options: { waitForResult: true } }),
    });
    assert.strictEqual(finalDisplay.response.status, 200);
    assert.strictEqual(finalDisplay.body.kind, 'project_final_display');
    assert.strictEqual(finalDisplay.body.run.elementImages.length, 1);
    assert.strictEqual(finalDisplay.body.run.finalDesignImages.length, 1);

    const invalidCode = await requestJson(baseUrl, '/v1/projects/lookup', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ requestId: 'bad_code', projectCode: 'ABC123' }),
    });
    assert.strictEqual(invalidCode.response.status, 400);
    assert.strictEqual(invalidCode.body.error.code, 'EVIDENCE_AGENT_INVALID_PROJECT_CODE');

    const lookup = await requestJson(baseUrl, '/v1/projects/lookup', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        requestId: 'lookup_ok',
        projectCode: 'YXF2603230144',
        options: { includeMaterials: true, includeHistory: true, includeFinalDesigns: true },
      }),
    });
    assert.strictEqual(lookup.response.status, 200);
    assert.strictEqual(lookup.body.status, 'completed');
    assert.strictEqual(lookup.body.project.projectCode, 'YXF2603230144');
    assert.strictEqual(lookup.body.materials.length, 1);
    assert.strictEqual(lookup.body.historyDesigns.length, 1);
    assert.strictEqual(lookup.body.elementImages.length, 1);
    assert.strictEqual(lookup.body.elementImages[0].imageUrl, 'https://assets.example.test/design.png');
    assert.strictEqual(lookup.body.elementImages[0].thumbnailUrl, 'https://assets.example.test/design.png');
    assert.strictEqual(lookup.body.finalDesigns.length, 0);
    assert.strictEqual(lookup.body.displayState.status, 'thinking_design');
    assert.strictEqual(lookup.body.project.textElements, 'Baby in Bloom');
    assert(!lookup.body.project.textElements.includes('文案'));
    assert(lookup.body.designTasks.some((task) => task.id === 'final_image_generation'));
    assertSafeJson(lookup.body);

    const search = await requestJson(baseUrl, '/v1/evidence/search', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ requestId: 'search_ok', query: 'YXF2603230144 baby in bloom' }),
    });
    assert.strictEqual(search.response.status, 200);
    assert.strictEqual(search.body.status, 'completed');
    assert(search.body.results.length > 0);
    assertSafeJson(search.body);

    const chat = await requestJson(baseUrl, '/v1/canvas-chat/respond', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        requestId: 'chat_ok',
        conversation: { language: 'zh' },
        message: { text: '帮我看一下 YXF2603230144 的素材图和最终生成输入。' },
        canvasContext: {
          version: 1,
          workflow: { nodeCount: 2 },
          nodes: [{ id: 'node-1', prompt: 'safe node text' }],
        },
        options: { includeDraftAnswer: true, maxEvidenceItems: 6 },
      }),
    });
    assert.strictEqual(chat.response.status, 200);
    assert.strictEqual(chat.body.status, 'completed');
    assert.strictEqual(chat.body.intent, 'project_lookup');
    assert.strictEqual(chat.body.evidence.length, 1);
    assert.strictEqual(chat.body.evidence[0].type, 'company_project_preview');
    assert.strictEqual(chat.body.project.textElements, 'Baby in Bloom');
    assert.strictEqual(chat.body.project.graphicElements, 'baby in bloom');
    assert.strictEqual(chat.body.designReferenceImages.length, 1);
    assert.strictEqual(chat.body.designReferenceImages[0].imageUrl, 'https://assets.example.test/design.png');
    assert.strictEqual(chat.body.displayState.status, 'thinking_design');
    assert.strictEqual('materials' in chat.body, false);
    assert.strictEqual('historyDesigns' in chat.body, false);
    assert.strictEqual('finalDesigns' in chat.body, false);
    assert.strictEqual('designTasks' in chat.body, false);
    assert(!chat.body.draftAnswer.text.includes('history layout'));
    assert(!chat.body.draftAnswer.text.includes('material image block'));
    assertSafeJson(chat.body);

    const notFound = await requestJson(baseUrl, '/v1/projects/lookup', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ requestId: 'not_found', projectCode: 'YXF2600000000' }),
    });
    assert.strictEqual(notFound.response.status, 404);
    assert.strictEqual(notFound.body.error.code, 'EVIDENCE_AGENT_PROJECT_NOT_FOUND');
  });

  console.log('[test:canvas-chat-contract] Canvas chat contract tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
