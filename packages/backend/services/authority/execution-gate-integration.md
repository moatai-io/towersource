# Execution Gate integration plan

The Execution Gate is useful only if it is injected at narrow, unavoidable execution choke points. It must not depend on every individual skill remembering to call it.

## Core rule

> Project members can run what the project package provides. Owners/admins control project entry, attached credentials, secret visibility, and high-impact policy.

## Required execution context

Runtime/session setup should construct a `ProjectExecutionContext` once per turn or command:

```ts
interface ProjectExecutionContext {
  userId: number;
  userRole: string;
  projectId: string;
  projectRole: 'owner' | 'member' | string;
  projectPolicy: ExecutionPolicy;
  executionSurface: 'host' | 'project-runbox' | 'operator-runbox' | 'backend';
  runtimeProfile?: string;
  credentialProfile?: string;
  availableCredentialNames?: string[];
  availableTools?: string[];
}
```

The current pure `evaluateExecutionGate()` function does not fetch DB state. A future adapter should build this context from project membership, project runtime profile, credential policies, and command/tool metadata.

## Injection points

### 1. Runbox context creation

Purpose: attach project execution policy, runtime profile, credential profile, and member role to the command context.

Mode: read-only context assembly. Do not enforce here except for missing project membership.

### 2. Tool / skill dispatcher

Purpose: classify every tool/skill execution into an action class before execution.

Examples:

| Execution | Action class |
|---|---|
| file read, status check | `read` |
| file write | `write` |
| npm/pip/apt-style project install | `install-tool` |
| command uses injected env/temp credential | `credential-use` |
| credential grant/profile mutation | `credential-admin` |
| secret value reveal | `secret-read` |
| all-project materialize / shared workspace mutation | `cross-project` |
| self-hosted server ssh/log/status/sync | `self-hosted-server` + operation kind |
| container exec/restart/logs | `container` + operation kind |
| deploy/release/restart | `deploy` |
| host/global mutation | `host-admin` |

For `self-hosted-server` and `container`, classifier also attaches `target.operation`:

- observe-only: `status`, `logs`, `list`, `inspect` → reads/diagnostics only; allowed under ops/elevated policy without confirmation
- mutating/high-impact: `exec`, `sync`, `restart`, `deploy`, `delete`, `write`, `unknown` → may change remote/project/runtime state; confirmation remains required

Known observe-only fleet scripts:

- `fleet-status.sh`
- `check-ai-capabilities.sh`
- `deploy-verify-plus.sh`
- `deploy-managed-skills.sh --diff`
- `fleet-remote-dirty-guard.sh` without `--apply`

This is the most important choke point. Individual project-local skills should not each own their own permission system.

### 3. Credential materializer

Purpose: decide whether a credential may be made available to a command and whether the request is use-only or value-reveal.

Rules:

- Credential use can be allowed for project members when the credential is attached to the project context.
- Secret value reveal remains admin/owner-oriented.
- Audit credential names/classes only, never values.

### 4. Backend mutating APIs

Purpose: replace scattered `admin` / `full` checks only where the action is really a project execution policy question.

Initial candidates:

- Runtime Box command preflight
- project credential grant/apply routes
- managed skill materialization routes/scripts if exposed through API
- self-hosted server helper APIs
- future container broker APIs

## Shadow mode first

Initial Pi tool dispatcher shadow mode is implemented in:

```text
packages/backend/services/authority/execution-gate-shadow.ts
packages/backend/engines/pi/tool-assembly.ts
```

It wraps guarded Pi tools after the existing ToolGuard, classifies each execution into an action class, evaluates the Execution Gate, and logs notable decisions. It does **not** block execution.

Do not enforce everything immediately.

Initial integration should record the gate decision without blocking:

```text
allow | deny | needs_setup | needs_confirmation
```

Shadow-mode audit should include:

- user id / role
- context project id
- project role
- action class
- target summary
- execution surface
- credential names/classes, not values
- decision
- result status

## First enforcement candidates

Enforce only high-confidence boundaries first:

1. `secret-read`
2. `credential-admin`
3. `deploy`
4. destructive/high-impact `container`
5. `host-admin`

Keep ordinary read/write/install/credential-use in observe-or-allow mode at first.

## Known bypasses to inventory

- direct host bash outside the tool/skill dispatcher
- legacy fleet scripts invoked manually
- raw ssh inside a skill if command classifier cannot see it
- `env`, `printenv`, `cat` against credential files
- raw Docker socket mount
- legacy `~/.claude` paths
- route-local `admin`/`TOWER_ROLE=full` checks that are not yet classified

The goal is not perfect enforcement on day one. The goal is to make bypasses visible, then shrink them.
