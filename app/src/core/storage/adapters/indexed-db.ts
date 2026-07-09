import { get, set, del, entries, clear, createStore } from "idb-keyval";
import type { StorageAdapter, FileMetadata, Manifest } from "../interface";
import { ManifestSchema, MANIFEST_PATH } from "../interface";

/**
 * ============================================================================
 * INDEXED-DB ADAPTER  (the always-available fallback)
 * ============================================================================
 *
 * A StorageAdapter backed by IndexedDB through idb-keyval. This is the backend
 * the app uses when the File System Access API isn't available — i.e. Safari
 * and Firefox — or when the user hasn't picked a folder. It works the moment
 * the page loads: no OAuth, no permission prompts, no picker.
 *
 * SHAPE (ported from deckboss's `core/storage/local-db.ts`): a flat key→value
 * store, one idb-keyval store per concern. Critically each store gets its OWN
 * database (createStore("activelog-idb-files", …), createStore("activelog-
 * idb-blobs", …)) rather than sharing one DB with two object stores. The
 * reason is a real shipped bug deckboss hit: when multiple createStore() calls
 * share a dbName, only the first request's `upgradeneeded` fires and creates
 * its object store — the second store is never created and every read/write
 * against it throws "One of the specified object stores was not found." One
 * database per store sidesteps that shared-open race entirely.
 *
 * Unlike a picked folder (file-system-access.ts), IndexedDB is opaque origin
 * storage — the user can't browse/back it up as files, and it's cleared with
 * origin data. It's a real, working store, just not a portable one; that's
 * exactly why the FSA adapter exists as the upgrade path.
 *
 * NOTE on modifiedAt: IndexedDB doesn't expose a cheap per-record mtime, so
 * (matching deckboss's local-zip adapter) listFiles stamps each entry with the
 * listing time. Sync change-detection relies on content hashes, not mtime, so
 * this is fine for a local-only fallback that has no cloud peer to sync with.
 */

const fileStore = createStore("activelog-idb-files", "files");
const blobStore = createStore("activelog-idb-blobs", "blobs");

export class IndexedDBAdapter implements StorageAdapter {
  readonly id = "indexed-db" as const;

  async isAuthenticated(): Promise<boolean> {
    // No auth: if IndexedDB is reachable, this adapter is ready. (If it isn't
    // reachable, the constructor-time store creation will surface an error on
    // first use; we don't pre-flight here.)
    return true;
  }

  async authenticate(): Promise<void> {
    // No-op — nothing to authenticate against.
  }

  async logout(): Promise<void> {
    await clear(fileStore);
    await clear(blobStore);
  }

  async readFile(path: string): Promise<string> {
    const v = await get<string>(path, fileStore);
    if (v === undefined) throw new Error(`File not found: ${path}`);
    return v;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await set(path, content, fileStore);
  }

  async deleteFile(path: string): Promise<void> {
    await del(path, fileStore);
  }

  async readBlob(path: string): Promise<Blob> {
    const v = await get<Blob>(path, blobStore);
    if (v === undefined) throw new Error(`Blob not found: ${path}`);
    return v;
  }

  async writeBlob(path: string, blob: Blob): Promise<void> {
    await set(path, blob, blobStore);
  }

  async deleteBlob(path: string): Promise<void> {
    await del(path, blobStore);
  }

  async listFiles(prefix: string): Promise<FileMetadata[]> {
    // Both stores in one pass so a listing under any prefix sees text files
    // and binary attachments together (mirrors local-zip's combined listing).
    const now = new Date().toISOString();
    const textEntries = await entries<string, string>(fileStore);
    const blobEntries = await entries<string, Blob>(blobStore);
    const out: FileMetadata[] = [];
    for (const [p, content] of textEntries) {
      if (p.startsWith(prefix)) {
        out.push({ path: p, size: new Blob([content]).size, modifiedAt: now });
      }
    }
    for (const [p, blob] of blobEntries) {
      if (p.startsWith(prefix)) {
        out.push({ path: p, size: blob.size, modifiedAt: now });
      }
    }
    return out;
  }

  async getManifest(): Promise<Manifest> {
    const raw = await get<string>(MANIFEST_PATH, fileStore);
    if (raw === undefined) {
      return { version: "1.0", generatedAt: new Date().toISOString(), entries: [] };
    }
    const parsed = ManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success
      ? parsed.data
      : { version: "1.0", generatedAt: new Date().toISOString(), entries: [] };
  }

  async writeManifest(manifest: Manifest): Promise<void> {
    await set(MANIFEST_PATH, JSON.stringify(manifest, null, 2), fileStore);
  }
}
