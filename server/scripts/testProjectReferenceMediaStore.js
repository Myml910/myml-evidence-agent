const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  persistProjectReferenceImages,
  referenceSourceHash,
} = require('../services/projectReferenceMediaStore');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myml-reference-media-'));
const assetDir = path.join(tempDir, 'assets');
const env = {
  COMPANY_REFERENCE_IMAGE_BASE_URL: 'http://assets.internal/static/',
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
  'base64',
);
let fetchCount = 0;
const committedFiles = [];
const commitFile = (filePath, details) => committedFiles.push({ filePath, details });

async function fetchImage(url) {
  fetchCount += 1;
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/not-image')) {
    return new Response('not an image', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }
  if (parsed.pathname.endsWith('/too-large')) {
    return new Response(png, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': '9999',
      },
    });
  }
  return new Response(png, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'content-length': String(png.length),
    },
  });
}

async function main() {
  const runId = 'prun-YXF2607090107-reference-media';
  const sourceImages = Array.from({ length: 5 }, (_, index) => ({
    id: `reference-${index + 1}`,
    title: `Company design reference ${index + 1}`,
    source: 'company_project_data',
    imageUrl: `http://assets.internal/static/project/reference-${index + 1}.png?token=secret-${index + 1}`,
    thumbnailUrl: `http://assets.internal/static/project/reference-${index + 1}.png?token=secret-${index + 1}`,
  }));
  sourceImages[0].url = sourceImages[0].imageUrl;
  sourceImages[0].raw_path = 'internal/project/reference-1.png';

  const first = await persistProjectReferenceImages({
    runId,
    images: sourceImages,
  }, {
    assetDir,
    assetPublicPath: '/project-run-assets',
    env,
    fetchImpl: fetchImage,
    concurrency: 3,
    commitFile,
  });

  assert.strictEqual(first.images.length, 5);
  assert.strictEqual(first.failures.length, 0);
  assert.strictEqual(fetchCount, 5);
  assert(first.images.every((image) => image.imageUrl.startsWith(
    '/project-run-assets/prun-YXF2607090107-reference-media/references/reference-',
  )));
  assert(first.images.every((image) => image.imageUrl === image.thumbnailUrl));
  assert(first.images.every((image) => image.sourceUrlHash === referenceSourceHash(
    sourceImages.find((source) => source.id === image.id).imageUrl,
  )));
  assert(!JSON.stringify(first.images).includes('token=secret'));
  assert(!JSON.stringify(first.images).includes('assets.internal'));
  assert(!JSON.stringify(first.images).includes('raw_path'));

  const outputDir = path.join(assetDir, runId, 'references');
  assert.strictEqual(fs.readdirSync(outputDir).filter((name) => name.endsWith('.png')).length, 5);
  assert.strictEqual(fs.readdirSync(outputDir).filter((name) => name.endsWith('.tmp')).length, 0);

  const second = await persistProjectReferenceImages({
    runId,
    images: sourceImages,
  }, {
    assetDir,
    assetPublicPath: '/project-run-assets',
    env,
    fetchImpl: fetchImage,
    commitFile,
  });
  assert.deepStrictEqual(second.images.map((image) => image.imageUrl), first.images.map((image) => image.imageUrl));
  assert.strictEqual(fetchCount, 5);

  const duplicateSource = {
    imageUrl: 'http://assets.internal/static/project/duplicate.png?token=duplicate',
  };
  const beforeDuplicateFetches = fetchCount;
  const duplicates = await persistProjectReferenceImages({
    runId: `${runId}-duplicates`,
    images: [duplicateSource, { ...duplicateSource, id: 'duplicate-2' }],
  }, {
    assetDir,
    assetPublicPath: '/project-run-assets',
    env,
    fetchImpl: fetchImage,
    concurrency: 2,
    commitFile,
  });
  assert.strictEqual(duplicates.images.length, 2);
  assert.strictEqual(duplicates.images[0].imageUrl, duplicates.images[1].imageUrl);
  assert.strictEqual(fetchCount - beforeDuplicateFetches, 1);

  const failures = await persistProjectReferenceImages({
    runId: `${runId}-failures`,
    images: [
      { imageUrl: 'http://other.internal/static/not-allowed.png' },
      { imageUrl: 'http://assets.internal/outside/not-allowed.png' },
      { imageUrl: 'http://assets.internal/static/not-image' },
      { imageUrl: 'http://assets.internal/static/too-large' },
    ],
  }, {
    assetDir,
    assetPublicPath: '/project-run-assets',
    env,
    fetchImpl: fetchImage,
    maxBytes: 1024,
    commitFile,
  });
  assert.strictEqual(failures.images.length, 0);
  assert.deepStrictEqual(failures.failures.map((failure) => failure.code), [
    'REFERENCE_MEDIA_URL_NOT_ALLOWED',
    'REFERENCE_MEDIA_URL_NOT_ALLOWED',
    'REFERENCE_MEDIA_CONTENT_TYPE_INVALID',
    'REFERENCE_MEDIA_TOO_LARGE',
  ]);
  assert(!JSON.stringify(failures.failures).includes('other.internal'));
  assert(!JSON.stringify(failures.failures).includes('not-image'));

  const alreadyPersisted = await persistProjectReferenceImages({
    runId,
    images: [first.images[0]],
  }, {
    assetDir,
    assetPublicPath: '/project-run-assets',
    env: {},
    fetchImpl: async () => {
      throw new Error('Persisted assets must not be fetched again.');
    },
    commitFile,
  });
  assert.strictEqual(alreadyPersisted.images.length, 1);
  assert.strictEqual(alreadyPersisted.failures.length, 0);
  assert.strictEqual(committedFiles.length, 6);
  assert(committedFiles.every((entry) => entry.filePath.endsWith('.png')));
  assert(committedFiles.every((entry) => entry.details.contentType === 'image/png'));

  console.log('[test:project-reference-media] Project reference media tests passed.');
}

main().finally(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
