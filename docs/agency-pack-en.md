# Agency packs — write documents in your agency's house style

kordoc ships measured styles for 52 central ministries only. Local governments and public institutions each have their own house style, and there are
hundreds of them, so kordoc cannot contain them all. An agency pack (`.kpack`) solves this the other way round: **you give kordoc a few of your own
agency documents, it builds one file that holds that style**, and with that file kordoc writes new documents in the same style. Nothing agency-specific
is added to kordoc, so no agency logo or internal document ends up in the npm package. The Korean manual ([agency-pack.md](agency-pack.md)) is the reference.

## Quick start

```bash
kordoc pack build report1.hwpx report2.hwpx report3.hwpx --name Gwangyang -o gwangyang.kpack   # same kind of document, 3–10 samples
kordoc pack info gwangyang.kpack --guide                                                     # summary + writing guide
kordoc generate new.md --pack gwangyang.kpack -o new.hwpx                                     # manuscript written per the guide
kordoc pack build press1.hwpx press2.hwpx --name Gwangyang --kind press --into gwangyang.kpack   # add another document kind
```

API: `buildAgencyPack(name, samples, into?)`, `loadAgencyPack(buf)`, `packTemplate(pack, kind?)` → `markdownToHwpx(md, { template: packTemplate(pack) })`.
MCP: `build_agency_pack`, `agency_pack_info`, and `generate_document` with `pack_path`.

## What a pack does

A pack is a **zip with no code**: `pack.json` (name, kinds, representative, roles, per-sample agreement, self-check, leftover text, image count, sample
SHA-256 fingerprints), `kinds/<kind>.hwpx` (the representative sample with its original text stripped — styles, frames and logos only) and `guide.md`.

1. **Representative** — per-role (title box, contact line, summary box, chapter band, □·ㅇ·-·※, body) style votes over font, size, bold, alignment and
   line spacing pick six candidates; they are re-ranked by **cross-reproduction**: regenerate the other samples' text with each candidate and compare formats.
2. **Stripping** — a skeleton manuscript that uses each role once is generated with the representative; author/date metadata is cleared, names and phone
   numbers left in approval-line cells become ○, and department prefixes before job titles are removed.
3. **Self-check** — the stripped template is re-read; if roles or styles differ from the original, the next candidate is used, otherwise a warning is kept.
4. **Loading** treats a pack as untrusted: zip size and entry limits, only `pack.json`, `guide.md`, `kinds/*.hwpx`, and a format version check.

## Verification

Same scorer as the generation fidelity bench (`bench/gen-repro.mjs`). Every number uses a pack built **without** the document being scored.

| Set | Manuscript | Plain report preset | **Agency pack** | Upper bound (own template) | Font/size/bold (preset → pack) |
| --- | --- | --- | --- | --- | --- |
| Seoul policy plans, 5 of 16 with manuscripts | hand-transcribed | 68.3% | **73.9%** | 79.5% | 53.5% → **75.1%** |
| Gwangyang report style 1, 9 docs (from proposal #173) | same | 77.1% | **94.5%** | 95.4% | 38.8% → **85.3%** |
| Gwangyang website notices, 4 docs (same form) | parsed by kordoc | 58.3% | **70.6%** | 74.4% | 24.8% → **54.2%** |

Stripping is lossless for 135 of 144 Seoul template × manuscript cases (the other 9 come from one template the self-check flags). The privacy check
(names, phone numbers and 8-character body fragments of the sample must not appear in the pack) passes for all 16 Seoul and 9 Gwangyang samples.
Reproduce with `node bench/pack-repro.mjs [--dir=<folder>] [--privacy]`.

## Limits

Kind names are free-form (`report` by default, `press`, `notice`, …); they only select a template. Lines that start with a number and a period
(`2026. 3. 1.`) are read as Markdown ordered lists — escape the period (`2026\. 3. 1.`); generation warns about it. Template-mode limits apply (no images, footnotes or inline math; no cover or table of contents; one body section). Documents that use only numeric
hierarchy (1. → 1) → ①) benefit little. Single-table forms should use `fill_form`/`patch_document`. HWP 5.x samples must be saved as HWPX first.
Packs carry no original body text, author data or approval-line names, but they do carry logos, headers and footers — check before sharing.
