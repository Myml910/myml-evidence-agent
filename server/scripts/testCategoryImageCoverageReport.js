const assert = require('assert/strict');
const {
  buildCategoryImageCoverageReport,
} = require('./reportCategoryImageCoverage');

const report = buildCategoryImageCoverageReport({
  latestByProjectCode: {
    YXF2600010001: 'run_2',
    YXF2600010002: 'run_3',
  },
  runs: {
    run_1: {
      runId: 'run_1',
      projectCode: 'YXF2600010001',
      updatedAt: '2026-07-20T00:00:00.000Z',
      projectDataLayer: {
        sections: {
          categoryTargets: {
            items: [{ category: 'old category', hasHistoryTemplate: false }],
          },
        },
      },
    },
    run_2: {
      runId: 'run_2',
      projectCode: 'YXF2600010001',
      updatedAt: '2026-07-21T00:00:00.000Z',
      projectDataLayer: {
        sections: {
          categoryTargets: {
            items: [
              { category: 'plate', catalogStatus: 'ready', hasHistoryTemplate: true },
              { category: 'wind chime', catalogStatus: 'missing_from_category_image_catalog' },
            ],
          },
        },
      },
    },
    run_3: {
      runId: 'run_3',
      projectCode: 'YXF2600010002',
      updatedAt: '2026-07-21T01:00:00.000Z',
      projectDataLayer: {
        sections: {
          categoryTargets: {
            items: [
              { category: 'Wind Chime', hasHistoryTemplate: false },
              { category: 'ornament', hasCatalogEntry: true, hasHistoryTemplate: false },
            ],
          },
        },
      },
    },
  },
});

assert.equal(report.projectsScanned, 2);
assert.equal(report.projectsWithCategoryCoverage, 2);
assert.equal(report.affectedProjectCount, 2);
assert.equal(report.missingCategoryCount, 2);
assert.equal(report.maintenanceRequired, true);
assert.deepStrictEqual(report.categories, [
  {
    category: 'wind chime',
    catalogStatuses: ['missing_from_category_image_catalog'],
    projectCount: 2,
    projects: ['YXF2600010001', 'YXF2600010002'],
    runIds: ['run_2', 'run_3'],
  },
  {
    category: 'ornament',
    catalogStatuses: ['category_image_unusable'],
    projectCount: 1,
    projects: ['YXF2600010002'],
    runIds: ['run_3'],
  },
]);

console.log('[test:category-image-coverage] Category image coverage report tests passed.');
