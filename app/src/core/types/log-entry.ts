import { z } from "zod";
import { isoDateString, uuidV4, SCHEMA_VERSION } from "./common";

/**
 * ============================================================================
 * THE LOG ENTRY SCHEMA (domain-neutral)
 * ============================================================================
 *
 * One LogEntry = one entry in the log = one file on disk (Markdown body with
 * JSON frontmatter, or a JSON envelope — see the storage adapters). This file
 * is the single source of truth for what an "entry" is; the storage adapters
 * and (later) the query engine all read/write this shape and nothing else. If
 * a field needs to change, it changes here first.
 *
 * PORTED FROM deckboss's `core/types/log-entry.ts`, then trimmed to be
 * domain-neutral. Correction from an earlier pass of this file: only the
 * fishing-specific *content* field (`entities`) is dropped, replaced by a
 * generic `tags: string[]`. `transcript`, `audio`, and `source` are kept —
 * they describe the domain-neutral *capture mechanism* (voice-to-text is
 * Phase 1's whole product, not a fishing-specific add-on), not fishing
 * content. `source` is now a free-form string (deckboss pinned it to a
 * fixed transcription-engine enum; ActiveLog has no fixed engine
 * vocabulary). The envelope-derived metadata fields (`dev`, `seq`,
 * `timestamp`, `gps`) are optional/nullable — ActiveLog must not force a
 * caller to have a device id, a sequence number, or a GPS fix just to
 * record something.
 *
 * THE MERGE-SAFE INVARIANT IS PRESERVED VERBATIM: `corrections` and
 * `thread_id` keep deckboss's exact shape. DIVERGENCE FROM A NAIVE
 * LAST-WRITE-WINS MODEL, DELIBERATE: there is no in-place edit or delete.
 * "Delete" sets retracted=true via a Correction; "Edit" appends a Correction
 * that overlays fields. The *effective* entry (what the UI shows) is computed
 * at read time by folding corrections over the on-disk record — the on-disk
 * record never loses information. This costs a read-time fold; it buys back
 * conflict-free offline sync (two devices' corrections just union, they never
 * conflict) and a write-path invariant that's cheap to enforce mechanically
 * rather than something every future contributor has to remember to preserve
 * by convention.
 *
 * This is NOT justified by, or a claim toward, regulatory/compliance
 * evidentiary value. That would be a real feature with real requirements
 * (chain of custody, legal review, retention policy) that nobody has decided
 * to pursue. The design earns its keep on sync-safety grounds alone.
 */

export const GPSSourceSchema = z.enum(["gps", "network", "unknown"]);

export const GPSReadingSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative(), // meters
  altitude: z.number().nullable(),
  heading: z.number().min(0).max(360).nullable(),
  speed: z.number().nonnegative().nullable(), // m/s
  timestamp: isoDateString,
  source: GPSSourceSchema,
});
export type GPSReading = z.infer<typeof GPSReadingSchema>;

/**
 * The result of a transcription engine run (webspeech, whisper, or any
 * future engine) — the interpretation of a capture, not the capture-time
 * fact itself. See `buildEntry`'s comment in entry-builder.ts for why this
 * is stored as a Correction rather than a base-record field.
 */
export const TranscriptResultSchema = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1),
  language: z.string(),
  engine: z.string(),
});
export type TranscriptResult = z.infer<typeof TranscriptResultSchema>;

/** Metadata about a captured audio blob. The blob itself lives in storage
 * (keyed by `filename`), never inline in the LogEntry — this is pointer +
 * facts only. */
export const AudioMetaSchema = z.object({
  filename: z.string(),
  duration_ms: z.number().nonnegative(),
  format: z.string(),
  size_bytes: z.number().nonnegative(),
});
export type AudioMeta = z.infer<typeof AudioMetaSchema>;

/**
 * A Correction is the only way an entry changes after creation. `amend`
 * carries a partial overlay of editable fields (never id/timestamp — the
 * capture facts are permanent); `retract` carries just a reason. Corrections
 * are applied in array order at read time.
 *
 * EditableFields is the domain-neutral user-editable set: `tags` (manual
 * edits) and `transcript` (the first transcription result is itself applied
 * as a correction — see entry-builder.ts — since it's an interpretation of
 * the capture, not a capture-time fact).
 */
export const EditableFieldsSchema = z
  .object({
    tags: z.array(z.string()),
    transcript: TranscriptResultSchema,
  })
  .partial();
export type EditableFields = z.infer<typeof EditableFieldsSchema>;

export const CorrectionAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human") }),
  // Domain-neutral: deckboss pinned this to its transcription-engine enum
  // ("webspeech" | "whisper-1"). ActiveLog has no fixed engine vocabulary, so
  // `engine` is free-form — the human/model distinction (provenance: was a
  // correction made by a person or auto-applied by some engine?) is what
  // matters and is preserved.
  z.object({ kind: z.literal("model"), engine: z.string() }),
]);
export type CorrectionAuthor = z.infer<typeof CorrectionAuthorSchema>;

