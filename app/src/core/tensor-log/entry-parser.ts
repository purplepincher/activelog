import yaml from "js-yaml";
import type { ZodIssue } from "zod";
import { LogEntrySchema, type LogEntry } from "../types/log-entry";

export class EntryParseError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EntryParseError";
  }
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Markdown string -> LogEntry. Only the frontmatter block is authoritative;
 * the body (transcript text + rendered corrections) is entry-serializer's
 * cosmetic duplicate and is not parsed back. Round-trip fidelity is
 * guaranteed field-by-field via LogEntrySchema, not by re-diffing text.
 *
 * Ported near-verbatim from deckboss; the format is domain-neutral.
 */
export function parseEntry(markdown: string): LogEntry {
  const match = markdown.match(FRONTMATTER_RE);
  const frontmatterText = match?.[1];
  if (!match || frontmatterText === undefined) {
    throw new EntryParseError("No YAML frontmatter block found (expected leading ---...---).");
  }

  let raw: unknown;
  try {
    raw = yaml.load(frontmatterText);
  } catch (err) {
    throw new EntryParseError("Frontmatter is not valid YAML.", err);
  }

  const result = LogEntrySchema.safeParse(raw);
  if (!result.success) {
    throw new EntryParseError(
      `Entry failed schema validation: ${result.error.issues.map((i: ZodIssue) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      result.error,
    );
  }

  return result.data;
}

export function tryParseEntry(markdown: string): LogEntry | null {
  try {
    return parseEntry(markdown);
  } catch {
    return null;
  }
}
