const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createDataManifest,
  verifyDataManifest,
} = require('./dataManifest');

async function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myml-evidence-manifest-'));
  const dataDir = path.join(tempRoot, 'data');
  const manifestPath = path.join(tempRoot, 'manifest.json');

  try {
    fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'element-terms.json'), '["flower"]\n');
    fs.writeFileSync(path.join(dataDir, 'images', 'sample.png'), Buffer.from([1, 2, 3, 4]));

    const manifest = await createDataManifest(dataDir, manifestPath);
    assert.equal(manifest.fileCount, 2);
    assert.equal(manifest.files.every((item) => !path.isAbsolute(item.path)), true);

    const valid = await verifyDataManifest(dataDir, manifestPath);
    assert.equal(valid.ok, true);

    fs.appendFileSync(path.join(dataDir, 'element-terms.json'), ' ');
    const changed = await verifyDataManifest(dataDir, manifestPath);
    assert.equal(changed.ok, false);
    assert.equal(changed.changed, 1);

    console.log('Data manifest tests passed.');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
