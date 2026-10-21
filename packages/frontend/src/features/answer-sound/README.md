# Answer completion sound

Opt-in, browser-local preference scoped by the signed-in account ID. Notification settings enable the preference and play a user-gesture preview to unlock browser audio. No server preference or audio network resource is required.

`useChatRuntime` invokes `notifyAnswerCompleted` only for completed root-turn terminal facts, before active-session filtering. Both direct and wrapped terminal envelopes are supported; invocation/engine completion, stop, retry and failure do not chime. Valid live `ask_user` events also call `notifyQuestionRequired` before active-session filtering. Question IDs and root-turn IDs use separate deduplication namespaces; reconnect snapshot restoration does not chime. Session/root-turn and session/question pairs are deduplicated in a bounded in-memory set; completions within 1.5 seconds coalesce. Reload resets that set. Browser autoplay restrictions, closed tabs, OS mute and suspended tabs can prevent playback. Multiple open Tower tabs may each play a sound; cross-tab leader election is not included.

Implementation: `answer-sound.ts`, `../../hooks/useChatRuntime.ts`, `../../components/notifications/NotificationSettingsPanel.tsx`.
Regression coverage: `answer-sound.test.ts`. Automated tests do not establish live browser audibility.

Preview playback now schedules the tones synchronously in the user's click gesture before
awaiting AudioContext.resume(), supports the legacy webkitAudioContext constructor, and
recreates a closed context. The settings panel includes a separate preview button and
reports rejected/unsupported playback instead of silently failing. A running context does
not establish physical audibility: OS mute and output routing still require a live check.

## Selectable sound profiles

Settings → Notifications provides glass (default), marimba, piano, and bloom.
The browser/account-local `tower:answer-sound:<userId>:style` preference is separate
from the enabled preference: choosing a sound previews it but does not enable alerts.
Missing or unknown style values resolve to glass; explicit sound-off choices remain off.
All four profiles use local Web Audio synthesis and release their nodes after playback.
The comparison WAVs include stereo echoes and peak normalization; runtime synthesis uses
the same notes/partials/envelope shape without those audition-only mastering effects.
Tests cover style fallback/account isolation and the default glass scheduling.

Event chimes are suppressed when the exact session is visibly focused. Web Locks
serialize cross-tab playback with an account-local recent-event marker; without Web
Locks the storage check is best-effort. Preview buttons deliberately bypass this filter.
OS notification sounds are controlled separately by the browser/OS.
