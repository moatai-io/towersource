# Tower Spreadsheet Analysis Guide Resource

Use this guide when reading, querying, comparing, or writing Excel/CSV files with Tower finance/spreadsheet tools.

## Tool choice

- `excel_read`: first pass. Understand sheets, headers, merged cells, formulas, formatting, and sample rows.
- `excel_query`: pandas analysis on the pre-cleaned DataFrame `df` after `excel_read` has established structure.
- `excel_diff`: compare two or more Excel/CSV files side-by-side, usually by a key column.
- `excel_write`: create a formatted `.xlsx` from structured row objects.

## `excel_read` interpretation

`excel_read` returns a pre-cleaned view with metadata:

- merged cells unmerged and filled
- auto-detected headers, including multi-row Korean headers
- `_style` column with formatting info
- formulas per column, exposing business logic
- color legend and number formats when available

Treat formulas as a signal for derived columns. Identify which columns are inputs and which are computed before drawing conclusions.

## Formatting semantics

- `_style` contains markers such as `B` for bold, `I` for italic, and `bg:#...` for background color.
- Bold rows often indicate headers, subtotals, or totals.
- Korean financial spreadsheets often use colors semantically: yellow for active/current values, orange for estimates, gray for subtotal/header sections.

## `excel_query` patterns

The DataFrame is named `df` and is already cleaned:

- `df.describe()` for numeric overview
- `df[df._style.str.contains("B", na=False)]` for bold/header/total rows
- `df[df._style.str.contains("bg:", na=False)]` for colored rows
- `df.groupby("Category").sum(numeric_only=True)` for grouped totals
- `df.pivot_table(...)` for matrix summaries
- `df.corr(numeric_only=True)` for numeric relationships

Use `na=False` in style filters when unsure whether `_style` has missing values.

## `excel_diff` guidance

- Use `key_column` when rows represent named items such as `항목`, `거래처`, `계정`, or `SKU`.
- If `value_columns` is omitted, numeric columns are compared automatically.
- Review absolute delta and percentage delta together; percentage deltas can be misleading when the base value is tiny.

## `excel_write` guidance

Pass rows as an array of objects, e.g. `[{"항목":"매출", "금액": 1000}]`. Number columns are auto-formatted with commas by default. Add `title` when producing a shareable report.

Generated `.xlsx` outputs should be saved inside the project and handed off with a workspace absolute path in the final answer.
