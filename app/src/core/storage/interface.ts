import { z } from "zod";
import { isoDateString } from "../types/common";

/**
 * ============================================================================
 * STORAGE ADAPTER CONTRACT
 * ============================================================================
 *
 * Every storage backend (the browser's File System Access API, IndexedDB, the
 * zero-auth Local ZIP export, and later cloud backends) implements this exact
 * interface. Code that reads/writes entries is written against StorageAdapter
 * only — it never imports a concrete adapter. This is what makes storage
 * "backend-agnostic": swapping backends means swapping which adapter a factory
 * hands out, nothing else changes.
 *
 * SECURITY BOUNDARY: adapters take credentials at construction time (from
 * IndexedDB via a local-only settings store) and hold them in memory. No
 * adapter, and nothing it writes through writeManifest/writeFile, may ever
 * place a secret (API key, OAuth token, client secret) into a file that lands
 * in the user's storage. The manifest and entry files are meant to be readable
 * by any tool, including ones with no notion of "this app's credentials."
 *
 * Ported near-verbatim from deckboss's `core/storage/interface.ts`; only the
 * backend-id enum (two new local backends) and the on-disk folder name
 * (`ActiveLog` instead of `DeckBoss`) differ.
 */

export const StorageBackendIdSchema = z.enum([
  "file-system-access",
  "indexed-db",
  "local-zip",
]);
export type StorageBackendId = z.infer<typeof StorageBackendIdSchema>;

export const FileMetadataSchema = z.object({
  path: z.string(),
  size: z.number().nonnegative(),
  modifiedAt: isoDateString,
  hash: z.string().optional(), // sha256, for conflict/change detection
});
export type FileMetadata = z.infer<typeof FileMetadataSchema>;

export const ManifestSchema = z.object({
  version: z.string(),
  generatedAt: isoDateString,
  entries: z.array(FileMetadataSchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export interface StorageAdapter {
  readonly id: StorageBackendId;

  // Authentication
  isAuthenticated(): Promise<boolean>;
  authenticate(): Promise<void>;
  logout(): Promise<void>;

  // Text file operations (Markdown entries, manifest.json, config.yaml)
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listFiles(prefix: string): Promise<FileMetadata[]>; // recursive

  // Binary attachments
  readBlob(path: string): Promise<Blob>;
  writeBlob(path: string, blob: Blob): Promise<void>;
  deleteBlob(path: string): Promise<void>;

  // Sync helpers
  getManifest(): Promise<Manifest>;
  writeManifest(manifest: Manifest): Promise<void>;
}

/**
 * Path layout every adapter writes, regardless of backend, so a user's folder
 * is human-browseable:
 *
 *   ActiveLog/
 *     2026/07/02/{filename}.md
 *     .activelog/manifest.json
 *     .activelog/config.yaml
 *     .activelog/attachments/{filename}_audio.webm
 */
export const STORAGE_ROOT = "ActiveLog";
export const MANIFEST_PATH = ".activelog/manifest.json";
export const ATTACHMENTS_DIR = ".activelog/attachments";

/**
 * Maps an entry to its on-disk path, bucketed by capture date (UTC) so a
 * folder stays browseable by day. `timestamp` is nullable (an imported or
 * manually-entered entry may have no capture time), so a null timestamp is
 * routed under an `undated/` bucket rather than crashing — the only
 * deviation from deckboss's otherwise identical helper, and forced by the
 * domain-neutral schema. Identity is `id` (a uuid, verbatim from deckboss),
 * not `dev`+`seq` — those are envelope-derived metadata, optional, and not
 * guaranteed unique on their own (a device that doesn't stamp seq).
 */
export function entryPath(timestamp: string | null, id: string): string {
  if (timestamp === null) {
    return `${STORAGE_ROOT}/undated/${id}.md`;
  }
  const d = new Date(timestamp);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${STORAGE_ROOT}/${yyyy}/${mm}/${dd}/${id}.md`;
}

/**
 * Full on-disk path for an id-keyed attachment: `${ATTACHMENTS_DIR}/${id}.${ext}`.
 *
 * Not yet wired up. Phase 1 audio attachments are named `${dev}_${seq}_audio.${ext}`
 * (see `buildAudioMeta` in entry-builder.ts) and written directly via
 * `${ATTACHMENTS_DIR}/${entry.audio.filename}` in App.tsx, because `AudioMeta.filename`
 * is a bare filename, not an id. Kept as the id-keyed parallel to `entryPath` for a
 * future attachment type that is naturally keyed by entry id; reconcile the two
 * naming schemes when that lands.
 */
export function attachmentPath(id: string, ext: string): string {
  return `${ATTACHMENTS_DIR}/${id}.${ext}`;
}
