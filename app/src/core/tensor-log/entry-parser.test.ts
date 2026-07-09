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
    expect(() => parseEntry(md)).toThrow(/invalid YAML/i);
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
id: "abc"
timestamp: "2025-01-01T00:00:00.000Z"
gps: null
audio: null
transcript: null
corrections: []
---
Some body text
`;
    const entry = parseEntry(md);
    expect(entry).toBeDefined();
    expect(entry.id).toBe("abc");
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
id: "abc"
timestamp: "2025-01-01T00:00:00.000Z"
gps: null
audio: null
transcript: null
corrections: []
---
Body
`;
    const entry = tryParseEntry(md);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("abc");
  });
});
