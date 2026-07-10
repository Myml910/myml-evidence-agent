const fs = require('fs');
const path = require('path');
const { prepareProposalFromCompanyLookup } = require('../server/services/companyLookupAdapter');

const ROOT = path.resolve(__dirname, '..');
const PROJECT_CODE_PATTERN = /\b(yxf\d{10})\b/i;

function loadLocalEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .forEach((rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) {
        return;
      }
      const separatorIndex = line.indexOf('=');
      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
}

function parseProjectCode(value) {
  const match = String(value || '').match(PROJECT_CODE_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

async function main() {
  loadLocalEnv();
  const rawInput = process.argv.slice(2).join(' ') || 'YXF2603230144';
  const projectCode = parseProjectCode(rawInput);
  const result = await prepareProposalFromCompanyLookup({
    message: rawInput,
    projectCode,
  });

  console.log(
    JSON.stringify(
      {
        project_code: result.project_code,
        found: result.found,
        source: result.source,
        data_origin: result.data_origin,
        mock: result.mock,
        lookup_status: result.lookup_status,
        error_code: result.error_code,
        error_message: result.error_message,
        field_summary: result.field_summary,
        safe_proposal_summary: {
          project_name_present: Boolean(result.proposal.project_name),
          category: result.proposal.category || null,
          category_label: result.proposal.category_label || null,
          development_keywords_count: result.proposal.development_keywords.length,
          text_elements_present: Boolean(result.proposal.text_elements),
          design_img_present: Boolean(result.proposal.design_img),
          oper_img_present: Boolean(result.proposal.oper_img),
          reference_image_field_count: [result.proposal.design_img, result.proposal.oper_img].filter(
            Boolean,
          ).length,
          reference_image_count: Array.isArray(result.proposal.reference_images)
            ? result.proposal.reference_images.length
            : 0,
          reference_image_display_url_count: Array.isArray(result.proposal.reference_images)
            ? result.proposal.reference_images.filter((image) => Boolean(image.url)).length
            : 0,
          builtin_element_term_count: result.element_terms?.term_count || 0,
          matched_element_term_count: result.element_terms?.matched_term_count || 0,
          ai_element_status: result.ai_element_mapping?.ai_status || 'unknown',
          ai_element_model: result.ai_element_mapping?.model || '',
          ai_primary_term_count: result.ai_element_mapping?.summary?.primary_count || 0,
          ai_scene_term_count: result.ai_element_mapping?.summary?.scene_count || 0,
          ai_style_term_count: result.ai_element_mapping?.summary?.style_count || 0,
          ai_attribute_term_count: result.ai_element_mapping?.summary?.attribute_count || 0,
          category_judgment_status: result.category_judgment?.status || 'unknown',
          category_judgment_source: result.category_judgment?.match_source || 'unknown',
          category_candidate_count: result.category_judgment?.candidate_count || 0,
          predicted_category: result.category_judgment?.predicted_category || null,
          predicted_category_confidence: result.category_judgment?.confidence || 0,
          selected_gallery_image_status: result.selected_gallery_images?.status || 'unknown',
          selected_gallery_image_count: result.selected_gallery_images?.selected_image_count || 0,
          gallery_filter_candidate_count: result.selected_gallery_images?.candidate_image_count || 0,
          source_row_id_present: Boolean(result.proposal.source_row_id),
          updated_at_present: Boolean(result.proposal.updated_at),
          created_at_present: Boolean(result.proposal.created_at),
        },
        safety: {
          no_db_password_printed: true,
          no_api_key_printed: true,
          no_connection_string_printed: true,
          no_full_proposal_printed: true,
          no_prompt_printed: true,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
