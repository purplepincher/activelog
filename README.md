# ActiveLog Phase 1 — the first slice (single screen, local‑first)

This branch is the working first slice of ActiveLog: a single‑screen web app
where you **pick a folder, tap record, see a markdown file** — and on reload the
folder is remembered and the entries are still there. The UI is wired (not a
scaffold), the storage layer has two real backends, and there are **76 passing
unit tests across 8 files**. Audio capture, live transcription, the markdown
entry format, and the storage adapters are extracted from the proven, shipped
[`deckboss`](https://github.com/purplepincher/deckboss) codebase.

Every claim below is verified against the files present in `app/src/` and
against `npm run build && npm test`. Where something is **not** yet done, the
“Markers” legend below says so plainly.

---

## Markers

Used throughout this doc, matching the honesty convention in
[`docs/product-status.md`](docs/product-status.md) and [`family/README.md`](family/README.md):

- ✅ **real today** — present and working in this commit.
- ⚠️ **real but conditional** — present, but limited or likely to change.
- 🔮 **later phase** — planned, not coded yet.

---

## What exists (the modules)

| Path | Status | What it does |
|---|---|---|
| `app/src/App.tsx` | ✅ real today | **The one screen**, fully wired (see below). Folder pick / permission‑reconnect, record + live transcript, stop → build → write, reload restores the folder and re‑lists entries. Includes the visual design pass (teal accent tokens, card surfaces, button states, focus rings, footer). |
| `app/src/main.tsx` | ✅ real today | React 18 `createRoot` mount of `<App/>` in `StrictMode`. |
| `app/src/core/audio/recorder.ts` | ✅ real today | `AudioRecorder` wraps `MediaRecorder` with a 1‑second timeslice, a 5‑minute auto‑stop safety net, and `onDataAvailable` / `onAutoStop` callbacks. |
| `app/src/services/webspeech.ts` | ✅ real today | `WebSpeechTranscriber` — typed wrapper around `SpeechRecognition` (Web Speech API). Streams interim + final results via `onResult`; flags a network error distinctly from genuine silence. |
| `app/src/core/storage/interface.ts` | ✅ real today | `StorageAdapter` interface + constants (`STORAGE_ROOT`, `MANIFEST_PATH`, `ATTACHMENTS_DIR`) and path helpers (`entryPath`, `attachmentPath`). |
| `app/src/core/storage/adapters/file‑system‑access.ts` | ✅ real today | `FileSystemAccessAdapter` — reads/writes files directly in the folder the user picks via `showDirectoryPicker`. Persists the handle to IndexedDB for reload; re‑requests `readwrite` permission from a user gesture on each load. ⚠️ Chromium‑only (see below). |
| `app/src/core/storage/adapters/indexed‑db.ts` | ✅ real today | `IndexedDBAdapter` — the always‑available fallback when the File System Access API is absent (Safari/Firefox). One idb‑keyval DB per store to dodge the shared‑`upgradeneeded` race deckboss shipped against. |
| `app/src/core/storage/adapters/local‑zip.ts` | ✅ real today | `LocalZipAdapter` — an in‑memory `StorageAdapter` that also `exportZip()`s its contents as a real `.zip` (read back through JSZip in tests). Used as the test/scaffold adapter, not in the shipped screen. |
| `app/src/core/tensor‑log/entry‑builder.ts` | ✅ real today | `buildEntry()` assembles the canonical YAML‑front‑matter markdown (id, timestamp, audio metadata, transcript, tags); `applyCorrections()` folds later corrections into a displayable entry. |
| `app/src/core/tensor‑log/entry‑parser.ts` | ✅ real today | `parseEntry()` and `tryParseEntry()` round‑trip a markdown file back to a typed `LogEntry`. |
| `app/src/core/tensor‑log/entry‑serializer.ts` | ✅ real today | `serializeEntry()` produces the full markdown text including the corrections section. |
| `app/src/core/types/log‑entry.ts` (+ `common.ts`) | ✅ real today | Zod schemas for `LogEntry`, `AudioMeta`, `TranscriptResult`, `GPSReading`, and related types. |
| `app/src/core/diagnostics.ts` | ✅ real today | `Diagnostics` — counters for recordings, sync attempts, entries skipped, etc., persisted to IndexedDB. |
| `app/src/utils/date.ts` | ✅ real today | `nowIso()` helper. |
| `app/src/utils/file.ts` | ✅ real today | `mimeToExt()`; `readAudioDurationMs()` (⚠️ not unit‑tested — needs a browser `Audio` element). |
| `app/src/utils/id.ts` | ✅ real today | id helpers. |

---

## The one screen (`App.tsx`)

The single shippable screen (per `docs/ACTIVELOG_FIRST_SLICE.md` §7 item 10) is
implemented end to end:

1. **Pick folder** → `FileSystemAccessAdapter`’s `showDirectoryPicker` flow.
   On a browser without the File System Access API, the app silently falls back
   to `IndexedDBAdapter` and says so in the copy (no “your folder” wording where
   there isn’t one).
2. **Record** → `AudioRecorder` + `WebSpeechTranscriber` start together; the
   recognized text streams into the UI live (final text + interim, the interim
   greyed).
3. **Stop** → `buildEntry()` → `serializeEntry()` → the note is written as a
   markdown file; the captured audio is written as a blob best‑effort so a
   failed attachment can never lose the note. There is a 5‑minute auto‑stop
   safety limit that routes the captured‑so‑far audio through the same save path.
4. **See entry** → persisted entries render as cards (timestamp, transcript,
   tags, an expandable “view on‑disk markdown” pane).
5. **Reload** → the directory handle is restored from IndexedDB, permission is
   re‑requested from a click, files are re‑listed — the entries are still there.

The visual pass is in‑file: one teal accent (`#0e7c86`) carried across the
primary button, the wordmark mark, tag chips, and focus rings, on an 8/16/24/32
spacing scale, with card surfaces, primary/danger/ghost button states, and a
quiet pinned footer that states only what’s verifiable (local‑first, no account,
transcription may be cloud‑backed). Deliberately plain: `useState`/`useRef`
only — no routing, no state library, no component library. If a capability isn’t
wired, it’s simply not on the screen (no greyed‑out placeholders).

---

## Running locally

```bash
cd app
npm install
npm run dev
```

The Vite dev server starts and mounts the real screen. To exercise the “real
files on disk” path you need a Chromium browser (Chrome/Edge/Opera desktop);
Safari/Firefox will run the IndexedDB fallback automatically.

---

## Testing

```bash
cd app
npm test          # 76 tests across 8 files (vitest)
```

| Suite | Tests | Covers |
|---|---|---|
| `utils/date.test.ts` | 3 | `nowIso()` |
| `utils/file.test.ts` | 10 | `mimeToExt()` round‑trips |
| `tensor‑log/entry‑builder.test.ts` | 4 | `buildEntry()` assembly |
| `tensor‑log/entry‑parser.test.ts` | 9 | `parseEntry()` / `tryParseEntry()` (incl. malformed input) |
| `tensor‑log/entry‑serializer.test.ts` | 3 | markdown round‑trip + parse errors |
| `storage/adapters/indexed‑db.test.ts` | 20 | full `StorageAdapter` contract (auth, text, blobs, listFiles, manifest) under `fake‑indexeddb` |
| `storage/adapters/local‑zip.test.ts` | 21 | in‑memory logic + `exportZip()` read back through JSZip |
| `storage/adapters/local‑zip.roundtrip.test.ts` | 6 | export → import round‑trip under `happy‑dom` |

Honest gaps: `AudioRecorder`/`WebSpeechTranscriber`/`App.tsx` are not unit‑tested
(they wrap live browser APIs and the screen); `readAudioDurationMs()` needs a
real `Audio` element. The pure logic — entry build/parse/serialize, path/date
helpers, and the storage‑adapter contracts (including the IndexedDB fallback) —
is covered.

---

## Deploying

The build writes into the repo‑root `public/`, which `wrangler.jsonc` serves via
the `ASSETS` static‑assets binding; the Worker at `src/index.ts` is a thin
static handler.

```bash
cd app && npm run build && cd ..
npx wrangler deploy --dry-run   # preview — verified to pass on this branch
npx wrangler deploy             # deploy to a real *.workers.dev URL
```

⚠️ The **config is valid and `--dry-run` passes**, but a **live `wrangler
deploy` to a real URL has not been run** on this branch yet — treat the deploy as
configured, not yet confirmed live.

---

## What this does NOT do yet

| Feature | Status | Explanation |
|---|---|---|
| PWA installability / offline | 🔮 later phase | There is **no web app manifest** (`<link rel="manifest">` is absent from `index.html`) and **no service worker**. `app/public/icon-192.png` / `icon-512.png` exist but are not wired in. The app loads over the network today; it is not installable or offline‑capable. |
| Confirmed live deploy | 🔮 later phase | See Deploying — config valid, dry‑run passes, but no real deploy has been run on this branch. |
| Save‑to‑real‑files on Safari/Firefox | ⚠️ conditional | The File System Access API is Chromium‑only; those browsers fall back to opaque IndexedDB storage (still works, not a folder you can back up). |
| GPS integration | 🔮 later phase | The `GPSReading` type is defined; no code reads the Geolocation API (`App.tsx` passes `gps: null`). |
| Chat / messaging | 🔮 later phase | None. |
| Wake‑word detection | 🔮 later phase | None. |
| User‑facing storage‑backend toggle | 🔮 later phase | IndexedDB is used only as automatic fallback; no UI chooses between backends. |
| Hardware I/O (serial, Bluetooth, external mic) | 🔮 later phase | Not supported. |
| Per‑site accent (family design system) | 🔮 later phase | The screen uses its own inline teal tokens, not the `family/` `--claw` accent swap. |

---

## Provenance

ActiveLog’s core modules are extracted from [`deckboss`](https://github.com/purplepincher/deckboss),
a real, shipped fishing‑logbook PWA. The audio‑recording, transcription,
storage‑adapter, and markdown‑entry code was battle‑tested there first.

The design‑system skeleton (`family/` directory) is shared with sibling repos
[`activeledger`](https://github.com/purplepincher/activeledger) and
[`luciddreamer`](https://github.com/purplepincher/luciddreamer); its operator’s
manual is [`family/README.md`](family/README.md). (ActiveLog does not currently
consume `family/` at build time — see the per‑site‑accent row above.)

---

## Previous version

This branch replaces a repo that was a landing‑page‑only Cloudflare Worker
serving a single static HTML page describing a proposed “ActiveLog envelope”
convention. That old, frank assessment is preserved in
[`docs/product-status.md`](docs/product-status.md); this README supersedes it
for the current branch.
