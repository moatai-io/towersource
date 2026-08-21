# Installation Guide

> **2026-06 기준 기본 설치 방향: Pi-first.** 신규 Tower 설치는 `PI_ENABLED=true`, `DEFAULT_ENGINE=pi`를 기본으로 보고, Claude Code CLI는 명시적으로 legacy Claude fallback이 필요한 경우에만 설치/인증합니다. 기존 Claude 관련 절차는 호환용으로 남아 있지만 새 설치의 필수 경로가 아닙니다.

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| **Ubuntu** | 22.04+ | `lsb_release -a` |
| **Node.js** | 22+ (installer가 자동 설치) | `node -v` |
| **Git** | any | `git --version` |
| **At least one AI engine** | Pi preferred; Claude legacy fallback optional | — |
| **Azure OpenAI / OpenRouter / OpenAI** *(Pi path)* | any provider you use | — |
| **Claude Code CLI** *(legacy Claude fallback only)* | latest | `claude --version` |
| **Anthropic API** *(legacy Claude fallback only)* | Max plan or API key | `claude auth status` |
| **PostgreSQL** | **18+ with `pg_trgm` + `pgvector`** | `psql --version` |

> **You don't need Claude to run Tower.** Tower ships with a Pi-first engine path and a legacy Claude fallback path. New installs should use **Pi-only** (`PI_ENABLED=true`, `DEFAULT_ENGINE=pi`, `CLAUDE_ENABLED=false`) unless you explicitly need Claude fallback. In Pi-only mode, skip the entire "Install Claude Code CLI" and "Authenticate Claude" steps. See [Pi-Only Install (No Claude)](#pi-only-install-no-claude) below.

> **PostgreSQL is required.** As of the SQLite → PG migration, there is a single primary database. Tower won't start without `DATABASE_URL` pointing to a live PG instance. See [PostgreSQL 18 Setup](#postgresql-18-setup-required) below.
>
> **Memory**: Development mode (`npm run dev`) needs **4GB+ RAM** (Vite HMR + tsx watch). Production mode (`npm run build` + `./start.sh`) runs fine on **2GB+**. On small VMs (e.g. Azure B2s), use production mode.

---

## Quick Start — Ubuntu Server

For a fresh Ubuntu 22.04 or 24.04 server, use the OSS installer. It provisions base build packages, Node.js 22, PostgreSQL 18 with `uuid-ossp`/`pg_trgm`/`vector`, the reproducible Nix compute closure, secure local secrets, the Tower build, nginx, systemd services, the local Project Worker bootstrap, and the curated public skill seed.

If Git is already installed:

```bash
git clone https://github.com/moatai-io/towersource.git tower
cd tower
sudo bash scripts/oss/install.sh --public-url http://YOUR_SERVER_IP
```

On a blank supported Ubuntu VM, install only `curl` and run the public bootstrap entry point. It installs Git, clones the requested public revision, and delegates to the same installer:

```bash
sudo apt-get update && sudo apt-get install -y curl ca-certificates
curl -fsSL https://raw.githubusercontent.com/moatai-io/towersource/main/scripts/oss/bootstrap.sh -o /tmp/tower-bootstrap.sh
sudo bash /tmp/tower-bootstrap.sh --public-url http://YOUR_SERVER_IP
```

Open `http://YOUR_SERVER_IP`, create the first administrator account, and choose an inference provider in the guided first-run screen. OpenRouter uses `openrouter/auto`; direct OpenAI Responses uses `gpt-5.6-terra`. Tower then creates the first AI teammate and activates the local Worker automatically.

For automatic nginx + Let's Encrypt HTTPS, point a domain at the server first:

```bash
sudo bash scripts/oss/install.sh \
  --domain tower.example.com \
  --email admin@example.com
```

Run the readiness check again at any time:

```bash
sudo bash /opt/tower/scripts/oss/doctor.sh --url http://YOUR_SERVER_IP
```

> `setup.sh` and `npm run dev` are retained for development/workstation setup. They are not the canonical single-server production install path.

---

## Manual Development Setup

The OSS installer above is the canonical production path. The following sections are for contributors who intentionally want a development checkout and need to understand individual components; do not combine these PM2/dev commands with the systemd installation.

### 1. System Prerequisites (Ubuntu)

