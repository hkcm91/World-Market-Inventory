# Barcode Scanner (StickerNest widget)

A single-file StickerNest widget that scans barcodes with the device camera
(or accepts typed codes) and records every scan as a row in a StickerNest
**DataSource** (table).

## What it does

- **Camera scanning** via the native `BarcodeDetector` API, with a lazy
  [`@zxing/library`](https://github.com/zxing-js/library) fallback for browsers
  that lack it. Manual entry always works.
- **Records to a database** — each scan is written as a row via the live
  `StickerNest.datasource.table.addRow` API. Cells are keyed by column id; the
  widget reads the bound DataSource schema at load and maps column *name → id*,
  so renaming/rebuilding the table keeps working.
- **Two workflows**: stage a scan and edit its metadata before saving, or flip
  on **Auto-save each scan** for rapid inventory counting.
- **Recent scans** are read back from the DataSource and listed newest-first.
- Duplicate-scan debounce (2.5s), beep + haptic feedback on a good read.
- Emits `barcode.scanned` and `datasource.changed` on the host bus so pipelines
  and other widgets can react.

## Bound database

By default the widget binds to the **"Barcode Scans"** DataSource
(`dd8dc90f-e5b2-4f6e-9142-0061692b2133`) with columns:

| Column | Type |
| --- | --- |
| Barcode | text |
| Format | text |
| Product | text |
| Quantity | number |
| Location | text |
| Note | text |
| Scanned At | text (ISO timestamp) |

Point it at a different table by setting the instance config
`dataSourceId` (and optionally `dataSourceName`, `autoSave`).

## Live vs. preview

The DataSource API is only injected when the widget is mounted on a **canvas**.
In the MCP/preview sandbox it shows a `PREVIEW` badge and keeps scans locally;
on a canvas it shows `LIVE` and writes real rows.

## Permissions

`datasource`, `datasource-write`, `camera`.

## Publishing

This HTML is the source of record. It was published to the StickerNest library
via `library_save_widget` (widget id `barcode-scanner`). To update, edit this
file and re-save with the same widget id.
