---
title: "Visual Outputs and Artifacts"
icon: "📊"
order: 6
---

# Visual Outputs and Artifacts

Tower can present structured results directly in a Session and can create durable files for work that should be reopened, edited, printed, or shared.

## Choose the right output

| Need | Recommended output |
|---|---|
| Process, architecture, or relationships | Mermaid diagram |
| Numeric comparison | Chart or data table |
| Trend over time | Line or area chart |
| Dense structured data | Data table or Excel file |
| Before-and-after change | Diff or comparison block |
| Ordered activity | Timeline |
| Executed command evidence | Terminal block |
| Interactive static result | HTML artifact |
| Printable report | PDF |
| Editable business document | DOCX |
| Reusable analysis or source | Markdown, CSV, JSON, or project file |

## In-Session visual blocks

Tower can render supported structured blocks such as:

- Mermaid diagrams;
- charts and treemaps;
- data tables;
- timelines and step lists;
- maps;
- diffs and comparisons;
- galleries;
- terminal output;
- interactive forms;
- HTML and SVG previews;
- CAD evidence previews.

The AI should choose a visual only when it makes the relationship, sequence, magnitude, or decision easier to understand than prose alone.

## Viewer Pane and files

A durable artifact should be written to the Project and opened in the Viewer Pane. The Viewer Pane can display or edit supported files without losing the Session context.

Use Project files when:

- collaborators need to review the result later;
- the output will be revised over several Sessions;
- the work needs a stable path;
- the artifact should be handed off to another Project or attached to a conversation;
- the result should be published or exported.

## PDF, spreadsheet, and CAD analysis

Layout-heavy formats require visual inspection.

- PDFs should be checked as rendered pages, not only as extracted text.
- Spreadsheets should be read with formulas, merged headers, number formats, and meaningful formatting preserved.
- CAD previews are useful for visual understanding but do not replace engineering sign-off for critical dimensions or tolerances.

Tower uses dedicated runtime guides for these tool contracts.

## Publishing a static result

A static HTML site or report can be published through Tower Publishing Hub.

1. Create a project-local output directory containing `index.html`.
2. Review the output before publishing.
3. Use **unlisted** visibility by default.
4. Use **public** only when you explicitly want a public or discoverable URL.
5. Share the returned URL only after publication succeeds.

Do not write directly into server publishing directories or invent a deployment URL.

## Exporting a PDF

For a final PDF artifact, Tower exports print-ready HTML through its PDF pipeline and visually verifies the rendered pages.

A successful source build is not enough. Check page breaks, fonts, diagrams, charts, and clipped content in the final PDF preview.

## Artifact paths

Generated user-facing files should stay inside the current Project. Common conventions include:

```text
work/      intermediate work
final/     shareable final outputs
sources/   source material
records/   durable records
```

Follow the current Project's `AGENTS.md` when it defines different paths.
