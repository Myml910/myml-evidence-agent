const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  ELEMENT_REQUIREMENT_SOURCE_UPLOADED,
  UPLOADED_PROPOSAL_DATA_ORIGIN,
  UPLOADED_PROPOSAL_LOOKUP_SOURCE,
  prepareProposalFromMinimalFields,
} = require('./companyLookupAdapter');

const DEFAULT_PACKAGE_PATH = 'C:\\Users\\admin\\Downloads\\SLP_blanket_proposal_upload_package.zip';
const DEFAULT_PROJECT_CODE = 'UPLOAD-SLP-BLANKET';
const PROPOSAL_PACKAGE_PUBLIC_PATH = '/proposal-package-files';
const PROPOSAL_PACKAGE_CACHE_DIR = path.join(os.tmpdir(), 'myml-evidence-agent-proposal-packages');

const FIELD_PRODUCT_CATEGORY = '\u4ea7\u54c1\u5206\u7c7b';
const FIELD_PROJECT_NAME = '\u9879\u76ee\u540d\u79f0';
const FIELD_MATERIAL = '\u6750\u8d28';
const FIELD_CRAFT = '\u5de5\u827a';
const FIELD_MARKET = '\u5e02\u573a';
const FIELD_AUDIENCE = '\u4eba\u7fa4';
const FIELD_SCENE = '\u573a\u666f';
const SECTION_KEYWORDS = '\u5f00\u53d1\u5173\u952e\u8bcd';
const SECTION_GRAPHIC_ELEMENTS = '\u56fe\u5f62\u5143\u7d20';
const SECTION_TEXT_ELEMENTS = '\u6587\u5b57\u5143\u7d20';
const SECTION_DESIGN_REQUIREMENT = '\u8bbe\u8ba1\u8981\u6c42';
const LABEL_EXTERNAL_EVIDENCE = '\u5916\u90e8\u7ade\u54c1\u8bc1\u636e\u56fe';
const CATEGORY_BLANKET = '\u6bdb\u6bef';

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function unique(values) {
  return [...new Set(values.map(cleanString).filter(Boolean))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureCacheDir() {
  fs.mkdirSync(PROPOSAL_PACKAGE_CACHE_DIR, { recursive: true });
}

function buildPackageId(packagePath) {
  const stats = fs.statSync(packagePath);
  const seed = `${path.basename(packagePath)}:${stats.size}:${Number(stats.mtimeMs)}`;
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

function assertInsideCache(targetPath) {
  const resolvedCache = path.resolve(PROPOSAL_PACKAGE_CACHE_DIR);
  const resolvedTarget = path.resolve(targetPath);
  if (!resolvedTarget.startsWith(`${resolvedCache}${path.sep}`)) {
    throw new Error('Unsafe proposal package extraction path.');
  }
}

function expandPackage(packagePath) {
  if (!fs.existsSync(packagePath)) {
    const error = new Error(`Proposal package not found: ${packagePath}`);
    error.code = 'PACKAGE_NOT_FOUND';
    throw error;
  }

  ensureCacheDir();
  const packageId = buildPackageId(packagePath);
  const destination = path.join(PROPOSAL_PACKAGE_CACHE_DIR, packageId);
  assertInsideCache(destination);

  if (fs.existsSync(destination)) {
    fs.rmSync(destination, { recursive: true, force: true });
  }
  fs.mkdirSync(destination, { recursive: true });

  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      '& { param($zipPath, $destinationPath) Expand-Archive -LiteralPath $zipPath -DestinationPath $destinationPath -Force }',
      packagePath,
      destination,
    ],
    { stdio: 'pipe' },
  );

  return { packageId, destination };
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(fullPath);
    }
    return [fullPath];
  });
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function findFirstFile(rootDir, predicate) {
  return walkFiles(rootDir).find(predicate) || '';
}

