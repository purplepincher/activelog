import { describe, it, expect } from "vitest";
import { mimeToExt } from "./file";

describe("mimeToExt", () => {
  it("returns 'webm' for audio/webm", () => {
    expect(mimeToExt("audio/webm")).toBe("webm");
  });

  it("returns 'm4a' for audio/mp4", () => {
    expect(mimeToExt("audio/mp4")).toBe("m4a");
  });

  it("returns 'ogg' for audio/ogg", () => {
    expect(mimeToExt("audio/ogg")).toBe("ogg");
  });

  it("returns 'wav' for audio/wav", () => {
    expect(mimeToExt("audio/wav")).toBe("wav");
  });

  it("returns 'bin' for undefined", () => {
    expect(mimeToExt(undefined)).toBe("bin");
  });

  it("returns 'bin' for null", () => {
    expect(mimeToExt(null)).toBe("bin");
  });

  it("returns 'bin' for empty string", () => {
    expect(mimeToExt("")).toBe("bin");
  });

  it("returns 'bin' for unknown MIME type", () => {
    expect(mimeToExt("image/png")).toBe("bin");
  });

  it("handles parameterized MIME types (e.g. audio/webm; codecs=...)", () => {
    expect(mimeToExt("audio/webm; codecs=opus")).toBe("webm");
  });

  it("is case-insensitive", () => {
    expect(mimeToExt("Audio/WEBM")).toBe("webm");
    expect(mimeToExt("AUDIO/MP4")).toBe("m4a");
  });
});

// readAudioDurationMs is not tested because it requires a browser Audio element
// (not available in plain Node).
