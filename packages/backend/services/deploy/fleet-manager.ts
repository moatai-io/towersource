/**
 * Fleet Manager — Managed service self-hosted server operations
 *
 * Reads customer registry from docs/customer-servers.md, SSHs into VMs to collect status.
 * Admin-only functionality for Moat AI internal use.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../../config.js';

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────

export interface CustomerInfo {
  name: string;
  profile: string;
  ssh: string;
  domain: string;
  team_name?: string;
}

export interface VMStatus {
  customer: string;
  domain: string;
  team_name: string;
  profile: string;
  ssh: string;
  reachable: boolean;
  pm2?: { name: string; status: string; cpu: string; memory: string; uptime: string };
  disk?: { total: string; used: string; avail: string; pct: string };
  memory?: { total: string; used: string; free: string };
  load?: string;
  git_rev?: string;
  git_date?: string;
  port_listening?: boolean;
  ssl_expires?: string;
  skill_count?: number;
  project_count?: number;
  workspace_ok?: boolean;
  error?: string;
}

export interface WorkspaceCheck {
  customer: string;
  root: Record<string, boolean | string>;
  projects: Array<{
    name: string;
    agents_md: boolean | string; // true, false, or 'template-only'
    legacy_claude_md: boolean;
    project_dir: boolean;
    progress_md: boolean;
    decisions_dir: boolean;
  }>;
  fixes_applied?: string[];
}

// ── Customer registry reader ─────────────────────────────────────

const CUSTOMER_SERVERS_MD = path.resolve(process.cwd(), 'docs/customer-servers.md');

/** Parse docs/customer-servers.md's server registry table as the fleet customer source. */
export async function getCustomers(): Promise<CustomerInfo[]> {
  const markdown = await fs.readFile(CUSTOMER_SERVERS_MD, 'utf8');
  const rows = parseCustomerRegistryTable(markdown);
  return rows
    .filter(row => row.ssh && row.ssh !== '-' && !row.ssh.startsWith('—'))
    .map(row => ({
      name: row.vmName || row.customer,
      profile: inferFleetProfile(row.vmName),
      ssh: row.ssh,
      domain: stripCodeTicks(row.domain),
      team_name: row.customer,
    }));
}

interface CustomerRegistryRow {
  customer: string;
  vmName: string;
  domain: string;
  ssh: string;
}

function parseCustomerRegistryTable(markdown: string): CustomerRegistryRow[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => line.trim().startsWith('| 고객 | VM 이름 |'));
  if (start < 0) return [];

  const rows: CustomerRegistryRow[] = [];
  for (const line of lines.slice(start + 2)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) break;
    const cells = trimmed.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length < 5) continue;
    rows.push({
      customer: stripMarkdown(cells[0]),
      vmName: stripMarkdown(cells[1]),
      domain: stripCodeTicks(cells[3]),
      ssh: stripCodeTicks(cells[4]),
    });
  }
  return rows;
}

function stripMarkdown(value: string): string {
  return stripCodeTicks(value).replace(/\*\*/g, '').trim();
}

