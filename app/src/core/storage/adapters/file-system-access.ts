import { get, set, del, createStore } from "idb-keyval";
import type { StorageAdapter, FileMetadata, Manifest } from "../interface";
import { ManifestSchema, MANIFEST_PATH } from "../interface";

/**
 * ============================================================================
 * FILE SYSTEM ACCESS ADAPTER  (net-new — no deckboss equivalent)
 * ============================================================================
 *
 * A StorageAdapter backed by the browser's File System Access API
 * (https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API):
 * the user picks a real folder on their device with
 * `window.showDirectoryPicker()`, and we read/write files directly inside it.
 * Supported in Chromium-based browsers (Chrome/Edge/Opera desktop, and
 * ChromeOS/Android via the picker). NOT supported in Safari or Firefox — for
 * those, IndexedDBAdapter is the fallback (see indexed-db.ts).
 *
 * Why this exists alongside the IndexedDB fallback: a picked folder is a
 * real, user-owned, app-independent directory. The user can back it up, sync
 * it through Dropbox/iCloud, hand-edit the files, or move them to another
 * machine. IndexedDB is opaque browser storage that gets wiped with origin
 * data. Both implement the same StorageAdapter contract, so the rest of the
 * app doesn't care which one is in use.
 *
 * RELOAD / PERMISSION MODEL: a `FileSystemDirectoryHandle` is itself
 * structured-cloneable, so it can be persisted to IndexedDB (via idb-keyval)
 * and read back after a reload — but the readwrite permission it carried is
 * NOT persisted across sessions in most browsers. On reload we restore the
 * handle, then `authenticate()` (called from a user gesture) calls
 * `requestPermission({ mode: "readwrite" })` to re-grant. If permission was
 * already durable, `queryPermission` returns "granted" and no prompt shows.
 * We persist the *handle* (not just a list of filenames) because without the
 * handle there's no way back into the same folder without re-picking.
 */

// ---- Ambient declarations for the parts of the File System Access API that
// TS 5.6's lib.dom.d.ts does not ship (verified absent: showDirectoryPicker,
// FileSystemHandle.queryPermission/requestPermission, and async iteration of
// a directory's entries). Everything else used below —
// FileSystemDirectoryHandle.{getFileHandle,getDirectoryHandle,removeEntry},
// FileSystemFileHandle.{getFile,createWritable},
// FileSystemWritableFileStream.{write,close}, PermissionState — IS already in
// the lib and is reused, not redeclared. ----
type FileSystemPermissionMode = "read" | "readwrite";
interface FileSystemHandlePermissionDescriptor {
  mode?: FileSystemPermissionMode;
}

declare global {
  interface Window {
    // `mode` IS a standard member of the spec's DirectoryPickerOptions
    // (defaults to "read"); setting "readwrite" up front avoids a second
    // permission prompt on initial pick. Verified against the WICG File
    // System Access API editor's draft and MDN.
    showDirectoryPicker(options?: {
      id?: string;
      mode?: FileSystemPermissionMode;
      startIn?: FileSystemHandle | string;
    }): Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    queryPermission(
      descriptor?: FileSystemHandlePermissionDescriptor,
    ): Promise<PermissionState>;
    requestPermission(
      descriptor?: FileSystemHandlePermissionDescriptor,
    ): Promise<PermissionState>;
  }
  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }
}

/**
 * Thrown when the File System Access API is unavailable — e.g. in Firefox,
 * Safari, or any context where `window.showDirectoryPicker` doesn't exist.
 * Mirrors `RecorderPermissionError` (core/audio/recorder.ts) so callers can
 * catch this by type instead of receiving a raw, unhelpful TypeError.
 */
export class FileSystemAccessUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("File System Access API is not supported in this browser.");
    this.name = "FileSystemAccessUnavailableError";
    // Error.cause is standard (ES2022); this project targets ES2020 so the
    // lib doesn't type it. Assign via cast — the property is real at runtime
    // in every target browser. (Same pattern as RecorderPermissionError.)
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

const handleStore = createStore("activelog-fsa", "handle");
const HANDLE_KEY = "root-dir-handle";

function splitPath(path: string): { dirs: string[]; name: string } {
  const segs = path.split("/").filter((s) => s.length > 0);
  if (segs.length === 0) throw new Error(`Invalid path: "${path}"`);
  return { dirs: segs.slice(0, -1), name: segs[segs.length - 1] };
}

/** Walks `dir`'s subtree, yielding [fullPath, fileHandle] for every file. */
async function* walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
): AsyncGenerator<[string, FileSystemFileHandle]> {
  for await (const [name, handle] of dir.entries()) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      yield* walk(handle as FileSystemDirectoryHandle, p);
    } else {
      yield [p, handle as FileSystemFileHandle];
    }
  }
}

export class FileSystemAccessAdapter implements StorageAdapter {
  readonly id = "file-system-access" as const;

