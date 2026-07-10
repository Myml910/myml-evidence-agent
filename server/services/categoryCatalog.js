const fs = require('fs');
const path = require('path');
const { EVIDENCE_DATA_DIR } = require('../config/dataPaths');

const CATEGORY_CANDIDATES_PATH = path.join(EVIDENCE_DATA_DIR, 'category-candidates.json');
const CATEGORY_CATALOG_OVERRIDES_PATH = path.join(
  EVIDENCE_DATA_DIR,
  'category-catalog-overrides.json',
);
const CATEGORY_IMAGE_UPLOAD_DIR = path.join(EVIDENCE_DATA_DIR, 'category-images');
const CATEGORY_IMAGE_PUBLIC_PATH = '/category-images';
const CATEGORY_CATALOG_SOURCE = '2026-6月-近期品类表.xlsx';
const CATEGORY_CATALOG_MANUAL_SOURCE = 'manual_category_catalog';
const CATEGORY_CATALOG_UPLOAD_SOURCE = 'manual_category_image_upload';
const CATEGORY_IMAGE_MIME_EXTENSIONS = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

let cachedCatalog = null;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCategoryName(value) {
  return cleanString(value).replace(/\s+/g, ' ');
}

function normalizeImageUrl(value) {
  return cleanString(value);
}

function normalizeCategoryKey(value) {
  return normalizeCategoryName(value).toLocaleLowerCase('zh-Hans-CN');
}

function isUsableCategoryName(value) {
  const normalized = normalizeCategoryName(value);
  return Boolean(normalized && normalized !== '-' && normalized !== '—');
}

