# Tower PDF Analysis Guide Resource

Use this guide when reading, inspecting, extracting tables from, or visually understanding existing PDF files. This is separate from `pdf-export`, which creates final PDFs from print-ready HTML.

## Core rule

PDFs are visual documents. Do not conclude from text extraction alone when layout, scans, drawings, forms, slides, signatures, or page breaks matter.

## Tool choice

- `pdf_view`: visual understanding. Render pages to internal cached images and inspect with vision.
- `pdf_read`: table extraction from financial reports, invoices, audit reports, and similar text/table PDFs.
- `read` on a PDF: convenient quick path; it automatically views representative pages for vision analysis.
- `project_shell`: only for custom preprocessing, specialized CLI use, generated intermediate artifacts, or Runtime Box project-local scripts.

## Recommended flow

1. Start with `pdf_view` when the request says read, inspect, review, summarize, compare layout, understand a scanned PDF, analyze drawings, or check a slide deck/form.
2. Use `pdf_read` as a supplement when structured tables are needed.
3. Specify page ranges for precision and speed, e.g. `pages: "5-8"` for financial statements.
4. If text extraction or OCR is weak, do not stop. Inspect rendered pages visually.
5. Summarize broad PDFs in page batches; inspect smaller ranges at higher DPI for detail.

## `pdf_read` table extraction notes

- Best for financial reports, invoices, prospectuses, audit reports, and structured tables.
- Korean parenthetical negatives like `(1,234,567)` are auto-converted to negative numbers.
- Multi-page table continuation is supported when the relevant pages are extracted together.
- Use `table_index` only after first seeing which tables were detected.

## Runtime Box boundary

For project-local PDFs, prefer harness `pdf_view` for ordinary visual reading because it uses internal cache and does not create project files. Use `project_shell` only when you need custom preprocessing or generated intermediate artifacts under `/workspace`.

Do not tell the user a PDF cannot be analyzed just because `pdf_read`, OCR binaries, or sandbox workspace mounting failed. Switch to `pdf_view` or explicit rendering and report the useful outcome.
