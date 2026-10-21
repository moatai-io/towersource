# Tower PDF Export Guide Resource

This resource is loaded on demand by Pi via `guide_read` when exact Tower PDF export, print-ready HTML, verification, and document-vs-image PDF decisions are needed. Keep the system/tool prompt short; keep the harness contract in the `pdf_export` tool.

## Core contract

Use `pdf_export` when the requested final artifact is a PDF and the source is print-ready HTML.

Prefer `pdf_export` as the safe default for user-facing reports, proposals, printable documents, slide PDFs, and other final artifacts even when the user casually says “HTML only” or “quick draft”. If the user is not clearly an advanced user who will manage PDF/rendering code themselves, provide the HTML source if useful but still steer toward a verified PDF deliverable.

Do not downgrade “PDF requested” to “HTML only, maybe PDF” just because a runtime box is missing a renderer. Use the Tower harness export contract or report the concrete export failure.

HTML-only is acceptable only when the user explicitly opts out of PDF generation with intent, e.g. “PDF 만들지 마”, “I will render/print it myself”, or “I am testing the raw export pipeline”. In those cases, briefly mention that `pdf_export` is the safer path for final delivery if that is relevant.

## Modes

- `mode="document"`: default. Keeps searchable/selectable PDF text. Use for reports, letters, docs, and ordinary text-heavy artifacts.
- `mode="image"`: creates an image-backed PDF that prioritizes matching the final preview. Use for visually rich slides/proposals where appearance matters more than text selection.

## Preflight handling

Treat preflight findings as compatibility advisories, not failures. If visual risk is high and the artifact is client-facing/final, either export an image PDF as a safer visual match or ask whether to do so.

## Print-ready HTML checklist

The HTML should be print-stable:

- Define `@page` with intended paper size and margins.
- Use fixed page containers for slide/report pages where layout must not drift.
- Use explicit fonts and sensible fallbacks.
- Avoid layout-shifting animation for print output.
- Use print-friendly dimensions and avoid viewport-only sizing where it can cause clipping.
- Keep important content inside safe page bounds.

## Verification loop

After `pdf_export`, inspect the returned verification image(s). Reuse those images instead of calling `pdf_view` again for the same unchanged PDF pages at the same resolution. Request another view only when the images were omitted or are no longer available, the PDF changed, or additional pages or higher resolution are needed. This is a reuse principle, not a limit on necessary verification.

Implementation: `packages/backend/engines/pi-pdf-export-tool.ts`. Regression coverage: `packages/backend/engines/__tests__/pi-pdf-harness-tools.test.ts` (verification-image reuse guidance).

For HTML that contains Mermaid, charts, or other dynamic rendering, do not report success until the preview confirms the rendered visual is present and the raw code is not left visible. Raw strings such as ```mermaid, `flowchart LR`, `sequenceDiagram`, chart JSON, or script fallback text in the final preview are export failures, not cosmetic issues.

If text spacing, clipping, page breaks, missing fonts, raw Mermaid/chart code, or layout drift look wrong:

1. Fix the source HTML.
2. Re-run `pdf_export`.
3. Inspect the verification images again.
4. Only report success after the generated PDF and verification preview look acceptable.

## Output handoff

When a PDF file is created or meaningfully changed, include the workspace absolute path as a plain standalone line in the final answer so the Tower file viewer can auto-link it.