```bash
# Node.js 22+ (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Build tools (needed for a few native deps + git)
sudo apt install -y build-essential python3 git
```

### 2. AI Engine: Pi-first by default

Tower no longer requires Claude Code CLI for a normal install. Use the Pi Agent / AI Router path first:

```bash
# Required baseline for new installs
PI_ENABLED=true
DEFAULT_ENGINE=pi
CLAUDE_ENABLED=false

# Provider credentials are entered in Tower's first-run secure setup screen.
# Default routes:
# - OpenRouter: openrouter/auto
# - Direct OpenAI Responses: gpt-5.6-terra
```

Claude Code CLI is now an **archived break-glass fallback**. Install/authenticate it only if you explicitly need to test the old Claude engine path, then set both `CLAUDE_ENABLED=true` and `TOWER_ENABLE_ARCHIVED_CLAUDE_ENGINE=true`.

### 3. Pi Agent Engine / AI Router

Tower supports multiple AI engines simultaneously. Pi Agent is built on the [Pi coding agent SDK](https://github.com/badlogic/pi-mono) and routes requests to **OpenRouter** by default or to any endpoint implementing the OpenAI Responses API.

```bash
# Add to .env:
PI_ENABLED=true

# Optional: make Pi the default engine for new sessions
# DEFAULT_ENGINE=pi

# Recommended: OpenRouter — get a key at https://openrouter.ai/keys
OPENROUTER_API_KEY=sk-or-v1-...

# Alternative: OpenAI-compatible Responses endpoint
# OPENAI_RESPONSES_BASE_URL=https://api.openai.com/v1
# OPENAI_RESPONSES_API_KEY=sk-...

# Verify that the configured provider matches the default model
npm run provider:doctor
```

#### Configure Available Models

Each VM keeps its writable model registry in `data/models.json`. `setup.sh` creates it once from `packages/backend/models.public.json`; upgrades do not overwrite it. You can also set `TOWER_MODELS_PATH` to an external config volume. Each entry picks its provider:

```json
{
  "pi": [
    { "provider": "openrouter", "modelId": "openrouter/auto", "name": "OpenRouter Auto", "badge": "OR", "enabled": true, "api": "openai-completions" },
    { "provider": "openai-responses-compatible", "modelId": "default", "name": "OpenAI-compatible Responses", "badge": "API", "enabled": true, "api": "openai-responses" }
  ]
}
```

> **How it works**: Pi engine uses whichever upstream providers you wire up — usage is metered per token or handled by your router policy. The old Claude engine is archived behind a two-flag break-glass path and is no longer part of the default install.

### 3b. Pi-Only Install (No Claude)

If you don't have an Anthropic account (or you're deploying for a customer who shouldn't share your Claude seat), Tower runs fine without Claude Code installed.

**Then in `.env`:**

```bash
# Turn archived Claude off, Pi on
CLAUDE_ENABLED=false
TOWER_ENABLE_ARCHIVED_CLAUDE_ENGINE=false
PI_ENABLED=true
DEFAULT_ENGINE=pi

# Configure at least one Pi provider (see section 3 above).
OPENROUTER_API_KEY=sk-or-v1-...

# Then verify readiness:
npm run provider:doctor
```

When `CLAUDE_ENABLED=false`:

- Login, user management, projects, folders, chat rooms, search — all work normally.
- New-session UI hides Claude models and defaults to Pi. Attempting to create a Claude session via API returns `501 Not Implemented`.
- Quick-replies (`@ai`) and `@task` run on the Pi engine automatically.
- The Claude CLI is never invoked, so no `~/.claude/.credentials.json` is needed.

### 4. Clone & Install

```bash
git clone https://github.com/moatai-io/towersource.git tower
cd tower
npm install
```

### 5. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` — at minimum, change `JWT_SECRET`:

```bash
# Auto-generate a secure secret
sed -i "s/change-me-to-a-random-secret/$(openssl rand -hex 32)/" .env
```

### 6. Initialize Workspace (optional)

```bash
# Copy workspace templates
mkdir -p ~/workspace
cp -r templates/workspace/* ~/workspace/
```

### 7. Optional legacy Claude CLI hooks

```bash
# Memory hooks (local SQLite FTS5 DB for session activity logging — separate from Tower's main PG DB)
bash memory-hooks/install.sh
```

> **스킬 설치**: 공개 installer는 검토된 기본 skill seed를 설치하고, 첫 관리자 이후 General 프로젝트의 `.tower/skills`에 자동 materialize합니다.

### 8. Start

```bash
# Development (hot reload)
npm run dev
# → Frontend: http://localhost:32354 (Vite HMR)
# → Backend:  http://localhost:32355 (tsx watch, auto-restart)

# Local production-style build for contributor testing
npm ci
npm run build
# For an actual server, return to the canonical systemd installer above.
```

---

## First Login

1. Open `http://localhost:32354` (or your domain)
2. **The first account you create becomes the admin.** There is no default password — you set it yourself.
3. Add team members via the admin panel (shield icon in header)

---

## Post-Setup Testing Checklist

After installation, walk through these steps to verify everything works:

### Step 1: Server Health

```bash
# Backend responds
curl -s http://localhost:32354/api/auth/status
# → {"authEnabled":true,"hasUsers":false}   (before first login)
# → {"authEnabled":true,"hasUsers":true}    (after first login)
```

### Step 2: Create Admin Account

Open `http://localhost:32354` in your browser. You'll see the login page.
- Enter a username and password (min 8 characters)
- Click "Sign in" → you're now the admin

### Step 3: Verify WebSocket Connection

After login, check the bottom-left status bar:
- **Green dot + "Ready"** = WebSocket connected and at least one enabled engine is available
- **Red/orange dot** = Connection issue — check the backend logs

### Step 4: Send a Test Message

Type "hello" in the chat box and press Enter.
- Tower AI should respond within a few seconds
- If you see an engine error, check `.env` provider keys and `PI_ENABLED=true` / `DEFAULT_ENGINE=pi`

### Step 4b: Test Pi Engine (if PI_ENABLED=true)

- Click the model selector in the chat header
- You should see OpenRouter models (e.g., "Sonnet 4.6 [OR]", "Gemini 3.1 Pro [OR]")
- Create a new session with a Pi model and send "hello"
- The response should stream, with cost/token info shown after each turn

### Step 5: Check the File Tree

Click the **Files** tab in the left sidebar.
- You should see your workspace directory contents
- If empty, that's normal — workspace starts with just template files

### Step 6: Create a Project

Click the **hamburger menu (☰)** → look for project options.
- Create a new project (e.g., "test-project")
- Tower auto-creates `~/workspace/projects/test-project/` with a `AGENTS.md` file
- New chats in this project will use that directory as working directory

### Step 7: Verify Git Auto-Commit

```bash
cd ~/workspace && git log --oneline -5
# → Should show "init: workspace initialized by Tower"
```

If git log shows commits, auto-commit is working. Claude's file edits will be committed automatically.

---

## How Tower Uses the File System

Understanding this prevents most confusion:

```
~/workspace/                    ← WORKSPACE_ROOT (file tree root, git repo)
├── projects/                   ← Auto-created when you make a project
│   ├── my-project/             ← Each project = a directory
│   │   ├── AGENTS.md           ← Project-specific instructions (auto-created)
│   │   └── (AI-created files)    ← AI reads/writes here
│   └── another-project/
│       └── AGENTS.md
├── decisions/                  ← Team decision records (from setup.sh)
├── docs/                       ← Process documentation
└── published/                  ← Deployed outputs
```

### Key concepts:

- **Workspace** (`WORKSPACE_ROOT`): The root directory users can browse in the Files tab. Tower initializes a git repo here on first start.
- **Projects**: Groupings of chat sessions. Each project has its own folder with a `AGENTS.md` that AI reads automatically.
- **AGENTS.md**: Instructions file that AI loads when working in a directory. Edit this to tell Claude about your project's conventions, tech stack, or rules.
- **CWD (Current Working Directory)**: Each chat session has a working directory where AI reads/writes files. For project chats, this is the project folder. For standalone chats, it defaults to `DEFAULT_CWD`.
- **Git auto-commit**: Tower can auto-commit AI/code edit flows to the workspace git repo when explicitly enabled with `GIT_AUTO_COMMIT=true`. Uploaded files are never auto-committed.

### What happens when you create a new chat:

1. If created inside a **project** → CWD = project's root directory → AI reads that project's `AGENTS.md`
2. If created as a **standalone chat** → CWD = `DEFAULT_CWD` (usually `~/workspace`) → AI reads workspace-level `AGENTS.md`
3. Claude can read/write files relative to the CWD
4. File changes are auto-committed to git (if enabled)

### Codebase projects (advanced):

If your project is a code repo outside the workspace (e.g., `~/my-app/`):
- Create a project and set the **root path** to `~/my-app/`
- Tower points Claude's CWD there instead of workspace
- AI reads `~/my-app/AGENTS.md` if it exists

---

## PostgreSQL 18 Setup (Required)

PostgreSQL is Tower's single primary database — sessions, projects, users, chat rooms, and search indexes all live in PG. `setup.sh` can provision it for you; the steps below are for manual installs or custom environments.

### Install PostgreSQL 18 + pgvector

```bash
# Add PGDG official repository
sudo apt install -y curl ca-certificates
sudo install -d /usr/share/postgresql-common/pgdg
curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
  https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list

# Install PostgreSQL 18 + pgvector
sudo apt update
sudo apt install -y postgresql-18 postgresql-18-pgvector
```

### Create Database & User

```bash
sudo -u postgres psql -p 5433 <<'SQL'
CREATE USER tower WITH PASSWORD 'your-secure-password';
CREATE DATABASE tower_chat OWNER tower;
\c tower_chat
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "vector";
SQL
```

### Configure Environment

Add to your `.env`:

```bash
DATABASE_URL=postgresql://tower:your-secure-password@127.0.0.1:5433/tower_chat
```

**Alternative: peer-auth over the Unix socket** (no password, the OS user must match the PG role). Useful on single-tenant self-hosted servers where the OS account (`toweradmin`) owns both the app and the DB:

```bash
# Create a role named after the OS user
sudo -u postgres createuser --createdb toweradmin
sudo -u postgres createdb -O toweradmin tower

# In .env — note the explicit host= for the socket directory.
# node-postgres won't pick up the socket automatically.
DATABASE_URL=postgresql://admin@localhost/tower?host=/var/run/postgresql
```

### Verify

```bash
# Check PG is running
sudo systemctl status postgresql@18-main

# Test connection
psql "postgresql://tower:your-secure-password@127.0.0.1:5433/tower_chat" -c "SELECT version();"
# → PostgreSQL 18.3 ...

# Check extensions
psql "postgresql://tower:your-secure-password@127.0.0.1:5433/tower_chat" -c "\dx"
# → pg_trgm, uuid-ossp, vector
```

Migrations run automatically on server start when `DATABASE_URL` is set.

> **Note**: PG 18 defaults to port 5433 if PG 14/16 is already installed on 5432. Check with `pg_lsclusters`.

---

## Cloud VM Networking

The installer is cloud-provider neutral. Create a supported Ubuntu 22.04 or 24.04 VM, allow inbound SSH for administration, and expose HTTP/HTTPS through your provider firewall or security group.

Recommended inbound ports:

| Port | Purpose | Public exposure |
|------|---------|-----------------|
| `22/tcp` | SSH administration | Restrict to trusted source IPs |
| `80/tcp` | HTTP and Let's Encrypt challenge | Public when using nginx |
| `443/tcp` | HTTPS | Public when using a domain |

Do not expose PostgreSQL or Tower's internal application port directly. The installer binds Tower to `127.0.0.1:32364` and exposes it through nginx.

For IP-based testing:

```bash
sudo bash scripts/oss/install.sh --public-url http://YOUR_SERVER_IP
```

For a production domain, create the DNS record first and let the installer configure nginx and Let's Encrypt:

```bash
sudo bash scripts/oss/install.sh \
  --domain tower.example.com \
  --email admin@example.com
```

---

## Environment Variables

Copy `.env.example` to `.env` and edit:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `32354` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `WORKSPACE_ROOT` | `$HOME/workspace` | Root directory for file browsing |
| `DEFAULT_CWD` | `$WORKSPACE_ROOT` | Default CWD for new sessions |
| `JWT_SECRET` | *(must change)* | JWT signing key |
| `NO_AUTH` | `false` | Set `true` to disable auth |
| `PERMISSION_MODE` | `bypassPermissions` | Claude permission level |
| `MAX_CONCURRENT_SESSIONS` | `10` | Max concurrent sessions |
| `GIT_AUTO_COMMIT` | `false` | Opt-in auto-commit for AI/code edit flows. Uploads never auto-commit. |
| `DATABASE_URL` | *(required)* | PostgreSQL connection string — the primary DB |
| `CLAUDE_PATH` | *(optional)* | Archived Claude CLI path override, only when both Claude flags are enabled |
| `CLAUDE_ENABLED` | `false` | Archived Claude engine flag; also requires `TOWER_ENABLE_ARCHIVED_CLAUDE_ENGINE=true` |
| `TOWER_ENABLE_ARCHIVED_CLAUDE_ENGINE` | `false` | Break-glass gate for the archived Claude engine |
| `PI_ENABLED` | `true` | Enable Pi Agent / AI Router engine |
| `DEFAULT_ENGINE` | `pi` | Default engine for new sessions (`pi` preferred; `claude` only for legacy fallback) |
| `OPENROUTER_API_KEY` | *(none)* | OpenRouter API key (required for Pi engine) |
| `OPENAI_API_KEY` | *(none)* | OpenAI API key (optional, for Pi with OpenAI models) |
| `PUBLIC_URL` | *(none)* | Canonical domain for share links |

---

## User Roles

| Role | Claude Permissions | File Access | Admin Panel |
|------|-------------------|-------------|-------------|
| `admin` | `bypassPermissions` | Full | Yes |
| `operator` | `bypassPermissions` | Full | No |
| `member` | `acceptEdits` | `allowed_path` only | No |
| `viewer` | `plan` (read-only) | `allowed_path` only | No |

**`allowed_path`** — restricts what files a user (and their Claude sessions) can access. For example:
- `/home/user/workspace/project-a` — user can only see files in this directory
- Leave empty to use the default `WORKSPACE_ROOT`

---

## Server Management (OSS systemd install)

```bash
sudo systemctl status tower
sudo systemctl restart tower
sudo journalctl -u tower -f
sudo systemctl status tower-oss-worker-bootstrap.path
sudo systemctl status tower-workbench-worker-tower-oss-local-01.service
```

Do not start a second PM2 or Vite instance on a server installed by `scripts/oss/install.sh`. The canonical public install uses the `tower` system service, binds the application to `127.0.0.1:32364`, and exposes it through nginx.

---

## Verify Installation

```bash
# Complete readiness check (pre-admin or post-admin aware)
sudo bash /opt/tower/scripts/oss/doctor.sh --url http://YOUR_SERVER_IP

# Internal backend health
curl -fsS http://127.0.0.1:32364/api/health

# Public nginx path
curl -fsS http://YOUR_SERVER_IP/api/health
```

After the first administrator and Provider are configured, Doctor additionally verifies the local Worker, heartbeat, and General skill materialization.

---

## Troubleshooting

### `npm install` fails on a native dep

```bash
sudo apt install -y build-essential python3
npm install
```

### Port already in use

```bash
fuser -k 32354/tcp 32355/tcp
npm run dev
```

### Managed skills not loading

```bash
# Check project materialized skills
find ~/workspace/projects -path '*/.tower/skills/manifest.json' -maxdepth 5 -print

```

### File tree shows nothing / "Cannot read directory"

```bash
# Check workspace exists
ls ~/workspace/
# If missing, create it:
mkdir -p ~/workspace
# Restart the server — it will auto-initialize git
```

### Claude doesn't know about my project

Make sure your project has a `AGENTS.md` file in its root directory:

```bash
ls ~/workspace/projects/my-project/AGENTS.md
# If missing, create one:
echo "# My Project\n\nDescribe your project here." > ~/workspace/projects/my-project/AGENTS.md
```

### Pi models not showing in session

```bash
# Check PI_ENABLED is set
grep PI_ENABLED .env
# → PI_ENABLED=true

# Check OpenRouter key
grep OPENROUTER_API_KEY .env
# → Should have a value starting with sk-or-v1-

# Verify models.json is valid
node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.TOWER_MODELS_PATH || 'data/models.json','utf8')))"

# Restart server after changing .env
```

### OpenRouter 401 / Pi session fails

```bash
# Test your OpenRouter key directly
curl https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer $(grep OPENROUTER_API_KEY .env | cut -d= -f2)" \
  | head -c 200
# → Should return JSON with model list
```

### "Claude not found" or sessions fail

```bash
# Check Pi / AI Router env
grep -E '^(PI_ENABLED|DEFAULT_ENGINE|CLAUDE_ENABLED|TOWER_ENABLE_ARCHIVED_CLAUDE_ENGINE|OPENROUTER_|OPENAI_RESPONSES_)=' .env
# Archived Claude break-glass only:
# claude --version && claude auth status
```

### Zombie tsx processes

```bash
# Check for duplicate backend processes:
pgrep -fa "tsx.*backend"
# Kill extras — only one should run:
pkill -f "tsx.*backend"
npm run dev
```

### Database connection issues

```bash
# Is PG reachable?
pg_isready -d "$DATABASE_URL"

# Pool exhausted / too many connections?
psql "$DATABASE_URL" -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"

# Restart the server — it will reconnect and release idle connections.
```

---

## Backup & Restore

### Manual backup

```bash
bash scripts/backup.sh
```

`scripts/backup.sh` is the **PostgreSQL edition**. It runs `pg_dump` against `DATABASE_URL`, tars `~/workspace` and, when present, legacy `~/.claude`, and optionally pushes backup artifacts to Azure Blob when `BACKUP_TO_BLOB=1`.

### Automated (cron)

```bash
crontab -e
# Add this line:
0 3 * * * cd ~/tower && bash scripts/backup.sh >> ~/tower-backups/backup.log 2>&1
```

Keeps last 7 local days by default (`KEEP_DAYS=7`) and 30 days in Blob (`BLOB_KEEP_DAYS=30`) when enabled.

### Restore

```bash
# Stop the server (PM2: ./start.sh prod-stop)

# Restore the database:
gunzip -c backups/20260228_030000/tower-pg-*.sql.gz | psql "$DATABASE_URL"

# Restore the workspace:
tar -xzf backups/20260228_030000/workspace.tar.gz -C ~/

# Restart the server
```

---

## Security Checklist

Before going live, verify:

- [ ] `JWT_SECRET` is a random value (not the default placeholder)
- [ ] Admin password is strong
- [ ] `NO_AUTH` is **not** set to `true`
- [ ] Pi / AI Router provider key is configured; archived Claude auth only if both Claude flags are enabled
- [ ] `OPENROUTER_API_KEY` is not committed to git (if using Pi engine)
- [ ] `WORKSPACE_ROOT` points to the intended directory
- [ ] Non-admin users have `allowed_path` set appropriately
- [ ] Server is behind HTTPS (Cloudflare, nginx, or tunnel)
- [ ] Firewall allows only port 443 (HTTPS) inbound, or your chosen port
- [ ] Backup cron is running (`crontab -l`)

---

## Project Structure

```
tower/
├── packages/
│   ├── backend/      # Express + WebSocket server (TypeScript)
│   ├── frontend/     # React + Vite
│   └── shared/       # Cross-boundary types (@tower/shared)
├── memory-hooks/     # 3-layer memory system
├── templates/        # Workspace templates
├── docs/             # Architecture / operations / guides
├── scripts/          # Azure provisioning, backup, deploy
├── setup.sh          # One-step setup wizard
├── start.sh          # Production server management (PM2)
├── .env.example      # Environment template
├── ecosystem.config.cjs  # PM2 configuration
└── package.json
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18, Vite 6, Tailwind CSS 4, Zustand 5, CodeMirror |
| **Backend** | Express, WebSocket (ws), tsx watch |
| **AI** | Multi-engine: `@anthropic-ai/claude-agent-sdk` + `@mariozechner/pi-coding-agent` (OpenRouter) + local LLM (OpenAI-compat) |
| **DB** | PostgreSQL 18 + `pg_trgm` + `pgvector` (single primary DB) |
| **Auth** | JWT (bcryptjs + jsonwebtoken) |
| **Process** | PM2 (production), concurrently (dev) |

---

## Browser Automation — Runtime Box Playwright

Tower web capture uses Runtime Box `playwright-core + system Chromium` as the supported baseline. This keeps browser work project-scoped, reproducible, and aligned with the multi-user Runtime Box boundary.

`bootstrap-prod.sh` Tier 2+ installs Chromium/Playwright support. Browser automation should run through Runtime Box Playwright or first-party Tower browser tooling, not a host-level browser daemon.
