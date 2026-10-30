# Step 11 — Conversation workflow and temporary session facts

Piko 0.4.0 connects inspection, edited voice or typed answers, local Qwen,
questions, exact approval, and verified filling. The application owns the
workflow. Model output creates proposals; it cannot authorize DOM changes.

## Try a conversation

Build from the repository root with `npm run build`, then reload Piko from
`apps/extension/dist` in `chrome://extensions`. Start and pair the companion
using [the connection guide](08-local-service-connection.md). Whisper and Piper
remain optional; typed answers and manual proposal editing work without them.
The health endpoint is JSON, while the assistant UI is Chrome's Piko side panel.

Serve the synthetic fixture in a separate terminal:

```bash
python3 -m http.server 8787 --bind 127.0.0.1 --directory tests/fixtures
```

1. Open `http://127.0.0.1:8787/form-fixture.html` in the browser where Piko is
   installed. Click its toolbar icon on that tab, then **Inspect this page**.
2. Read **Current question**. Type an answer in **Edited answer for this form**,
   or record and accept an edited Whisper transcript. Accepting a transcript
   does not send it to Qwen. Click **Interpret edited answer** explicitly.
3. Supply more answers over subsequent turns. Previous validated proposals stay
   available; manual edits stay protected. **Skip this question** leaves its
   required answer unresolved. You may finish manually or review a partial batch.
4. Include the fields to insert and check the proposed values. Separately enable
   overwrite only where intended. Click **Review selected values** for native
   preflight and the exact destination/value list.
5. Optionally check **Remember selected answers for this session**. This does
   not approve filling. Check **I approve this exact batch and destination.**,
   then **Approve and fill selected fields**.
6. Read the actual per-field outcomes and unverified required-field count. A
   partial result remains partial. Submit the form manually. If conditional
   fields appear or the page changes, inspect again and review a new batch.
7. **Clear session** removes reusable facts and the live conversation.
   **Clear scan** discards the current workflow while retaining confirmed facts.
   Reopening the panel restores only session metadata/facts and requires a scan.

Enable **Spoken responses** only if wanted. Automatic speech uses fixed
questions/status messages, never personal proposal values or raw model wording.
The exact spoken text stays visible, with manual replay and text fallback.
Recording and playback share the existing voice coordinator and cannot overlap.

## State and service boundaries

`workflow.reducer.ts` is the live workflow's source of truth.
`assistant.orchestrator.ts` invokes the existing typed scanner, interpretation,
speech, session, and filling interfaces. It has no raw DOM operations or direct
HTTP/model process calls. The old synthetic demo remains separately labeled.

The explicit stages are `idle`, `scanning`, `collecting`, `transcribing`,
`interpreting`, `review`, `approving`, `filling`, `results`, `stale`, and `error`.
Recording/playback substates stay in the existing media controllers. The
`approving` stage requests preflight; only a valid, unexpired exact review and
the separate approval checkbox permit the `filling` stage.

`question-queue.ts` derives missing required answers and validated ambiguities
from the current scan and merged proposals. Every question has a field and scan
identity. Skipped questions remain unresolved. Proposal validity is preliminary;
the existing native preflight and fill engine enforce the live constraints.

Each interpretation has a unique request ID, session ID, scan ID, and workflow
revision. The worker checks the current document and stored session version.
Superseding edits abort the client request and invalidate old responses. A late
response cannot replace a manual edit or use an old document. Cancellation may
leave inference draining locally; its response is discarded.

Each `/v1/interpret` request contains only current edited text, relevant approved
facts, and eligible field metadata. Conversation history is never sent. FastAPI
keeps no session database or hidden conversational history. Existing strict
schema, field/option IDs, evidence, and constraint checks remain in force.

Navigation, origin change, form replacement, stale references, session changes,
and expiry invalidate pending reviews. The existing worker coordinator remains
the sole issuer of one-use, short-lived exact-batch grants. No AI response starts
a fill. Transport loss during a fill reports an unknown outcome for manual
checking; the orchestrator does not retry a potentially executed batch.

