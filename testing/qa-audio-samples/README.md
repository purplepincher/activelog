# Manual QA audio samples

The `pick a folder → record → dictate → find a real file` acceptance
scenario needs a human tester — `showDirectoryPicker()` is a native OS
dialog that no browser-automation tool can drive, and the Web Speech API
transcribes a *live microphone stream*, not a pre-recorded file, so these
can't substitute for a real click-through either. They exist to make manual
testing faster and repeatable: play one through your speakers near your mic
while ActiveLog is recording, instead of having to come up with something
to say each time.

- `qa-sample-1-clear.mp3` (~9s) — a clean, evenly-paced sentence. Use this
  to check the happy path: does the transcript come out clean and readable.
- `qa-sample-2-natural-hesitant.mp3` (~11s) — natural hesitation, filler
  words ("um", "uh"), slower pace. Use this to check how the transcript
  handles real, imperfect speech rather than a scripted-sounding read.

Both generated via MiniMax TTS (`speech-2.8-hd`), English_expressive_narrator
voice — not real recordings, but natural enough for exercising the
transcription path. They are test fixtures, not sample product content;
nothing about them is fishing/voice-note-domain-specific by design, since
ActiveLog's Phase 1 core is domain-neutral.
