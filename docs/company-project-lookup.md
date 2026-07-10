# Company Project Lookup

The current MYML Evidence Agent is a slim real company data viewer.

```text
YXF project code
-> read-only company DB lookup
-> mapped company development fields
-> AI real-category classification constrained by the test category sheet
-> built-in element term list matching
-> gpt-5.5 element-term mapping constrained by the built-in term list
-> web page display
```

The app does not read `myml-design-knowledge-base` at runtime, match SKU data,
match historical images, generate images, copy images, or create Obsidian pages.
Element-term mapping uses only the built-in `server/data/element-terms.json`
string list as the allowed vocabulary. AI can choose terms only from recalled
candidates in that built-in list.

Real-category judgment uses `server/data/category-candidates.json`, imported from
the supplied test category workbook. AI can choose only one category from that
candidate catalog. If the AI category call is unavailable or invalid, the API can
return a safe rule fallback based on direct category evidence in the company DB
fields.

## API

Use:

```http
POST /api/proposal-agent/prepare
```

The endpoint name is kept for compatibility, but the behavior is now company project lookup only.

Mapped company fields include development keywords, graphic elements, text elements,
design reference image fields, operation reference image fields, and the other slim
development metadata shown in the web page. Reference image fields are displayed as
company data values only; this app does not download, copy, or generate images.
Element-term output includes only matched terms and source field names; it does not
include source SKUs, categories, titles, or historical image metadata.

AI mapping sends these scoped inputs:

- `project_name` for primary element terms
- project name, development keywords, scene, and design requirement for scene terms
- development keywords, text elements, design requirement, style/color fields, and
  referenced company images for style terms
- element requirement, material/shape/spec fields, design requirement, and referenced
  company images for attribute terms

Product/carrier terms are intentionally excluded from the AI element-term groups.

## Error Cases

- Unrecognized project code
- Missing DB config
- DB query failure
- Project code not found
- Empty field mapping

All DB errors are returned as safe summaries and do not include passwords, API keys, connection strings, or full DB rows.

## Tests

```powershell
npm.cmd run check
```
