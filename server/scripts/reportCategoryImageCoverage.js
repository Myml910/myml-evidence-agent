const fs = require('fs');
const path = require('path');
const { EVIDENCE_RUNTIME_DIR } = require('../config/dataPaths');

const READY_STATUS = 'ready';
const MISSING_STATUS = 'missing_from_category_image_catalog';
const UNUSABLE_STATUS = 'category_image_unusable';
const DEFAULT_PROJECT_RUN_STORE_PATH = path.join(EVIDENCE_RUNTIME_DIR, 'project-runs.json');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function targetCatalogStatus(target = {}) {
  const explicit = cleanString(target.catalogStatus);
  if (explicit) return explicit;
  if (target.hasHistoryTemplate === true) return READY_STATUS;
  return target.hasCatalogEntry === true ? UNUSABLE_STATUS : MISSING_STATUS;
}

function latestRuns(store = {}) {
  const runs = store.runs && typeof store.runs === 'object' ? store.runs : {};
  const latestByProjectCode = store.latestByProjectCode && typeof store.latestByProjectCode === 'object'
    ? store.latestByProjectCode
    : {};
  const selected = new Map();

  for (const [projectCode, runId] of Object.entries(latestByProjectCode)) {
    const run = runs[runId];
    if (run) selected.set(projectCode, run);
  }

  for (const run of Object.values(runs)) {
    const projectCode = cleanString(run?.projectCode);
    if (!projectCode) continue;
    const current = selected.get(projectCode);
    if (!current || String(run.updatedAt || '').localeCompare(String(current.updatedAt || '')) > 0) {
      selected.set(projectCode, run);
    }
  }

  return Array.from(selected.entries()).map(([projectCode, run]) => ({ projectCode, run }));
}

function buildCategoryImageCoverageReport(store = {}) {
  const runs = latestRuns(store);
  const gaps = new Map();
  const affectedProjects = new Set();
  let projectsWithCoverage = 0;

  for (const { projectCode, run } of runs) {
    const items = run?.projectDataLayer?.sections?.categoryTargets?.items;
    if (!Array.isArray(items) || items.length === 0) continue;
    projectsWithCoverage += 1;

    for (const target of items) {
      const category = cleanString(target?.category);
      const status = targetCatalogStatus(target);
      if (!category || status === READY_STATUS) continue;

      const key = category.toLocaleLowerCase();
      const gap = gaps.get(key) || {
        category,
        catalogStatuses: new Set(),
        projects: new Set(),
        runIds: new Set(),
      };
      gap.catalogStatuses.add(status);
      gap.projects.add(projectCode);
      if (cleanString(run?.runId)) gap.runIds.add(run.runId);
      gaps.set(key, gap);
      affectedProjects.add(projectCode);
    }
  }

  return {
    projectsScanned: runs.length,
    projectsWithCategoryCoverage: projectsWithCoverage,
    affectedProjectCount: affectedProjects.size,
    missingCategoryCount: gaps.size,
    maintenanceRequired: gaps.size > 0,
    categories: Array.from(gaps.values())
      .map((gap) => ({
        category: gap.category,
        catalogStatuses: Array.from(gap.catalogStatuses).sort(),
        projectCount: gap.projects.size,
        projects: Array.from(gap.projects).sort(),
        runIds: Array.from(gap.runIds).sort(),
      }))
      .sort((left, right) => (
        right.projectCount - left.projectCount || left.category.localeCompare(right.category)
      )),
  };
}

function main() {
  const storePath = path.resolve(
    process.argv[2] || process.env.PROJECT_RUN_STORE_PATH || DEFAULT_PROJECT_RUN_STORE_PATH,
  );
  if (!fs.existsSync(storePath)) {
    throw new Error(`PROJECT_RUN_STORE_NOT_FOUND:${storePath}`);
  }

  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const report = buildCategoryImageCoverageReport(store);

  console.log(`STORE=${storePath}`);
  console.log(`PROJECTS_SCANNED=${report.projectsScanned}`);
  console.log(`PROJECTS_WITH_CATEGORY_COVERAGE=${report.projectsWithCategoryCoverage}`);
  console.log(`AFFECTED_PROJECTS=${report.affectedProjectCount}`);
  console.log(`MISSING_CATEGORY_IMAGE_CATALOG_ENTRIES=${report.missingCategoryCount}`);
  console.log(`CATEGORY_IMAGE_CATALOG_MAINTENANCE_REQUIRED=${report.maintenanceRequired}`);
  for (const category of report.categories) {
    console.log(`CATEGORY_GAP=${JSON.stringify(category)}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildCategoryImageCoverageReport,
  targetCatalogStatus,
};
