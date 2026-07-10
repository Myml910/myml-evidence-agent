const assert = require('assert');
const fs = require('fs');
const {
  ELEMENT_TERMS_PATH,
  extractElementTermsFromProposal,
  loadElementTerms,
} = require('../services/elementTermExtractor');

function main() {
  const rawTerms = JSON.parse(fs.readFileSync(ELEMENT_TERMS_PATH, 'utf8'));
  assert(Array.isArray(rawTerms));
  assert(rawTerms.length > 3000);
  assert(rawTerms.every((term) => typeof term === 'string'));
  assert(rawTerms.includes('baby shower'));
  assert(rawTerms.includes('flower bloom'));
  assert(rawTerms.includes('flower decorations'));
  assert(!JSON.stringify(rawTerms.slice(0, 20)).includes('source_skus'));
  assert(!JSON.stringify(rawTerms.slice(0, 20)).includes('category_labels'));

  const terms = loadElementTerms();
  const result = extractElementTermsFromProposal({
    development_keywords: ['baby shower decorations', 'baby in bloom'],
    design_requirement: 'Use flower bloom and flower decorations.',
    text_elements: 'baby in bloom',
  }, {
    terms,
  });

  const matchedTerms = result.matched_terms.map((match) => match.term);
  assert.strictEqual(result.source, 'builtin_element_terms');
  assert(result.term_count > 3000);
  assert(matchedTerms.includes('baby shower'));
  assert(matchedTerms.includes('flower bloom'));
  assert(matchedTerms.includes('flower decorations'));
  assert(!matchedTerms.includes('baby in bloom'));
  assert(
    result.matched_terms.every(
      (match) =>
        !Object.prototype.hasOwnProperty.call(match, 'source_skus') &&
        !Object.prototype.hasOwnProperty.call(match, 'category_labels'),
    ),
  );

  console.log('[test:element-terms] Built-in element term extractor tests passed.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
