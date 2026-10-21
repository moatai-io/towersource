# AI Team application surface

`AITeamHome.tsx` owns the AI Team directory header, teammate cards, and the
explicit **Return to chat** action. `App.tsx` passes the same surface to the
shared `AppContentRouter` in desktop and mobile layouts.

## Navigation contract

- AI Team home is an application view, not a newly selected conversation.
- The close button calls the required `onClose` callback. It has a localized
  accessible name, visible label, keyboard focus indicator, and an inline icon
  hidden from assistive technology.
- `useAgentAcademy.closeAiTeamHome` changes `activeView` to `chat` and calls
  `file-store.activateChatSlot()`. This clears stale main file/system-tab
  selection without closing tabs, changing the selected session, resetting
  messages, sending a message, or opening a new session.
- With no selected session, closing returns to the normal empty chat surface.
- Creator cancellation remains separate: `closeAgentAcademy` returns from the
  creator to AI Team home. It does not dismiss AI Team.

## Team mutation review focus

`TeamManagementPanel` renders the preview as an inline, labelled review region,
not a modal dialog; it does not trap focus or make the rest of the form inert.
When a valid preview is committed, a layout effect focuses its review heading
before paint. Cancellation removes the review and returns focus to the preview
trigger. Intent expiry remains a separate passive-effect timer.

`TeamManagementPanel.test.tsx` checks heading focus during the commit, cancellation
focus restoration, mutation announcements, and preview/apply intent invalidation.

## Regression coverage

- `AITeamHome.grouping.test.tsx`: accessible close action, callback invocation,
  and no accidental teammate-home navigation.
- `AITeamWorkspace.source.test.ts`: App callback wiring and shared view ownership.
- `../../hooks/useAgentAcademy.navigation.test.tsx`: selected session/message
  preservation, stale file/system-tab dismissal without tab loss, empty-chat
  return, shared router result, and creator-cancel distinction.
- `../layout/AppContentRouter.test.tsx`: desktop/mobile surface-selection rules.

Local component/hook tests and frontend typechecking do not replace a deployed
browser check of desktop/mobile layout and keyboard navigation. No backend,
permission, character-image, or deployment behavior belongs to this change.

## Team control room (initial)

AI Team now has a Control room tab alongside the existing directory and team views. It reads explicitly registered dashboards from each visible, non-archived Project through the existing ACL-protected file API. Visual team membership never grants file access.

Registration is currently file-based and manual: a Project owner may create `dashboards/control-room.json` containing:

```json
{"version":1,"dashboards":[{"slug":"pricing-comparison","title":"Pricing comparison"}]}
```

The slug references `dashboards/<slug>/dashboard.pricing-app.json` in the same Project. No filesystem paths or external URLs are accepted in registry entries. Missing registries are empty; read/parse failures produce a partial-load warning. Nothing is registered merely by creating a pricing calculator. No customer registry was created as part of implementation.

Cards show the responsible Agent and explicitly say manual input/no automatic refresh. File modification time is not shown as data freshness. Opening a card rechecks file access through `/api/files/read` and renders the host-owned pricing component inline below the list. Closing does not change conversation state. Refresh reloads the registry, not business data.

Initial limitations: no registration UI/tool, cross-Project data grants, favorites, scheduling or live KPI templates. Registry discovery currently scans Projects sequentially; production scale and deployed-browser verification remain outstanding. Tests: `../interactive-apps/TeamDashboardControl.test.tsx`, existing AITeamHome grouping tests.

### Free-form HTML registration

Control-room entries may additionally specify `format: "html", entry: "site/index.html"`. The entry must be a single `.html` filename under `site/` in the dashboard package. It is read through the existing file ACL and rendered with HtmlPreviewSurface. Legacy entries without format still open pricing JSON. The first implementation supports self-contained HTML; relative asset loading is not guaranteed and no filesystem bypass/base URL is added. Existing HTML preview isolation is reused, not a claim of complete network-exfiltration protection. This opens the Project draft, not a deployed immutable release. Registration does not publish, grant access or start a job. Database/source scripts must stay outside the publish-only site folder.
