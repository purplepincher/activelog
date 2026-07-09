import { describe, it, expect } from "vitest";
import { parseEntry, tryParseEntry, EntryParseError } from "./entry-parser";

describe("parseEntry", () => {
  it("throws EntryParseError when frontmatter block is missing", () => {
    expect(() => parseEntry("just plain text\n")).toThrow(EntryParseError);
  });

  it("throws EntryParseError when frontmatter contains invalid YAML", () => {
    const md = `---
invalid: [unclosed bracket
---
`;
    expect(() => parseEntry(md)).toThrow(EntryParseError);
    expect(() => parseEntry(md)).toThrow(/not valid YAML/i);
  });

  it("throws EntryParseError when YAML parses but schema validation fails", () => {
    // top-level string is valid YAML but fails LogEntrySchema (expects object)
    const md = `---
just a string
---
`;
    expect(() => parseEntry(md)).toThrow(EntryParseError);
  });

  it("throws EntryParseError when a required field is missing (e.g. no id)", () => {
    const md = `---
timestamp: "2025-01-01T00:00:00.000Z"
gps: null
audio: null
transcript: null
corrections: []
---
`;
    // id is missing → schema validation fails
    expect(() => parseEntry(md)).toThrow(EntryParseError);
  });

  it("parses a fully valid minimal entry (no gps/audio/transcript)", () => {
    const md = `---
id: "11111111-1111-4111-8111-111111111111"
timestamp: "2025-01-01T00:00:00.000Z"
dev: null
seq: null
gps: null
audio: null
transcript: null
source: null
tags: []
thread_id: "22222222-2222-4222-8222-222222222222"
version: "1.0"
corrections: []
---
Some body text
`;
    const entry = parseEntry(md);
    expect(entry).toBeDefined();
    expect(entry.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(entry.timestamp).toBe("2025-01-01T00:00:00.000Z");
    expect(entry.gps).toBeNull();
    expect(entry.audio).toBeNull();
    expect(entry.transcript).toBeNull();
    expect(entry.corrections).toEqual([]);
  });
});

describe("tryParseEntry", () => {
  it("returns null for invalid markdown (no frontmatter)", () => {
    expect(tryParseEntry("just text")).toBeNull();
  });

  it("returns null for invalid YAML", () => {
    const md = `---
[a
---
`;
    expect(tryParseEntry(md)).toBeNull();
  });

  it("returns null for schema validation failure (top-level string)", () => {
    const md = `---
hi
---
`;
    expect(tryParseEntry(md)).toBeNull();
  });

  it("returns entry for valid minimal entry", () => {
    const md = `---
id: "11111111-1111-4111-8111-111111111111"
timestamp: "2025-01-01T00:00:00.000Z"
dev: null
seq: null
gps: null
audio: null
transcript: null
source: null
tags: []
thread_id: "22222222-2222-4222-8222-222222222222"
version: "1.0"
corrections: []
---
Body
`;
    const entry = tryParseEntry(md);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("11111111-1111-4111-8111-111111111111");
  });
});
