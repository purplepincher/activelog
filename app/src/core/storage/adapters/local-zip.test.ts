import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { LocalZipAdapter } from './local-zip';
import { MANIFEST_PATH, type Manifest } from '../interface';

/**
 * Pure-Node coverage of LocalZipAdapter's in-memory logic.
 *
 * The adapter is an in-memory Map<String> + Map<Blob> with a few helpers, and
 * all of that logic (read/write/delete/list/manifest/blob ops, and exportZip's
 * assembly of a real zip) is exercised here with no browser API.
 *
 * NOTE on exportZip: we DO verify exportZip() produces a genuine, well-formed
 * zip by reading it back through `JSZip.loadAsync(await blob.arrayBuffer())`.
 * loadAsync accepts an ArrayBuffer in plain Node (it only chokes on a Blob,
 * because jszip's Blob path needs the browser's FileReader). The full
 * export→import round-trip — which requires reading a Blob back in — lives in
 * `local-zip.roundtrip.test.ts`, run under a real DOM environment (happy-dom)
 * precisely because that's where the browser FileReader dependency surfaces.
 */
describe('LocalZipAdapter (in-memory + export)', () => {
  let adapter: LocalZipAdapter;

  beforeEach(() => {
    adapter = new LocalZipAdapter();
  });

  // ---- auth / lifecycle ------------------------------------------------

  describe('auth & lifecycle', () => {
    it('is always authenticated with no setup', async () => {
      expect(await adapter.isAuthenticated()).toBe(true);
    });

    it('authenticate() is a no-op that resolves', async () => {
      await expect(adapter.authenticate()).resolves.toBeUndefined();
    });

    it('clears all files and blobs on logout()', async () => {
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
      // Guards the documented behaviour: listFiles MUST walk the blobs map too,
      // or attachments never appear.
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

    it('persists and reads back a written manifest', async () => {
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
  });

  // ---- exportZip produces a genuine, well-formed zip (pure Node) -------

  // loadAsync(ArrayBuffer) works in plain Node, so we can prove exportZip()
  // really packs every written file + blob into a valid zip without needing a
  // DOM. The reverse direction (importing that zip) is covered separately.
  describe('exportZip', () => {
    it('produces a real, non-empty zip Blob', async () => {
      await adapter.writeFile('a.md', 'hello');
      const blob = await adapter.exportZip();
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });

    it('packs every written text file with its original content', async () => {
      await adapter.writeFile('ActiveLog/2026/07/09/entry.md', '# Day one');
      await adapter.writeFile('.activelog/config.yaml', 'theme: dark\n');

      const zip = await JSZip.loadAsync(await (await adapter.exportZip()).arrayBuffer());

      expect(await zip.file('ActiveLog/2026/07/09/entry.md')!.async('text')).toBe('# Day one');
      expect(await zip.file('.activelog/config.yaml')!.async('text')).toBe('theme: dark\n');
    });

    // NOTE: binary blobs are NOT verified here. jszip must read a Blob to
    // compress it during generateAsync(), which — like loadAsync(Blob) — needs
    // the browser's FileReader. Blob export/import is covered end-to-end in
    // local-zip.roundtrip.test.ts under happy-dom.

    it('an export of an empty store yields a valid (but empty) archive', async () => {
      const zip = await JSZip.loadAsync(await (await adapter.exportZip()).arrayBuffer());
      const fileNames = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
      expect(fileNames).toHaveLength(0);
    });
  });
});
