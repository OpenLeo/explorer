# OpenLEO Explorer

A static web application to browse the [PSA-RE](https://github.com/prototux/PSA-RE) DBMUXEv (v0.2) YAML
database of the Peugeot / Citroën / DS electronic architectures (AEE2001 VAN+CAN, AEE2004, AEE2010…),
written for people who build things that talk to these cars: custom ECUs, diagnostic tools,
CAN / VAN / LIN sniffers, dashboards, retrofits.

No build step, no server code: `index.html` + ES modules + one CSS file. The only external library is
[js-yaml](https://github.com/nodeca/js-yaml), loaded from jsDelivr with a vendored copy (`vendor/js-yaml.mjs`) as fallback.

> Unofficial, reverse engineered data: use it at your own risk. The HS / IS bus is safety critical.

## Features

- **Architectures**: variants (comment, years, parent), buses (protocol, bitrate), SVG topology
  (buses as lines, ECUs attached, gateways such as the BSI connected to several buses),
  ECU codes, diff with the parent variant (added / changed / inherited frames), bus notes.
- **Cars**: searchable table (codes, names, brand, years, architecture); car page with versions, fitted ECUs
  (optional ones marked) and the frames you should see on the car.
- **Frames** (main view): filters (architecture, buses, ECU as sender/receiver, text, type, timing, alternatives,
  data warnings, source), virtualized list, and per frame:
  - **Grid**: SavvyCAN / CANdb++ style bit layout (8 columns, one row per byte, MSB/LSB markers, hatched
    undocumented bits, mux selector, big-endian and little-endian multi-byte signals, long can-tp/VAN payloads
    collapsed), hover details and legend;
  - **Simple view**: bit string with letter groups and staggered callouts, plus a
    prose listing ("Byte 3, bits 7-6: … 0 = closed, 1 = open");
  - **Signals** table (PSA bits, start, length, DBC Motorola start bit, type, scaling, range, invalid/default, values);
  - **Emitters / receivers** SVG diagram with links to the ECUs and the cars fitted with them;
  - **Decode** a payload (hex or a candump line) with flags (invalid, out of range, unknown value…);
  - **Encode** from a form (physical values, enums, raw) with `cansend`, `cangen`, candump, SavvyCAN CSV,
    python-can, Arduino MCP2515 and ESP32 TWAI snippets (VAN and LIN specifics: LIN PID/checksum);
  - **Code**: C header (struct + pack/unpack with shifts and masks, sign extension, byte order),
    Python decoder/encoder, DBC snippet;
  - **Alternatives**: conflicting observations side by side, applicable to every other tab;
  - **Other architectures**: same ID elsewhere with a signal-level diff.
  - Variant inheritance (inherited frames, "changed in this variant" + diff), symbolic links
    ("same as AEE2004.full LS.CONF 036"), multi-source switch, "never released" badges.
- **Signals**: searchable exact-name cross-reference across effective architecture variants, independent of frame ID.
  Each signal page groups occurrences by architecture and shows the containing frame, bus, bit range, encoding,
  timing, source/inheritance status, and links back to the frame's Signals tab.
- **ECUs**: list per variant (inherited nodes marked, pseudo nodes such as `DIAG_TOOL`), ECU page with the frames
  sent/received, diag addressing, a "build a custom ECU / emulate it" checklist (kept in the browser),
  cars fitted with it, DBC export limited to its frames.
- **Diagnostics**: protocol reference (from `diag/protocols/*.yml`, or built-in ISO 14229/14230/J1979 tables),
  addressing table (nodes' `diag` blocks + `diag/*/*/ecu.yml`), ECU diag pages (sessions, services,
  security access, DIDs/LIDs/routines/IO controls with a payload decoder), DTC lookup (`B1003` ↔ `0x9003`),
  ISO-TP request builder (SF/FF/FC/CF explained, can-utils / isotp / python-can-isotp snippets), and the PSA
  seed/key calculator (port of `PSA-RE/sandbox/uds_auth_algorithm.py`). Shows "no data yet" when `diag/` is absent.
- **Tools**: log decoder (candump `-L` and default formats, SavvyCAN/GVRET CSV, Vector ASC, plain `ID#DATA`) with
  per-ID statistics (count, measured vs documented period, unknown IDs, changing bits heat map, ISO-TP reassembly),
  bit position converter (PSA ↔ DBC Motorola ↔ Motorola LSB ↔ Intel), DBC / JSON export (whole bus or filtered),
  bus load estimator, data issues panel.
- Global search (`/`): frame ID (`036`, `0x036`), frame/signal names, ECUs, car codes, DTCs, DIDs.
- Hash routing (shareable URLs such as `#/frames/AEE2004.full/LS.CONF/036?tab=decode`), content language
  selector (en, fr, es, de, it, pl, ru, zh, hu with fallback en → fr → any), light/dark theme.

## Run locally

```sh
cd /path/to/BusDoc            # folder containing openleo-explorer/ (and optionally PSA-RE*/)
python3 -m http.server 8000
# open http://localhost:8000/openleo-explorer/
```

ES modules need HTTP (opening `index.html` with `file://` does not work).

Serve the explorer and the repositories **from the same server** (same host and port): a page loaded from
`localhost:8080` cannot read data from `localhost:8081`, because `python3 -m http.server` does not send CORS
headers and the browser blocks the requests. If you really want separate servers, serve the data with
`python3 openleo-explorer/tools/serve.py 8081` (directory listings + CORS headers).

By default the data is fetched from GitHub (`prototux/PSA-RE@master`). To use local repositories served by the same
server, open the settings (⚙) and add HTTP sources, or pass them in the URL:

```
http://localhost:8000/openleo-explorer/?url=http://localhost:8000/PSA-RE/&only
```

(`url=` and `github=owner/repo@branch[:subpath]` can be repeated; `&only` ignores the saved sources.)

## Host it

Copy the `openleo-explorer/` folder to any static host (GitHub Pages works as is: publish the folder or a branch
containing it). Nothing else is needed; the data is fetched by the browser.

## Data sources

Sources are configured in the settings page and stored in `localStorage`. Several sources can be enabled at once:
they are merged in the configured order (the first one wins by default), every object is tagged with its source
(colored badge), and frames defined in several sources get a "sources" switch. Nodes marked `released: false`
in the data show a red "never released" badge.

1. **GitHub** (owner, repo, branch, optional sub-path): one call to the tree API
   (`/git/trees/<branch>?recursive=1`), then files from `raw.githubusercontent.com` (16 parallel requests).
   Git symlinks (mode `120000`) are resolved relative to the link and reuse the target's parsed data.
   When the API is rate limited (60 calls/hour unauthenticated) the loader falls back to jsDelivr
   (`data.jsdelivr.com` listing, `cdn.jsdelivr.net/gh/…` files). An optional token (settings) raises the limit;
   it is only sent to `api.github.com`.
2. **HTTP URL** of a folder with the same layout: the loader reads `manifest.json` (or `index.json`), and
   otherwise walks the HTML directory listings produced by `python3 -m http.server`.
   Generate a manifest (faster, and keeps symlinks as links) with:

   ```sh
   python3 openleo-explorer/tools/make_manifest.py PSA-RE          # writes PSA-RE/manifest.json
   python3 openleo-explorer/tools/make_manifest.py PSA-RE --output /tmp/m.json --revision v1
   ```

   Format: `{"revision": "...", "files": ["architectures.yml", ...], "symlinks": {"link path": "target path"}}`
   (a plain JSON array of paths is accepted too).
3. **Local folder**: picked with the File System Access API when available, or `<input webkitdirectory>`
   (files are read locally, nothing is uploaded). The folder must be picked again after a page reload.

Parsed files are cached in IndexedDB, keyed by source + revision (GitHub tree SHA, jsDelivr commit, manifest
revision or listing hash): reloading is instant until the repository changes. The ⟳ button reloads without cache.

The loader is tolerant: YAML errors are collected per file (Tools › Data issues) and legacy constructs are
normalized with a warning badge (`periodicity: 10` → `['10ms']`, free-text periodicities, `type: 'VAN'`,
`resolution` → `factor`, `unit` → `units`, `signed: true` → `sint`, legacy types `uint8`/`int16`/`float`…,
legacy bit notations `'3'` / `'1-2'`, legacy bus directories such as `buses/AEE2001/CONF`, VAN `method`,
duplicate keys, non UTF-8 files…).

## Architecture of the code

```
index.html              shell (top bar, tabs, search, settings buttons)
css/app.css             all styles (CSS variables, light/dark theme, container queries)
vendor/js-yaml.mjs      js-yaml 4.1.0 (fallback when jsDelivr is unreachable)
js/app.js               bootstrap, source loading + progress, hash router, global search, theme/lang
js/core/                UI independent logic (runs in node, unit tested)
  util.js               escaping, multilang pick, hex helpers, bounded concurrency, identifiers
  bits.js               PSA bit notation, abs indexes, Motorola/Intel/DBC conversions, bit extraction/insertion,
                        little-endian chunks
  normalize.js          tolerant normalization of frames, signals, alternatives, architectures, nodes, cars
  codec.js              decode / encode payloads (uint, sint, bool, enum, bcd, str, bytes, float, mux, byte order)
  paths.js              repository path conventions, symlink resolution
  yamlparse.js          js-yaml loading (CDN / vendored), tolerant parsing, encoding fallback
  sources.js            GitHub / jsDelivr / HTTP (manifest or listing) / local folder loaders
  cache.js              IndexedDB cache + safe localStorage
  repo.js               database build: merge sources, variants inheritance, nodes, cars, frames, diag,
                        overrides, search index, diffs
  signalref.js          exact-name signal catalog across effective variant frames and differing frame IDs
  dbc.js                DBC and JSON export
  codegen.js            C header, Python, transmit snippets, LIN PID/checksum
  logparse.js           candump / SavvyCAN / ASC / plain log parsing, per-ID statistics
  isotp.js              ISO-TP segmentation, flow control, reassembly
  seedkey.js            PSA SecurityAccess seed/key algorithm
  busload.js            CAN / VAN / LIN bus load estimation
  diagref.js            built-in UDS / KWP2000 / OBD service and NRC tables, request description
js/ui/                  DOM code
  dom.js                html`` tagged template (auto-escaping), delegated events, copy/download, toasts
  state.js              settings and shared app state
  widgets.js            badges, links, code blocks, small fragments
  bitgrid.js            bit layout grid, legend, signal details
  simpleview.js         simple (byte by byte) view
  diagrams.js           SVG topology and emitters/receivers diagrams
  vlist.js              virtualized list
  views/                one module per tab (frames, frame detail, signals, archs, cars, ecus, diag, tools, about,
                        settings)
tools/make_manifest.py  manifest generator for HTTP sources
tests/                  node --test unit tests + fixtures (small repositories with symlinks, a second source)
```

Every data-derived string is escaped by the `html` template (or `esc()` for the few string-built rows).

## Tests

```sh
cd openleo-explorer
node --test tests/
```

The tests cover the bit notation and DBC conversions, normalization of legacy data, decoding/encoding
(including little endian, mux, strings, floats), the loaders (mocked GitHub API + raw + jsDelivr fallback,
manifest, a real `python3 -m http.server` crawl of `../PSA-RE`), symlinks, variant inheritance, multi-source
merging, search, DTC codes, DBC export, generated C (compiled with `gcc -Wall -Werror` and compared with the JS
codec on random payloads of every PSA-RE frame), generated Python (run with `python3`), log parsing, ISO-TP,
the seed/key algorithm (vectors from the Python reference), bus load, and the `dbmuxev/doc` examples.
Tests needing `../PSA-RE`, `gcc` or `python3` are skipped when absent.

## Known limitations

- Local folder sources must be picked again after each reload (browsers do not persist the permission).
- jsDelivr fallback may lag behind GitHub by a few hours and cannot tell which files are symlinks
  (link files stored as plain text are still detected).
- DBC cannot express VAN/LIN frames, fields wider than 64 bits, or non byte-aligned little-endian fields: they are
  exported with a warning or skipped. Frames sharing an ID on one bus: only the first one is exported.
- Bus load is an estimate (worst-case CAN bit stuffing, approximate VAN time slots, LIN nominal × 1.4).
- The "custom ECU" checklist uses heuristics for wake-up / supervision frames (ID ranges and names).