function isSafeImageUrl(value) {
  const imageUrl = normalizeImageUrl(value);
  return Boolean(
    imageUrl &&
      (/^https?:\/\//i.test(imageUrl) || imageUrl.startsWith(`${CATEGORY_IMAGE_PUBLIC_PATH}/`)),
  );
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function readJsonArray(filePath, fallback = []) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path.basename(filePath)} must be a JSON array.`);
  }
  return parsed;
}

function readCategoryCandidateRows(filePath = CATEGORY_CANDIDATES_PATH) {
  const parsed = readJsonArray(filePath);
  return parsed.map((value) => normalizeCategoryName(String(value || '')));
}

function filenameFromImageUrl(value) {
  const imageUrl = normalizeImageUrl(value);
  if (!imageUrl) {
    return '';
  }

  try {
    const parsed = new URL(imageUrl);
    const filename = path.posix.basename(parsed.pathname || '');
    return decodeURIComponent(filename || parsed.hostname);
  } catch (_error) {
    return imageUrl.split(/[\\/]/).filter(Boolean).pop() || imageUrl;
  }
}

function normalizeHistoryImage(value = {}) {
  const imageUrl = normalizeImageUrl(value.image_url || value.imageUrl || value.url);
  if (!imageUrl) {
    return null;
  }

  return {
    image_url: imageUrl,
    image_filename: cleanString(value.image_filename || value.imageFilename || value.filename) ||
      filenameFromImageUrl(imageUrl),
    note: cleanString(value.note),
    source: cleanString(value.source) || CATEGORY_CATALOG_MANUAL_SOURCE,
    created_at: cleanString(value.created_at || value.createdAt),
  };
}

function normalizeManualEntry(entry = {}) {
  const category = normalizeCategoryName(entry.category || entry.name);
  const imageUrl = normalizeImageUrl(entry.image_url || entry.imageUrl);
  if (!isUsableCategoryName(category)) {
    return null;
  }

  return {
    category,
    image_url: imageUrl,
    image_filename: cleanString(entry.image_filename || entry.imageFilename) || filenameFromImageUrl(imageUrl),
    note: cleanString(entry.note),
    source: cleanString(entry.source) || CATEGORY_CATALOG_MANUAL_SOURCE,
    created_at: cleanString(entry.created_at || entry.createdAt),
    updated_at: cleanString(entry.updated_at || entry.updatedAt),
    history_images: Array.isArray(entry.history_images)
      ? entry.history_images.map(normalizeHistoryImage).filter(Boolean)
      : [],
  };
}

function readManualCategoryEntries(overridesPath = CATEGORY_CATALOG_OVERRIDES_PATH) {
  return readJsonArray(overridesPath, []).map(normalizeManualEntry).filter(Boolean);
}

function baseCatalogEntry(category) {
  return {
    category,
    image_url: '',
    image_filename: '',
    note: '',
    source: CATEGORY_CATALOG_SOURCE,
    created_at: '',
    updated_at: '',
    history_images: [],
  };
}

function mergeCategoryEntries(candidates, manualEntries) {
  const entryMap = new Map();

  candidates.forEach((category) => {
    entryMap.set(normalizeCategoryKey(category), baseCatalogEntry(category));
  });

  manualEntries.forEach((entry) => {
    const key = normalizeCategoryKey(entry.category);
    const existing = entryMap.get(key);
    entryMap.set(key, {
      ...(existing || baseCatalogEntry(entry.category)),
      ...entry,
      category: existing?.category || entry.category,
      source: entry.source || existing?.source || CATEGORY_CATALOG_MANUAL_SOURCE,
    });
  });

  return Array.from(entryMap.values());
}

function loadCategoryCatalog(options = {}) {
  const filePath = options.filePath || CATEGORY_CANDIDATES_PATH;
  const overridesPath = options.overridesPath || CATEGORY_CATALOG_OVERRIDES_PATH;
  const canUseCache = !options.filePath && !options.overridesPath;
  if (canUseCache && cachedCatalog) {
    return rewriteCatalogImageUrlsForBase(cachedCatalog, options.publicBaseUrl);
  }

  const rawRows = readCategoryCandidateRows(filePath);
  const baseCandidates = unique(rawRows.filter(isUsableCategoryName));
  const manualEntries = readManualCategoryEntries(overridesPath);
  const entries = mergeCategoryEntries(baseCandidates, manualEntries);
  const candidates = entries.map((entry) => entry.category);
  const catalog = {
    source: CATEGORY_CATALOG_SOURCE,
    source_path: filePath,
    overrides_path: overridesPath,
    raw_count: rawRows.length,
    manual_count: manualEntries.length,
    candidate_count: candidates.length,
    image_count: entries.filter((entry) => entry.image_url).length,
    history_image_count: entries.reduce(
      (total, entry) => total + (Array.isArray(entry.history_images) ? entry.history_images.length : 0),
      0,
    ),
    candidates,
    entries,
  };

  if (canUseCache) {
    cachedCatalog = catalog;
  }

  return rewriteCatalogImageUrlsForBase(catalog, options.publicBaseUrl);
}

function findCategoryCatalogEntry(category, options = {}) {
  const normalized = normalizeCategoryKey(category);
  if (!normalized) {
    return null;
  }

  const catalog = options.catalog || loadCategoryCatalog(options);
  const entries = Array.isArray(catalog.entries)
    ? catalog.entries
    : (catalog.candidates || []).map(baseCatalogEntry);

  return entries.find((entry) => normalizeCategoryKey(entry.category) === normalized) || null;
}

function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function createNotFoundError(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function writeJsonArrayAtomic(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function uniqueHistoryImages(images = []) {
  const seen = new Set();
  return images.filter((image) => {
    const key = publicUploadFileNameFromUrl(image.image_url) || normalizeImageUrl(image.image_url);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sameCategoryImageUrl(left, right) {
  const leftUrl = normalizeImageUrl(left);
  const rightUrl = normalizeImageUrl(right);
  if (!leftUrl || !rightUrl) {
    return false;
  }
  if (leftUrl === rightUrl) {
    return true;
  }

  const leftFileName = publicUploadFileNameFromUrl(leftUrl);
  const rightFileName = publicUploadFileNameFromUrl(rightUrl);
  return Boolean(leftFileName && rightFileName && leftFileName === rightFileName);
}

function rewriteCategoryImageUrlForBase(imageUrl, publicBaseUrl = '') {
  const normalized = normalizeImageUrl(imageUrl);
  const uploadFileName = publicUploadFileNameFromUrl(normalized);
  if (!uploadFileName) {
    return normalized;
  }
  return publicImageUrl(uploadFileName, publicBaseUrl);
}

function rewriteCategoryEntryImageUrls(entry, publicBaseUrl = '') {
  if (!publicBaseUrl || !entry) {
    return entry;
  }

  return {
    ...entry,
    image_url: rewriteCategoryImageUrlForBase(entry.image_url, publicBaseUrl),
    history_images: (entry.history_images || []).map((image) => ({
      ...image,
      image_url: rewriteCategoryImageUrlForBase(image.image_url, publicBaseUrl),
    })),
  };
}

function rewriteCatalogImageUrlsForBase(catalog, publicBaseUrl = '') {
  if (!publicBaseUrl || !catalog) {
    return catalog;
  }

  return {
    ...catalog,
    entries: (catalog.entries || []).map((entry) => rewriteCategoryEntryImageUrls(entry, publicBaseUrl)),
  };
}

function addCategoryCatalogEntry(input = {}, options = {}) {
  const category = normalizeCategoryName(input.category || input.name);
  const submittedImageUrl = normalizeImageUrl(input.image_url || input.imageUrl);
  const overridesPath = options.overridesPath || CATEGORY_CATALOG_OVERRIDES_PATH;

  if (!isUsableCategoryName(category)) {
    throw createValidationError('Category name is required.');
  }
  if (submittedImageUrl && !isSafeImageUrl(submittedImageUrl)) {
    throw createValidationError('Category image URL must start with http:// or https://.');
  }

  const now = new Date().toISOString();
  const rawEntries = readJsonArray(overridesPath, []);
  const normalizedEntries = rawEntries.map(normalizeManualEntry).filter(Boolean);
  const existingIndex = normalizedEntries.findIndex(
    (entry) => normalizeCategoryKey(entry.category) === normalizeCategoryKey(category),
  );
  const existingEntry = existingIndex >= 0 ? normalizedEntries[existingIndex] : null;
  const nextHistoryImage = normalizeHistoryImage(input.history_image || input.historyImage);
  const historyImages = uniqueHistoryImages([
    ...(existingEntry?.history_images || []),
    ...(nextHistoryImage ? [nextHistoryImage] : []),
  ]);
  const imageUrl = submittedImageUrl || existingEntry?.image_url || '';
  const imageFilename = submittedImageUrl
    ? cleanString(input.image_filename || input.imageFilename) || filenameFromImageUrl(submittedImageUrl)
    : existingEntry?.image_filename || '';
  const nextEntry = {
    category,
    image_url: imageUrl,
    image_filename: imageFilename,
    note: cleanString(input.note) || existingEntry?.note || '',
    source: cleanString(input.source) || existingEntry?.source || CATEGORY_CATALOG_MANUAL_SOURCE,
    created_at: existingIndex >= 0 ? existingEntry.created_at || now : now,
    updated_at: now,
    history_images: historyImages,
  };

  const nextEntries = [...normalizedEntries];
  if (existingIndex >= 0) {
    nextEntries[existingIndex] = nextEntry;
  } else {
    nextEntries.push(nextEntry);
  }

  writeJsonArrayAtomic(overridesPath, nextEntries);
  cachedCatalog = null;

  return {
    entry: findCategoryCatalogEntry(category, {
      filePath: options.filePath,
      overridesPath,
      publicBaseUrl: options.publicBaseUrl,
    }),
    catalog: loadCategoryCatalog({
      filePath: options.filePath,
      overridesPath,
      publicBaseUrl: options.publicBaseUrl,
    }),
  };
}

function normalizeUploadMimeType(value, fallback = '') {
  const mimeType = cleanString(value || fallback).toLowerCase();
  return CATEGORY_IMAGE_MIME_EXTENSIONS[mimeType] ? mimeType : '';
}

function extensionFromFilename(value) {
  const extension = path.extname(cleanString(value)).replace(/^\./, '').toLowerCase();
  return ['gif', 'jpeg', 'jpg', 'png', 'webp'].includes(extension) ? extension : '';
}

function categoryFileSlug(value) {
  const slug = normalizeCategoryName(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return slug || 'category';
}

function decodeUploadImageData(imageData, mimeType) {
  const raw = cleanString(imageData);
  const dataUrlMatch = raw.match(/^data:([^;,]+);base64,(.+)$/);
  const effectiveMimeType = normalizeUploadMimeType(dataUrlMatch?.[1], mimeType);
  const base64 = dataUrlMatch ? dataUrlMatch[2] : raw;

  if (!effectiveMimeType) {
    throw createValidationError('Only png, jpg, webp, or gif images can be uploaded.');
  }
  if (!base64) {
    throw createValidationError('Image upload data is required.');
  }

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) {
    throw createValidationError('Image upload data is empty.');
  }
  if (buffer.length > 8 * 1024 * 1024) {
    throw createValidationError('Image upload must be 8MB or smaller.');
  }

  return {
    buffer,
    mimeType: effectiveMimeType,
  };
}

function publicImageUrl(fileName, publicBaseUrl = '') {
  const encodedFileName = encodeURIComponent(fileName);
  const relativeUrl = `${CATEGORY_IMAGE_PUBLIC_PATH}/${encodedFileName}`;
  const baseUrl = cleanString(publicBaseUrl);
  return baseUrl ? `${baseUrl.replace(/\/+$/, '')}${relativeUrl}` : relativeUrl;
}

function saveCategoryCatalogImageUpload(input = {}, options = {}) {
  const category = normalizeCategoryName(input.category || input.name);
  if (!isUsableCategoryName(category)) {
    throw createValidationError('Category name is required.');
  }

  const decoded = decodeUploadImageData(input.image_data || input.imageData, input.mime_type || input.mimeType);
  const uploadDir = options.uploadDir || CATEGORY_IMAGE_UPLOAD_DIR;
  const filenameExtension =
    extensionFromFilename(input.filename) || CATEGORY_IMAGE_MIME_EXTENSIONS[decoded.mimeType];
  const uniqueSuffix = Math.random().toString(36).slice(2, 8);
  const safeFilename = `${Date.now()}-${uniqueSuffix}-${categoryFileSlug(category)}.${filenameExtension}`;
  const filePath = path.join(uploadDir, safeFilename);
  const imageUrl = publicImageUrl(safeFilename, options.publicBaseUrl);
  const now = new Date().toISOString();

  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(filePath, decoded.buffer);

  return addCategoryCatalogEntry(
    {
      category,
      image_url: imageUrl,
      image_filename: cleanString(input.filename) || safeFilename,
      note: cleanString(input.note),
      source: CATEGORY_CATALOG_UPLOAD_SOURCE,
      history_image: {
        image_url: imageUrl,
        image_filename: cleanString(input.filename) || safeFilename,
        note: cleanString(input.note),
        source: CATEGORY_CATALOG_UPLOAD_SOURCE,
        created_at: now,
      },
    },
    {
      filePath: options.filePath,
      overridesPath: options.overridesPath,
      publicBaseUrl: options.publicBaseUrl,
    },
  );
}

function catalogImageToEntryFields(image) {
  return {
    image_url: image?.image_url || '',
    image_filename: image?.image_filename || '',
    note: image?.note || '',
    source: image?.source || CATEGORY_CATALOG_MANUAL_SOURCE,
  };
}

function publicUploadFileNameFromUrl(imageUrl) {
  const urlValue = normalizeImageUrl(imageUrl);
  if (!urlValue) {
    return '';
  }

  let pathname = urlValue;
  try {
    pathname = new URL(urlValue).pathname;
  } catch (_error) {
    pathname = urlValue;
  }

  const expectedPrefix = `${CATEGORY_IMAGE_PUBLIC_PATH}/`;
  if (!pathname.startsWith(expectedPrefix)) {
    return '';
  }

  const filename = decodeURIComponent(pathname.slice(expectedPrefix.length));
  if (!filename || filename.includes('/') || filename.includes('\\')) {
    return '';
  }

  return filename;
}

function collectReferencedUploadFileNames(entries = []) {
  const referenced = new Set();
  entries.forEach((entry) => {
    const primaryFileName = publicUploadFileNameFromUrl(entry.image_url);
    if (primaryFileName) {
      referenced.add(primaryFileName);
    }
    (entry.history_images || []).forEach((image) => {
      const historyFileName = publicUploadFileNameFromUrl(image.image_url);
      if (historyFileName) {
        referenced.add(historyFileName);
      }
    });
  });
  return referenced;
}

function removeUploadedImageFileIfUnreferenced(imageUrl, entries, uploadDir = CATEGORY_IMAGE_UPLOAD_DIR) {
  const filename = publicUploadFileNameFromUrl(imageUrl);
  if (!filename || collectReferencedUploadFileNames(entries).has(filename)) {
    return;
  }

  const root = path.resolve(uploadDir);
  const targetPath = path.resolve(root, filename);
  if (!targetPath.startsWith(`${root}${path.sep}`)) {
    return;
  }
  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }
}

function removeCategoryCatalogImage(input = {}, options = {}) {
  const category = normalizeCategoryName(input.category || input.name);
  const imageUrl = normalizeImageUrl(input.image_url || input.imageUrl);
  const overridesPath = options.overridesPath || CATEGORY_CATALOG_OVERRIDES_PATH;

  if (!isUsableCategoryName(category)) {
    throw createValidationError('Category name is required.');
  }
  if (!imageUrl) {
    throw createValidationError('Image URL is required.');
  }

  const now = new Date().toISOString();
  const normalizedEntries = readJsonArray(overridesPath, []).map(normalizeManualEntry).filter(Boolean);
  const existingIndex = normalizedEntries.findIndex(
    (entry) => normalizeCategoryKey(entry.category) === normalizeCategoryKey(category),
  );
  if (existingIndex < 0) {
    throw createNotFoundError('Category image was not found.');
  }

  const existingEntry = normalizedEntries[existingIndex];
  const existingHistoryImages = existingEntry.history_images || [];
  const removedPrimary = sameCategoryImageUrl(existingEntry.image_url, imageUrl);
  const remainingHistoryImages = existingHistoryImages.filter(
    (image) => !sameCategoryImageUrl(image.image_url, imageUrl),
  );
  const removedHistoryCount = existingHistoryImages.length - remainingHistoryImages.length;

  if (!removedPrimary && removedHistoryCount === 0) {
    throw createNotFoundError('Category image was not found.');
  }

  const replacementImage = removedPrimary
    ? remainingHistoryImages[remainingHistoryImages.length - 1] || null
    : {
        image_url: existingEntry.image_url,
        image_filename: existingEntry.image_filename,
        note: existingEntry.note,
        source: existingEntry.source,
      };
  const replacementFields = catalogImageToEntryFields(replacementImage);
  const nextEntry = {
    ...existingEntry,
    ...replacementFields,
    updated_at: now,
    history_images: remainingHistoryImages,
  };
  const nextEntries = [...normalizedEntries];
  nextEntries[existingIndex] = nextEntry;

  writeJsonArrayAtomic(overridesPath, nextEntries);
  removeUploadedImageFileIfUnreferenced(imageUrl, nextEntries, options.uploadDir);
  cachedCatalog = null;

  return {
    entry: findCategoryCatalogEntry(category, {
      filePath: options.filePath,
      overridesPath,
      publicBaseUrl: options.publicBaseUrl,
    }),
    catalog: loadCategoryCatalog({
      filePath: options.filePath,
      overridesPath,
      publicBaseUrl: options.publicBaseUrl,
    }),
  };
}

module.exports = {
  CATEGORY_CANDIDATES_PATH,
  CATEGORY_CATALOG_MANUAL_SOURCE,
  CATEGORY_CATALOG_OVERRIDES_PATH,
  CATEGORY_CATALOG_SOURCE,
  CATEGORY_CATALOG_UPLOAD_SOURCE,
  CATEGORY_IMAGE_PUBLIC_PATH,
  CATEGORY_IMAGE_UPLOAD_DIR,
  addCategoryCatalogEntry,
  findCategoryCatalogEntry,
  loadCategoryCatalog,
  normalizeCategoryName,
  removeCategoryCatalogImage,
  rewriteCatalogImageUrlsForBase,
  saveCategoryCatalogImageUpload,
};
