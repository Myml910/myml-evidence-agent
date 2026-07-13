const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  PROJECT_RUN_ASSET_DIR,
  PROJECT_RUN_ASSET_PUBLIC_PATH,
} = require('./projectRunStore');

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const MAX_REDIRECTS = 3;
const IMAGE_MIME_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
]);

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeIdPart(value, fallback = 'item') {
  return cleanString(value)
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || fallback;
}

function referenceSourceHash(value) {
  return crypto.createHash('sha256').update(cleanString(value)).digest('hex').slice(0, 20);
}

function sourceUrlFromImage(image) {
  return cleanString(image?.imageUrl || image?.thumbnailUrl || image?.url);
}

function referenceSourcePolicy(env = process.env) {
  const configured = cleanString(env.COMPANY_REFERENCE_IMAGE_BASE_URL);
  if (!configured) {
    return null;
  }

  try {
    const parsed = new URL(configured);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null;
    }
    parsed.search = '';
    parsed.hash = '';
    const basePath = parsed.pathname.replace(/\/+$/, '') || '/';
    return {
      origin: parsed.origin,
      basePath,
    };
  } catch (_error) {
    return null;
  }
}

function validateSourceUrl(value, policy) {
  if (!policy) {
    throw Object.assign(new Error('Company reference media origin is not configured.'), {
      code: 'REFERENCE_MEDIA_ORIGIN_NOT_CONFIGURED',
    });
  }

  let parsed;
  try {
    parsed = new URL(cleanString(value));
  } catch (_error) {
    throw Object.assign(new Error('Company reference media URL is invalid.'), {
      code: 'REFERENCE_MEDIA_URL_INVALID',
    });
  }

  const withinBasePath = policy.basePath === '/' ||
    parsed.pathname === policy.basePath ||
    parsed.pathname.startsWith(`${policy.basePath}/`);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.origin !== policy.origin ||
    !withinBasePath
  ) {
    throw Object.assign(new Error('Company reference media URL is outside the configured source boundary.'), {
      code: 'REFERENCE_MEDIA_URL_NOT_ALLOWED',
    });
  }

  return parsed;
}

function persistedRunAssetUrl(value, runId, publicPath) {
  const text = cleanString(value);
  let pathname = text.split('?')[0].split('#')[0];
  if (/^https?:\/\//i.test(text)) {
    try {
      pathname = new URL(text).pathname;
    } catch (_error) {
      return '';
    }
  }
  const runPart = encodeURIComponent(safeIdPart(runId, 'run'));
  return pathname.startsWith(`${publicPath}/${runPart}/references/`) ? pathname : '';
}

function cachedAssetUrl(outputDir, publicDir, sourceHash) {
  for (const extension of IMAGE_MIME_EXTENSIONS.values()) {
    const fileName = `reference-${sourceHash}.${extension}`;
    const filePath = path.join(outputDir, fileName);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return `${publicDir}/${encodeURIComponent(fileName)}`;
    }
  }
  return '';
}

async function readResponseBody(response, maxBytes) {
  const declaredLength = Number.parseInt(response.headers?.get?.('content-length') || '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw Object.assign(new Error('Company reference media exceeds the size limit.'), {
      code: 'REFERENCE_MEDIA_TOO_LARGE',
    });
  }

  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > maxBytes) {
      throw Object.assign(new Error('Company reference media has an invalid size.'), {
        code: buffer.length ? 'REFERENCE_MEDIA_TOO_LARGE' : 'REFERENCE_MEDIA_EMPTY',
      });
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw Object.assign(new Error('Company reference media exceeds the size limit.'), {
          code: 'REFERENCE_MEDIA_TOO_LARGE',
        });
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }

  if (total === 0) {
    throw Object.assign(new Error('Company reference media is empty.'), {
      code: 'REFERENCE_MEDIA_EMPTY',
    });
  }
  return Buffer.concat(chunks, total);
}

function detectedImageType(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
    return { contentType: 'image/gif', extension: 'gif' };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString('ascii') === 'ftyp' &&
    ['avif', 'avis'].includes(buffer.subarray(8, 12).toString('ascii'))
  ) {
    return { contentType: 'image/avif', extension: 'avif' };
  }
  return null;
}

async function fetchReferenceImage(sourceUrl, options) {
  let current = validateSourceUrl(sourceUrl, options.policy);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await options.fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      signal: options.signal,
      headers: {
        Accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif',
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirect === MAX_REDIRECTS) {
        throw Object.assign(new Error('Company reference media exceeded the redirect limit.'), {
          code: 'REFERENCE_MEDIA_REDIRECT_LIMIT',
        });
      }
      const location = cleanString(response.headers?.get?.('location'));
      current = validateSourceUrl(new URL(location, current).toString(), options.policy);
      continue;
    }

    if (!response.ok) {
      throw Object.assign(new Error('Company reference media request failed.'), {
        code: 'REFERENCE_MEDIA_FETCH_FAILED',
        status: response.status,
      });
    }

    const declaredContentType = cleanString(response.headers?.get?.('content-type')).split(';')[0].toLowerCase();
    const buffer = await readResponseBody(response, options.maxBytes);
    const detected = detectedImageType(buffer);
    if (!detected) {
      throw Object.assign(new Error('Company reference media returned a non-image content type.'), {
        code: 'REFERENCE_MEDIA_CONTENT_TYPE_INVALID',
      });
    }
    const declaredExtension = IMAGE_MIME_EXTENSIONS.get(declaredContentType);
    if (declaredExtension && declaredExtension !== detected.extension) {
      throw Object.assign(new Error('Company reference media content does not match its declared type.'), {
        code: 'REFERENCE_MEDIA_CONTENT_TYPE_MISMATCH',
      });
    }

    return {
      buffer,
      contentType: detected.contentType,
      extension: detected.extension,
    };
  }

  throw Object.assign(new Error('Company reference media request failed.'), {
    code: 'REFERENCE_MEDIA_FETCH_FAILED',
  });
}

