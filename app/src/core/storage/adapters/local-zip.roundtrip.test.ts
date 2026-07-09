// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { LocalZipAdapter } from './local-zip';

/**
 * Full export→import round-trip coverage.
 *
 * Why this file needs a DOM environment: `importZip()` calls
 * `JSZip.loadAsync(blob)`, and jszip's Blob I/O path reads blob data through
 * the browser's `FileReader`. In plain Node there is no FileReader, so jszip
 * throws "Can't read the data of '…'" on ANY blob (even text-only zips) — that
 * is an environment gap, not a bug in LocalZipAdapter (which always handles
 * real browser Blobs in production). happy-dom supplies a *real* Blob and a
 * *real* FileReader, so jszip genuinely compresses and decompresses here; the
 * assertions fail if the adapter's packing or extension-based routing is wrong.
 *
 * The pure-Node counterpart of this suite lives in `local-zip.test.ts`.
 */
describe('LocalZipAdapter export→import round-trip (real jszip, happy-dom)', () => {
  it('round-trips text files (.md/.json/.yaml) through a zip into a fresh adapter', async () => {
    const exporter = new LocalZipAdapter();
    await exporter.writeFile('ActiveLog/2026/07/09/entry.md', '# Day one');
    await exporter.writeFile('.activelog/manifest.json', '{"version":"1.0"}');
    await exporter.writeFile('.activelog/config.yaml', 'theme: dark\n');

    const zip = await exporter.exportZip();

    const importer = new LocalZipAdapter();
    await importer.importZip(zip);

    expect(await importer.readFile('ActiveLog/2026/07/09/entry.md')).toBe('# Day one');
    expect(await importer.readFile('.activelog/manifest.json')).toBe('{"version":"1.0"}');
    expect(await importer.readFile('.activelog/config.yaml')).toBe('theme: dark\n');
  });

  it('routes a binary blob through the zip into the blobs map on import', async () => {
    // importZip splits entries by extension: text types -> files map,
    // everything else -> blobs map. A .webm must come back via readBlob().
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 255]);
    const exporter = new LocalZipAdapter();
    await exporter.writeBlob('.activelog/attachments/audio.webm', new Blob([bytes]));

    const zip = await exporter.exportZip();
    const importer = new LocalZipAdapter();
    await importer.importZip(zip);

    const got = await importer.readBlob('.activelog/attachments/audio.webm');
    expect(Array.from(new Uint8Array(await got.arrayBuffer()))).toEqual(Array.from(bytes));
  });

  it('a binary import does NOT also land in the text files map', async () => {
    const exporter = new LocalZipAdapter();
    await exporter.writeBlob('img/clip.webm', new Blob([new Uint8Array([9, 9])]));

    const importer = new LocalZipAdapter();
    await importer.importZip(await exporter.exportZip());

    // It must be readable as a blob, and must NOT be readable as a text file.
    expect((await importer.readBlob('img/clip.webm')).size).toBe(2);
    await expect(importer.readFile('img/clip.webm')).rejects.toThrow();
  });

  it('the imported store lists exactly the same paths as the exporter', async () => {
    const exporter = new LocalZipAdapter();
    await exporter.writeFile('one.md', '1');
    await exporter.writeFile('two.md', '2');
    await exporter.writeBlob('img.png', new Blob([new Uint8Array([9])]));

    const importer = new LocalZipAdapter();
    await importer.importZip(await exporter.exportZip());

    const before = (await exporter.listFiles('')).map((m) => m.path).sort();
    const after = (await importer.listFiles('')).map((m) => m.path).sort();
    expect(after).toEqual(before);
  });

  it('importing an empty zip leaves the store empty', async () => {
    const importer = new LocalZipAdapter();
    await importer.importZip(await new LocalZipAdapter().exportZip());
    expect(await importer.listFiles('')).toHaveLength(0);
  });

  it('round-trips a multi-entry store and the manifest survives as text', async () => {
    const exporter = new LocalZipAdapter();
    await exporter.writeFile('ActiveLog/2026/07/09/a.md', '### A');
    await exporter.writeFile('ActiveLog/2026/07/09/b.md', '### B');
    await exporter.writeBlob(
      '.activelog/attachments/audio.webm',
      new Blob([new Uint8Array([7, 7, 7])]),
    );
    await exporter.writeManifest({
      version: '1.0',
      generatedAt: '2026-07-09T12:00:00.000Z',
      entries: [],
    });

    const importer = new LocalZipAdapter();
    await importer.importZip(await exporter.exportZip());

    expect(await importer.readFile('ActiveLog/2026/07/09/a.md')).toBe('### A');
    expect(await importer.readFile('ActiveLog/2026/07/09/b.md')).toBe('### B');
    expect((await importer.readBlob('.activelog/attachments/audio.webm')).size).toBe(3);
    const manifest = await importer.getManifest();
    expect(manifest.version).toBe('1.0');
    expect(manifest.generatedAt).toBe('2026-07-09T12:00:00.000Z');
  });
});
