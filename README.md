# Piko — local voice form assistant

Piko helps you fill a website form through a conversation. The Chrome extension
coordinates **Whisper.cpp → local Ollama/Qwen → Piper TTS**. You confirm each
answer before the existing native filling engine inserts it.

The main screen has one question, microphone controls, a typed fallback, and
**Yes, fill it / Change answer**. The demo and component workbench are no longer
part of the application screen.

## Setup

From the repository root:

```bash
npm install
npm --prefix apps/extension install
python3 -m venv apps/local-service/.venv
apps/local-service/.venv/bin/python -m pip install -r apps/local-service/requirements-dev.txt
npm run setup:voice
```

The voice installer targets Linux x86_64 with Python 3.12+, `git`, `cmake`, and `g++` installed.
It builds the official Whisper.cpp v1.9.5 CPU runtime, installs the multilingual
`large-v3-turbo-q5_0` model (547 MiB) and Silero speech detection, installs
FFmpeg/FFprobe, and downloads the Piper Lessac voice only if missing. Model and
FFmpeg archive checksums are verified. Recognition stays in English and speech
detection filters quiet portions before decoding. Runtime files
stay in ignored `vendor/`, `models/`, and `voices/` directories. No downloads run
when the companion starts. It saves local paths in the ignored
`apps/local-service/.voice-config.json`.

Install/run Ollama and make the configured local model available:

```bash
ollama pull qwen3.5:2b
```

Start the companion in one terminal, then build the extension in another:

```bash
npm run dev:service
```

```bash
npm run build
```

Load `apps/extension/dist` from `chrome://extensions` using **Load unpacked**.
If Piko is already installed, click its **Reload** button after rebuilding.
Development (`npm run dev:extension`) emits to `apps/extension/dist-dev`;
production builds emit to `apps/extension/dist`, so HMR cannot overwrite them.
The local service listens on `127.0.0.1:8765`; its health URL is an API endpoint,
not the assistant screen. There is no pairing-code entry in the UI.

## Use Piko

1. Open a normal HTTP/HTTPS page containing a form in the same Chrome browser.
2. Click Piko’s toolbar icon on that tab, then **Start voice assistant**.
3. The first time, a Piko permission tab opens. Click **Enable microphone** and
   allow Chrome’s microphone prompt. It stops its test stream and returns to the
   form. Microphone capture then happens in the side panel.
4. Piko says “Analysing the form,” reads the Ollama summary, then asks a natural
   question such as “Let’s start with your name. What is your name?”
5. Speak your answer. Pause to end the turn, or click **Stop recording**.
   Whisper’s transcript is shown, then sent to local Ollama for interpretation.
6. The AI extracts the value: “My name is Dario George” becomes “Dario George.”
   Piper says “Your name is Dario George. Shall I continue?” Say **yes** or click **Yes, fill it**
   to fill that exact field. Say **no**, provide a correction, or click
   **Change answer** to revise it. A model reply alone never fills anything.
7. Repeat until the supported fields are checked. Review the final answer list,
   click **Finish review**, then submit the form yourself on the website.

For a name field, “use a random name” asks the AI to suggest a fictional name.
That suggestion also waits for your confirmation.

Voice mode reads answers aloud for confirmation. **Use text instead** starts a
text conversation, and **Use text** switches an active conversation to text.
You can skip a field, use a direct manual value after a model failure, replay a
question, and end the session. Existing answers require separate overwrite
review. Passwords, consent and excluded sensitive fields remain manual.

Recordings are capped at 20 seconds and stop after detected speech followed by
quiet. Recording and playback do not overlap. Audio and transcripts are not
kept as a permanent history. **End session** removes temporary form-session data.

## Try the fixture

```bash
python3 -m http.server 8787 --bind 127.0.0.1 --directory tests/fixtures
```

Open `http://127.0.0.1:8787/form-fixture.html` in Chrome, click Piko’s toolbar
icon on that tab, and start. Browser internal pages, extension pages, custom
widgets, shadow DOM and iframe contents are outside the current scanner.
Conditional form changes require another scan and confirmation.

## Verification

```bash
npm run build
npm run lint
npm test
PIKO_TEST_REAL_VOICE=1 PIKO_TEST_REAL_PIPER=1 npm run test:python
npm run test:browser
```

Browser fixtures require port 8765 to be free. The optional real-engine browser
case can instead use an already running, configured companion:

```bash
PIKO_TEST_REAL_VOICE=1 PIKO_TEST_USE_RUNNING_SERVICE=1 npm run test:browser -- tests/voice.browser.spec.cjs --grep 'installed Whisper'
```

That case generates synthetic Piper speech as Chromium’s test microphone; it
uses actual Whisper, local Ollama, and Piper, without recording a person. Physical
microphone permission, device selection and audible speaker output still need a
check in your normal browser. See [the workflow guide](docs/voice-workflow.md)
for implementation details, recovery behavior and recorded verification.
