import { newId } from "../../utils/id";
import { nowIso } from "../../utils/date";
import { mimeToExt, readAudioDurationMs } from "../../utils/file";
import { SCHEMA_VERSION } from "../types/common";
import type {
  LogEntry,
  GPSReading,
  TranscriptResult,
  EffectiveLogEntry,
  Correction,
  CorrectionAuthor,
  EditableFields,
} from "../types/log-entry";

// TODO: confirm against core/types/log-entry.ts once merged.
// This builder assumes the trimmed, domain-neutral LogEntry shape described in
// docs/ACTIVELOG_FIRST_SLICE.md §1 item 1 — keyed by `dev` + `seq` (not deckboss's
// single uuid `id`), optional `gps`, additive `corrections` + `thread_id`, and a
// neutral `tags: string[]` in place of deckboss's fishing-specific `entities`.
// Field names assumed here: dev, seq, ts, gps, audio, transcript, tags, source,
// thread_id, corrections. If the merged type differs (e.g. adds `type`/`mono` from
// the envelope, renames `ts`, etc.), adjust buildEntry's object literal to match —
// `tsc` will name exactly the mismatched fields.

interface BuildEntryParams {
  dev: string;
  seq: number;
  audioBlob: Blob | null;
  timestamp?: string; // defaults to now — capture time, not transcription-return time
  gps: GPSReading | null;
  transcript?: TranscriptResult;
  source?: LogEntry["source"];
  threadId?: string;
}

const HUMAN_AUTHOR: CorrectionAuthor = { kind: "human" };

/**
 * The only place a LogEntry gets constructed. GPS or transcript being
 * unavailable never blocks this — a null gps and a null transcript are both
 * valid entries (the capture pipeline must never block on interpretation).
 *
 * The first transcript is stored as a correction rather than written directly
 * to the base record: transcript is an interpretation of the capture (audio +
 * GPS + timestamp), not a capture-time fact. Legacy entries with transcript
 * set directly are still honored by applyCorrections().
 *
 * Unlike deckboss, this builds the domain-neutral shape: no fishing entity
 * extraction — `tags` starts empty and is filled only by explicit edits.
 */
export async function buildEntry(params: BuildEntryParams): Promise<LogEntry> {
  const timestamp = params.timestamp ?? nowIso();

  const audio = params.audioBlob ? await buildAudioMeta(params.audioBlob, params.dev, params.seq) : null;
  const thread_id = params.threadId ?? newId();

  const entry: LogEntry = {
    id: newId(),
    dev: params.dev,
    seq: params.seq,
    timestamp,
    gps: params.gps,
    audio,
    transcript: null,
    tags: [],
    source: params.source ?? "voice",
    thread_id,
    version: SCHEMA_VERSION,
    corrections: [],
  };

  if (params.transcript) {
    // A live black-box test found that silence/no-signal recordings (a real
    // TranscriptResult object, but with text: "") were getting marked "edited"
    // in the UI despite never having been touched by a human — because any
    // truthy transcript result pushed a correction, and applyCorrections()
    // sets amended=true for any correction at all, empty or not. There's
    // nothing meaningful to record as a correction when the engine returned
    // nothing, so skip it — the entry correctly falls back to "No transcript"
    // in the UI either way.
    if (params.transcript.text.trim().length > 0) {
      entry.corrections.push(
        buildAmendCorrection(
          { transcript: params.transcript },
          params.dev,
          undefined,
          { kind: "model", engine: params.transcript.engine },
        ),
      );
    }
  }

  return entry;
}

async function buildAudioMeta(blob: Blob, dev: string, seq: number) {
  const ext = mimeToExt(blob.type);
  const duration_ms = await readAudioDurationMs(blob).catch(() => 0);
  return {
    filename: `${dev}_${seq}_audio.${ext}`,
    duration_ms,
    format: blob.type || "application/octet-stream",
    size_bytes: blob.size,
  };
}

export function buildAmendCorrection(
  fields: EditableFields,
  deviceId: string,
  reason?: string,
  author: CorrectionAuthor = HUMAN_AUTHOR,
): Correction {
  return {
    id: newId(),
    created_at: nowIso(),
    type: "amend",
    author,
    deviceId,
    reason,
    fields,
  };
}

export function buildRetractCorrection(
  deviceId: string,
  reason?: string,
  author: CorrectionAuthor = HUMAN_AUTHOR,
): Correction {
  return {
    id: newId(),
    created_at: nowIso(),
    type: "retract",
    author,
    deviceId,
    reason,
  };
}

/**
 * Folds `corrections` over the base entry to produce what the UI actually
 * shows. Applied in array order so later corrections win field-by-field; a
 * `retract` at any point sets `retracted = true` for the rest of the fold
 * (a later amend can't resurrect a retracted entry — undo a retract with
 * another correction type if that's ever needed, don't just stop emitting
 * retracts).
 */
export function applyCorrections(entry: LogEntry): EffectiveLogEntry {
  const { corrections, ...base } = entry;

  let retracted = false;
  let amended = false;
  let lastCorrectionReason: string | null = null;
  let transcript = base.transcript;
  let tags = base.tags;

  for (const c of corrections) {
    lastCorrectionReason = c.reason ?? lastCorrectionReason;
    if (c.type === "retract") {
      retracted = true;
      continue;
    }
    amended = true;
    if (c.fields?.transcript) transcript = c.fields.transcript;
    if (c.fields?.tags) tags = c.fields.tags;
  }

  return { ...base, transcript, tags, retracted, amended, lastCorrectionReason };
}
