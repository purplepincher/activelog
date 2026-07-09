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

// ---- Design tokens (Phase 1 visual polish) ----------------------------
// One accent hue (teal) in a small set of shades, used on the primary
// button, the wordmark mark, tag chips, and focus rings so the eye has a
// single place to land. Spacing stays on an 8/16/24/32 scale for consistent
// vertical rhythm. Keep these as the only source of truth for color/spacing.
const COLOR = {
  ink: "#1a1a1a", // headings, strong text
  text: "#3a3a3a", // body / tagline (deliberately darker than the old #666)
  muted: "#6b7280", // secondary meta (timestamps, "no logs yet")
  faint: "#9aa1aa", // interim transcript, disabled-feeling hints
  surface: "#ffffff",
  surfaceAlt: "#f7f9fa", // code/pre panes
  hairline: "#e6e8eb", // card borders
  accent: "#0e7c86", // primary brand accent (teal)
  accentHover: "#0a6269", // hover / pressed
  accentText: "#0a5b63", // text on accent tint (tags)
  accentTint: "#e7f4f5", // tinted fills (tag chips)
  danger: "#d33", // active Stop action
  dangerHover: "#b22a2a",
  dangerTint: "#fde8e8",
  dangerBorder: "#f3b4b4",
  dangerText: "#8a1f1f",
  warnTint: "#fff8e1",
  warnBorder: "#f0d98a",
} as const;

const SP = { s1: 8, s2: 16, s3: 24, s4: 32 } as const;

