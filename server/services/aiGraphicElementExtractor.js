const { getAiElementMapperConfig } = require('./aiElementMapper');

const AI_GRAPHIC_ELEMENT_SOURCE = 'ai_project_name';
const FALLBACK_GRAPHIC_ELEMENT_SOURCE = 'derived_from_project_name';

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseGraphicElements(value) {
  const list = Array.isArray(value) ? value : [value];
  return unique(
    list
      .flatMap((item) => String(item || '').split(/[\n\r,;，；、]+/))
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.slice(0, 80)),
  ).slice(0, 8);
}

function buildFallbackGraphicElements(proposal, options = {}, status = 'fallback', error = null) {
  const projectName = cleanString(proposal.project_name);
  const fallbackValue =
    typeof options.fallbackExtractor === 'function'
      ? options.fallbackExtractor({ projectName })
      : cleanString(proposal.ai_graphic_elements || proposal.element_requirement);
  const fallbackElements = parseGraphicElements(fallbackValue);
  const value = fallbackElements.join('; ');

  return {
    ...proposal,
    element_requirement: value,
    element_requirement_source: value ? FALLBACK_GRAPHIC_ELEMENT_SOURCE : '',
    ai_graphic_elements: value,
    ai_graphic_elements_source: value ? FALLBACK_GRAPHIC_ELEMENT_SOURCE : '',
    ai_graphic_elements_status: status,
    ai_graphic_elements_error: error,
  };
}

function buildGraphicElementMessages(projectName) {
  return [
    {
      role: 'system',
      content: [
        'You are the MYML graphic element extraction assistant.',
        'Use only the project_name provided by the user.',
        'Extract the visual motif or graphic subject that needs to be designed.',
        'Prefer title segments that include theme, motif, character, plant, animal, object, illustration subject, colorway, or visual pattern.',
        'Exclude product carriers, categories, crafts, materials, quantities, size, shape, packaging, and usage scene when they are not visual motifs.',
        'Examples:',
        'project_name: 厨房-热带植物主题-冰箱贴-圆形5.5以内-12pcs -> graphic_elements: ["热带植物"]',
        'project_name: 手工艺-手工材料包-绘画类-钻石面-动画Q版耶稣降临主题钻石画)水箱贴-12pcs -> graphic_elements: ["动画Q版耶稣降临主题"]',
        'project_name: 派对-餐盘套装-火焰骰子派对装饰24个黑色叉子 -> graphic_elements: ["火焰骰子", "黑色"]',
        'Do not return SKUs, historical image references, image paths, or Obsidian content.',
        'Return JSON only.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        project_name: projectName,
        output_schema: {
          graphic_elements: ['visual motif only'],
          ignored_terms: ['carrier/category/size/quantity terms'],
          reason: 'short reason',
        },
      }),
    },
  ];
}

function buildGraphicElementRequestBody(config, projectName) {
  const body = {
    model: config.model,
    messages: buildGraphicElementMessages(projectName),
    stream: false,
    max_tokens: Math.min(config.maxTokens || 300, 400),
  };

  if (config.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  return body;
}

function safeError(type, stage, message, extra = {}) {
  return {
    type,
    stage,
    message,
    ...extra,
  };
}

async function extractGraphicElementsFromProjectNameWithAi(proposal = {}, options = {}) {
  const projectName = cleanString(proposal.project_name);
  if (!projectName) {
    return buildFallbackGraphicElements(proposal, options, 'empty_project_name');
  }

  const env = options.env || process.env;
  const config = getAiElementMapperConfig(env);
  const fallback = (status, error = null) =>
    buildFallbackGraphicElements(proposal, options, status, error);

  if (!config.enabled) {
    return fallback('disabled');
  }
  if (!config.baseUrl || !config.apiKey) {
    return fallback(
      'missing_config',
      safeError('missing_config', 'config', 'AI graphic element extractor is not configured.'),
    );
  }

  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    return fallback(
      'missing_fetch',
      safeError('missing_fetch', 'request', 'No fetch implementation is available.'),
    );
  }

  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/${config.endpointPath.replace(/^\/+/, '')}`;
  const requestBody = buildGraphicElementRequestBody(config, projectName);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const responseText = await response.text();
    const contentType = response.headers?.get?.('content-type') || '';

    if (!response.ok) {
      return fallback(
        'http_error',
        safeError('http_error', 'response', `AI graphic element request failed with HTTP ${response.status}.`, {
          http_status: response.status,
          content_type: contentType,
        }),
      );
    }

    let envelope;
    try {
      envelope = JSON.parse(responseText);
    } catch (_error) {
      return fallback(
        'json_parse_error',
        safeError('json_parse_error', 'response_parse', 'AI graphic element response was not valid JSON.', {
          content_type: contentType,
        }),
      );
    }

    const content = envelope.choices?.[0]?.message?.content;
    if (!content) {
      return fallback(
        'empty_ai_result',
        safeError('empty_ai_result', 'message_content', 'AI graphic element response did not include message content.'),
      );
    }

    let payload;
    try {
      payload = typeof content === 'string' ? JSON.parse(content) : content;
    } catch (_error) {
      return fallback(
        'json_parse_error',
        safeError('json_parse_error', 'content_parse', 'AI graphic element content was not valid JSON.'),
      );
    }

    const graphicElements = parseGraphicElements(payload.graphic_elements);
    if (graphicElements.length === 0) {
      return fallback(
        'empty_ai_result',
        safeError('empty_ai_result', 'validation', 'AI did not return graphic elements.'),
      );
    }

    const value = graphicElements.join('; ');
    return {
      ...proposal,
      element_requirement: value,
      element_requirement_source: AI_GRAPHIC_ELEMENT_SOURCE,
      ai_graphic_elements: value,
      ai_graphic_elements_source: AI_GRAPHIC_ELEMENT_SOURCE,
      ai_graphic_elements_status: 'success',
      ai_graphic_elements_error: null,
    };
  } catch (error) {
    return fallback(
      error?.name === 'AbortError' ? 'timeout' : 'request_failed',
      safeError(
        error?.name === 'AbortError' ? 'timeout' : 'request_failed',
        error?.name === 'AbortError' ? 'timeout' : 'request',
        error?.name === 'AbortError'
          ? 'AI graphic element request timed out.'
          : 'AI graphic element request failed.',
      ),
    );
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  AI_GRAPHIC_ELEMENT_SOURCE,
  FALLBACK_GRAPHIC_ELEMENT_SOURCE,
  buildGraphicElementMessages,
  buildGraphicElementRequestBody,
  extractGraphicElementsFromProjectNameWithAi,
  parseGraphicElements,
};
