# Chat dictation (input only)

Chat dictation is separate from conversational voice: it does not start a LiveKit room, run an assistant turn, synthesize speech, or automatically send a message. Existing conversation routes remain unchanged.

## HTTP contract

`POST /api/sessions/:sessionId/dictation` requires normal Tower authentication and session access. Multipart upload contains one `audio` file (maximum 15 MiB; WebM, MP4, Ogg, WAV). Uploads are buffered in memory, not saved to project storage. Browser recording stops after 120 seconds. Provider request times out after 60 seconds.

The backend resolves the current project's Gateway Profile catalog entry `speech-to-text` using existing Vault authorization. Its route prefix must address a multipart transcription endpoint accepting `file` and `language=ko`, returning `{ "text": "..." }`. The gateway owns provider/model selection and request adaptation. No fallback to direct provider credentials is performed. Upstream responses and credentials are not exposed in errors.

This source change does **not** create or enable the catalog entry, change Zuplo routes, select a provider, or configure upstream retention. Those external changes require approval. Without the entry and working route, transcription returns a generic 503.

## Client behavior

Microphone access requires browser permission and a secure context. The input composer displays an analyser-backed waveform, elapsed time, stop and cancel controls. Stop transcribes and appends to the current draft; cancel discards audio/results. Component unmount/session change stops microphone tracks, closes AudioContext, cancels animation, and aborts pending fetch. Existing text is preserved and the user explicitly sends the final message.

## Evidence and remaining validation

- Backend TypeScript check passed.
- InputBox tests: 41 passed, 9 skipped.
- DictationButton initial-state/unsupported-browser tests: 2 passed.
- Full frontend typecheck is blocked by an unrelated AgentDirectory avatar prop error.
- Real browser microphone/codec behavior, recording/cancellation race cases, gateway integration, provider Korean recognition accuracy, concurrent memory pressure, and end-to-end tests are not yet verified. Not deployed.

Code: `packages/backend/routes/dictation-api.ts`, `packages/frontend/src/components/chat/DictationButton.tsx`, `InputBox.tsx`.
