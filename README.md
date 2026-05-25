# Kleinanzeigen Upload

Electron app for posting ads to [kleinanzeigen.de](https://www.kleinanzeigen.de) at scale. Edits a folder of items locally, then drives a real Chrome session via the DevTools Protocol to fill out the form and upload photos automatically.

## Architecture

```
Electron app  ──IPC──▶  main process  ──puppeteer──▶  Chrome (debug port 9222)
   editor UI                                              ▲
   (renderer)                                             │
                                                          │ logged-in
   data on disk:                                          │ kleinanzeigen.de
   <project-folder>/<item>/data.json + photos             │ session
                                                          │
   reference data:                                        │
   app/categories.json    (scraped category tree)         │
   app/shipping-options.json (scraped via 🔄 button)──────┘
```

- **Editor (renderer)**: Picks category, sets price/condition/shipping, manages photo order. All form state lives in `data.json` per item folder.
- **Main process**: Spawns Chrome via `open -na` (clean launchd environment, no QoS throttling), exposes IPC for the renderer, runs the automation against the open Kleinanzeigen tab.
- **Automation**: Connects to Chrome through DevTools Protocol, walks the post-ad form step by step. Each step is React-aware (uses native value setters + dispatches synthetic events) and logs to `automation.log` so failures are diagnosable.

## Project layout

```
app/
  src/
    main.js              Electron main process + IPC handlers
    preload.js           contextBridge between renderer and main
    index.html           Editor UI (single file, vanilla JS)
    automation.js        Puppeteer-based form filler
    cli.js               Standalone Node CLI (older, less maintained)
    scrape-categories.js One-shot: refresh app/categories.json
  categories.json        Category tree + per-category attribute schemas
  shipping-options.json  Carriers with current prices and packageSize
  assets/icon.png        macOS app icon

scripts/
  build-icon.py          Regenerate app/assets/icon.png from source
  build-icns.sh          Generate AppIcon.icns for the .app bundle
  inspect-categories.py  Audit each item's categoryPath
  migrate-categories.py  Upgrade legacy 2-level paths to 3 levels

config.json              Points at the project folder (see below)
"Kleinanzeigen Upload.app"  Built macOS app bundle that runs `npx electron .`
```

### Item folder layout (managed by the user)

```
<config.json projectFolder>/
  bomber/
    DSC_0722.JPG
    ...
    data.json
  buffalo boots/
    IMG_2934.HEIC
    ...
    data.json
  ...
```

Each `data.json` carries title, description, price, category path, condition, shipping options, and category-specific attributes (size, color, brand etc.). The editor is just a typed view of these files.

## Running

### Prerequisites

- macOS (the spawn flow uses `/usr/bin/open` and `sips`; Linux/Windows have stub paths but aren't tested)
- Node.js (any recent version)
- Google Chrome installed at `/Applications/Google Chrome.app`
- A Kleinanzeigen account, logged in

### Setup

```bash
npm install
```

Edit `config.json` to point at your item folder:
```json
{ "projectFolder": "/Users/you/Pictures/kleinanzeigen" }
```

You can also pick the folder from the UI later (`📁` button in the sidebar).

### Run

```bash
npm start
```

Then in the app:

1. Click **🌐** to launch Chrome with `--remote-debugging-port=9222 --user-data-dir=/Users/Max/chrome-dev-session`. The button turns green when Chrome is connected.
2. In that Chrome window: log into kleinanzeigen.de and open *Anzeige aufgeben* (the post-ad form).
3. Click **🔄** once to scrape current carrier prices into `app/shipping-options.json`.
4. Pick an item from the sidebar, edit it, then check it in the list and hit **Posten** at the bottom.

For batch posting, tick multiple items and hit **Posten (N)**. The bottom panel also lets you bulk-edit Versandart, shipping methods, and Direkt kaufen.

### Other commands

```bash
npm run cli      # Older standalone CLI (one item at a time, prompts for input)
npm run scrape   # Refresh app/categories.json from kleinanzeigen.de
```

## How it works

### Posting flow

`runSingleItem(itemPath)` in `app/src/automation.js`:

1. Connect Puppeteer to debug Chrome, find the open `kleinanzeigen.de` tab with the form.
2. Type the title.
3. **Category**: prefer matching one of the suggested radios (full path > unique-leaf fallback). Otherwise click *Andere Kategorie wählen* and walk the path manually.
4. Description, price, price type.
5. **Direkt kaufen**: click the matching radio if `data.buyNow` is set and the radios are present.
6. **Per-category attributes**: brand/size/color/condition. Branches by control type — combobox, dialog (Zustand picker), autocomplete (838 brand options), select, plain input. Brand uses keyboard typing + suggestion polling; condition uses a parent-walk to find the dialog trigger button (no ID on it).
7. **Versand**:
    - `versandMode: 'nein'` → click *Nur Abholung* radio.
    - `versandMode: 'ja'` → click *Versand möglich*, open the dialog, switch to view 2 (size picker) via *Andere Versandmethoden*, click the right size (derived from the carriers' `packageSize` in `shipping-options.json`), click *Weiter*, tick the user's specific carriers in view 3, click *Fertig*.
    - `versandMode: 'custom'` → click *Versand möglich*, open the dialog, tick *Individueller Versand*, type the cost, click *Fertig*.
8. ZIP code (hardcoded `44141` Dortmund-Mitte for now).
9. Photo upload: drop files into the file input, then poll `<img>` thumbnails until count matches expected.

### Why we open Chrome via `open -na` instead of spawning the binary directly

Spawning `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` from Electron makes Chrome a child of the app bundle. macOS attributes its network traffic accordingly, applies parent QoS, and the photo uploads get throttled. Going through `launchd` (`open -na`) gives Chrome a clean process tree, and uploads are full-speed.

### Why the brand field needs special handling

The brand attribute has 838 options, rendered as a free-text autocomplete with a server-filtered dropdown. Setting `.value` directly bypasses React's value tracker, so the dropdown filters against stale state and we end up selecting "Sonstige" instead of "Tommy Hilfiger". Fix: clear via real keyboard events, type the label one character at a time with a small delay, then click the matching `[role="option"]` once it appears.

### Why CSS selectors with colons fail

Kleinanzeigen's React app uses `useId()` which generates IDs like `:r8r16:-control`. CSS selectors don't support raw colons in attribute values, so `label[for=":r8r16:-control"]` matches nothing. We work around this by iterating `<label>` elements and matching with `getAttribute('for')`.

### Why the Versandmethoden dialog has three views

1. *Empfehlung für dein Produkt* — recommended pair for the page's default size, with a *Bestätigen* button.
2. *Wähle eine andere Paketgröße aus.* — size radios (Klein/Mittel/Groß) + *Individueller Versand* checkbox. Reached via *Andere Versandmethoden* link. Confirms with *Weiter*.
3. *Optionen mit Sendungsverfolgung* — carrier checkboxes for the chosen size. *Fertig* is disabled until at least one is checked.

The automation always goes via views 2 → 3 so it can pick exact carriers.

## Logs

Automation writes to `automation.log` in the workspace root with one line per step. Rotates to `.old` at 1 MB. Tail it during a run:

```bash
tail -f automation.log
```

Each `[shipping]`, `[category]`, `[fillAttribute]`, `[autocomplete]`, `[attrs]`, `[photos]` line is a checkpoint with structured JSON state.

## Limitations

- ZIP/city are hardcoded to Dortmund-Mitte (`44141`). Editable in code only.
- Photos must be in the item's folder before posting; the upload step doesn't deduplicate or rename.
- The category tree is a snapshot. If Kleinanzeigen restructures their categories, run `npm run scrape` to refresh.
- The `cli.js` flow is older and lags behind `automation.js`. Use the GUI.

## License

Private. Don't distribute.