## Temporary facts

The worker serializes reads and mutations of
`chrome.storage.session['piko.assistant.session.v1']`. It explicitly restricts
the storage area to `TRUSTED_CONTEXTS`. The separate existing companion pairing
credential remains under its own session key and is unaffected by Clear session.

Only selected, approved, eligible values with a successful `filled` or
`already-matched` native outcome may be remembered, and only with the separate
remember opt-in. Supported meanings are full/first/last name, email, phone,
department, organization, city, and country. Unknown meanings, excluded fields,
checkboxes/consent, credentials, and payment-like values are rejected. A select
or radio fact stores the approved option label, then maps to a new current
option ID when reused. Reused drafts start unselected with overwrite disabled.

Limits are 20 facts, 256 characters per value, a 16 KiB validated snapshot, and
an **absolute 30-minute lifetime from session creation**. Remembering a later
answer does not extend that deadline. Facts are scoped to one origin; inspecting
a different origin replaces the session. Every read/use validates shape, origin,
version, and expiry. Expired/malformed data is purged and dependent contexts are
invalidated. A pending old remember operation cannot recreate a cleared session.

Transcript text, conversation messages, unapproved proposals, scan registries,
reviews, and results stay in memory. Audio stays in the existing bounded media
buffers. None is written to extension local/sync storage, files, or a database.
Current conversation messages are bounded to 20 entries and 32,768 characters.
Values and model diagnostics are not logged.

Chrome documents that session storage survives worker suspension but is cleared
on browser restart and extension reload/disable/update. See the
[Chrome storage API](https://developer.chrome.com/docs/extensions/reference/api/storage#storage-areas).
Worker globals disappear on shutdown, so they cannot prove an old field registry
is still valid; after worker restart Piko requires a fresh scan before review or
filling. See [the worker lifecycle guide](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

## Verification

From the repository root:

```bash
npm run typecheck
npm run lint
npm run build
npm test
npm run test:python
npm run test:browser
```

Browser tests launch isolated Chromium profiles with real extension APIs and
the built production manifest. Their fixtures require port 8765 to be free;
stop your development companion before running them and restart it afterward.
Workflow tests use synthetic names/addresses, an authenticated fixture companion,
and controlled model replies. They verify multiple turns, current text only,
late-response rejection, protected manual edits, skipped/partial batches,
independent memory opt-in, successful-outcome-only retention, expiry, clear,
conditional rescans, worker suspension, and browser restart. Existing suites cover
the native approval engine, media failures, no microphone/playback overlap,
content-script storage isolation, and no automatic submission.

Optional installed-model integration checks:

```bash
PIKO_TEST_REAL_PIPER=1 npm run test:python
PIKO_TEST_REAL_PIPER=1 npm run test:browser
```

The real Piper browser case uses local Qwen 2.5 14B and fixture transcription.
Physical microphone/speaker checks and real whisper.cpp recognition remain
separate opt-in/manual checks. Test skips are not passes. Step 11 does not change
the recorded Step 9 model accuracy benchmark or complete Step 12's security,
offline, performance, and packaging milestone.

### Recorded Step 11 checks — 2026-10-30

- Production build (including TypeScript), lint, and `npm test`: passed.
- Direct workflow unit run: 22 scenarios passed, including transport loss,
  expiry/clear races, stale status replies, and date/number question validity.
- Python with `PIKO_TEST_REAL_PIPER=1`: 76 run, 75 passed, one real-Whisper
  integration check skipped. The installed Piper voice was exercised.
- Complete browser suite: 44 scenarios, 37 passed and seven skipped. The skips
  were five opt-in real voice-input checks and two opt-in real-model browser cases.
- After the final guards/validation changes, all seven workflow browser cases
  passed again against the rebuilt extension.

Browser fixtures ran in a private Linux network namespace to avoid stopping the
development companion already listening on port 8765. Controlled model replies
prove workflow behavior; these results do not establish real Whisper accuracy,
physical microphone/speaker behavior, or new Qwen benchmark accuracy.
