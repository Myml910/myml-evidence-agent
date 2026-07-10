# MYML Evidence Agent

Production data layout, secure transfer, manifest verification, and container
readiness checks are documented in `docs/server-data-deployment.md`.

Current slim version:

```text
project code
-> read-only real company DB lookup
-> AI real-category classification constrained by the test category sheet
-> built-in element term list matching
-> gpt-5.5 element-term mapping constrained by the built-in term list
-> read-only element gallery relationship lookup
-> company development data shown in the web page
```

This build uses a built-in `server/data/element-terms.json` string list as the only
element-term vocabulary source. AI mapping is constrained to this built-in term list:
project name maps to primary element terms, development keywords plus text elements
map to other element terms, and referenced company images can be sent with the
development requirement for image-aware term mapping. When the optional gallery
index is available, the app reads `element-source-gallery-index.json` to show a
local element-term-to-gallery-image relationship graph. It intentionally does not
do nine-type experiments, SKU matching, historical image matching, image
generation, image copying, or Obsidian export.

The supplied June 2026 test category workbook has been imported into
`server/data/category-candidates.json`. The category classifier asks the AI model
to choose one true category only from that candidate list using the real company
proposal fields. If the classifier is not configured or the model returns an
invalid category, the API returns a safe rule-based fallback when direct category
evidence is available.

## Run

```powershell
npm.cmd run dev
```

Frontend:

```text
http://127.0.0.1:4260
```

Backend:

```text
http://127.0.0.1:3101
```

## Environment

Copy `.env.example` to `.env` and configure only the read-only company DB settings:

```env
COMPANY_LOOKUP_SOURCE=db_minimal
COMPANY_DB_HOST=
COMPANY_DB_PORT=3306
COMPANY_DB_NAME=
COMPANY_DB_USER=
COMPANY_DB_PASSWORD=
COMPANY_DB_VIEW=
COMPANY_DB_PROJECT_CODE_COLUMN=project_code
COMPANY_DB_TIMEOUT_MS=10000
COMPANY_REFERENCE_IMAGE_BASE_URL=
AI_ELEMENT_MAPPER_ENABLED=true
AI_ELEMENT_MAPPER_BASE_URL=https://ai.t8star.org/v1
AI_ELEMENT_MAPPER_ENDPOINT_PATH=/chat/completions
AI_ELEMENT_MAPPER_API_KEY=
AI_ELEMENT_MAPPER_MODEL=gpt-5.5
AI_CATEGORY_CLASSIFIER_ENABLED=
AI_CATEGORY_CLASSIFIER_BASE_URL=
AI_CATEGORY_CLASSIFIER_ENDPOINT_PATH=
AI_CATEGORY_CLASSIFIER_API_KEY=
AI_CATEGORY_CLASSIFIER_MODEL=
AI_CATEGORY_CLASSIFIER_TIMEOUT_MS=
AI_CATEGORY_CLASSIFIER_MAX_TOKENS=
AI_CATEGORY_CLASSIFIER_RESPONSE_FORMAT=
MYML_DESIGN_KNOWLEDGE_BASE_PATH=
ELEMENT_SOURCE_GALLERY_INDEX_PATH=
ELEMENT_GALLERY_MAX_IMAGES_PER_TERM=8
ELEMENT_GALLERY_MAX_GRAPH_IMAGES=40
```

If DB config is missing, the API returns:

```text
真实公司数据源未配置，请检查 COMPANY_DB_* 配置。
```

The server only performs a parameterized `SELECT * FROM <configured view> WHERE <project code column> = ? LIMIT 1`. It does not write to the database.

The gallery relationship view is also read-only. Configure either
`MYML_DESIGN_KNOWLEDGE_BASE_PATH` or `ELEMENT_SOURCE_GALLERY_INDEX_PATH` if the
knowledge base is not in the default local workspace location.

## API

`POST /api/proposal-agent/prepare`

Request:

```json
{
  "projectCode": "YXF2603230144"
}
```

Natural language containing a YXF project code is also accepted through `message`.

Response shape:

```json
{
  "project_code": "",
  "found": true,
  "source": "real_company_lookup",
  "data_origin": "real_company_db",
  "mock": false,
  "proposal": {
    "project_name": "",
    "category": "",
    "category_label": "",
    "development_keywords": [],
    "core_prompt": "",
    "design_requirement": "",
    "element_requirement": "",
    "text_elements": "",
    "design_img": "",
    "oper_img": "",
    "reference_images": [
      {
        "source_field": "design_img",
        "label": "",
        "raw_path": "",
        "url": "",
        "filename": ""
      }
    ],
    "color_requirement": "",
    "style_requirement": "",
    "craft_requirement": "",
    "material": "",
    "market": "",
    "audience": "",
    "scene": "",
    "quantity": "",
    "size": "",
    "specification": "",
    "source_row_id": "",
    "updated_at": "",
    "created_at": ""
  },
  "category_judgment": {
    "status": "success",
    "source": "ai_category_classifier",
    "basis": "test_category_catalog",
    "model": "gpt-5.5",
    "catalog_source": "2026-6月-近期品类表.xlsx",
    "candidate_count": 70,
    "predicted_category": "",
    "confidence": 0.0,
    "reason": "",
    "evidence_fields": [],
    "alternatives": [],
    "match_source": "ai",
    "ai_error": null
  },
  "element_terms": {
    "source": "builtin_element_terms",
    "term_count": 0,
    "matched_term_count": 0,
    "matched_terms": [
      {
        "term": "",
        "source_fields": [],
        "match_type": "contains"
      }
    ]
  },
  "ai_element_mapping": {
    "ai_status": "success",
    "model": "gpt-5.5",
    "source": "ai_element_mapper",
    "basis": "builtin_element_terms",
    "primary_element_terms": [],
    "scene_terms": [],
    "style_terms": [],
    "attribute_terms": [],
    "unmatched_terms": [],
    "summary": {
      "primary_count": 0,
      "scene_count": 0,
      "style_count": 0,
      "attribute_count": 0,
      "unmatched_count": 0
    },
    "ai_error": null
  },
  "element_gallery": {
    "status": "success",
    "source": "element_source_gallery_index",
    "terms_count": 0,
    "matched_terms_count": 0,
    "image_count": 0,
    "max_intersection_count": 0,
    "primary_element_gallery_matches": [],
    "other_element_gallery_matches": [],
    "graph": {
      "nodes": [],
      "edges": []
    },
    "error": null
  },
  "field_summary": {
    "field_count": 0,
    "non_empty_field_count": 0,
    "development_keywords_count": 0
  }
}
```

## Checks

```powershell
npm.cmd run check
```

Safe real lookup diagnostic:

```powershell
npm.cmd run diagnose:proposal-lookup -- YXF2603230144
```

The diagnostic prints only a safe summary. It does not print DB passwords, API keys, connection strings, full DB rows, or full proposal text.
