# Kleinanzeigen Upload

Electron app for posting ads to [kleinanzeigen.de](https://www.kleinanzeigen.de) at scale. You edit a folder of items locally, then the app drives a real Chrome session via the DevTools Protocol to fill the post-ad form, upload photos, and submit. One ad takes ~10 seconds; ten ads in a row run unattended.

## Architecture

```
┌─ Editor (renderer)  ─┐  ┌─ Main process ────────┐  ┌─ Chrome (debug 9222) ─┐
│ index.html           │  │ main.js               │  │ kleinanzeigen.de tab  │
│  · sidebar list      │◀─▶ IPC handlers          │◀─▶ post-ad form          │
│  · per-item form     │  │ launches Chrome       │  │ logged-in user        │
│  · bulk panel        │  │ writes config/state   │  │                       │
└──────────────────────┘  └─────────┬─────────────┘  └───────────────────────┘
                                    │ puppeteer
                                    ▼
                          ┌─ automation.js ────┐
                          │  walks the form    │
                          │  step by step      │
                          └────────────────────┘

User-managed data:        <project-folder>/<item>/data.json + photos
Bundled reference data:   app/categories.json, app/shipping-options.json
Writable state:           ~/Library/Application Support/Kleinanzeigen Upload/
```

The split:

- **Editor** (`app/src/index.html`) — single-file HTML + vanilla JS. Reads/writes one `data.json` per item, plus a few global pieces of state (project folder, shipping options).
- **Main process** (`app/src/main.js`) — Electron entrypoint. Owns the file system, spawns Chrome, exposes IPC. Read-only assets like `categories.json` ship inside `app.asar`; writable files like `config.json` and `automation.log` live in the OS user-data dir so the app bundle stays read-only.
- **Automation** (`app/src/automation.js`) — Puppeteer-based form filler. Connects to Chrome over the DevTools Protocol, walks the post-ad form step by step. Each step is React-aware (uses native value setters + dispatches synthetic events). Logs every checkpoint to `automation.log` so failures are diagnosable.

## Project layout

```
app/
  src/
    main.js                   Electron main process + IPC handlers
    preload.js                contextBridge between renderer and main
    index.html                Editor UI (single-file vanilla JS)
    automation.js             Puppeteer form filler — the heart of the app
    cli.js                    Older standalone Node CLI (kept for reference)
    scrape-categories.js      Refreshes app/categories.json from kleinanzeigen.de
  categories.json             Category tree + per-category attribute schemas
  shipping-options.json       Carrier IDs with prices and packageSize
  assets/
    icon.png                  1024×1024 source icon
    AppIcon.icns              Generated for the macOS bundle (gitignored)

scripts/
  build-icns.sh               Generates AppIcon.icns from icon.png
  build-icon.py               Regenerates icon.png from the original art
  audit-data.py               Reports schema drift in data.json files
  clean-data.py               One-shot migration: drops dead keys, canonicalizes
  inspect-categories.py       Audits each item's categoryPath
  migrate-categories.py       Legacy: upgrades 2-level paths to 3 levels
```

### What lives where on disk (when packaged)

| File                         | Location                                                     | Why                                  |
| ---                          | ---                                                          | ---                                  |
| `categories.json`            | inside `app.asar` (read-only)                                | ships with the build                 |
| `shipping-options.json`      | inside `app.asar` as default; user copy in user-data dir     | refresh button writes the user copy  |
| `config.json`                | `~/Library/Application Support/Kleinanzeigen Upload/`        | remembers the project folder         |
| `automation.log`             | same                                                         | rotates at 1 MB                      |
| HEIC thumb cache             | same, under `thumbs/`                                        | needed because HEIC isn't web-renderable |
| Item folders + `data.json`   | wherever the user picks (e.g. `~/Pictures/kleinanzeigen/`)   | the user's content                   |
| Chrome user profile          | `/Users/Max/chrome-dev-session/`                             | dedicated profile so cookies survive |

### `data.json` schema (one per item)

```jsonc
{
    "title": "M&S Anzughose Schwarz Slim Fit W34 L31",
    "description": "...",
    "price": "35",
    "priceType": "FIXED",                    // FIXED | NEGOTIABLE | GIVE_AWAY
    "buyNow": true,                          // Direkt kaufen — only honored for FIXED
    "categoryPath": "Mode & Beauty > Herrenbekleidung > Hosen",
    "condition": "like_new",                 // new_with_tag | new | like_new | ok | alright
    "zipCode": "44141",
    "versandMode": "ja",                     // nein | ja | custom — source of truth for shipping
    "shippingOptions": ["HERMES_002", "DHL_001"],   // when versandMode === "ja"
    "customShippingCost": "7,77",            // when versandMode === "custom"
    "dynamicFields": {
        "kleidung_herren.brand":     "marks_spencer",
        "kleidung_herren.groesse":   "m",
        "kleidung_herren.color":     "schwarz",
        "kleidung_herren.art":       "hosen",
        "kleidung_herren.condition": "like_new"
    },
    "autocompleteFields": {                  // human labels for free-text fields
        "brands-input": "Marks & Spencer"
    },
    "photoOrder": ["DSC_0734.JPG", "DSC_0722.JPG", ...],   // order in the post-ad form
    "posted": "2026-05-25T19:24:40.210Z"     // set on successful submit; auto-clears after 24h or on edit
}
```

`dynamicFields` keys are canonical bare attribute names matching `categories.json` schemas (no `_s` suffix, no `attributeMap[]` wrapping). The form's actual `<input name="">` may add `_s` to some attributes — `fillAttribute` tries both forms during lookup, so the storage stays clean.

Run `python3 scripts/audit-data.py` at any time to verify your `data.json` files match this schema. Run `python3 scripts/clean-data.py` once if you find drift.

## Running

### Prerequisites

- macOS (the spawn flow uses `/usr/bin/open` and `sips`; not tested elsewhere)
- Node.js 18+
- Google Chrome installed at `/Applications/Google Chrome.app`
- A logged-in Kleinanzeigen account

### Day-one setup

```bash
npm install
```

That's it. First time you launch the app, the sidebar `📁` button picks your project folder; the path is saved to `config.json` in the user-data dir.

### Two ways to run

**Dev mode** — fast iteration, dock icon shows as "Electron":
```bash
npm start
```

**As a real macOS app** — pinnable in the Dock, opens via Spotlight, looks like a proper app:
```bash
npm run build
codesign --deep --force --sign - "dist/mac-arm64/Kleinanzeigen Upload.app"
mv "dist/mac-arm64/Kleinanzeigen Upload.app" /Applications/
xattr -dr com.apple.quarantine "/Applications/Kleinanzeigen Upload.app"
open "/Applications/Kleinanzeigen Upload.app"
```

The codesign line is an ad-hoc signature — required for unsigned apps to launch on Apple Silicon. Tied to your machine; not for distribution. For a real distributable, get an Apple Developer ID and run `npm run dist` instead.

Other npm scripts:

```bash
npm run scrape     # Refresh app/categories.json from kleinanzeigen.de
npm run cli        # Older standalone CLI (one item, prompts for input)
npm run icns       # Just regenerate AppIcon.icns
npm run dist       # Full build with installer artifacts (.dmg)
```

### Posting an ad — the loop

1. Click **🌐** to launch Chrome with `--remote-debugging-port=9222 --user-data-dir=/Users/Max/chrome-dev-session`. The button turns green when Chrome is connected.
2. In that Chrome window: log into Kleinanzeigen, open *Anzeige aufgeben* (the post-ad form), keep the tab focused.
3. Click **🔄** once per session to scrape current carrier prices into your local copy of `shipping-options.json`. Tooltips on the shipping dropdowns will show the latest prices.
4. Pick an item from the sidebar, edit anything, debounced save writes after 250 ms.
5. Tick one or more items in the sidebar, click **Posten (N)** at the bottom. Each item posts in sequence; on success the item gets a green tag with the post time and sinks to the bottom of the list. After 24 hours the tag turns muted but the timestamp stays visible.

Bulk-edit panel (visible when items are ticked) sets Versandart, shipping methods, or *Direkt kaufen* across the selection in one click — no automation involved, just batched JSON edits.

## How posting works

`runSingleItem(itemPath, { submit })` in `app/src/automation.js`:

1. Connect Puppeteer to debug Chrome, find the open `kleinanzeigen.de` tab with the form.
2. **Title**. Type into `#ad-title`, triple-click + backspace to clear first.
3. **Category**. Kleinanzeigen has two paths to set a category:
    - **Inline autosuggest** (preferred): typing the title shows up to ~3 radio buttons with full category paths. We tick whichever matches our saved path. Match priority: full-path > same-trunk (parent>sub matches, leaf differs — leaf is set later via `art_s`) > unique-leaf-only.
    - **Manual picker** (fallback): click *Andere Kategorie wählen*. Navigates to `p-kategorie-aendern.html`, walks each path segment with polling per level, clicks *Weiter*, waits for navigation back to the form.
4. **Description, price, price type**. Plain typing + combobox click.
5. **Direkt kaufen**. Click `#ad-buy-now-true` or `#ad-buy-now-false` if the radios are present (only shows for FIXED-price items in eligible categories under €1000).
6. **Per-category attributes**. Each `dynamicFields` key dispatches by control type:
    - **combobox**: click trigger, scan `[role="option"]` for matching `data-value` → text → label.
    - **dialog**: condition picker. The trigger button has no ID, so we walk parents of the hidden input until we find a `button[aria-haspopup="dialog"]`, tag it, click, pick the radio inside, hit *Bestätigen*.
    - **autocomplete**: brand. 838 options, server-filtered. Setting `.value` bypasses React's tracker, so we type one character at a time and poll for a matching `[role="option"]`.
    - **select / input**: standard `page.select` / `page.type`.
7. **Versand**:
    - `versandMode: 'nein'` → click *Nur Abholung* radio.
    - `versandMode: 'ja'` → click *Versand möglich*, open the dialog, switch to view 2 (size picker) via *Andere Versandmethoden*, click the matching size (derived from the carriers' `packageSize` in `shipping-options.json`), click *Weiter*, tick the user's specific carriers in view 3, click *Fertig*.
    - `versandMode: 'custom'` → tick *Individueller Versand*, type the cost via puppeteer keyboard so the React handler picks it up, click *Fertig*.
8. **ZIP code**. From `data.zipCode` (typically `44141`).
9. **Photos**. Drop the files into the file input in `data.photoOrder` order, poll `<img>` thumbnails until count matches expected.
10. **Submit** (only if called with `{ submit: true }`). Click *Anzeige aufgeben*, wait up to 60 s for the URL to leave `p-anzeige-aufgeben-schritt2`, then `page.goto()` back to the form so the next item starts fresh. On failure (still on the form after 60 s) the batch stops so you can investigate.

## How `categories.json` works

A scraped snapshot of Kleinanzeigen's category tree plus per-category form schemas. Two consumers:

- **Editor**: builds the parent/sub/leaf dropdowns from `tree`, builds the dynamic attribute fields from `attributeSchemas[<categoryId>].attributes`.
- **Automation**: builds a `{ attrKey: { optionValue: label } }` lookup so the combobox click can fall back to the German label when `data-value` doesn't match (e.g. saved value `pine`, rendered label `Kiefer`).

Refresh with `npm run scrape` whenever Kleinanzeigen restructures their categories.

A subtlety: the tree has 3 visible levels (parent / sub / leaf), but Kleinanzeigen only stores 2 real category IDs. The "leaf" is actually the `art_s` form attribute. That's why our automation accepts a same-trunk autosuggest (different leaf) — `art_s` gets corrected later in step 6.

## How `shipping-options.json` works

Each option has an ID like `HERMES_002`, a `packageSize` (`SMALL` / `MEDIUM` / `LARGE`), a current price, and a description. Two consumers:

- **Editor**: groups options into Klein / Mittel / Groß optgroups in the shipping dropdowns, shows description on hover, enforces same-size constraint between Option 1 and Option 2.
- **Automation**: derives the target package size for the Versandmethoden dialog by picking the largest size needed to ship all selected carriers.

Refresh with the **🔄** button. The button:

1. Connects Puppeteer to the open Kleinanzeigen tab.
2. Reads `availableShippingOptions` from the `<astro-island component-url="…PostListingForm…">` props (Astro encodes values as `[type, value]` tuples — we unwrap them recursively).
3. Writes the result to `~/Library/Application Support/Kleinanzeigen Upload/shipping-options.json` (the user copy overrides the bundled default).

## Why some specific things are the way they are

### Why we open Chrome via `open -na` instead of spawning the binary directly

Spawning `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` from Electron makes Chrome a child of the app bundle. macOS attributes its network traffic accordingly, applies parent QoS, and the photo uploads get throttled (we measured: ~30 KB/s vs full speed). Going through `launchd` with `open -na` gives Chrome a clean process tree and uploads run at line rate.

### Why CSS selectors with colons fail

Kleinanzeigen's React app uses `useId()` which generates IDs like `:r8r16:-control`. CSS selectors don't support raw colons in attribute values, so `label[for=":r8r16:-control"]` matches nothing. We work around this everywhere by iterating `<label>` and matching with `getAttribute('for')`.

### Why the brand field needs special handling

The brand attribute has 838 options, rendered as a free-text autocomplete with a server-filtered dropdown. Setting `.value` directly bypasses React's value tracker, so the dropdown filters against stale state and we end up selecting "Sonstige" instead of "Tommy Hilfiger". Fix: clear via real keyboard events, type the label one character at a time with a small delay, then click the matching `[role="option"]` once it appears.

### Why the Versandmethoden dialog has three views

1. *Empfehlung für dein Produkt* — recommended pair for the page's default size, with a *Bestätigen* button.
2. *Wähle eine andere Paketgröße aus.* — size radios (Klein / Mittel / Groß) + *Individueller Versand* checkbox. Reached via *Andere Versandmethoden*. Confirms with *Weiter*.
3. *Optionen mit Sendungsverfolgung* — carrier checkboxes for the chosen size. *Fertig* is disabled until at least one is checked.

The automation always goes via views 2 → 3 so it can pick exact carriers regardless of what the recommendation shows.

## Logs

Tail during a run:

```bash
tail -f "$HOME/Library/Application Support/Kleinanzeigen Upload/automation.log"
```

Each `[shipping]`, `[category]`, `[fillAttribute]`, `[autocomplete]`, `[attrs]`, `[photos]`, `[submit]` line is a checkpoint with structured JSON state. Rotates to `.old` at 1 MB.

## Limitations

- ZIP code is per-item but city is fixed by ZIP (Kleinanzeigen autofills it).
- Photos must be in the item's folder before posting; the upload step doesn't deduplicate or rename.
- The category tree is a snapshot. If Kleinanzeigen restructures, run `npm run scrape`.
- The `cli.js` flow is older and lags behind `automation.js`. Use the GUI.
- Ad-hoc codesign tied to one Mac. For a real distributable: Apple Developer ID + `npm run dist`.

## License

Private. Don't distribute.