function stripCodeTicks(value: string): string {
  return value.replace(/`/g, '').trim();
}

function inferFleetProfile(vmName: string): string {
  return vmName === 'enterpriseai' ? 'full' : 'managed';
}

export async function getCustomer(name: string): Promise<CustomerInfo | null> {
  const customers = await getCustomers();
  return customers.find(c => c.name === name) || null;
}

// ── SSH helper ───────────────────────────────────────────────────

async function sshExec(target: string, command: string, timeoutMs = 15000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ssh', [
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      target,
      command,
    ], { timeout: timeoutMs });
    return stdout;
  } catch (err: any) {
    if (err.killed) throw new Error('SSH timeout');
    throw new Error(err.stderr || err.message);
  }
}

// ── Fleet Status ─────────────────────────────────────────────────

export async function getFleetStatus(): Promise<VMStatus[]> {
  const customers = await getCustomers();
  const results = await Promise.allSettled(
    customers.map(c => getVMStatus(c))
  );

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      customer: customers[i].name,
      domain: customers[i].domain,
      team_name: customers[i].team_name || '',
      profile: customers[i].profile,
      ssh: customers[i].ssh,
      reachable: false,
      error: (r.reason as Error).message,
    };
  });
}

export async function getVMStatus(info: CustomerInfo): Promise<VMStatus> {
  const result: VMStatus = {
    customer: info.name,
    domain: info.domain,
    team_name: info.team_name || '',
    profile: info.profile,
    ssh: info.ssh,
    reachable: false,
  };

  try {
    const raw = await sshExec(info.ssh, `
echo "===PM2==="
pm2 list --no-color 2>/dev/null | grep tower || echo "NO_PM2"
echo "===DISK==="
df -h / | tail -1 | awk '{print $2"|"$3"|"$4"|"$5}'
echo "===MEM==="
free -m | grep Mem | awk '{print $2"|"$3"|"$4}'
echo "===LOAD==="
cat /proc/loadavg | awk '{print $1}'
echo "===GIT==="
cd ~/tower && git log -1 --format="%h|%ci" 2>/dev/null || echo "NO_GIT"
echo "===PORT==="
ss -tlnp 2>/dev/null | grep 32364 | wc -l
echo "===SSL==="
echo | openssl s_client -connect ${info.domain}:443 -servername ${info.domain} 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || echo "SSL_ERR"
echo "===SKILLS==="
if [ -f ~/workspace/projects/shared/.tower/skills/manifest.json ]; then
  node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.env.HOME+"/workspace/projects/shared/.tower/skills/manifest.json","utf8")); console.log(Array.isArray(m.skills)?m.skills.length:0)' 2>/dev/null
elif [ -d ~/workspace/projects ]; then
  find ~/workspace/projects -path '*/.tower/skills/*/SKILL.md' -print 2>/dev/null | wc -l
else
  echo 0
fi
echo "===PROJECTS==="
ls ~/workspace/projects/ 2>/dev/null | wc -l
echo "===WORKSPACE==="
test -f ~/workspace/AGENTS.md && test -f ~/workspace/principles.md && test -d ~/workspace/guide && echo "OK" || echo "INCOMPLETE"
    `);

    result.reachable = true;

    // Parse sections
    const sections = new Map<string, string>();
    let currentKey = '';
    for (const line of raw.split('\n')) {
      const m = line.match(/^===(\w+)===$/);
      if (m) { currentKey = m[1]; sections.set(currentKey, ''); continue; }
      if (currentKey) {
        sections.set(currentKey, (sections.get(currentKey) || '') + line.trim());
      }
    }

    // PM2
    const pm2Line = sections.get('PM2') || '';
    if (pm2Line && !pm2Line.includes('NO_PM2')) {
      const cols = pm2Line.split('│').map(s => s.trim()).filter(Boolean);
      if (cols.length >= 10) {
        result.pm2 = {
          name: cols[1] || 'tower-prod',
          status: cols[9] || 'unknown',
          cpu: cols[10] || '?',
          memory: cols[11] || '?',
          uptime: cols[7] || '?',
        };
      }
    }

    // Disk
    const diskParts = (sections.get('DISK') || '').split('|');
    if (diskParts.length >= 4) {
      result.disk = { total: diskParts[0], used: diskParts[1], avail: diskParts[2], pct: diskParts[3] };
    }

    // Memory
    const memParts = (sections.get('MEM') || '').split('|');
    if (memParts.length >= 3) {
      result.memory = { total: memParts[0] + 'MB', used: memParts[1] + 'MB', free: memParts[2] + 'MB' };
    }

    // Load
    result.load = sections.get('LOAD') || '?';

    // Git
    const gitParts = (sections.get('GIT') || '').split('|');
    if (gitParts.length >= 2) {
      result.git_rev = gitParts[0];
      result.git_date = gitParts[1];
    }

    // Port
    result.port_listening = (sections.get('PORT') || '').trim() !== '0';

    // SSL
    const sslVal = (sections.get('SSL') || '').trim();
    result.ssl_expires = sslVal && !sslVal.includes('ERR') ? sslVal : undefined;

    // Skills
    result.skill_count = parseInt(sections.get('SKILLS') || '0', 10);

    // Projects
    result.project_count = parseInt(sections.get('PROJECTS') || '0', 10);

    // Workspace
    result.workspace_ok = (sections.get('WORKSPACE') || '').trim() === 'OK';

  } catch (err: any) {
    result.error = err.message;
  }

  return result;
}

// ── Workspace Check ──────────────────────────────────────────────

export async function checkWorkspace(info: CustomerInfo): Promise<WorkspaceCheck> {
  const raw = await sshExec(info.ssh, `
