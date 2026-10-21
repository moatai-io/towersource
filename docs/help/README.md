# Help documentation maintenance

The in-app Help Panel requests localized topics with `?lang=en` or `?lang=ko`.

## Canonical language sources

- `docs/help/en/` — canonical English help
- `docs/help/ko/` — canonical Korean help

English is the default authoring language for new public OSS documentation unless a feature requires a Korean-first guide. Important user-facing changes should update both language sets. Topic IDs 05–08 have different filenames in each language: resolve links within the selected language instead of copying paths literally.

The Help Panel and `GET /api/help?lang=ko|en` discover localized Markdown topics; `GET /api/help/:slug` loads a topic. Preserve YAML frontmatter (`title`, `icon`, `order`), stable filenames, and working relative links when adding or updating topics.

## Reader paths

| Topic | Scope |
|---|---|
| index, 01 | AI teammate selection and first task |
| 02 | Sessions, follow-up instructions, progress, and continuity |
| 04 | Attachments, Project files, Viewer, delivery, and publication boundaries |
| 05 | Work records and Automations |
| 06 | Visual output and artifact formats |
| 07, 09 | Settings, permissions, Connections, and operational prerequisites |
| 08 | Shortcuts and effective requests |
| 10 | Support AI delegation, reuse, reporting, and runtime-control limits |
| 11 | Personal tasks, Secretariat, participation relationships, services, and experimental voice |
| 03 | Retired internal Channels transition page; not a current usage tutorial |

## Evidence and verification

Start with `docs/index.md`, the owning architecture contract or module README, current UI entry points, backend implementation, and relevant tests. Distinguish accepted direction, observed implementation, executed checks, and live verification. A source file or proposed architecture is not proof of deployment or user availability.

Useful current evidence paths include:

- AI teammate entry and workspace: `packages/frontend/src/components/agents/README.md`, `features/agent-directory/`, and `components/files/ProjectHome.tsx`.
- Support AI: `packages/backend/mcp/agent-worker-server.ts`, `packages/backend/services/agent-workers.ts`, `packages/frontend/src/components/agents/AgentsPanel.tsx`, and `features/agent-sessions/README.md`.
- Retired Channels: `components/rooms/RetiredChannelNotice.tsx`, `InternalChannelRetirement.source.test.ts`, and backend internal-channel write retirement tests.
- File delivery: `packages/frontend/src/features/file-exchange/README.md` and `packages/backend/services/file-exchange/README.md`.
- Personal assistance and participation: frontend `features/secretariat/README.md` and `features/team-connections/README.md`.
- Voice availability: `packages/frontend/src/config/voice-feature.ts`; development Voice Lab visibility is not ordinary-user availability.
- Keyboard bindings: `packages/frontend/src/stores/shortcut-store.ts` and `docs/architecture/keyboard-shortcuts.md`.
- Help loading and display: `packages/backend/routes/api.ts` and `packages/frontend/src/components/help/HelpPanel.tsx`.

Paths beginning with `features/` or `components/` above are relative to `packages/frontend/src/`. Check exact ownership rather than inventing a README for every directory.

For a refresh, check localized topic metadata and links, language topic coverage, retired workflow recommendations, and the diff for unrelated or private material. Run applicable existing regression tests. Browser navigation, rendered help, provider-backed features, and deployment must be verified separately before claiming live readiness.

## Documentation rules

1. Describe the public product, not private fleet or customer operations. Keep examples synthetic and credentials out of files.
2. Use current terms: AI teammate, Project, Session, Files, Viewer, Work, Automations, Skills, and Connections. Describe legacy Runtime Box identifiers through the current execution terminology contract; do not infer OS isolation from a name.
3. Preserve historical evidence without presenting retired procedures as current instructions. Retirement does not prove deletion of old data or retirement of unrelated external integrations.
4. Distinguish temporary attachments, permanent Project storage, Personal Space copies, file exchange, shared snapshots, and published sites. A path or directory card is not an access grant.
5. Explain role, installation, experimental flags, and Connection prerequisites. Pause of a support AI refuses later requests; it does not itself abort a running engine.
6. Keep support AI briefs self-contained. Accept prerequisite evidence before implementation or dependent validation, assign edit ownership, and integrate reports against the final diff. Do not change investigators' source documents unnoticed while their review is active.
7. Link to `INSTALL.md` and `docs/tower-guide/architecture.md` rather than duplicating installation or architecture contracts.

## Root-level compatibility files

Files such as `docs/help/01-getting-started.md` are legacy compatibility copies, not localized authoring sources. Do not add a third independent version. Leave them unchanged unless a known compatibility consumer needs an update; use a clear historical notice for retired UI when appropriate. Existing Git history preserves previous localized text.

## AI guide and organizational ownership

The `tower-intro` Skill's handbook is a separate AI-answering source, not the in-app Help canonical tree. Its registry may resolve to an organization-owned Project. Read the registry before locating assets; do not edit generated `.tower/skills` or `.tower/skill-assets` copies, or silently mutate another Project. Align the organizational source through an explicitly scoped handoff and then verify its materialization. Help edits alone do not refresh that handbook.

## Runtime guides

`docs/tower-guide/resources/` contains runtime-guide contracts loaded and packaged by backend code. These are not localized Help topics. Renaming or moving them requires coordinated code and test changes.

## In-app navigation contract

`HelpPanel.tsx` maps local `./<slug>.md` links to panel topic selection without leaving the app. Language changes resolve the same numeric topic ID against the destination topic list (05–08 have different localized filenames), falling back to the first topic. Topic and content failures show a retry action; obsolete responses are ignored after language/topic changes. Non-topic links retain ordinary browser navigation.

Behavior coverage: `packages/frontend/src/components/help/HelpPanel.test.tsx`. The topic endpoint returns JSON, while `/api/help/:slug` returns plain text with frontmatter removed; browser fixtures must preserve this difference.
