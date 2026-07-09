import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { IndexedDBAdapter } from './indexed-db';
import { MANIFEST_PATH, type Manifest } from '../interface';

/**
 * Real coverage of IndexedDBAdapter.
 *
 * `fake-indexeddb` is a faithful, commonly-used in-memory polyfill that
 * implements the actual IndexedDB spec (transactions, object stores, the
 * `upgradeneeded` lifecycle that idb-keyval's createStore() relies on). It is
 * not a mock of *this* adapter — the real idb-keyval calls and the real
 * IndexedDBAdapter code run against it, so a broken adapter makes these
 * assertions fail. This is exactly the kind of polyfill that's worth using:
 * it exercises real logic in Node that otherwise needs a browser.
 *
 * State isolation: IndexedDBAdapter keeps its two idb-keyval stores as
 * module-level singletons (one DB per store — see the adapter's doc comment),
 * so each test starts from a blank slate by calling logout(), which clears
 * both stores.
 */
describe('IndexedDBAdapter', () => {
  let adapter: IndexedDBAdapter;

  beforeEach(async () => {
    adapter = new IndexedDBAdapter();
    await adapter.logout(); // clear module-level stores for isolation
  });

  // ---- auth / lifecycle ------------------------------------------------

  describe('auth & lifecycle', () => {
    it('is always authenticated with no setup', async () => {
      expect(await adapter.isAuthenticated()).toBe(true);
    });

    it('authenticate() is a no-op that resolves', async () => {
      await expect(adapter.authenticate()).resolves.toBeUndefined();
    });

    it('logout() clears all files and blobs', async () => {
      await adapter.writeFile('a.md', 'hello');
      await adapter.writeBlob('b.webm', new Blob([new Uint8Array([1, 2, 3])]));
      expect(await adapter.listFiles('')).toHaveLength(2);

      await adapter.logout();

      expect(await adapter.listFiles('')).toHaveLength(0);
      await expect(adapter.readFile('a.md')).rejects.toThrow('not found');
    });
  });

  // ---- text file operations -------------------------------------------

  describe('text files', () => {
    it('round-trips a written file through readFile', async () => {
      await adapter.writeFile('entries/x.md', '# Hello');
      expect(await adapter.readFile('entries/x.md')).toBe('# Hello');
    });

    it('overwrites an existing path with the latest content', async () => {
      await adapter.writeFile('a.md', 'first');
      await adapter.writeFile('a.md', 'second');
      expect(await adapter.readFile('a.md')).toBe('second');
    });

    it('throws when reading a path that was never written', async () => {
      await expect(adapter.readFile('nope.md')).rejects.toThrow(/not found/i);
    });

    it('deletes a written file', async () => {
      await adapter.writeFile('gone.md', 'bye');
      await adapter.deleteFile('gone.md');
      await expect(adapter.readFile('gone.md')).rejects.toThrow();
    });

    it('deleteFile on a missing path is a no-op (does not throw)', async () => {
      await expect(adapter.deleteFile('never-existed.md')).resolves.toBeUndefined();
    });
  });

  // ---- binary blobs ----------------------------------------------------

  describe('binary blobs', () => {
    it('round-trips a written blob through readBlob', async () => {
      const bytes = new Uint8Array([10, 20, 30, 40]);
      await adapter.writeBlob('att/audio.webm', new Blob([bytes]));
      const got = await adapter.readBlob('att/audio.webm');
      expect(got.size).toBe(bytes.byteLength);
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    });

    it('throws when reading a blob that was never written', async () => {
      await expect(adapter.readBlob('nope.webm')).rejects.toThrow(/not found/i);
    });

    it('deletes a written blob', async () => {
      await adapter.writeBlob('att/x.webm', new Blob([new Uint8Array([1])]));
      await adapter.deleteBlob('att/x.webm');
      await expect(adapter.readBlob('att/x.webm')).rejects.toThrow();
    });

    it('keeps files and blobs in independent stores', async () => {
      // A path collision across the two stores must not collide: the same key
      // in the file store and the blob store are distinct records.
      await adapter.writeFile('same-key', 'text-content');
      await adapter.writeBlob('same-key', new Blob([new Uint8Array([9])]));

      expect(await adapter.readFile('same-key')).toBe('text-content');
      expect((await adapter.readBlob('same-key')).size).toBe(1);
    });
  });

  // ---- listing ---------------------------------------------------------

  describe('listFiles', () => {
    beforeEach(async () => {
      await adapter.writeFile('ActiveLog/2026/07/09/a.md', '# a');
      await adapter.writeFile('ActiveLog/2026/07/09/b.md', '# b');
      await adapter.writeFile('.activelog/manifest.json', '{}');
      await adapter.writeBlob(
        '.activelog/attachments/audio.webm',
        new Blob([new Uint8Array([1, 2, 3])]),
      );
    });

    it('lists every entry (text + blobs) under an empty prefix', async () => {
      const all = await adapter.listFiles('');
      expect(all.map((m) => m.path).sort()).toEqual(
        [
          'ActiveLog/2026/07/09/a.md',
          'ActiveLog/2026/07/09/b.md',
          '.activelog/manifest.json',
          '.activelog/attachments/audio.webm',
        ].sort(),
      );
    });

    it('filters to a prefix and includes blob entries under it', async () => {
      const atts = await adapter.listFiles('.activelog/attachments');
      expect(atts).toHaveLength(1);
      expect(atts[0].path).toBe('.activelog/attachments/audio.webm');
      expect(atts[0].size).toBe(3);
    });

    it('reports a size computed from the stored content', async () => {
      const listing = await adapter.listFiles('ActiveLog/2026/07/09/a.md');
      expect(listing).toHaveLength(1);
      expect(listing[0].size).toBe(new Blob(['# a']).size);
    });

    it('every entry carries an ISO modifiedAt timestamp', async () => {
      const listing = await adapter.listFiles('');
      for (const m of listing) {
        expect(() => new Date(m.modifiedAt).toISOString()).not.toThrow();
        expect(m.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }
    });
  });

  // ---- manifest --------------------------------------------------------

  describe('manifest', () => {
    it('returns an empty manifest when none was written', async () => {
      const m = await adapter.getManifest();
      expect(m.entries).toEqual([]);
      expect(m.version).toBe('1.0');
    });

    it('persists and reads back a written manifest (round-trips through ManifestSchema)', async () => {
      const manifest: Manifest = {
        version: '1.0',
        generatedAt: '2026-07-09T12:00:00.000Z',
        entries: [
          { path: 'ActiveLog/2026/07/09/x.md', size: 5, modifiedAt: '2026-07-09T12:00:00.000Z' },
        ],
      };
      await adapter.writeManifest(manifest);
      const got = await adapter.getManifest();
      expect(got).toEqual(manifest);
    });

    it('stores the manifest at the canonical MANIFEST_PATH', async () => {
      await adapter.writeManifest({
        version: '1.0',
        generatedAt: '2026-07-09T00:00:00.000Z',
        entries: [],
      });
      const raw = await adapter.readFile(MANIFEST_PATH);
      expect(JSON.parse(raw).version).toBe('1.0');
    });

    it('degrades to an empty manifest when the stored JSON fails the schema', async () => {
      // Write deliberately-invalid manifest JSON directly to the file store
      // path so getManifest() hits its safeParse-failure branch.
      await adapter.writeFile(MANIFEST_PATH, JSON.stringify({ nope: true }));
      const m = await adapter.getManifest();
      expect(m.entries).toEqual([]);
      expect(m.version).toBe('1.0');
    });
  });
});
