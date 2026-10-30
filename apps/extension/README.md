# Piko Chrome extension

The primary side panel is the guided voice form assistant. It asks one question
at a time, reads back the interpreted answer, waits for confirmation, fills that
exact field through the existing native engine, and continues. Submission is manual.

Build from the repository root with `npm run build`, then load or reload
`apps/extension/dist` in Chrome. Voice runs through the local companion; run
`npm run setup:voice` once and `npm run dev:service` to start it.

See [the setup guide](../../README.md) and
[the guided workflow](../../docs/voice-workflow.md) for permissions, testing and recovery.

Production permissions remain `sidePanel`, `activeTab`, `scripting`, `storage`,
and the single loopback host. The dedicated microphone permission page is bundled
with the extension. No cloud or permanent answer-profile feature is added.
