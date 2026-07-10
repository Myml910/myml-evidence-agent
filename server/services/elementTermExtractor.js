const fs = require('fs');
const path = require('path');
const { EVIDENCE_DATA_DIR } = require('../config/dataPaths');

const ELEMENT_TERMS_PATH = path.join(EVIDENCE_DATA_DIR, 'element-terms.json');

const SOURCE_FIELDS = [
  'project_name',
  'category_label',
  'development_keywords',
  'core_prompt',
  'design_requirement',
  'element_requirement',
  'text_elements',
  'color_requirement',
  'style_requirement',
  'craft_requirement',
  'material',
  'market',
  'audience',
  'scene',
  'quantity',
  'size',
  'specification',
];

let cachedTerms = null;

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadElementTerms() {
  if (cachedTerms) {
    return cachedTerms;
  }

  const rawTerms = JSON.parse(fs.readFileSync(ELEMENT_TERMS_PATH, 'utf8'));
  cachedTerms = [...new Set(rawTerms.map(normalizeText).filter(Boolean))].sort((a, b) => {
    if (b.length !== a.length) {
      return b.length - a.length;
    }
    return a.localeCompare(b);
  });
  return cachedTerms;
}

function valueToTexts(value) {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return [String(value)];
}

function collectProposalTexts(proposal = {}) {
  return SOURCE_FIELDS.flatMap((field) =>
    valueToTexts(proposal[field]).map((value) => ({
      source_field: field,
      normalized_text: normalizeText(value),
    })),
  ).filter((item) => item.normalized_text);
}

function termMatchesText(term, normalizedText) {
  if (!term || !normalizedText) {
    return false;
  }
  if (term.length < 2) {
    return false;
  }
  if (normalizedText === term) {
    return true;
  }
  return ` ${normalizedText} `.includes(` ${term} `);
}

function extractElementTermsFromProposal(proposal = {}, options = {}) {
  const maxTerms = Number.isInteger(options.maxTerms) ? options.maxTerms : 100;
  const terms = options.terms || loadElementTerms();
  const proposalTexts = collectProposalTexts(proposal);
  const matches = new Map();

  for (const term of terms) {
    for (const textEntry of proposalTexts) {
      if (!termMatchesText(term, textEntry.normalized_text)) {
        continue;
      }

      const existing = matches.get(term) || {
        term,
        source_fields: [],
        match_type: textEntry.normalized_text === term ? 'exact' : 'contains',
      };
      if (!existing.source_fields.includes(textEntry.source_field)) {
        existing.source_fields.push(textEntry.source_field);
      }
      if (textEntry.normalized_text === term) {
        existing.match_type = 'exact';
      }
      matches.set(term, existing);
      break;
    }

    if (matches.size >= maxTerms) {
      break;
    }
  }

  const matchedTerms = [...matches.values()].sort((a, b) => {
    if (b.source_fields.length !== a.source_fields.length) {
      return b.source_fields.length - a.source_fields.length;
    }
    return a.term.localeCompare(b.term);
  });

  return {
    source: 'builtin_element_terms',
    term_count: terms.length,
    matched_term_count: matchedTerms.length,
    matched_terms: matchedTerms,
  };
}

module.exports = {
  ELEMENT_TERMS_PATH,
  SOURCE_FIELDS,
  collectProposalTexts,
  extractElementTermsFromProposal,
  loadElementTerms,
  normalizeText,
  termMatchesText,
};
