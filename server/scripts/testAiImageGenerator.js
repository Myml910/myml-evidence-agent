const assert = require('assert');
const {
  buildImageGenerationFetchPayload,
  buildImageGenerationRequestBody,
  collectGeneratedImages,
  generatePatternImage,
} = require('../services/aiImageGenerator');

function fakePngBuffer(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

async function main() {
  const prompt = 'Generate a black flame dice plate design.';
  const wideHistoryPng = fakePngBuffer(2856, 1108);
  const inputImages = [
    {
      id: 'material-1',
      role: 'material',
      label: '素材图 1',
      filename: 'material.png',
      url: 'https://assets.example.test/material.png',
      detail: 'flame dice motif',
    },
    {
      id: 'history-1',
      role: 'history',
      label: '历史设计图',
      filename: 'history.png',
      url: `data:image/png;base64,${wideHistoryPng.toString('base64')}`,
      detail: 'layout master',
    },
  ];

  const imageFetch = async (url) => {
    assert.strictEqual(url, 'https://assets.example.test/material.png');
    return {
      ok: true,
      headers: {
        get() {
          return 'image/png';
        },
      },
      async arrayBuffer() {
        return fakePngBuffer(800, 800);
      },
    };
  };

  const requestBody = await buildImageGenerationRequestBody(prompt, inputImages, {
    model: 'gpt-image-2',
    size: '2048x2048',
    quality: 'standard',
    style: 'vivid',
    n: 1,
    responseFormat: 'url',
    requestMode: 'chat',
    embedInputImages: true,
    maxInputImageBytes: 1024 * 1024,
  }, imageFetch);

  assert.strictEqual(requestBody.model, 'gpt-image-2');
  assert.strictEqual(requestBody.messages[0].role, 'user');
  assert(!Object.prototype.hasOwnProperty.call(requestBody, 'response_format'));
  assert(requestBody.messages[0].content.some((part) => part.type === 'image_url'));
  assert(JSON.stringify(requestBody).includes('构图母版'));

  const editsPayload = await buildImageGenerationFetchPayload(prompt, inputImages, {
    model: 'gpt-image-2',
    size: '2048x2048',
    quality: 'standard',
    style: 'vivid',
    n: 1,
    responseFormat: 'url',
    requestMode: 'edits',
    matchHistoryAspect: true,
    imageFieldName: 'image',
    maxInputImageBytes: 1024 * 1024,
  }, imageFetch, { historyLayoutLockPolicy: 'geometry_lock' });

  assert.strictEqual(typeof editsPayload.body.get, 'function');
  assert.deepStrictEqual(editsPayload.headers, {});
  assert.strictEqual(editsPayload.body.get('model'), 'gpt-image-2');
  assert.strictEqual(editsPayload.body.get('size'), '2048x1024');
  const editPrompt = editsPayload.body.get('prompt');
  assert(editPrompt.includes(prompt));
  assert(editPrompt.includes('按第一张历史图所属的 2K 方/横/竖比例请求输出画布'));
  assert(editPrompt.includes('不要额外加黑边'));
  assert(editPrompt.includes('不要为了填满画布而放大、拉伸、裁切或移动历史版式'));
  assert(editPrompt.includes('版式母版策略：geometry_lock'));
  assert(editPrompt.includes('禁止拉伸、压缩、放大、缩小、裁切、移动或重新排布图1刀模模板'));
  assert(editPrompt.includes('禁止把刀模/版位放大到铺满整张画布'));
  assert(editPrompt.includes('输入图角色与构图硬约束'));
  assert(editPrompt.includes('严格输入顺序'));
  assert(editPrompt.includes('图1/第一张输入图是历史设计图/构图母版'));
  assert(editPrompt.includes('图2及以后是素材图/素材本体来源'));
  assert(editPrompt.includes('宽幅横向版式'));
  assert(editPrompt.includes('横向多设计单元'));
  assert(editPrompt.includes('版位硬锁定'));
  assert(editPrompt.includes('单元数量硬锁定'));
  assert(editPrompt.includes('历史内容禁用'));
  assert(editPrompt.includes('旧文字、旧图案、旧主题'));
  assert(editPrompt.includes('素材图硬边界'));
  assert(editPrompt.includes('素材图是最终素材本体来源'));
  assert(editPrompt.includes('只有用户提示词明确要求但素材图没有的元素才可以创新补充'));
  assert(editPrompt.includes('不要抛弃素材图重新画一套全新元素'));
  assert(editPrompt.includes('背景策略硬约束'));
  assert(editPrompt.includes('素材图中的白底只表示抠图底或素材展示底'));
  assert(editPrompt.includes('最终背景必须服从提示词里的开发思路和公司设计参考图背景策略'));
  assert(editPrompt.includes('背景只能进入历史图已有版位内部'));
  assert(editPrompt.includes('可用素材排入历史版式'));
  assert(editPrompt.includes('不要整张全新重画而忽略素材图'));

  const flexiblePayload = await buildImageGenerationFetchPayload(prompt, inputImages, {
    model: 'gpt-image-2',
    size: '2048x2048',
    quality: 'standard',
    style: 'vivid',
    n: 1,
    responseFormat: 'url',
    requestMode: 'edits',
    matchHistoryAspect: true,
    imageFieldName: 'image',
    maxInputImageBytes: 1024 * 1024,
  }, imageFetch, { historyLayoutLockPolicy: 'flexible_reference' });
  const flexiblePrompt = flexiblePayload.body.get('prompt');
  assert(flexiblePrompt.includes('版式母版策略：flexible_reference'));
  assert(flexiblePrompt.includes('不强行锁死每条刀线、异形轮廓或局部边界'));
  assert(!flexiblePrompt.includes('禁止拉伸、压缩、放大、缩小、裁切、移动或重新排布图1刀模模板'));
  assert(editPrompt.includes('设计质量要求'));
  assert(editPrompt.includes('细节稳定硬约束'));
  assert(editPrompt.includes('Clean and polished image, controllable details, smooth and consistent textures'));
  assert(editPrompt.includes('no over-sharpening, no color blotches, no noise, no broken patterns'));
  assert(editPrompt.includes('版位外的白底、单元间隙、尺寸线、尺寸文字'));
  assert(editPrompt.includes('横向装饰海报'));
  assert(editPrompt.includes('单个圆形餐盘'));
  const editImages = editsPayload.body.getAll('image');
  assert(editImages.length >= 2);
  assert.strictEqual(editImages[0].name, 'history.png');
  assert.strictEqual(editImages[1].name, 'material.png');

  const collected = collectGeneratedImages({
    choices: [
      {
        message: {
          content: JSON.stringify({
            data: [
              {
                url: 'https://assets.example.test/generated.png',
                revised_prompt: 'revised',
              },
            ],
          }),
        },
      },
    ],
  });
  assert.strictEqual(collected.length, 1);
  assert.strictEqual(collected[0].url, 'https://assets.example.test/generated.png');

  let endpointRequest = null;
  const result = await generatePatternImage({
    prompt,
    input_images: inputImages,
  }, {
    env: {
      AI_IMAGE_GENERATOR_BASE_URL: 'https://ai.example.test/v1',
      AI_IMAGE_GENERATOR_API_KEY: 'test-key',
      AI_IMAGE_GENERATOR_MODEL: 'gpt-image-2',
      AI_IMAGE_GENERATOR_REQUEST_MODE: 'images',
      AI_IMAGE_GENERATOR_ENDPOINT_PATH: '/images/generations',
      AI_IMAGE_GENERATOR_RESPONSE_FORMAT: 'url',
    },
    fetchImpl: async (url, options) => {
      if (url === 'https://assets.example.test/material.png') {
        return imageFetch(url);
      }
      endpointRequest = {
        url,
        body: JSON.parse(options.body),
        authorization: options.headers.Authorization,
      };
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
            data: [
              {
                url: 'https://assets.example.test/generated-2.png',
              },
            ],
          });
        },
      };
    },
  });

  assert.strictEqual(endpointRequest.url, 'https://ai.example.test/v1/images/generations');
  assert.strictEqual(endpointRequest.body.prompt, prompt);
  assert.strictEqual(endpointRequest.authorization, 'Bearer test-key');
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.images[0].url, 'https://assets.example.test/generated-2.png');
  assert(!JSON.stringify(result).includes('test-key'));

  let textOnlyEndpointRequest = null;
  const textOnlyResult = await generatePatternImage({
    prompt: 'Generate a clean material board from the reverse description only.',
    request_mode: 'images',
    input_images: [],
  }, {
    env: {
      AI_IMAGE_GENERATOR_BASE_URL: 'https://ai.example.test/v1',
      AI_IMAGE_GENERATOR_API_KEY: 'test-key',
      AI_IMAGE_GENERATOR_MODEL: 'gpt-image-2',
      AI_IMAGE_GENERATOR_REQUEST_MODE: 'edits',
      AI_IMAGE_GENERATOR_ENDPOINT_PATH: '/images/edits',
      AI_IMAGE_GENERATOR_RESPONSE_FORMAT: 'url',
    },
    fetchImpl: async (url, options) => {
      textOnlyEndpointRequest = {
        url,
        body: JSON.parse(options.body),
      };
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
            data: [
              {
                url: 'https://assets.example.test/text-only-generated.png',
              },
            ],
          });
        },
      };
    },
  });

  assert.strictEqual(textOnlyEndpointRequest.url, 'https://ai.example.test/v1/images/generations');
  assert.strictEqual(textOnlyEndpointRequest.body.prompt, 'Generate a clean material board from the reverse description only.');
  assert.strictEqual(textOnlyResult.status, 'success');
  assert.strictEqual(textOnlyResult.input_image_count, 0);
  assert.strictEqual(textOnlyResult.request_mode, 'images');

  const missingConfig = await generatePatternImage({
    prompt,
  }, {
    env: {},
  });
  assert.strictEqual(missingConfig.status, 'missing_config');

  const missingInputImages = await generatePatternImage({
    prompt,
    input_images: [],
  }, {
    env: {
      AI_IMAGE_GENERATOR_BASE_URL: 'https://ai.example.test/v1',
      AI_IMAGE_GENERATOR_API_KEY: 'test-key',
      AI_IMAGE_GENERATOR_REQUEST_MODE: 'edits',
      AI_IMAGE_GENERATOR_ENDPOINT_PATH: '/images/edits',
    },
  });
  assert.strictEqual(missingInputImages.status, 'missing_input_images');

  console.log('[test:ai-image-generator] AI image generator tests passed.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
