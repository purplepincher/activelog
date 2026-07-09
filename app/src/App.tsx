import { useCallback, useEffect, useRef, useState } from "react";
import { FileSystemAccessAdapter } from "./core/storage/adapters/file-system-access";
import {
  ATTACHMENTS_DIR,
  entryPath,
  STORAGE_ROOT,
} from "./core/storage/interface";
import { AudioRecorder, RecorderPermissionError } from "./core/audio/recorder";
import { WebSpeechTranscriber, isWebSpeechSupported } from "./services/webspeech";
import { buildEntry, applyCorrections } from "./core/tensor-log/entry-builder";
import { serializeEntry } from "./core/tensor-log/entry-serializer";
import { tryParseEntry } from "./core/tensor-log/entry-parser";
import type { LogEntry } from "./core/types/log-entry";

/**
 * ============================================================================
 * THE ONE SCREEN (Phase 1)
 * ============================================================================
 *
 * Per docs/ACTIVELOG_FIRST_SLICE.md §7 item 10 — the single shippable screen:
 *
 *   1. Pick folder  → FileSystemAccessAdapter directory-picker flow.
 *   2. Record       → AudioRecorder + WebSpeechTranscriber, transcript shown
 *                     live.
 *   3. Stop         → buildEntry() → serializeEntry() → adapter.writeFile();
 *                     the captured audio is written as a blob alongside it.
 *   4. See entry    → the persisted entries render on screen.
 *   5. Reload       → the handle is restored, permission re-requested from a
 *                     gesture, files re-listed — the entries are still there.
 *
 * Deliberately plain: useState/useRef only, no routing, no state library, no
 * component library. Every capability here is a call into an already-built
 * module under core/ or services/. If a capability isn't wired here, it's
 * simply not on the screen — no greyed-out placeholders.
 *
 * The only seam edit required for the "shown live" requirement is an additive
 * `onResult` callback on WebSpeechTranscriber (see services/webspeech.ts) — it
 * streams recognized text as it arrives without changing stop()'s contract.
 */

// ---- Per-browser device identity + sequence number ---------------------
// buildEntry() requires a `dev` id and a per-device monotonic `seq`. Phase 1
// has no auth or backend, so these live in localStorage: a uuid minted once
// and a counter bumped after every successful write.
const DEV_KEY = "activelog:dev";
const SEQ_KEY = "activelog:seq";

function getDev(): string {
  let dev = localStorage.getItem(DEV_KEY);
  if (!dev) {
    dev = crypto.randomUUID();
    localStorage.setItem(DEV_KEY, dev);
  }
  return dev;
}

function currentSeq(): number {
  return Number(localStorage.getItem(SEQ_KEY) ?? "0");
}

function commitSeq(seq: number): void {
  localStorage.setItem(SEQ_KEY, String(seq + 1));
}

// ---- Small view helpers ------------------------------------------------

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function formatWhen(ts: string | null): string {
  if (!ts) return "undated";
  return new Date(ts).toLocaleString();
}

type ConnState = "checking" | "needs-folder" | "needs-permission" | "ready" | "unsupported";
type Phase = "idle" | "recording" | "saving";

