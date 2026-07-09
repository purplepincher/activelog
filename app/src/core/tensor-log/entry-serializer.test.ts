import { describe, it, expect } from 'vitest';
import { buildEntry } from './entry-builder';
import { serializeEntry } from './entry-serializer';
import { EntryParseError, parseEntry, tryParseEntry } from './entry-parser';
import type { TranscriptResult } from '../types/log-entry';

describe('round‑trip', () => {
  it('serializeEntry then parseEntry recovers equivalent LogEntry', async () => {
    const dev = 'dev1';
    const seq = 123;
    const timestamp = '2026-07-09T15:00:00.000Z';
    const transcript: TranscriptResult = {
      text: 'Hello world',
      engine: 'test',
      confidence: 0.95,
    };

    const original = await buildEntry({
      dev,
      seq,
      audioBlob: null,
      timestamp,
      gps: null,
      transcript,
      threadId: 'thread-xyz',
    });

    const serialized = serializeEntry(original);
    const parsed = parseEntry(serialized);

    expect(parsed.dev).toBe(original.dev);
    expect(parsed.seq).toBe(original.seq);
    expect(parsed.timestamp).toBe(original.timestamp);
    expect(parsed.tags).toEqual(original.tags);
    expect(parsed.corrections).toHaveLength(original.corrections.length);
    expect(JSON.stringify(parsed.corrections)).toEqual(JSON.stringify(original.corrections));
    expect(parsed.thread_id).toBe(original.thread_id);
    expect(parsed.id).toBe(original.id);
  });
});

describe('parseEntry errors', () => {
  it('throws EntryParseError for malformed input (no frontmatter)', () => {
    expect(() => parseEntry('no frontmatter')).toThrow(EntryParseError);
  });

  it('tryParseEntry returns null for the same malformed input', () => {
    expect(tryParseEntry('no frontmatter')).toBeNull();
  });
});
