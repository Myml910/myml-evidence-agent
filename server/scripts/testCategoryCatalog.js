const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  addCategoryCatalogEntry,
  findCategoryCatalogEntry,
  loadCategoryCatalog,
  removeCategoryCatalogImage,
  saveCategoryCatalogImageUpload,
} = require('../services/categoryCatalog');

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myml-category-catalog-'));
  const filePath = path.join(tempDir, 'category-candidates.json');
  const overridesPath = path.join(tempDir, 'category-catalog-overrides.json');
  const uploadDir = path.join(tempDir, 'category-images');
  const committedFiles = [];
  const deletedFiles = [];
  const commitFile = (targetPath, details) => committedFiles.push({ targetPath, details });
  const recordDelete = (targetPath) => deletedFiles.push(targetPath);

  try {
    writeJson(filePath, ['Plates', '-', 'Door Magnet']);
    writeJson(overridesPath, [
      {
        category: 'Plates',
        image_url: 'https://assets.example.test/plates.png',
        note: 'Existing base category image.',
      },
    ]);

    const catalog = loadCategoryCatalog({ filePath, overridesPath });
    assert.strictEqual(catalog.raw_count, 3);
    assert.strictEqual(catalog.candidate_count, 2);
    assert.strictEqual(catalog.image_count, 1);
    assert.deepStrictEqual(catalog.candidates, ['Plates', 'Door Magnet']);
    assert.strictEqual(
      findCategoryCatalogEntry('Plates', { catalog }).image_url,
      'https://assets.example.test/plates.png',
    );

    const added = addCategoryCatalogEntry(
      {
        category: 'New Party Kit',
        image_url: 'https://assets.example.test/new-party-kit.png',
        note: 'Manual category.',
      },
      { filePath, overridesPath },
    );
    assert.strictEqual(added.entry.category, 'New Party Kit');
    assert.strictEqual(added.catalog.candidate_count, 3);
    assert.strictEqual(added.catalog.image_count, 2);
    assert(added.catalog.candidates.includes('New Party Kit'));

    const updated = addCategoryCatalogEntry(
      {
        category: 'New Party Kit',
        image_url: 'https://assets.example.test/new-party-kit-v2.png',
        note: 'Updated image.',
      },
      { filePath, overridesPath },
    );
    assert.strictEqual(updated.catalog.candidate_count, 3);
    assert.strictEqual(updated.catalog.manual_count, 2);
    assert.strictEqual(
      findCategoryCatalogEntry('New Party Kit', { catalog: updated.catalog }).image_url,
      'https://assets.example.test/new-party-kit-v2.png',
    );
    assert.deepStrictEqual(
      findCategoryCatalogEntry('New Party Kit', { catalog: updated.catalog }).history_images,
      [],
    );

    const pendingImageCategory = addCategoryCatalogEntry(
      {
        category: 'Pending Image Category',
        note: 'Image can be added later.',
      },
      { filePath, overridesPath },
    );
    const pendingImageEntry = findCategoryCatalogEntry('Pending Image Category', {
      catalog: pendingImageCategory.catalog,
    });
    assert.strictEqual(pendingImageEntry.category, 'Pending Image Category');
    assert.strictEqual(pendingImageEntry.image_url, '');
    assert.deepStrictEqual(pendingImageEntry.history_images, []);
    assert.strictEqual(pendingImageCategory.catalog.candidate_count, 4);
    assert.strictEqual(pendingImageCategory.catalog.image_count, 2);

    const uploaded = saveCategoryCatalogImageUpload(
      {
        category: 'Door Magnet',
        image_data: TINY_PNG_DATA_URL,
        filename: 'historic-door-magnet.png',
        mime_type: 'image/png',
        note: 'Dropped history design.',
      },
      {
        filePath,
        overridesPath,
        uploadDir,
        publicBaseUrl: 'http://127.0.0.1:3102',
        commitFile,
      },
    );
    const uploadedEntry = findCategoryCatalogEntry('Door Magnet', { catalog: uploaded.catalog });
    assert.strictEqual(uploadedEntry.category, 'Door Magnet');
    assert.strictEqual(uploadedEntry.source, 'manual_category_image_upload');
    assert.strictEqual(uploadedEntry.history_images.length, 1);
    assert.strictEqual(uploadedEntry.history_images[0].note, 'Dropped history design.');
    assert(uploadedEntry.image_url.startsWith('http://127.0.0.1:3102/category-images/'));
    assert(fs.existsSync(path.join(uploadDir, path.basename(decodeURIComponent(uploadedEntry.image_url)))));
    const rewrittenUploadCatalog = loadCategoryCatalog({
      filePath,
      overridesPath,
      publicBaseUrl: 'http://127.0.0.1:3101',
    });
    const rewrittenUploadEntry = findCategoryCatalogEntry('Door Magnet', { catalog: rewrittenUploadCatalog });
    assert(rewrittenUploadEntry.image_url.startsWith('http://127.0.0.1:3101/category-images/'));
    assert(rewrittenUploadEntry.history_images[0].image_url.startsWith('http://127.0.0.1:3101/category-images/'));

    const uploadedAgain = saveCategoryCatalogImageUpload(
      {
        category: 'Door Magnet',
        image_data: TINY_PNG_DATA_URL,
        filename: 'historic-door-magnet-second.png',
        mime_type: 'image/png',
        note: 'Second dropped history design.',
      },
      {
        filePath,
        overridesPath,
        uploadDir,
        publicBaseUrl: 'http://127.0.0.1:3102',
        commitFile,
      },
    );
    const multiImageEntry = findCategoryCatalogEntry('Door Magnet', { catalog: uploadedAgain.catalog });
    assert.strictEqual(multiImageEntry.history_images.length, 2);
    assert.strictEqual(uploadedAgain.catalog.history_image_count, 2);
    assert.notStrictEqual(
      multiImageEntry.history_images[0].image_url,
      multiImageEntry.history_images[1].image_url,
    );
    const rewrittenMultiImageEntry = findCategoryCatalogEntry('Door Magnet', {
      catalog: loadCategoryCatalog({
        filePath,
        overridesPath,
        publicBaseUrl: 'http://127.0.0.1:3101',
      }),
    });
    const firstUploadedImageUrl = rewrittenMultiImageEntry.history_images[0].image_url;
    const firstUploadedFilePath = path.join(
      uploadDir,
      path.basename(decodeURIComponent(new URL(firstUploadedImageUrl).pathname)),
    );
    const secondUploadedImageUrl = rewrittenMultiImageEntry.history_images[1].image_url;

    const removedFirst = removeCategoryCatalogImage(
      {
        category: 'Door Magnet',
        image_url: firstUploadedImageUrl,
      },
      {
        filePath,
        overridesPath,
        uploadDir,
        publicBaseUrl: 'http://127.0.0.1:3101',
        commitFile,
        recordDelete,
      },
    );
    const removedFirstEntry = findCategoryCatalogEntry('Door Magnet', { catalog: removedFirst.catalog });
    assert.strictEqual(removedFirstEntry.history_images.length, 1);
    assert.strictEqual(removedFirstEntry.image_url, secondUploadedImageUrl);
    assert(!fs.existsSync(firstUploadedFilePath));

    const removedLast = removeCategoryCatalogImage(
      {
        category: 'Door Magnet',
        image_url: secondUploadedImageUrl,
      },
      { filePath, overridesPath, uploadDir, commitFile, recordDelete },
    );
    const removedLastEntry = findCategoryCatalogEntry('Door Magnet', { catalog: removedLast.catalog });
    assert.strictEqual(removedLastEntry.image_url, '');
    assert.strictEqual(removedLastEntry.history_images.length, 0);
    assert.strictEqual(committedFiles.length, 6);
    assert.strictEqual(deletedFiles.length, 2);
    assert(committedFiles.some((entry) => entry.targetPath.endsWith('.png')));
    assert(committedFiles.some((entry) => entry.targetPath === overridesPath));

    assert.throws(
      () => addCategoryCatalogEntry(
        {
          category: 'Unsafe Image Category',
          image_url: 'javascript:alert(1)',
        },
        { filePath, overridesPath },
      ),
      /Category image URL/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('[test:category-catalog] Category catalog tests passed.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
