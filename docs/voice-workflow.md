# Guided voice workflow

The current application follows the supplied conversation workflow:

1. User activates Piko on a website form.
2. The deterministic scanner collects eligible field metadata.
3. Piper announces “Analysing the form.” Local Ollama generates a bounded
   summary beginning “The form asks for”; Piper reads it aloud.
4. Piko asks naturally, for example “Let’s start with your name. What is your
   name?”, and listens after playback ends.
5. Whisper.cpp transcribes the answer; local Ollama returns validated proposals.
6. Piper says “Your name is Dario George. Shall I continue? Yes or no.”
   It reads the extracted value, never the entire “My name is …” input sentence.
7. The user says yes or clicks **Yes, fill it**. The existing exact review and
   one-use native authorization engine fill only that field and verify its result.
8. Piko advances to the next unverified field. Interpretation is scoped to that
   field; another field cannot be populated from an incidental word in the answer.
9. The user reviews the final list and finishes review. Submission remains manual.

The primary UI no longer renders the synthetic demo, raw field inventory,
component test panels, separate speech-text editor or batch-selection workbench.
The smaller **Connection** disclosure reports engine readiness when needed.
Development output uses `dist-dev`; production output uses `dist`. This prevents
a running Vite HMR server from replacing the tested production manifest/worker.

## Local runtime

`npm run setup:voice` runs `scripts/setup-voice.py` explicitly. On Linux x86_64 it
builds official Whisper.cpp v1.9.5, verifies and installs `ggml-base.en.bin`,
verifies a Linux FFmpeg archive and installs FFmpeg/FFprobe, and ensures the Piper
Lessac voice exists. Models, native source/builds and `.voice-config.json` remain
ignored. Existing downloaded files with unexpected checksums are left for manual
inspection. `npm run dev:service` launches the service from the correct directory.

The runtime follows [Whisper.cpp’s installation interface](https://github.com/ggml-org/whisper.cpp),
the static-build provider linked by [FFmpeg’s download page](https://ffmpeg.org/download.html),
and the installed [Piper TTS runtime](https://github.com/OHF-Voice/piper1-gpl).
Piper is the TTS component; it does not need another language model.

The companion was previously issuing a one-year session while the extension
accepted at most 12 hours. The resulting connection rejection disabled voice
controls. The companion now issues 12-hour sessions, retaining code-free local
connection. Restart the companion after installing voice files or changing its
configuration. The current default local model remains `qwen3.5:2b`.

## Microphone and playback

Chrome may suppress a new microphone prompt inside a side panel. Piko opens its
own visible `microphone.html` extension tab for the first permission grant. The
user explicitly clicks **Enable microphone**, grants Chrome permission, and the
helper immediately stops its tracks and returns to the original form tab. It
never uploads or stores audio. The side panel then records using that permission.
Only a result from that exact helper tab/request is accepted.

`RecordingController` still owns the stream and hard 20-second cap. The guided
adapter adds in-memory speech/quiet detection so a completed answer does not need
an extra click. The existing voice coordinator releases the microphone before
Piper playback and stops playback before recording. Automatic listening starts
only after a successfully played question or confirmation. If autoplay is blocked,
**Play question** retries the prepared clip. Text remains visible on every failure.

Voice mode explicitly reads back the current answer, as requested by this
workflow. A user can choose text mode before starting or mute during a turn.
Audio is sent only to the loopback companion. Whisper decoding uses bounded
FFmpeg output and temporary files that are removed after completion or failure.

## Authority and recovery

`GuidedAssistant` owns the conversational turn and delegates scan/proposal/review/
fill state to `AssistantOrchestrator`. It does not manipulate the DOM. A unique
turn number binds a captured answer or spoken yes to the displayed field/review.
Typing, correction, cancellation, stale scans and ending a session invalidate old
turns. Only strict affirmative phrases count as approval; “yes, but change it”
does not. Correcting a field explicitly discards its old proposal and review so
later interpretation can propose a replacement.

Each field is preflighted before its spoken confirmation. The user’s affirmative
response authorizes that exact current review; expiry and document/scan identity
checks remain in the existing filling engine. An existing answer is protected
unless the user separately chooses **Review replacing the existing answer**.
Actual partial failures never advance as successful fills. Changed/conditional
forms require a fresh scan; expired reviews return to answer collection.

The new authenticated `POST /v1/summary` accepts only current eligible metadata.
It shares the bounded Ollama client, request cancellation and session revalidation
with interpretation. Its response is strict, short plain text. A summary failure
uses a short deterministic description so the user can still continue. Requests
never include full conversation history. The backend keeps no conversational
session database. A short focused turn constrains the evidence quote to the
original answer in the structured-output grammar. Invalid evidence can trigger
one bounded regeneration; every response is independently validated. Explicit
spoken email punctuation such as “at” and “dot” is checked deterministically on
both sides; missing aliases, letters or domains are never invented.

An explicit whole-answer request such as “use a random name” permits a fictional
AI suggestion for the current recognized name field only. This exception does
not invent other personal details or turn the suggestion into a known fact. It
requires its own spoken/button confirmation. Name sentence prefixes and the
words “random name” are rejected as literal name values.

Model failures preserve the last transcript on screen and offer typed/direct
value recovery. Skipped required fields remain unresolved in final review.
Passwords, payment fields, consent and excluded controls remain manual. The UI
makes no automatic submission and exposes no session-profile or cloud feature.

## Verification

The automated suites cover the new conversation UI, multi-field answers with
separate confirmations, negative/corrected/ambiguous approvals, stale/expired
reviews, missing required fields, manual recovery, cancelled responses, denied and
first-time microphone permission, playback rejection, audio/track cleanup,
content-script storage isolation, and the existing native constraints/approval
engine. Old workbench/demo browser scenarios were replaced with guided-workflow
scenarios; native scanner, native filling and lower-level unit checks remain.

Real-engine checks use generated fictional speech, an actual Chromium
MediaRecorder, actual local Whisper.cpp/FFmpeg, local Ollama, Piper generation and
Chromium playback. They assert successful responses from all four inference/audio
routes and verify the approved DOM value. They do not establish physical device
quality or improve the earlier model-accuracy benchmark.

## Recorded verification — 2026-10-30

- Production build/TypeScript, lint, contract checks and unit suites passed.
- Browser fixtures: 30 passed; the one opt-in real-engine case was skipped in
  that isolated run and passed separately against the configured companion.
- Python: 70 tests passed with both real Whisper/FFmpeg and real Piper enabled.
- Guided state tests cover the current-field AI request, confirmation, correction,
  expired reviews, strict yes/no handling, spoken email and generated-name intent.
- Actual local Ollama returned `Dario George` for “My name is Dario George”, a
  fictional suggestion for “Use a random name”, and `alex@example.test` for the
  spoken email. No whole name-introduction sentence was inserted.
- A real Chromium conversation completed name → spoken yes → email → spoken yes
  using actual Whisper, local Ollama and Piper, then verified both native values.
  The test generated fictional microphone audio; no person was recorded.

Microphone permission and physical device/speaker selection must still be allowed
in the user's normal Chrome installation. The bundled permission tab makes that
first-time grant explicit. The current companion reports all three engines ready.