// Mirrors app/package.json `version` — shown as a quiet build marker in the
// footer. Bump both together when cutting a release.
const APP_VERSION = "v0.1.0";

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
        padding: `${SP.s4}px ${SP.s2}px`,
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: COLOR.ink,
      }}
    >
      {/* Interactive states (hover/focus/active) can't be expressed as inline
          styles, so a tiny scoped stylesheet provides them. Color comes from
          the same accent tokens used inline. */}
      <style>{INTERACTIVE_CSS}</style>

      <header style={{ marginBottom: SP.s3 }}>
        <h1
          style={{
            margin: 0,
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: "-0.02em",
          }}
        >
          ActiveLog
          {/* Accent mark under the wordmark — the single brand-color anchor. */}
          <span
            aria-hidden="true"
            style={{
              display: "block",
              width: 40,
              height: 4,
              background: COLOR.accent,
              borderRadius: 2,
              marginTop: SP.s1,
            }}
          />
        </h1>
        <p
          style={{
            margin: `${SP.s1}px 0 0`,
            color: COLOR.text,
            fontSize: 16,
            lineHeight: 1.5,
          }}
        >
          Voice notes that persist as real files on disk.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          style={{
            background: COLOR.dangerTint,
            border: `1px solid ${COLOR.dangerBorder}`,
            color: COLOR.dangerText,
            padding: `${SP.s1}px ${SP.s2}px`,
            borderRadius: 8,
            marginBottom: SP.s2,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: SP.s2,
          }}
        >
          <span>{error}</span>
          <button
            type="button"
            className="al-btn al-btn--ghost"
            onClick={() => setError(null)}
            style={ghostButtonStyle}
          >
            dismiss
          </button>
        </div>
      )}

      {conn === "unsupported" && (
        <div
          style={{
            ...cardStyle,
            background: COLOR.warnTint,
            borderColor: COLOR.warnBorder,
            padding: SP.s3,
            marginBottom: SP.s2,
          }}
        >
          <strong>This browser can't pick a folder.</strong>
          <p style={{ margin: `${SP.s1}px 0 0`, lineHeight: 1.5 }}>
            The File System Access API (needed to save logs as files in a folder
            you choose) isn't available here. Use a recent Chrome or Edge on
            desktop to run ActiveLog.
          </p>
        </div>
      )}

      {conn !== "ready" && conn !== "unsupported" && (
        <section
          style={{
            ...cardStyle,
            padding: SP.s4,
            textAlign: "center",
            marginBottom: SP.s2,
          }}
        >
          <p
            style={{
              margin: `0 0 ${SP.s3}px`,
              color: COLOR.text,
              fontSize: 16,
              lineHeight: 1.5,
            }}
          >
            {conn === "needs-folder" &&
              "Pick a folder to start saving voice notes as real files you own."}
            {conn === "needs-permission" &&
              "Reconnect your folder to keep reading and writing to it."}
            {conn === "checking" && "Checking for a connected folder…"}
          </p>
          <button
            type="button"
            className="al-btn al-btn--primary"
            onClick={() => void handleConnect()}
            disabled={connecting || conn === "checking"}
            style={primaryButtonStyle}
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
          <section style={{ ...cardStyle, padding: SP.s3, marginBottom: SP.s3 }}>
            <button
              type="button"
              className={
                phase === "recording"
                  ? "al-btn al-btn--danger"
                  : "al-btn al-btn--primary"
              }
              onClick={() =>
                void (phase === "recording" ? stopRecording() : startRecording())
              }
              disabled={phase === "saving"}
              style={{
                ...primaryButtonStyle,
                background: phase === "recording" ? COLOR.danger : COLOR.accent,
              }}
            >
              {phase === "recording"
                ? "Stop"
                : phase === "saving"
                  ? "Saving…"
                  : "Record"}
            </button>

            {phase === "recording" && (
              <div style={{ marginTop: SP.s2 }}>
                <div
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 20,
                    fontWeight: 600,
                  }}
                >
                  {formatElapsed(elapsedMs)}
                </div>
                <div
                  style={{ marginTop: SP.s1, minHeight: 48, lineHeight: 1.5 }}
                >
                  {transcriptSupported ? (
                    <span>
                      <span>{live.final}</span>
                      {live.interim && (
                        <span style={{ color: COLOR.faint }}>
                          {" "}
                          {live.interim}
                        </span>
                      )}
                      {!live.final && !live.interim && (
                        <span style={{ color: COLOR.faint }}>Listening…</span>
                      )}
                    </span>
                  ) : (
                    <span style={{ color: COLOR.faint }}>
                      Live transcription unavailable in this browser — audio is
                      still being captured.
                    </span>
                  )}
                </div>
              </div>
            )}

            {busy && (
              <div style={{ marginTop: SP.s2, color: COLOR.muted }}>{busy}</div>
            )}
          </section>

          <section style={{ marginBottom: SP.s3 }}>
            <h2
              style={{
                fontSize: 16,
                fontWeight: 600,
                margin: `0 0 ${SP.s2}px`,
              }}
            >
              Saved logs {entries.length > 0 && `(${entries.length})`}
            </h2>
            {entries.length === 0 ? (
              <p style={{ color: COLOR.muted, margin: 0 }}>
                No logs yet — record one above.
              </p>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: SP.s2,
                }}
              >
                {entries.map((entry) => {
                  const eff = applyCorrections(entry);
                  return (
                    <li
                      key={entryPath(entry.timestamp, entry.id)}
                      style={{ ...cardStyle, padding: SP.s2 }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "baseline",
                          gap: SP.s1,
                          marginBottom: SP.s1,
                        }}
                      >
                        <strong>{formatWhen(entry.timestamp)}</strong>
                        {entry.audio && (
                          <span style={{ color: COLOR.muted, fontSize: 13 }}>
                            {formatElapsed(entry.audio.duration_ms)} audio
                          </span>
                        )}
                      </div>
                      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                        {eff.transcript?.text || (
                          <span style={{ color: COLOR.faint }}>
                            No transcript{entry.audio ? " (audio saved)" : ""}.
                          </span>
                        )}
                      </div>
                      {eff.tags.length > 0 && (
                        <div style={{ marginTop: SP.s1 }}>
                          {eff.tags.map((t) => (
                            <span key={t} style={tagStyle}>
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                      <details style={{ marginTop: SP.s1 }}>
                        <summary
                          style={{ cursor: "pointer", color: COLOR.muted }}
                        >
                          view on-disk markdown
                        </summary>
                        <pre
                          style={{
                            whiteSpace: "pre-wrap",
                            background: COLOR.surfaceAlt,
                            border: `1px solid ${COLOR.hairline}`,
                            padding: SP.s1,
                            borderRadius: 6,
                            fontSize: 12,
                            overflowX: "auto",
                            marginTop: SP.s1,
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

      {/* Quiet footer pinned to the bottom of the viewport so the page no
          longer reads as bottomless. Copy states only what's verifiable:
          storage is local, user-owned files, no app-side account/sync; and
          honestly flags that the browser's own transcription may be
          network-backed (see services/webspeech.ts). */}
      <footer
        style={{
          marginTop: "auto",
          paddingTop: SP.s4,
          color: COLOR.muted,
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <p style={{ margin: 0 }}>
          Notes save as plain files in a folder you choose — no account, no
          ActiveLog sync. Live transcription runs through your browser's speech
          engine, which may be cloud-backed.
        </p>
        <p style={{ margin: `${SP.s1}px 0 0`, fontSize: 12, color: COLOR.faint }}>
          ActiveLog {APP_VERSION} · local-first
        </p>
      </footer>
    </div>
  );
}

// ---- Shared styles -----------------------------------------------------
// Card surface used across every state so the whole app reads as one design.
const cardStyle: React.CSSProperties = {
  background: COLOR.surface,
  border: `1px solid ${COLOR.hairline}`,
  borderRadius: 12,
  boxShadow: "0 1px 2px rgba(16, 24, 40, 0.04)",
};

const buttonBaseStyle: React.CSSProperties = {
  border: "none",
  borderRadius: 8,
  fontFamily: "inherit",
  cursor: "pointer",
};

// The single most prominent element on each screen: solid accent fill, large
// hit area (16/32 padding), white label. Hover/focus/active come from the
// .al-btn classes below.
const primaryButtonStyle: React.CSSProperties = {
  ...buttonBaseStyle,
  background: COLOR.accent,
  color: "#fff",
  fontWeight: 600,
  fontSize: 16,
  padding: `${SP.s2}px ${SP.s4}px`,
};

// Low-emphasis text button (e.g. the alert's "dismiss").
const ghostButtonStyle: React.CSSProperties = {
  ...buttonBaseStyle,
  background: "transparent",
  color: COLOR.dangerText,
  fontSize: 13,
  padding: `4px ${SP.s1}px`,
  borderRadius: 6,
};

const tagStyle: React.CSSProperties = {
  display: "inline-block",
  background: COLOR.accentTint,
  color: COLOR.accentText,
  borderRadius: 4,
  padding: `2px ${SP.s1}px`,
  marginRight: SP.s1,
  fontSize: 13,
};

// Hover/focus/active can't be done with inline styles, so a small scoped
// stylesheet handles them. Class names are prefixed `al-` to stay local.
const INTERACTIVE_CSS = `
  .al-btn { transition: background-color .12s ease, box-shadow .12s ease, transform .04s ease; }
  .al-btn:active:not(:disabled) { transform: translateY(1px); }
  .al-btn:focus-visible { outline: 3px solid ${COLOR.accent}; outline-offset: 2px; }
  .al-btn:disabled { opacity: .55; cursor: default; }
  .al-btn--primary:hover:not(:disabled) { background: ${COLOR.accentHover}; }
  .al-btn--danger:hover:not(:disabled) { background: ${COLOR.dangerHover}; }
  .al-btn--ghost { background: transparent; }
  .al-btn--ghost:hover:not(:disabled) { background: rgba(138, 31, 31, .08); }
`;
