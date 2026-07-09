import { describe, it, expect } from 'vitest';
import {
  buildEntry,
  buildRetractCorrection,
  applyCorrections,
} from './entry-builder';
import type { LogEntry, TranscriptResult } from '../types/log-entry';

describe('buildEntry', () => {
  it('builds an entry with the given fields', async () => {
    const dev = 'device1';
    const seq = 42;
    const timestamp = '2026-07-09T12:00:00.000Z';
    const transcript: TranscriptResult = {
      text: 'Hello world',
      engine: 'test',
      confidence: 0.95,
    };

    const entry = await buildEntry({
      dev,
      seq,
      audioBlob: null,
      timestamp,
      gps: null,
      transcript,
      source: 'voice',
      threadId: 'thread-1',
    });

    expect(entry.dev).toBe(dev);
    expect(entry.seq).toBe(seq);
    expect(entry.timestamp).toBe(timestamp);
    expect(entry.tags).toEqual([]);
    expect(entry.thread_id).toBe('thread-1');
    expect(entry.corrections).toHaveLength(1); // non‑empty transcript
    expect(entry.corrections[0].type).toBe('amend');
    expect(entry.corrections[0].fields?.transcript?.text).toBe(transcript.text);
  });

  it('does not push a correction for empty transcript text', async () => {
    const transcript: TranscriptResult = {
      text: '',
      engine: 'test',
      confidence: 0.95,
    };

    const entry = await buildEntry({
      dev: 'dev',
      seq: 1,
      audioBlob: null,
      timestamp: undefined,
      gps: null,
      transcript,
    });

    expect(entry.corrections).toHaveLength(0);
  });

  it('non‑empty transcript creates a correction and applyCorrections yields amended transcript', async () => {
    const transcript: TranscriptResult = {
      text: 'Hello world',
      engine: 'test',
      confidence: 0.95,
    };

    const entry = await buildEntry({
      dev: 'dev',
      seq: 1,
      audioBlob: null,
      timestamp: undefined,
      gps: null,
      transcript,
    });

    expect(entry.corrections).toHaveLength(1);

    const effective = applyCorrections(entry);
    expect(effective.transcript?.text).toBe(transcript.text);
    expect(effective.amended).toBe(true);
  });

  it('retract correction sets retracted true', async () => {
    const entry: LogEntry = {
      id: 'id',
      dev: 'dev',
      seq: 1,
      timestamp: '2026-07-09T12:00:00.000Z',
      gps: null,
      audio: null,
      transcript: null,
      tags: [],
      source: 'voice',
      thread_id: 't1',
      version: 1,
      corrections: [],
    };

    const retract = buildRetractCorrection('dev', 'reason', { kind: 'human' });
    entry.corrections.push(retract);

    const effective = applyCorrections(entry);
    expect(effective.retracted).toBe(true);
  });
});