function publicImageRecord(image, imageUrl, sourceHash, content = {}) {
  const {
    url: _url,
    rawPath: _rawPath,
    raw_path: _rawPathSnake,
    ...safeImage
  } = image || {};
  return {
    ...safeImage,
    imageUrl,
    thumbnailUrl: imageUrl,
    sourceUrlHash: sourceHash,
    mimeType: content.contentType || image?.mimeType,
    bytes: Number(content.bytes) || Number(image?.bytes) || undefined,
  };
}

async function persistOneReference(image, context) {
  const sourceUrl = sourceUrlFromImage(image);
  if (!sourceUrl) {
    throw Object.assign(new Error('Company reference media URL is missing.'), {
      code: 'REFERENCE_MEDIA_URL_MISSING',
    });
  }

  const persistedUrl = persistedRunAssetUrl(sourceUrl, context.runId, context.publicPath);
  if (persistedUrl) {
    return publicImageRecord(image, persistedUrl, cleanString(image.sourceUrlHash) || referenceSourceHash(persistedUrl));
  }

  validateSourceUrl(sourceUrl, context.policy);
  const sourceHash = referenceSourceHash(sourceUrl);
  const cachedUrl = cachedAssetUrl(context.outputDir, context.publicDir, sourceHash);
  if (cachedUrl) {
    return publicImageRecord(image, cachedUrl, sourceHash);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
  timeout.unref?.();
  try {
    const downloaded = await fetchReferenceImage(sourceUrl, {
      fetchImpl: context.fetchImpl,
      maxBytes: context.maxBytes,
      policy: context.policy,
      signal: controller.signal,
    });
    const fileName = `reference-${sourceHash}.${downloaded.extension}`;
    const finalPath = path.join(context.outputDir, fileName);
    const temporaryPath = `${finalPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, downloaded.buffer, { mode: 0o600 });
      fs.renameSync(temporaryPath, finalPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
    return publicImageRecord(
      image,
      `${context.publicDir}/${encodeURIComponent(fileName)}`,
      sourceHash,
      { contentType: downloaded.contentType, bytes: downloaded.buffer.length },
    );
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('Company reference media request timed out.'), {
        code: 'REFERENCE_MEDIA_TIMEOUT',
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function persistProjectReferenceImages({ runId, images } = {}, options = {}) {
  const safeRunId = safeIdPart(runId, '');
  if (!safeRunId) {
    throw Object.assign(new Error('Project run id is required for reference media persistence.'), {
      code: 'REFERENCE_MEDIA_RUN_ID_REQUIRED',
    });
  }

  const input = Array.isArray(images) ? images : [];
  if (input.length === 0) return { images: [], failures: [] };

  const assetDir = options.assetDir || PROJECT_RUN_ASSET_DIR;
  const publicPath = cleanString(options.assetPublicPath) || PROJECT_RUN_ASSET_PUBLIC_PATH;
  const runPart = encodeURIComponent(safeRunId);
  const outputDir = path.join(assetDir, safeRunId, 'references');
  const publicDir = `${publicPath}/${runPart}/references`;
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });

  const context = {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    maxBytes: positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES),
    outputDir,
    policy: referenceSourcePolicy(options.env || process.env),
    publicDir,
    publicPath,
    runId: safeRunId,
    timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS),
  };
  if (typeof context.fetchImpl !== 'function') {
    throw Object.assign(new Error('Fetch is unavailable for company reference media.'), {
      code: 'REFERENCE_MEDIA_FETCH_UNAVAILABLE',
    });
  }

  const persisted = new Array(input.length);
  const failures = [];
  const inFlightBySource = new Map();
  let nextIndex = 0;
  const concurrency = Math.min(
    positiveInteger(options.concurrency, DEFAULT_CONCURRENCY),
    MAX_CONCURRENCY,
    input.length,
  );

  const worker = async () => {
    while (nextIndex < input.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        const sourceUrl = sourceUrlFromImage(input[index]);
        let promise = inFlightBySource.get(sourceUrl);
        if (!promise) {
          promise = persistOneReference(input[index], context);
          inFlightBySource.set(sourceUrl, promise);
        }
        const stored = await promise;
        persisted[index] = publicImageRecord(
          input[index],
          stored.imageUrl,
          stored.sourceUrlHash,
          { contentType: stored.mimeType, bytes: stored.bytes },
        );
      } catch (error) {
        failures.push({
          index,
          code: cleanString(error?.code) || 'REFERENCE_MEDIA_PERSIST_FAILED',
          status: Number(error?.status) || undefined,
        });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return {
    images: persisted.filter(Boolean),
    failures: failures.sort((first, second) => first.index - second.index),
  };
}

module.exports = {
  persistProjectReferenceImages,
  referenceSourceHash,
};