  /** True where the API is usable; callers gate on this before offering the
   * "pick a folder" affordance and fall back to IndexedDB otherwise. */
  static isSupported(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.showDirectoryPicker === "function"
    );
  }

  /** Rehydrate from a previously-picked handle stored in IndexedDB, or null
   * if none. Does NOT request permission — that needs a user gesture, so the
   * caller must still invoke authenticate() from a click handler before any
   * read/write will succeed. */
  static async restore(): Promise<FileSystemAccessAdapter | null> {
    const stored = await get<FileSystemDirectoryHandle | undefined>(
      HANDLE_KEY,
      handleStore,
    );
    return stored ? new FileSystemAccessAdapter(stored) : null;
  }

  constructor(private root: FileSystemDirectoryHandle | null = null) {}

  async isAuthenticated(): Promise<boolean> {
    const handle = this.root ?? (await this.storedHandle());
    if (!handle) return false;
    // queryPermission is non-interactive: it reports current state without
    // prompting, so this is safe to call on every render.
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
  }

  /** Prompts the user to pick a folder (if no handle is stored yet) and
   * obtains readwrite permission. MUST be invoked from a user gesture — both
   * showDirectoryPicker() and requestPermission() require a transient
   * activation, or the browser rejects them. */
  async authenticate(): Promise<void> {
    if (typeof window.showDirectoryPicker !== "function") {
      throw new FileSystemAccessUnavailableError();
    }
    let handle = this.root ?? (await this.storedHandle());
    if (!handle) {
      handle = await window.showDirectoryPicker({ mode: "readwrite" });
    }
    if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted") {
      const granted = await handle.requestPermission({ mode: "readwrite" });
      if (granted !== "granted") {
        throw new Error("Permission denied for the selected directory.");
      }
    }
    this.root = handle;
    await set(HANDLE_KEY, handle, handleStore);
  }

  async logout(): Promise<void> {
    // Forget the handle locally and in IndexedDB. We intentionally do NOT
    // delete the files on disk — they're the user's, in their folder.
    this.root = null;
    await del(HANDLE_KEY, handleStore);
  }

  async readFile(path: string): Promise<string> {
    const { dir, name } = await this.resolveForRead(path);
    const fh = await dir.getFileHandle(name);
    return (await fh.getFile()).text();
  }

  async writeFile(path: string, content: string): Promise<void> {
    const { dir, name } = await this.resolveForWrite(path);
    const fh = await dir.getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async deleteFile(path: string): Promise<void> {
    const { dir, name } = await this.resolveForRead(path);
    await dir.removeEntry(name);
  }

  async readBlob(path: string): Promise<Blob> {
    const { dir, name } = await this.resolveForRead(path);
    const fh = await dir.getFileHandle(name);
    return fh.getFile(); // a File is a Blob
  }

  async writeBlob(path: string, blob: Blob): Promise<void> {
    const { dir, name } = await this.resolveForWrite(path);
    const fh = await dir.getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async deleteBlob(path: string): Promise<void> {
    const { dir, name } = await this.resolveForRead(path);
    await dir.removeEntry(name);
  }

  async listFiles(prefix: string): Promise<FileMetadata[]> {
    const root = this.rootOrThrow();
    const out: FileMetadata[] = [];
    for await (const [p, fh] of walk(root, "")) {
      if (!p.startsWith(prefix)) continue;
      const file = await fh.getFile();
      out.push({
        path: p,
        size: file.size,
        modifiedAt: new Date(file.lastModified).toISOString(),
      });
    }
    return out;
  }

  async getManifest(): Promise<Manifest> {
    const empty = (): Manifest => ({
      version: "1.0",
      generatedAt: new Date().toISOString(),
      entries: [],
    });
    // A missing manifest (first run) or an unreadable/corrupt one is normal —
    // degrade to an empty manifest rather than throwing.
    let raw: string;
    try {
      raw = await this.readFile(MANIFEST_PATH);
    } catch {
      return empty();
    }
    try {
      const parsed = ManifestSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : empty();
    } catch {
      return empty();
    }
  }

  async writeManifest(manifest: Manifest): Promise<void> {
    await this.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  }

  // ---- internals -------------------------------------------------------

  private async storedHandle(): Promise<FileSystemDirectoryHandle | null> {
    const h = await get<FileSystemDirectoryHandle | undefined>(
      HANDLE_KEY,
      handleStore,
    );
    return h ?? null;
  }

  private rootOrThrow(): FileSystemDirectoryHandle {
    if (!this.root) {
      throw new Error(
        "FileSystemAccessAdapter: not authenticated. Call authenticate() from a user gesture first.",
      );
    }
    return this.root;
  }

  /** Walks/creates intermediate directories so a path like
   * `ActiveLog/2026/07/09/x.md` resolves even on first write. */
  private async resolveForWrite(path: string): Promise<{
    dir: FileSystemDirectoryHandle;
    name: string;
  }> {
    const root = this.rootOrThrow();
    const { dirs, name } = splitPath(path);
    let dir = root;
    for (const d of dirs) dir = await dir.getDirectoryHandle(d, { create: true });
    return { dir, name };
  }

  /** Resolves without creating; a missing directory surfaces as the browser's
   * NotFoundError, which is the correct "file not found" semantics. */
  private async resolveForRead(path: string): Promise<{
    dir: FileSystemDirectoryHandle;
    name: string;
  }> {
    const root = this.rootOrThrow();
    const { dirs, name } = splitPath(path);
    let dir = root;
    for (const d of dirs) dir = await dir.getDirectoryHandle(d);
    return { dir, name };
  }
}