export const CorrectionSchema = z.object({
  id: uuidV4,
  created_at: isoDateString,
  type: z.enum(["amend", "retract"]),
  // Optional, not required: a correction written before this field existed
  // has no `author` on disk. Since this app has no backend and no way to
  // know whether a given local store already holds real corrections from
  // before this change, `author` must stay optional forever (or until a
  // version-gated migration is worth writing) — a required field here would
  // mean any pre-existing author-less correction fails LogEntrySchema.parse()
  // on the next write to that entry, silently bricking amend/retract for it.
  // Absent means "assume human" wherever this gets consumed.
  author: CorrectionAuthorSchema.optional(),
  // Optional, not required: a correction written before this field existed
  // has no `deviceId` on disk. New corrections are stamped at creation time;
  // absent means "created before device metadata was recorded."
  deviceId: z.string().uuid().optional(),
  reason: z.string().optional(),
  fields: EditableFieldsSchema.optional(), // present for "amend", absent for "retract"
});
export type Correction = z.infer<typeof CorrectionSchema>;

/**
 * LogEntry — the on-disk record. This is exactly what the storage adapters
 * write and read back.
 *
 * The shape is declared separately from the schema so `LogEntry` (the type
 * every module codes against) stays a plain, fully-typed object — no index
 * signature. `.passthrough()` is applied only to the *schema* used for
 * parsing, so a future version's unknown fields still survive a round-trip
 * through an older client at runtime (forward-compatibility) without
 * infecting the TS type: a passthrough schema's inferred type carries
 * `[x: string]: unknown`, which silently collapses `Omit<LogEntry,
 * "corrections">` (used below for EffectiveLogEntry) down to
 * `{ [x: string]: unknown }` — every field quietly becomes `unknown`
 * project-wide. Keeping the shape and the passthrough separate avoids that
 * trap entirely.
 *
 * `dev` and `seq` come from the ActiveLog JSON envelope convention
 * (`{ alv, dev, seq, ts, ... }`): the originating device and a per-device
 * sequence number. Both are optional/nullable — an entry may legitimately
 * have neither (e.g. manual import, or a device that doesn't stamp seq).
 * `timestamp` and `gps` are likewise nullable rather than required.
 */
const logEntryShape = {
  id: uuidV4,
  timestamp: isoDateString.nullable(), // capture time; nullable, not required
  dev: z.string().nullable().optional(), // envelope: originating device id
  seq: z.number().int().nonnegative().nullable().optional(), // envelope: per-device sequence
  gps: GPSReadingSchema.nullable(),
  audio: AudioMetaSchema.nullable(), // present iff this entry was voice-captured
  transcript: TranscriptResultSchema.nullable(), // base-record value stays null; the
  // first real transcript is applied as a Correction (see entry-builder.ts) so the
  // capture/interpretation split holds even for the very first transcription.
  source: z.string().nullable(), // free-form: "voice" | a future capture mechanism's own name
  tags: z.array(z.string()),
  thread_id: uuidV4, // defaults to id; links related entries. Verbatim from deckboss.
  version: z.string(),
  corrections: z.array(CorrectionSchema),
};

export const LogEntrySchema = z.object(logEntryShape).passthrough();
export type LogEntry = z.infer<z.ZodObject<typeof logEntryShape>>;

/**
 * EffectiveLogEntry — the *computed* view after folding `corrections` over
 * `LogEntry`. This is what every UI screen and the query engine actually
 * read. It is never itself persisted.
 */
export type EffectiveLogEntry = Omit<LogEntry, "corrections"> & {
  retracted: boolean;
  amended: boolean;
  lastCorrectionReason: string | null;
};

/**
 * Construct a minimal, valid LogEntry with no corrections and empty tags.
 * `id`, `timestamp`, and (unless overridden) `thread_id` are the identity
 * triple; everything else defaults. Mirrors deckboss's `newEntrySkeleton`,
 * adapted to the domain-neutral shape (no audio/source params; dev/seq
 * optional).
 */
export function newEntrySkeleton(params: {
  id: string;
  timestamp: string | null;
  gps: GPSReading | null;
  tags?: string[];
  dev?: string | null;
  seq?: number | null;
  threadId?: string;
  audio?: AudioMeta | null;
  source?: string | null;
}): LogEntry {
  return {
    id: params.id,
    timestamp: params.timestamp,
    dev: params.dev ?? null,
    seq: params.seq ?? null,
    gps: params.gps,
    audio: params.audio ?? null,
    transcript: null,
    source: params.source ?? null,
    tags: params.tags ?? [],
    thread_id: params.threadId ?? params.id,
    version: SCHEMA_VERSION,
    corrections: [],
  };
}
