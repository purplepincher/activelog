export class RecorderPermissionError extends Error {
  constructor(cause?: unknown) {
    super("Microphone permission denied or unavailable.");
    this.name = "RecorderPermissionError";
    // Error.cause is standard (ES2022); this project targets ES2020 so the
    // lib doesn't type it. Assign via cast — the property is real at runtime
    // in every target browser. (deckboss targets ES2022 and assigns directly.)
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export type RecorderState = "inactive" | "recording" | "paused";

export interface RecorderConfig {
  mimeType?: string;
  maxDurationMs?: number; // auto-stop safety net, default 5 minutes
}

const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];

function pickSupportedMimeType(preferred?: string): string | undefined {
  const candidates = preferred ? [preferred, ...PREFERRED_MIME_TYPES] : PREFERRED_MIME_TYPES;
  return candidates.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
}

/**
 * Wraps MediaRecorder. `onDataAvailable` fires on each timeslice chunk so
 * the UI can drive a live waveform without waiting for stop(). Auto-stops
 * at `maxDurationMs` so a stuck button (dropped tap, background tab) can't
 * run away and fill IndexedDB.
 */
export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private state: RecorderState = "inactive";
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private stopResolve: ((blob: Blob) => void) | null = null;

  onDataAvailable: ((chunk: Blob) => void) | null = null;
  onAutoStop: (() => void) | null = null;

  constructor(private config: RecorderConfig = {}) {}

  getState(): RecorderState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state !== "inactive") {
      throw new Error(`Cannot start recording from state "${this.state}"`);
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      throw new RecorderPermissionError(err);
    }

    const mimeType = pickSupportedMimeType(this.config.mimeType);
    this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];

    this.mediaRecorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
        this.onDataAvailable?.(e.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: mimeType ?? this.chunks[0]?.type ?? "audio/webm" });
      this.releaseStream();
      this.state = "inactive";
      this.stopResolve?.(blob);
      this.stopResolve = null;
    };

    this.mediaRecorder.start(1000); // 1s timeslice for waveform + incremental data
    this.state = "recording";

    const maxDurationMs = this.config.maxDurationMs ?? 300_000;
    this.maxDurationTimer = setTimeout(() => {
      if (this.state === "recording") {
        this.onAutoStop?.();
        void this.stop();
      }
    }, maxDurationMs);
  }

  async stop(): Promise<Blob> {
    if (!this.mediaRecorder || this.state === "inactive") {
      throw new Error("Not recording");
    }
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);

    return new Promise<Blob>((resolve) => {
      this.stopResolve = resolve;
      this.mediaRecorder!.stop();
    });
  }

  pause(): void {
    if (this.state !== "recording") return;
    this.mediaRecorder?.pause();
    this.state = "paused";
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.mediaRecorder?.resume();
    this.state = "recording";
  }

  /** Discards the in-progress recording without producing a Blob. */
  cancel(): void {
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.stopResolve = null;
    this.chunks = [];
    this.mediaRecorder?.stop();
    this.releaseStream();
    this.state = "inactive";
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
