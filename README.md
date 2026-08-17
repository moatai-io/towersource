> ⚠️ **This repository is going private on 2026-04-27.**
> See [#9](https://github.com/juliuschun/tower/issues/9) for details.
> Last public commit is tagged [`v1.0-last-oss`](https://github.com/juliuschun/tower/releases/tag/v1.0-last-oss).

# Tower

> **The AI command center your whole team can share.**
> Claude Code + agents + a real file system, served as a web app — so your non-developers use it too.

[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-research_alpha-orange)]()
[![Last commit](https://img.shields.io/github/last-commit/juliuschun/tower)](https://github.com/juliuschun/tower/commits)

🌐 [English](README.md) · [한국어](README.ko.md) · [Install](INSTALL.md) · [Architecture](docs/tower-guide/architecture.md)

<p align="center">
  <img src="capture-chat.png" alt="Tower — every AI conversation, shared like Google Docs" width="720" />
</p>

The strongest organization is one where 100% of the team works with AI — not just developers, not just power users, everyone. The barrier has never been AI itself. It's the terminal, the CLI, the setup, the isolation. Tower removes that barrier.

Every conversation with AI, shared by the whole team like a Google Doc. One file system. One memory. One place where your entire company's AI work happens — visible, searchable, and building on itself.

*In production. $20K revenue in first 2 weeks.*

<p align="center">
  <img src="diagram-tower.png" alt="Tower — team members contribute, knowledge compounds, everyone benefits" width="560" />
</p>

---

## Contents

- [The Problem](#the-problem-ai-is-personal-work-is-not)
- [The Solution](#the-solution-share-ai-like-google-docs)
- [Run Any Code. No CLI Needed.](#run-any-code-no-cli-needed)
- [Channel AI & Proactive Agent](#channel-ai--proactive-agent)
- [Automations & Agent Board](#automations--agent-board)
- [Publishing & Deploy Engine](#publishing--deploy-engine)
- [Skills Create Skills](#skills-create-skills)
- [Multi-Engine AI](#multi-engine-ai)
- [How Tower Differs](#how-tower-differs)
- [Tech Stack](#tech-stack)
- [Changelog](#changelog)
- [Get Started](#get-started)
- [Status & Roadmap](#status--roadmap)

---

## The Problem: AI Is Personal. Work Is Not.

ChatGPT. Claude Code. Copilot. They're all powerful — and they're all trapped on one person's screen.

- Conversations scatter across individual accounts
- What AI learns in one session dies when the session ends
- The same questions get asked over and over by different people
- Non-developers can't even get past the terminal

Even Claude Code — the most capable coding agent — lives in a single terminal. One person benefits. The team doesn't.

You can hand everyone an AI subscription. That doesn't make you an AI-augmented organization. It makes you a collection of individuals using AI alone.

---

## The Solution: Share AI Like Google Docs

### Shared Conversations

Every AI conversation is visible to the team. Who asked what. What AI answered. What decisions were made. Organized by project — your company's AI work at a glance.

No more "what did Claude say about that?" — just look. Any session can be turned into a **public share link** when you want to show it outside the team.

### One File System, One Memory

One server. One shared file system. One memory that persists across people and time.

What one person teaches AI on Monday, a new hire uses on Friday. Three layers of memory — session, project, and team — so nothing learned is ever lost.

Version control happens automatically. Every change is committed, browsable, and rollbackable. It looks and feels like file management — not Git. **Zero CLI knowledge required.**

### Partitioned by Team

Marketing doesn't see engineering's code. Engineering doesn't see HR's documents. But when they need to collaborate, the walls come down.

Projects, departments, teams, individuals — partition however your organization works. Four permission levels (`admin` / `operator` / `member` / `viewer`) with folder-level isolation (`allowed_path`).

```
workspace/
├── projects/
│   ├── marketing-site/
│   │   └── AGENTS.md    ← "Brand voice is casual. Use Next.js."
│   ├── api-backend/
│   │   └── AGENTS.md    ← "Use Go. Follow company style guide."
│   └── onboarding-docs/
│       └── AGENTS.md    ← "Write for non-technical readers."
└── decisions/            ← Team decision records
```

---

## Run Any Code. No CLI Needed.

<p align="center">
  <img src="diagram-access.png" alt="Tower — messages from any device become real work" width="640" />
</p>

Tower runs on your server. AI doesn't just chat — it executes. Write code, create files, deploy apps, run analyses. The full power of a development environment, accessible through a browser.

Your marketing lead can ask AI to build a landing page. Your ops manager can automate a report. Your intern can run a data analysis. None of them need to know what a terminal is.

---

## Channel AI & Proactive Agent

Most AI tools wait for you to ask. Tower's AI lives inside the team — in the chat, in the flow of work.

- **`@ai` — resident channel partner.** Drop `@ai` in any team channel. It reads the last messages, understands the project context (`AGENTS.md`), and replies in-thread. Multi-turn, not one-shot. The team sees the exchange.
- **`@task` — hand work off.** Turn a message into a running task without leaving the channel.
- **AI Side Panel.** Private AI thread alongside any channel. The AI already has the channel's context — ask it something privately, then share the answer back when it's ready.
- **Proactive Agent.** AI initiates conversations, not just reactive Q&A. It surfaces what needs attention (failed builds, stuck tasks, upcoming deadlines) in the **Inbox** with card-based UX.
- **Session sharing.** Publish any conversation to a public link — light-mode chat UI, rendered visuals, attachments intact.

---

## Automations & Agent Board

<p align="center">
  <img src="capture-board.png" alt="Tower — Agent Board with autonomous task execution" width="720" />
</p>

**Agent Board (Kanban).** Create a task. AI executes it. Tasks create tasks. "Plan our product launch" spawns market research, competitor analysis, pricing, and timeline — each running autonomously.

**Unified Automations.** Tasks and schedules merged into one model. Run once, run on a cron, run when triggered by an event. Three modes:

- **Spawn** — new session per run (clean context)
- **Inject** — append to an existing session (keep context)
- **Channel** — post result back to a team channel

Your weekly reports, morning stand-up digests, and recurring market scans write themselves.

---

## Publishing & Deploy Engine

<p align="center">
  <img src="capture-publish.png" alt="Tower — Publishing Hub" width="720" />
</p>

**Publishing Hub.** Turn any AI-generated artifact into a live site. Drop files into `workspace/published/sites/<name>/` and they're served at `<name>.<yourdomain>` — no nginx edit, no DNS dance.

**Deploy Engine.** Code type auto-detected:

- Static sites → **Cloudflare Pages** (global CDN, ~2s deploy)
- Dynamic apps → **Azure Container Apps** (scale-to-zero, ACR build, auto-generated Dockerfile)
- One API call. Zero config. Cloudflare DNS binding is automated.

**REST API:** `POST /api/deploy`, `GET /api/deploy/list`, `DELETE /api/deploy/:type/:name`.

---

## Skills Create Skills

When AI works with your whole team — connected to one file system and one shared memory — something compounds.

A one-off task becomes a reusable skill. That skill creates another skill. Your team's AI gets better every day, automatically.

**Example:** Someone creates a quote generator → it spawns a proposal skill → which evolves into a contract skill. Each one built on the last, available to everyone.

**50+ skills ship out of the box** — brainstorming, debugging, code review, planning, UI/UX design, research, document generation, presentation decks, Google Workspace (Gmail/Calendar/Drive/Sheets), SMS, web capture, remote browser, kanban, SQL from natural language, and more.

Three scopes (company / project / personal) with a **Skills Market** UI and per-user on/off toggles. Skills that need credentials (OAuth, API keys) get a guided **Connections** flow — the team-wide credential never touches the LLM.

---

## And Also

**Mobile.** Responsive browser UI. Long-press context menus, touch-optimized scroll, auto-login for remote browser (Neko). Full server compute behind your phone.

**File Sharing.** Internal team sharing + time-limited external links. No separate file service.

**Search Everything.** Files, conversations, tasks, Git history — PostgreSQL `pg_trgm` GIN full-text search (Korean + English) across your entire AI workspace.

**Usage Dashboard.** Daily turn line chart, per-project concentration heatmap, real turn counts in sidebar. See where AI time is actually going.

**Bilingual.** Full Korean / English UI (`i18n`) with consistent terms across product.

**Fleet Management.** Operating Tower for multiple customers? One control plane manages many VMs — publishing gateway, skill profiles (`standalone` / `managed` / `full`), 2-layer backup (local + offsite Azure Blob), live connectivity UI.

---

## Multi-Engine AI

Tower isn't locked to one AI provider. The Engine abstraction layer lets you run multiple AI backends side by side:

| Engine | Provider | Billing | Models |
|--------|----------|---------|--------|
| **Claude Code** | Anthropic Agent SDK | Max subscription ($200/mo) | Opus 4.8, Sonnet, Haiku |
| **Pi Agent** | Pi SDK via OpenRouter | Pay-per-token | Any OpenRouter model: Claude, GPT, Gemini, Grok, Kimi, MiniMax… |
| **Local LLM** | OpenAI-compatible endpoint | Your hardware | Any locally-hosted model |

Switch models mid-conversation. Compare outputs across providers. Start with Claude Max, add OpenRouter models when you need them. Remove any engine by deleting one file.

Configure available models in `packages/backend/engines/pi-models.json` — no code changes needed.

---

## How Tower Differs

| | **Tower** | Claude Code CLI | OpenWebUI / LibreChat |
|---|:---:|:---:|:---:|
| Team-visible conversations | ✓ | — | partial |
| Real file system + Git auto-commit | ✓ | ✓ | — |
| Runs code / deploys apps | ✓ | ✓ | — |
| Shared memory across people | ✓ | — | — |
| Non-developers can use it | ✓ | — | ✓ |
| Channel AI (`@ai` / `@task`) | ✓ | — | — |
| Proactive agent (AI initiates) | ✓ | — | — |
| Multi-engine (Claude + Pi + Local) | ✓ | Claude only | multi-provider |
| Kanban + cron automations | ✓ | — | — |
| Publishing + deploy pipeline | ✓ | — | — |
| Self-hosted | ✓ | ✓ | ✓ |

**Short version:** OpenWebUI gives a team chat UI for LLMs. Claude Code gives one developer a terminal agent with real file access. Tower is what you get when you put the second one behind the first one — and add the team plumbing (memory, partitions, automations, publishing) on top.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 18 · TypeScript · Vite 6 · Zustand · Tailwind CSS 4 · Virtuoso |
| **Backend** | Express · TypeScript · WebSocket · PM2 |
| **Storage** | PostgreSQL 18 (single primary DB) · `pg_trgm` GIN indexes for search · `pgvector` for embeddings |
| **AI Engines** | `@anthropic-ai/claude-agent-sdk` (Opus 4.8) · `@mariozechner/pi-coding-agent` via OpenRouter · local LLM via OpenAI-compat endpoint · MCP protocol · 50+ skills |
| **Auth** | JWT · bcrypt · Role-based (`admin` / `operator` / `member` / `viewer`) · folder-level `allowed_path` |
| **Monorepo** | `packages/backend` · `packages/frontend` · `packages/shared` |

---

## Changelog

### 4/20 — Task Agent Guardrails + Channel AI Polish
- **Channel AI carries project context** — `@ai` in a team chat sees the project's `AGENTS.md` and recent messages automatically
- **Auto-named AI threads** — the first turn picks a readable name
- **Task agent inherits team discipline** — architecture checks, decision-log, and commit rules injected into every task
- **Unified CWD → project mapping** — tasks and sessions always surface their working directory
- **Project create dedup** — rapid submit no longer creates duplicate folders

### 4/17–18 — Opus 4.7, Channel AI 2.0, Prefix Caching, Self-hosted VM Infra
- **Claude Opus 4.7** upgrade with effort pipeline (low / med / high reasoning budget)
- **`@ai` becomes a resident channel partner** — multi-turn threads instead of one-shot replies
- **System-prompt prefix caching** — split prompt for Anthropic cache; room context moved to user prompt
- **Richer visuals in chat** — inline `svg` block + `html-sandbox` (JSON / aspect modes), Linear-style Mermaid redesign
- **Session-scoped write guard** — AI can't create orphan project folders
- **Neko remote browser auto-install** for self-hosted VMs, gateway status endpoint, live fleet UI
- **2-layer backup architecture** — local snapshots + offsite Azure Blob (own server + self-hosted VMs)
- **Skill library single-source** — manifest-driven reconciliation, legacy `install-skills.sh` removed

### 4/13–15 — Automations, Fleet, Shared Sessions, i18n
- **Automations system** — tasks and schedules unified into one model (`spawn` / `inject` / `channel` modes)
- **Unified Kanban** — 2-column layout with schedule integration, AM/PM picker, visible run button
- **Session sharing** — shareable public link, light-mode chat UI, HTML rendering, attachments preserved
- **Fleet management** — manage multiple self-hosted servers from one control plane + publishing gateway
- **Cloudflare DNS automation** — one command binds a subdomain to a published site
- **Korean / English bilingual UI** — full i18n with consistent terms (Inbox = 완료, Task = 태스크)
- **Skill credentials + Connections UI** — Google OAuth for gmail/gws skills, Skill Readiness view
- **Tower Guide wiki** — in-repo architecture · skills · visual formats · operations docs

### 4/10–12 — Proactive Agent, Usage Dashboard, Realtime
- **Proactive Agent** — AI initiates conversations, Bell → Inbox flow, card-based UX
- **Usage dashboard** — daily turn line chart, per-project concentration heatmap, real turn counts in sidebar
- **Local LLM engine** — third engine alongside Claude and Pi
- **Session-scoped model selector** — picking a model only affects that session
- **Realtime sync** — WS event handlers for project / room / session / notification fan-out
- **PPTX preview** via LibreOffice → PDF (safer than client-side rendering)

### 4/6 — Deploy Engine
- Auto-detect code type (static vs dynamic) and deploy to the right platform
- Static sites → Cloudflare Pages (global CDN, ~2s deploy)
- Dynamic apps → Azure Container Apps (scale-to-zero, ACR build, auto Dockerfile)
- REST API: `POST /api/deploy`, `GET /api/deploy/list`, `DELETE /api/deploy/:type/:name`
- Manifest schema extended with `deploy_target`, `external_url`, `last_deployed_at`

### 3/17 — AI Side Panel & Unified Visibility
- AI Side Panel for channels — private AI threads alongside team chat
- Channel context injection — AI reads recent 30 messages automatically
- Share-to-channel — post AI answers back to the team
- Unified visibility model — `private` / `project` session scoping

### 3/16 — Monorepo + Channel AI (`@ai` / `@task`)
- `packages/backend`, `packages/frontend`, `packages/shared` structure with `@tower/shared`
- `@ai` inline quick reply and `@task` full task execution from channels
- Admin default model config per context (`session` / `ai_reply` / `ai_task`)

### 3/14–15 — Multi-Engine Architecture + 3-Tier Skills
- Engine abstraction (Claude + Pi) — Pi Agent SDK via OpenRouter, any model
- DB-backed skill management (company / project / personal scope) + Skills Market UI
- Pi models configurable via `pi-models.json`; hot-swap within a session

### 3/13 — Dynamic Visual
- Mermaid · charts (Recharts) · KaTeX · datatable · timeline · treemap · mindmap · gallery · diff · terminal · comparison
- `RichContent` component with code-split lazy loading

### Earlier
- **SQLite → PostgreSQL full migration** — single primary DB; `better-sqlite3` dependency removed
- Agent Board (Kanban) with autonomous task execution
- File sharing (internal + external links)
- Full-text search (`pg_trgm` GIN indexes for Korean + English)
- Publishing Hub — one-click deploy from AI artifacts
- Git auto-commit + browsable history
- Role-based auth with folder-level `allowed_path`

---

## Get Started

```bash
git clone https://github.com/juliuschun/tower.git
cd tower
bash setup.sh    # installs everything, asks you a few questions
npm run dev      # → http://localhost:32354
```

See **[INSTALL.md](INSTALL.md)** for details — Ubuntu prerequisites, Claude CLI auth, Pi/OpenRouter setup, PostgreSQL 18, Azure VM deployment, Cloudflare tunnel, troubleshooting, and security checklist.

---

## Status & Roadmap

### Status: Research Alpha

We use this every day in production. It works — and it's not finished.

Some features are still rough around the edges. New capabilities ship continuously. This is an active research project building toward a clear destination: **100% AI-augmented teams.**

### Roadmap (near-term)

- **Multi-user workspace isolation (Phase 8)** — full per-user sandboxing on the backend
- **SSO / SAML** for enterprise directories
- **Heartbeat Phase 2** — persisted cost dashboard, @-mention notifications, alert rules
- **Team-level memory** — explicit team-scope layer on top of session/project memory
- **Native mobile shell** (under consideration)

Feedback and contributions are welcome — [open an issue](https://github.com/juliuschun/tower/issues) or submit a PR.

## License

[Apache License 2.0](LICENSE)