export default function App() {
  const [conn, setConn] = useState<ConnState>("checking");
  const [connecting, setConnecting] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [live, setLive] = useState<{ final: string; interim: string }>({
    final: "",
    interim: "",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);

  const recorderRef = useRef<AudioRecorder | null>(null);
  const transcriberRef = useRef<WebSpeechTranscriber | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Ref mirror of the adapter so async handlers (stop) always read the live
  // instance rather than a stale closure value.
  const adapterRef = useRef<FileSystemAccessAdapter | null>(null);

  // ---- connection bootstrap -------------------------------------------
  const loadEntries = useCallback(async (a: FileSystemAccessAdapter) => {
    try {
      const files = await a.listFiles(`${STORAGE_ROOT}/`);
      const mdFiles = files
        .filter((f) => f.path.endsWith(".md"))
        .sort((x, y) => (x.modifiedAt < y.modifiedAt ? 1 : -1));
      const parsed: LogEntry[] = [];
      for (const f of mdFiles) {
        const content = await a.readFile(f.path);
        const entry = tryParseEntry(content);
        if (entry) parsed.push(entry);
      }
      setEntries(parsed);
    } catch (err) {
      // A failed reload never blocks recording — just log it.
      console.error("loadEntries failed", err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!FileSystemAccessAdapter.isSupported()) {
        setConn("unsupported");
        return;
      }
      const restored = await FileSystemAccessAdapter.restore();
      if (cancelled) return;
      if (!restored) {
        adapterRef.current = null;
        setConn("needs-folder");
        return;
      }
      adapterRef.current = restored;
      const ok = await restored.isAuthenticated();
      if (cancelled) return;
      setConn(ok ? "ready" : "needs-permission");
      if (ok) void loadEntries(restored);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadEntries]);

  const handleConnect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      // authenticate() must run from this user gesture: it calls
      // showDirectoryPicker() (if no stored handle) and requestPermission().
      const a = adapterRef.current ?? new FileSystemAccessAdapter();
      await a.authenticate();
      adapterRef.current = a;
      setConn("ready");
      await loadEntries(a);
    } catch (err) {
      const isAbort =
        err instanceof Error && (err.name === "AbortError" || err.name === "NotAllowedError");
      setError(
        isAbort
          ? "Folder selection cancelled."
          : err instanceof Error
            ? err.message
            : "Could not open that folder.",
      );
    } finally {
      setConnecting(false);
    }
  }, [loadEntries]);

  // ---- recording -------------------------------------------------------
  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const resetCaptureRefs = () => {
    recorderRef.current = null;
    transcriberRef.current?.stop();
    transcriberRef.current = null;
  };

  const startRecording = useCallback(async () => {
    setError(null);
    setLive({ final: "", interim: "" });
    setElapsedMs(0);

    const recorder = new AudioRecorder();
    recorderRef.current = recorder;

    // At the 5-minute safety limit the recorder stops itself and discards the
    // blob (its own contract). We reset the UI cleanly rather than chaining a
    // second stop() that would race the internal one.
    recorder.onAutoStop = () => {
      clearTimer();
      resetCaptureRefs();
      setPhase("idle");
      setElapsedMs(0);
      setError("Recording stopped automatically at the time limit.");
    };

    try {
      await recorder.start();
    } catch (err) {
      setError(
        err instanceof RecorderPermissionError
          ? err.message
          : "Could not start recording — check microphone permission.",
      );
      recorderRef.current = null;
      return;
    }

    if (isWebSpeechSupported()) {
      const transcriber = new WebSpeechTranscriber();
      transcriber.onResult = (finalText, interimText) =>
        setLive({ final: finalText, interim: interimText });
      transcriberRef.current = transcriber;
      transcriber.start();
    }

    setPhase("recording");
    const startedAt = Date.now();
    timerRef.current = setInterval(
      () => setElapsedMs(Date.now() - startedAt),
      200,
    );
  }, []);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    const a = adapterRef.current;
    if (!recorder || !a) return;
    clearTimer();
    setPhase("saving");
    setBusy("Saving…");

    try {
      const blob = await recorder.stop();
      recorderRef.current = null;

      const transcriber = transcriberRef.current;
      const liveTranscript = transcriber?.stop();
      const hadNetworkError = transcriber?.hadNetworkError ?? false;
      transcriberRef.current = null;

      // Web Speech is network-backed on most browsers: if it errored out and
      // produced nothing, leave transcript unset so the entry honestly reads
      // "no transcript" instead of a confident-looking blank.
      let transcript = liveTranscript;
      if (transcript && transcript.text === "" && hadNetworkError) {
        transcript = undefined;
      }

      const seq = currentSeq();
      const entry = await buildEntry({
        dev: getDev(),
        seq,
        audioBlob: blob,
        gps: null,
        transcript,
        source: "voice",
      });

      const markdown = serializeEntry(entry);
      const path = entryPath(entry.timestamp, entry.id);
      await a.writeFile(path, markdown);

      if (entry.audio) {
        // The note (the markdown) is what the user cares about; the audio is
        // best-effort and must never be able to lose the note if it fails.
        try {
          await a.writeBlob(`${ATTACHMENTS_DIR}/${entry.audio.filename}`, blob);
        } catch (err) {
          console.error("audio blob write failed", err);
        }
      }

      commitSeq(seq);
      await loadEntries(a);
      setLive({ final: "", interim: "" });
      setElapsedMs(0);
      setPhase("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the recording.");
      recorderRef.current?.cancel();
      resetCaptureRefs();
      setPhase("idle");
    } finally {
      setBusy(null);
    }
  }, [loadEntries]);

  // Tidy up the timer if the component unmounts mid-recording.
  useEffect(() => () => clearTimer(), []);

  const transcriptSupported = isWebSpeechSupported();

  // ---- render ----------------------------------------------------------
  return (
    <div
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: 24,
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#1a1a1a",
      }}
    >
      <h1 style={{ marginBottom: 4 }}>ActiveLog</h1>
      <p style={{ marginTop: 0, color: "#666" }}>
        Voice notes that persist as real files on disk.
      </p>

      {error && (
        <div
          role="alert"
          style={{
            background: "#fde8e8",
            border: "1px solid #f3b4b4",
            color: "#8a1f1f",
            padding: "8px 12px",
            borderRadius: 6,
            marginBottom: 16,
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      {conn === "unsupported" && (
        <div style={{ background: "#fff8e1", padding: 16, borderRadius: 8 }}>
          <strong>This browser can't pick a folder.</strong>
          <p style={{ marginTop: 8 }}>
            The File System Access API (needed to save logs as files in a folder
            you choose) isn't available here. Use a recent Chrome or Edge on
            desktop to run ActiveLog.
          </p>
        </div>
      )}

      {conn !== "ready" && conn !== "unsupported" && (
        <section
          style={{
            background: "#f6f7f9",
            padding: 20,
            borderRadius: 8,
            textAlign: "center",
          }}
        >
          <p style={{ marginTop: 0 }}>
            {conn === "needs-folder" && "No folder connected yet."}
            {conn === "needs-permission" &&
              "Reconnect your folder to keep reading and writing to it."}
            {conn === "checking" && "Checking for a connected folder…"}
          </p>
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={connecting || conn === "checking"}
            style={buttonStyle}
          >
            {connecting
              ? "Opening…"
              : conn === "needs-permission"
                ? "Reconnect folder"
                : "Pick a folder"}
          </button>
        </section>
      )}

      {conn === "ready" && (
        <>
          <section
            style={{
              border: "1px solid #e3e3e3",
              borderRadius: 8,
              padding: 16,
              marginBottom: 16,
            }}
          >
            <button
              type="button"
              onClick={() =>
                void (phase === "recording" ? stopRecording() : startRecording())
              }
              disabled={phase === "saving"}
              style={{
                ...buttonStyle,
                background: phase === "recording" ? "#d33" : "#1a73e8",
                color: "#fff",
                fontSize: 16,
                padding: "12px 28px",
              }}
            >
              {phase === "recording"
                ? "Stop"
                : phase === "saving"
                  ? "Saving…"
                  : "Record"}
            </button>

            {phase === "recording" && (
              <div style={{ marginTop: 12 }}>
                <div
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 20,
                    fontWeight: 600,
                  }}
                >
                  {formatElapsed(elapsedMs)}
                </div>
                <div style={{ marginTop: 8, minHeight: 48, lineHeight: 1.5 }}>
                  {transcriptSupported ? (
                    <span>
                      <span>{live.final}</span>
                      {live.interim && (
                        <span style={{ color: "#999" }}> {live.interim}</span>
                      )}
                      {!live.final && !live.interim && (
                        <span style={{ color: "#999" }}>Listening…</span>
                      )}
                    </span>
                  ) : (
                    <span style={{ color: "#999" }}>
                      Live transcription unavailable in this browser — audio is
                      still being captured.
                    </span>
                  )}
                </div>
              </div>
            )}

            {busy && <div style={{ marginTop: 12, color: "#666" }}>{busy}</div>}
          </section>

          <section>
            <h2 style={{ fontSize: 16, marginBottom: 8 }}>
              Saved logs {entries.length > 0 && `(${entries.length})`}
            </h2>
            {entries.length === 0 ? (
              <p style={{ color: "#666" }}>No logs yet — record one above.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {entries.map((entry) => {
                  const eff = applyCorrections(entry);
                  return (
                    <li
                      key={entryPath(entry.timestamp, entry.id)}
                      style={{
                        border: "1px solid #e3e3e3",
                        borderRadius: 8,
                        padding: 12,
                        marginBottom: 10,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 8,
                          marginBottom: 6,
                        }}
                      >
                        <strong>{formatWhen(entry.timestamp)}</strong>
                        {entry.audio && (
                          <span style={{ color: "#888", fontSize: 13 }}>
                            {formatElapsed(entry.audio.duration_ms)} audio
                          </span>
                        )}
                      </div>
                      <div style={{ whiteSpace: "pre-wrap" }}>
                        {eff.transcript?.text || (
                          <span style={{ color: "#999" }}>
                            No transcript{entry.audio ? " (audio saved)" : ""}.
                          </span>
                        )}
                      </div>
                      {eff.tags.length > 0 && (
                        <div style={{ marginTop: 6 }}>
                          {eff.tags.map((t) => (
                            <span key={t} style={tagStyle}>
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                      <details style={{ marginTop: 8 }}>
                        <summary style={{ cursor: "pointer", color: "#666" }}>
                          view on-disk markdown
                        </summary>
                        <pre
                          style={{
                            whiteSpace: "pre-wrap",
                            background: "#f6f7f9",
                            padding: 8,
                            borderRadius: 6,
                            fontSize: 12,
                            overflowX: "auto",
                          }}
                        >
                          {serializeEntry(entry)}
                        </pre>
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  border: "none",
  borderRadius: 6,
  padding: "10px 18px",
  fontSize: 14,
  cursor: "pointer",
};

const tagStyle: React.CSSProperties = {
  display: "inline-block",
  background: "#e8f0fe",
  color: "#1a56c4",
  borderRadius: 4,
  padding: "2px 8px",
  marginRight: 6,
  fontSize: 13,
};
