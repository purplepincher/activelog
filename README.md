# ActiveLog Phase 1 — Core Modules (UI pending)

This branch contains the building‑blocks for the Phase 1 ActiveLog Progressive Web App. The modules that handle audio capture, live transcription, file‑system storage, and markdown entry creation are implemented and tested (extracted from the proven, shipped [`deckboss`](https://github.com/purplepincher/deckboss) codebase). The user interface that ties them together into the promised “pick a folder, tap record, see a markdown file” flow is **not yet wired** – the current `app/src/App.tsx` is a scaffold placeholder. The integration is being built by other agents on this same branch; a `git pull` should soon bring in the working UI.

This branch replaces the earlier landing‑page‑only Worker with real application code, even though the full end‑to‑end experience is not yet complete on this commit. Every claim below is verified against the files present in `app/src/`.

---

## What exists (the core modules)

| Path | Status | What it does |
|---|---|---|
| `app/src/core/audio/recorder.ts` | ✅ real today | `AudioRecorder` wraps `MediaRecorder` with a 1‑second timeslice, a configurable auto‑stop safety net, and `onDataAvailable` callbacks. |
| `app/src/services/webspeech.ts` | ✅ real today | Typed wrapper around the browser’s `SpeechRecognition` (Web Speech API). Returns interim and final results; distinguishes a “network error” (offline) from genuine silence. |
| `app/src/core/storage/interface.ts` | ✅ real today | `StorageAdapter` interface + constants (`STORAGE_ROOT`, `MANIFEST_PATH`, `ATTACHMENTS_DIR`) and path helpers (`entryPath`, `attachmentPath`). |
| `app/src/core/storage/adapters/file‑system‑access.ts` | ✅ real today | `FileSystemAccessAdapter` – reads/writes files directly in the folder the user picks via `showDirectoryPicker`. Persists the handle to IndexedDB for reload; re‑requests permission on each load. |
| `app/src/core/storage/adapters/indexed‑db.ts` | ✅ real today | `IndexedDBAdapter` – automatic fallback when the File System Access API is unavailable. Three separate databases to avoid a known idb‑keyval race. |
| `app/src/core/tensor‑log/entry‑builder.ts` | ✅ real today | `buildEntry()` assembles the canonical YAML‑front‑matter markdown with id, timestamp, audio metadata, transcript, etc. |
| `app/src/core/tensor‑log/entry‑parser.ts` | ✅ real today | `parseEntry()` and `tryParseEntry()` that round‑trip a markdown file back to a typed `LogEntry`. |
| `app/src/core/tensor‑log/entry‑serializer.ts` | ✅ real today | `serializeEntry()` produces the full markdown text including corrections section. |
| `app/src/core/types/log‑entry.ts` | ✅ real today | Zod schemas for `LogEntry`, `AudioMeta`, `TranscriptResult`, `GPSReading`, and related types. |
| `app/src/core/diagnostics.ts` | ✅ real today | `Diagnostics` tracking counters for recordings, sync attempts, entries skipped, etc. Persistent to IndexedDB. |
| `app/src/utils/date.ts` | ✅ real today | `nowIso()` helper. |
| `app/src/App.tsx` | ⚠️ placeholder scaffold | Returns a static `<div>` placeholder. The UI that wires the modules together will land in this file (or be moved to separate components) in a subsequent commit. |

---

## What the UI *will* do (once wired)

When the integration is complete, the single‑screen app will:

1. Prompt the user to pick a folder (File System Access API).
2. Show a “Record” button.
3. On tap: start `AudioRecorder` and `WebSpeechTranscriber` simultaneously.
4. On stop: build a markdown file via `buildEntry()`, write it to the picked folder, and update the manifest.
5. On reload: restore the folder handle, list entries, and display them.

Until that UI code lands, you can verify each module’s correctness by reading the source or by running unit tests (none have been committed yet – see [What this does NOT do yet](#what-this-does-not-do-yet)).

---

## Running locally (as‑is)

```bash
cd app
npm install
npm run dev
```

The Vite dev server will start; the placeholder page shows “ActiveLog Phase 1 — scaffold placeholder, not yet wired.” That is expected on this commit. The underlying modules can be exercised manually by importing them from the browser console or by writing a small test harness.

---

## Deploying

Deployment uses the same Cloudflare Workers + static‑assets pattern as the earlier landing‑page version. The Worker at `src/index.ts` and the config at `wrangler.jsonc` are unchanged. When the UI is ready, you can deploy the built app:

```bash
cd app && npm run build && cd ..
wrangler deploy --dry-run   # preview
wrangler deploy             # deploy
```

The Worker’s handler:

```ts
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    try {
      const response = await env.ASSETS.fetch(request);
      if (!response) return new Response("Not found", { status: 404 });
      return response;
    } catch (e) {
      return new Response(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`, { status: 500 });
    }
  },
};
```

Every request goes to the static‑assets binding; missing paths return `404`.

---

## What this does NOT do yet

Markers:  
✅ **real today** – present in this commit  
⚠️ **real but conditional** – present but may change or be removed  
🔮 **later phase** – planned but not yet coded

| Feature | Status | Explanation |
|---|---|---|
| User‑facing record button and live UI | 🔮 later phase | `App.tsx` is a placeholder; the screen that lets you pick a folder, tap record, and see entries is not yet wired. |
| GPS integration | 🔮 later phase | The `GPSReading` type is defined, but no code reads the Geolocation API. |
| Chat / messaging | 🔮 later phase | No real‑time collaboration. |
| Wake‑word detection | 🔮 later phase | Not implemented. |
| User‑facing storage backend toggle | 🔮 later phase | IndexedDB is used only as automatic fallback; no UI lets you choose. |
| Hardware I/O (serial, Bluetooth, external mic) | 🔮 later phase | Not supported. |
| Domain‑specific skin or accent | 🔮 later phase | The UI will use the default aubergine `--claw` palette until a per‑site accent is applied. |
| Unit tests | 🔮 later phase | No test runner or tests are present. (The modules are extracted from a tested codebase, but no tests ship in this repo yet.) |

---

## Provenance

ActiveLog’s core modules are extracted from [`deckboss`](https://github.com/purplepincher/deckboss), a real, shipped fishing‑logbook PWA. The audio‑recording, transcription, storage‑adapter, and markdown‑entry code was battle‑tested there first.

The design‑system skeleton (`family/` directory) is shared with sibling repos [`activeledger`](https://github.com/purplepincher/activeledger) and [`luciddreamer`](https://github.com/purplepincher/luciddreamer). Its operator’s manual is at [`family/README.md`](family/README.md).

---

## Previous version

This branch replaces a repo that was a landing‑page‑only Cloudflare Worker serving a single static HTML page describing a proposed “ActiveLog envelope” convention. The old honest assessment is preserved in `docs/product-status.md`. The present README supersedes that document for this branch.