echo "===ROOT==="
test -f ~/workspace/AGENTS.md && echo "agents_md=true" || echo "agents_md=false"
test -f ~/workspace/CLAUDE.md && echo "legacy_claude_md=true" || echo "legacy_claude_md=false"
grep -c "{{TEAM_NAME}}" ~/workspace/AGENTS.md 2>/dev/null | xargs -I{} echo "placeholder={}"
test -f ~/workspace/principles.md && echo "principles=true" || echo "principles=false"
test -f ~/workspace/codify.md && echo "codify=true" || echo "codify=false"
test -d ~/workspace/decisions && echo "decisions=true" || echo "decisions=false"
test -d ~/workspace/docs && echo "docs=true" || echo "docs=false"
test -d ~/workspace/guide && echo "guide=true" || echo "guide=false"
ls ~/workspace/guide/ 2>/dev/null | wc -l | xargs -I{} echo "guide_files={}"
grep -c "tower-knowledge.md" ~/workspace/AGENTS.md 2>/dev/null | xargs -I{} echo "guide_ref={}"
echo "===PROJECTS==="
for dir in ~/workspace/projects/*/; do
  name=$(basename "$dir")
  agents=$(test -f "$dir/AGENTS.md" && echo "true" || echo "false")
  legacy_claude=$(test -e "$dir/CLAUDE.md" && echo "true" || echo "false")
  projdir=$(test -d "$dir/.project" && echo "true" || echo "false")
  progress=$(test -f "$dir/.project/progress.md" && echo "true" || echo "false")
  decisions=$(test -d "$dir/.project/decisions" && echo "true" || echo "false")
  template_only="false"
  if [ "$agents" = "true" ]; then
    lines=$(wc -l < "$dir/AGENTS.md")
    has_context=$(grep -c "^## Context" "$dir/AGENTS.md" 2>/dev/null || echo 0)
    if [ "$has_context" -gt 0 ] && [ "$lines" -lt 50 ]; then
      template_only="true"
    fi
  fi
  echo "$name|$agents|$template_only|$legacy_claude|$projdir|$progress|$decisions"
done
  `, 20000);

  const check: WorkspaceCheck = {
    customer: info.name,
    root: {},
    projects: [],
  };

  let section = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('===')) { section = line.replace(/=/g, '').trim(); continue; }
    if (section === 'ROOT') {
      const [key, val] = line.split('=');
      if (key && val !== undefined) check.root[key] = val === 'true' ? true : val === 'false' ? false : val;
    }
    if (section === 'PROJECTS' && line.includes('|')) {
      const [name, agents, templateOnly, legacyClaude, projdir, progress, decisions] = line.split('|');
      check.projects.push({
        name,
        agents_md: agents === 'true' ? (templateOnly === 'true' ? 'template-only' : true) : false,
        legacy_claude_md: legacyClaude === 'true',
        project_dir: projdir === 'true',
        progress_md: progress === 'true',
        decisions_dir: decisions === 'true',
      });
    }
  }

  return check;
}

// ── Remote Logs ──────────────────────────────────────────────────

export async function getLogs(info: CustomerInfo, lines = 30): Promise<string> {
  return sshExec(info.ssh, `pm2 logs tower-prod --lines ${lines} --nostream 2>&1`, 10000);
}

// ── Remote Command ───────────────────────────────────────────────

export async function remoteExec(info: CustomerInfo, command: string): Promise<string> {
  // SECURITY (TWR-03, 2026-04-28): defense-in-depth — even if a future caller
  // bypasses the route guard in api.ts, this function refuses to execute
  // when the env flag is not set. The substring blocklist below is known
  // to be trivially bypassable (extra spaces, base64, find -delete, etc.)
  // and is kept only as a last-resort guard during emergency-enable.
  if (!config.fleetExecEnabled) {
    throw new Error('Remote exec disabled. See FLEET_EXEC_ENABLED. Pending command-catalog redesign (TWR-03).');
  }
  // Safety: block dangerous commands (best-effort — known bypassable)
  const blocked = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'shutdown', 'reboot', 'halt'];
  if (blocked.some(b => command.includes(b))) {
    throw new Error('Blocked: dangerous command');
  }
  return sshExec(info.ssh, command, 30000);
}
