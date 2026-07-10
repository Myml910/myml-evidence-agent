const { getAiElementMapperConfig } = require('./aiElementMapper');

const TEXT_ELEMENT_SOURCE_REAL = 'real_company_text_elements';
const TEXT_ELEMENT_SOURCE_AI_DESIGN_REQUIREMENT = 'ai_design_requirement_text_elements';

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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

function parseTextElements(value) {
  const list = Array.isArray(value) ? value : [value];
  return unique(
    list
      .flatMap((item) => String(item || '').split(/[\n\r;；]+/))
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim())
      .filter(Boolean)
      .map(stripChineseFromVisibleTextElement)
      .filter(Boolean)
      .map((item) => item.slice(0, 120)),
  ).slice(0, 8);
}

function safeError(type, stage, message, extra = {}) {
  return {
    type,
    stage,
    message,
    ...extra,
  };
}

function withTextElements(proposal, textElements, source, status, error = null) {
  const value = parseTextElements(textElements).join('; ');
  return {
    ...proposal,
    text_elements: value,
    text_elements_source: value ? source : '',
    text_elements_status: status,
    text_elements_error: error,
  };
}

function buildTextElementMessages(proposal = {}) {
  const designRequirement = cleanString(proposal.design_requirement);

  return [
    {
      role: 'system',
      content: [
        'You are the MYML text element extraction assistant.',
        'Use only the design_requirement field provided by the user.',
        'Goal: decide whether the final pattern design must contain literal visible text.',
        'Extract only exact words, slogans, greetings, names, phrases, or copy that should appear on the artwork.',
        'Chinese words in the source are internal requirement notes, labels, or explanations. Do not return Chinese characters as visible artwork text; for mixed Chinese/English input, return only the literal non-Chinese copy that should appear on the design.',
        'Do not extract product categories, carriers, colors, styles, image references, layout instructions, or general themes unless they are explicitly intended as visible text.',
        'If no visible text requirement is present, return has_text_requirement false and an empty text_elements array.',
        'Return JSON only.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        design_requirement: designRequirement,
        output_schema: {
          has_text_requirement: true,
          text_elements: ['literal text that should appear in the final artwork'],
          ignored_terms: ['theme/style/carrier/layout words not intended as text'],
          reason: 'short reason',
        },
      }),
    },
  ];
}

function buildTextElementRequestBody(config, proposal = {}) {
  const body = {
    model: config.model,
    messages: buildTextElementMessages(proposal),
    stream: false,
    max_tokens: Math.min(config.maxTokens || 300, 400),
  };

  if (config.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  return body;
}

async function inferTextElementsFromDesignRequirementWithAi(proposal = {}, options = {}) {
  const realTextElements = parseTextElements(proposal.text_elements);
  if (realTextElements.length > 0) {
    return withTextElements(
      proposal,
      realTextElements,
      proposal.text_elements_source || TEXT_ELEMENT_SOURCE_REAL,
      proposal.text_elements_status || 'real_data',
      null,
    );
  }

  const designRequirement = cleanString(proposal.design_requirement);
  if (!designRequirement) {
    return withTextElements(proposal, [], '', 'empty_design_requirement', null);
  }

  const env = options.env || process.env;
  const config = getAiElementMapperConfig(env);
  const fallback = (status, error = null) => withTextElements(proposal, [], '', status, error);

  if (!config.enabled) {
    return fallback('disabled');
  }
  if (!config.baseUrl || !config.apiKey) {
    return fallback(
      'missing_config',
      safeError('missing_config', 'config', 'AI text element extractor is not configured.'),
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
  const requestBody = buildTextElementRequestBody(config, proposal);
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
        safeError('http_error', 'response', `AI text element request failed with HTTP ${response.status}.`, {
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
        safeError('json_parse_error', 'response_parse', 'AI text element response was not valid JSON.', {
          content_type: contentType,
        }),
      );
    }

    const content = envelope.choices?.[0]?.message?.content;
    if (!content) {
      return fallback(
        'empty_ai_result',
        safeError('empty_ai_result', 'message_content', 'AI text element response did not include message content.'),
      );
    }

    let payload;
    try {
      payload = typeof content === 'string' ? JSON.parse(content) : content;
    } catch (_error) {
      return fallback(
        'json_parse_error',
        safeError('json_parse_error', 'content_parse', 'AI text element content was not valid JSON.'),
      );
    }

    const textElements = payload.has_text_requirement === false
      ? []
      : parseTextElements(payload.text_elements);

    return withTextElements(
      proposal,
      textElements,
      textElements.length > 0 ? TEXT_ELEMENT_SOURCE_AI_DESIGN_REQUIREMENT : '',
      textElements.length > 0 ? 'success' : 'no_text_requirement',
      null,
    );
  } catch (error) {
    return fallback(
      error?.name === 'AbortError' ? 'timeout' : 'request_failed',
      safeError(
        error?.name === 'AbortError' ? 'timeout' : 'request_failed',
        error?.name === 'AbortError' ? 'timeout' : 'request',
        error?.name === 'AbortError'
          ? 'AI text element request timed out.'
          : 'AI text element request failed.',
      ),
    );
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  TEXT_ELEMENT_SOURCE_AI_DESIGN_REQUIREMENT,
  TEXT_ELEMENT_SOURCE_REAL,
  buildTextElementMessages,
  buildTextElementRequestBody,
  inferTextElementsFromDesignRequirementWithAi,
  parseTextElements,
};