function extractSection(markdown, title) {
  const headings = [...markdown.matchAll(/^##\s+\d+\.\s+(.+)$/gm)];
  const matchIndex = headings.findIndex((match) => match[1].includes(title));
  if (matchIndex < 0) {
    return '';
  }
  const start = headings[matchIndex].index + headings[matchIndex][0].length;
  const nextHeading = headings[matchIndex + 1];
  const end = nextHeading ? nextHeading.index : markdown.length;
  return markdown.slice(start, end).trim();
}

function extractTableValue(markdown, label) {
  const pattern = new RegExp(`\\|\\s*${escapeRegExp(label)}\\s*\\|\\s*([^|]+?)\\s*\\|`);
  const match = markdown.match(pattern);
  return cleanString(match?.[1] || '');
}

function extractCodeBlocks(section) {
  return [...section.matchAll(/```(?:text)?\s*([\s\S]*?)```/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function splitTerms(value) {
  return unique(
    String(value || '')
      .split(/[、,;；，\n\r]+/g)
      .map((item) => item.replace(/^[-*\s]+/, '').replace(/[.。]+$/g, '').trim()),
  );
}

function extractDevelopmentKeywords(markdown) {
  const section = extractSection(markdown, SECTION_KEYWORDS);
  const [block] = extractCodeBlocks(section);
  if (!block) {
    return [];
  }
  return unique(block.split(/\r?\n/g));
}

function extractGraphicElements(markdown) {
  const section = extractSection(markdown, SECTION_GRAPHIC_ELEMENTS);
  const lines = section.split(/\r?\n/g);
  const usefulLines = lines.filter((line) =>
    line.includes('\u4e3b\u5143\u7d20') || line.includes('\u8f85\u52a9\u5143\u7d20'),
  );
  return unique(
    usefulLines.flatMap((line) => {
      const value = line.split(/[：:]/).slice(1).join(':');
      return splitTerms(value);
    }),
  );
}

function extractTextElements(markdown) {
  const section = extractSection(markdown, SECTION_TEXT_ELEMENTS);
  const blocks = extractCodeBlocks(section).slice(0, 2);
  return unique(blocks.flatMap((block) => block.split(/\r?\n/g)));
}

function extractColorRequirement(markdown) {
  const designSection = extractSection(markdown, SECTION_DESIGN_REQUIREMENT);
  const palette = ['sage green', 'teal', 'cream', 'warm coral'].filter((term) =>
    designSection.toLowerCase().includes(term),
  );
  return palette.join('; ');
}

function extractStyleRequirement(markdown) {
  const designSection = extractSection(markdown, SECTION_DESIGN_REQUIREMENT);
  return [
    designSection.includes('\u67d4\u548c') ? '\u67d4\u548c' : '',
    designSection.includes('\u6e29\u6696') ? '\u6e29\u6696' : '',
    designSection.includes('\u4e13\u4e1a') ? '\u4e13\u4e1a' : '',
    designSection.includes('\u9ad8\u7ea7') ? '\u9ad8\u7ea7' : '',
    designSection.includes('\u5b89\u9759') ? '\u5b89\u9759' : '',
    'modern warm gift style',
    'clean composition',
    'readable typography',
  ].filter(Boolean).join('; ');
}

function buildStaticUrl(publicBaseUrl, packageId, filePath, rootDir) {
  const relativePath = path.relative(rootDir, filePath).split(path.sep).map(encodeURIComponent).join('/');
  const baseUrl = cleanString(publicBaseUrl).replace(/\/+$/, '');
  return `${baseUrl}${PROPOSAL_PACKAGE_PUBLIC_PATH}/${packageId}/${relativePath}`;
}

function loadManifest(rootDir) {
  const manifestPath = findFirstFile(rootDir, (file) => path.basename(file) === 'evidence_manifest.json');
  if (!manifestPath) {
    return [];
  }
  try {
    return JSON.parse(readTextFile(manifestPath));
  } catch (_error) {
    return [];
  }
}

function buildReferenceImages(rootDir, packageId, publicBaseUrl) {
  const manifest = loadManifest(rootDir);
  const screenshotDir = path.join(rootDir, 'screenshots');
  const screenshotFiles = walkFiles(screenshotDir).filter((file) => /\.(png|jpe?g|webp)$/i.test(file));
  const byName = new Map(screenshotFiles.map((file) => [path.basename(file), file]));
  const entries = manifest.length > 0
    ? manifest
      .map((item) => ({
        item,
        file: byName.get(item.file),
      }))
      .filter((entry) => entry.file)
    : screenshotFiles.map((file) => ({
      item: { file: path.basename(file), title: LABEL_EXTERNAL_EVIDENCE, usage: '' },
      file,
    }));

  return entries.map((entry, index) => ({
    source_field: 'external_evidence_img',
    label: `${LABEL_EXTERNAL_EVIDENCE} ${index + 1}`,
    raw_path: entry.item.url || entry.item.file || '',
    url: buildStaticUrl(publicBaseUrl, packageId, entry.file, rootDir),
    filename: path.basename(entry.file),
    note: cleanString(entry.item.usage || entry.item.title || ''),
  }));
}

function buildProposalFromMarkdown(markdown, options = {}) {
  const graphicElements = extractGraphicElements(markdown);
  const textElements = extractTextElements(markdown);
  const designRequirement = extractSection(markdown, SECTION_DESIGN_REQUIREMENT);
  const category = extractTableValue(markdown, FIELD_PRODUCT_CATEGORY) || CATEGORY_BLANKET;
  const projectName =
    extractTableValue(markdown, FIELD_PROJECT_NAME) ||
    'SLP / Speech Therapist appreciation fleece blanket design proposal';

  return {
    project_name: projectName,
    category,
    category_label: category,
    development_keywords: extractDevelopmentKeywords(markdown),
    core_prompt: extractCodeBlocks(designRequirement).slice(-1)[0] || '',
    design_requirement: designRequirement,
    element_requirement: graphicElements.join('; '),
    element_requirement_source: ELEMENT_REQUIREMENT_SOURCE_UPLOADED,
    real_graphic_elements: graphicElements.join('; '),
    real_graphic_elements_source: ELEMENT_REQUIREMENT_SOURCE_UPLOADED,
    ai_graphic_elements: graphicElements.join('; '),
    ai_graphic_elements_source: ELEMENT_REQUIREMENT_SOURCE_UPLOADED,
    ai_graphic_elements_status: 'provided_graphic_elements',
    ai_graphic_elements_error: null,
    text_elements: textElements.join('; '),
    text_elements_source: 'uploaded_proposal_text_elements',
    text_elements_status: 'real_data',
    text_elements_error: null,
    design_img: '',
    oper_img: (options.referenceImages || []).map((image) => image.raw_path).join('; '),
    reference_images: options.referenceImages || [],
    color_requirement: extractColorRequirement(markdown),
    style_requirement: extractStyleRequirement(markdown),
    craft_requirement: extractTableValue(markdown, FIELD_CRAFT),
    material: extractTableValue(markdown, FIELD_MATERIAL),
    market: extractTableValue(markdown, FIELD_MARKET) || 'Amazon US',
    audience: extractTableValue(markdown, FIELD_AUDIENCE),
    scene: extractTableValue(markdown, FIELD_SCENE),
    quantity: '1pc',
    size: '150*130cm',
    specification: '150*130cm 3D fleece blanket, vacuum compressed package',
    source_row_id: options.packagePath || '',
    updated_at: new Date().toISOString(),
    created_at: '',
  };
}

async function prepareProposalFromPackage(input = {}, options = {}) {
  const packagePath = cleanString(input.packagePath || input.package_path) || DEFAULT_PACKAGE_PATH;
  const publicBaseUrl = input.publicBaseUrl || options.publicBaseUrl || '';
  const { packageId, destination } = expandPackage(packagePath);
  const markdownPath = findFirstFile(destination, (file) => /\.md$/i.test(file));
  if (!markdownPath) {
    const error = new Error('Proposal package does not include a Markdown proposal file.');
    error.code = 'MISSING_MARKDOWN';
    throw error;
  }

  const referenceImages = buildReferenceImages(destination, packageId, publicBaseUrl);
  const proposal = buildProposalFromMarkdown(readTextFile(markdownPath), {
    packagePath,
    referenceImages,
  });

  return prepareProposalFromMinimalFields({
    projectCode: cleanString(input.projectCode || input.project_code) || DEFAULT_PROJECT_CODE,
    minimalFields: proposal,
    lookupStatus: 'uploaded_proposal_package_loaded',
    publicBaseUrl,
    source: UPLOADED_PROPOSAL_LOOKUP_SOURCE,
    dataOrigin: UPLOADED_PROPOSAL_DATA_ORIGIN,
  }, options);
}

module.exports = {
  DEFAULT_PACKAGE_PATH,
  PROPOSAL_PACKAGE_CACHE_DIR,
  PROPOSAL_PACKAGE_PUBLIC_PATH,
  buildProposalFromMarkdown,
  prepareProposalFromPackage,
};
