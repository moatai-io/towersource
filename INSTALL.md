# Installation Guide

> **2026-06 기준 기본 설치 방향: Pi-first.** 신규 Tower 설치는 `PI_ENABLED=true`, `DEFAULT_ENGINE=pi`를 기본으로 보고, Claude Code CLI는 명시적으로 legacy Claude fallback이 필요한 경우에만 설치/인증합니다. 기존 Claude 관련 절차는 호환용으로 남아 있지만 새 설치의 필수 경로가 아닙니다.

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| **Ubuntu** | 22.04+ | `lsb_release -a` |
| **Node.js** | 20+ | `node -v` |
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

## Quick Start (3 commands)

```bash
git clone https://github.com/moatai-io/towersource.git tower
cd tower
bash setup.sh
```

The setup wizard handles everything: dependencies, environment, workspace, skills, and memory hooks.

Then start:

```bash
npm run dev
# → Open http://localhost:32354
```

---

## Step-by-Step Setup

If you prefer to understand each step, or if `setup.sh` fails at any point:

### 1. System Prerequisites (Ubuntu)

```bash
# Node.js 20+ (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
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

# Configure at least one provider
# Recommended: OPENROUTER_API_KEY=sk-or-v1-...
# Or an OpenAI-compatible Responses endpoint:
# OPENAI_RESPONSES_BASE_URL=https://api.openai.com/v1
# OPENAI_RESPONSES_API_KEY=sk-...
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

> **스킬 설치**: 신규 경로는 teamskills + project `.tower/skills` materialization입니다.
> 자체 호스팅 서버 목록은 `~/workspace/projects/self-hosted-server-deploy/records/self-hosted-servers.yaml`을 사용하고,
> managed skill rollout은 `/fleet` / `/managed-skill-rollout` 경로로 실행합니다.

### 8. Start

```bash
# Development (hot reload)
npm run dev
# → Frontend: http://localhost:32354 (Vite HMR)
# → Backend:  http://localhost:32355 (tsx watch, auto-restart)

# Production (real prod instance = tower-prod on :32364)
npm install -g pm2    # one-time
npm run build
./start.sh prod-start
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

## Azure VM Deployment

If you're deploying to an Azure VM, prefer the dedicated end-to-end guide:

- `docs/azure-customer-deployment-runbook.md` — self-hosted deployment VM canonical runbook
- `docs/new-vm-install-checklist.md` — one-page checklist
- `docs/azure-prod-deployment.md`
- `scripts/azure/create-vm.sh`
- `scripts/azure/bootstrap-prod.sh`
- `scripts/azure/deploy-e2e.sh`

### Important repo-specific notes

- Real production runs as PM2 process **`tower-prod`** on **`:32364`**
- The production start command is **`./start.sh prod-start`**
- External exposure should usually be **nginx + domain + 80/443**, not direct public access to `32364`
- `ecosystem.config.cjs` contains the `tower-prod` `PUBLIC_URL`, so it must match your new domain

### Open Port in Network Security Group

```bash
# Replace <RG> and <VM> with your resource group and VM name
# Recommended: open only 80/443 publicly (plus 22 for SSH)
az vm open-port \
  --resource-group <RG> \
  --name <VM> \
  --port 80 \
  --priority 1010

az vm open-port \
  --resource-group <RG> \
  --name <VM> \
  --port 443 \
  --priority 1020
```

### End-to-end deployment example

```bash
bash scripts/azure/deploy-e2e.sh \
  --resource-group tower_self_hosted \
  --location koreacentral \
  --vm-name <customer> \
  --admin-user toweradmin \
  --size Standard_B2ms \
  --repo-url https://github.com/moatai-io/towersource.git \
  --domain <customer>.tower.example.com \
  --ssl-mode letsencrypt-wildcard \
  --certbot-email support@example.com \
  --tier managed
```

### Optional: Custom Domain with Cloudflare

1. Point your domain's DNS A record to the VM's public IP
2. Enable Cloudflare Proxy (orange cloud) for SSL
3. Ensure `PUBLIC_URL=https://your-domain.com` is reflected in both `.env` and `ecosystem.config.cjs` for `tower-prod`

### Optional: Cloudflare Quick Tunnel (temporary URL)

```bash
# Install cloudflared
curl -L --output /tmp/cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i /tmp/cloudflared.deb

# Temporary tunnel to the real prod port
cloudflared tunnel --url http://localhost:32364
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

## Server Management

### Dev PM2 instance (`tower` on `:32354`)

```bash
./start.sh start
./start.sh stop
./start.sh restart
./start.sh logs
./start.sh status
./start.sh verify
```

### Production PM2 instance (`tower-prod` on `:32364`)

```bash
./start.sh prod-start
./start.sh prod-stop
./start.sh prod-restart
./start.sh prod-logs
./start.sh prod-status
./start.sh prod-verify
```

> **Warning**: Do NOT mix `npm run dev` and `./start.sh`. They use different ports and process layouts. Pick one.

---

## Verify Installation

After starting, run these checks:

```bash
# Development instance health
curl -s http://localhost:32354/api/health

# Production instance health
curl -s http://localhost:32364/api/health

# Production WebSocket upgrade
curl -s -i --http1.1 \
  -H "Upgrade: websocket" -H "Connection: Upgrade" \
  -H "Sec-WebSocket-Key: <base64-websocket-nonce>" \
  -H "Sec-WebSocket-Version: 13" \
  http://localhost:32364/ws 2>&1 | head -3
# → Should return HTTP/1.1 101

# Pi / AI Router configured
grep -E '^(PI_ENABLED|DEFAULT_ENGINE|CLAUDE_ENABLED|TOWER_ENABLE_ARCHIVED_CLAUDE_ENGINE|OPENROUTER_|OPENAI_RESPONSES_)=' .env
```

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

# 관리형 자체 호스팅 서버인 경우 중앙 서버에서:
/fleet skills <customer> verify
# or run the materialize-managed-skills workflow for the target project.
```

### PM2 not found (production mode)

```bash
npm install -g pm2
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
