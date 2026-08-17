---
name: design-explore
description: |
  Explore design spaces by discovering problem-specific tensions and generating competing proposals from different perspectives.
  Use when facing architectural decisions, API design, data modeling, UX choices, or strategic questions where you need
  genuinely different approaches — not variations of the same middle-ground.
context: fork
agent: general-purpose
allowed-tools: Bash, Read, Write, Edit, Glob, WebSearch, WebFetch, Skill
argument-hint: "\"design problem\" [--perspectives N] [--save] [--auto]"
---

# Design Explore: Tension-Driven Design Divergence

Discover problem-specific tensions, generate competing proposals from different perspectives, compare side-by-side.

## Usage

```
/design-explore "design problem"                     # 3 perspectives, inline output
/design-explore "problem" --perspectives 4           # 4 perspectives
/design-explore "problem" --save                     # Save to docs/design-explorations/
/design-explore "problem" --auto                     # No confirmation (default behavior)
```

### Host Agent

Any agent (Claude, Codex, Gemini) can invoke `/design-explore`. The invoking agent becomes the **host** and coordinates all three phases.

---

## Protocol: DISCOVER → DIVERGE → COMPARE

### Phase 1: DISCOVER (Perspective Discovery)

The core differentiator. Problem-specific tensions generate non-obvious perspectives.

1. Read the problem statement from `$ARGUMENTS`
2. Parse optional flags: `--perspectives N` (default 3), `--save`, `--auto`
3. **Extract inherent tensions** using patterns from [perspectives.md](./perspectives.md):
   - Scan for **constraint pairs**: nouns/adjectives that imply trade-offs (e.g., "multi-tenant" → isolation ↔ efficiency)
   - Scan for **stakeholder conflicts**: groups with opposing needs (e.g., "platform" → platform team ↔ app developers)
   - Scan for **temporal tensions**: short-term vs long-term in this context (e.g., "MVP" → ship fast ↔ build foundations)
   - Identify 2-4 tensions
4. **Generate perspectives as tension resolutions**: Each perspective is a coherent design philosophy that resolves the discovered tensions in a specific direction. Name each with a descriptive thesis — "Isolation-Maximalist: each tenant gets its own auth domain" not "Option A"
5. If tension analysis yields fewer than N perspectives, supplement from fallback defaults in [perspectives.md](./perspectives.md)
6. Classify problem domain via signal words (see [Domain Classification](#domain-classification)) for output format adaptation
7. Present discovered tensions and generated perspectives briefly before proceeding. If problem is too vague, ask ONE clarifying question.

> **Worked example**:
> Problem: "How should we structure the authentication service for a multi-tenant SaaS platform?"
> Tensions: tenant-isolation ↔ resource-efficiency, security-rigor ↔ onboarding-friction, per-tenant-customization ↔ operational-simplicity
> Perspectives: Isolation-Maximalist (dedicated auth domain per tenant), Shared-Core (single service with tenant-scoped policies), Tenant-Sovereign (tenants bring own IdP, platform federates)

---

### Phase 2: DIVERGE (Parallel Generation)

Dispatch perspectives to available agents. Each produces a complete strawman.

#### Agent Dispatch Logic (Adaptive)

The host generates one perspective directly and dispatches others to available external agents via CLI.

| Host | Self | Invoke Codex | Invoke Gemini |
|------|------|--------------|---------------|
| Claude | Generates 1 perspective directly | `codex exec ...` via Bash | `gemini ... -p ...` via Bash |
| Codex | Generates 1-2 perspectives directly | N/A (you ARE Codex) | `gemini ... -p ...` via Bash |
| Gemini | Generates 1-2 perspectives directly | `codex exec ...` via Bash | N/A (you ARE Gemini) |

**Dispatch rules**:
- **3 agents reachable** (Claude as host): 1 perspective each to host, Codex, Gemini — invoke all in parallel
- **2 agents reachable** (Codex or Gemini as host): host takes 2 perspectives (with mode-separation preamble between them), dispatches 1 to the other agent — parallel
- **Host only** (no external CLIs installed): host generates all perspectives sequentially with mode-separation preambles between each
- **N > available agents**: When `--perspectives N` exceeds available agents, the host absorbs additional perspectives with mode-separation between each

**Note**: There is no `claude` CLI. When Codex or Gemini is the host, Claude's share is absorbed by the host — apply the mode-separation preamble between the host's own perspectives to maintain divergence.

#### Agent Strength Matching

| Agent | Strength | Best-fit perspectives |
|-------|----------|----------------------|
| Claude | Nuanced reasoning, philosophical depth | Perspectives emphasizing elegance, human factors, simplicity |
| Codex (GPT-5.2) | Technical precision, systematic analysis | Perspectives emphasizing performance, rigor, normalization |
| Gemini (3.1 Pro) | Broad knowledge, web-aware | Perspectives emphasizing ecosystem, evolution, extensibility |

Assign perspectives to agents based on this heuristic. When in doubt, assign the most technically precise perspective to Codex and the most ecosystem-aware to Gemini. When the host absorbs another agent's perspective, still match that perspective's character — the mode-separation preamble helps the host shift stance.

#### Invoking Other Agents

Invoke external agents via Bash tool (NOT via `/codex` or `/gemini` skills — to stay in current fork context). Always write to a unique response file, then read it.

**Codex CLI** (from Claude or Gemini as host):
```bash
mkdir -p work/design-explore && \
RESPONSE_FILE="work/design-explore/codex-response-$(uuidgen).md" && \
codex exec --skip-git-repo-check -m gpt-5.2 -c model_reasoning_effort=high -s read-only \
  -o "$RESPONSE_FILE" "PROMPT" > /dev/null && echo "$RESPONSE_FILE"
```

**Gemini CLI** (from Claude or Codex as host):
```bash
mkdir -p work/design-explore && \
RESPONSE_FILE="work/design-explore/gemini-response-$(uuidgen).md" && \
gemini -m gemini-3.1-pro-preview -p "PROMPT" > "$RESPONSE_FILE" && echo "$RESPONSE_FILE"
```

Then read the response file with Read tool. If the CLI is not installed, host generates that perspective itself with mode-separation preamble.

#### Anti-Convergence Instruction

Append this exact text to every agent prompt (do not paraphrase):

```
You are arguing FOR [Perspective Name]: [thesis]. Do not hedge. Do not present
a balanced view. Commit fully to this direction. Acknowledge weaknesses ONLY
in a "Known Risks" section, and propose mitigations from within your perspective.
Before finishing, verify: does this proposal genuinely differ from a reasonable
default? If it sounds like a safe middle ground, push further into your
perspective's extreme.
```

#### Strawman Output Format

Include in every agent prompt:

```markdown
## [Perspective Name]
**Thesis**: [one sentence — what this approach is and why it wins]

### Design
[Domain-appropriate sketch — C4 components / API surface / schema / user flow / etc.]

### Key Decisions
- [Decision 1 + rationale from this perspective]
- [Decision 2 + rationale]
- [Decision 3 + rationale]

### Known Risks
- [Risk → mitigation from within this perspective]

### Best When / Worst When
- Best: [conditions where this approach shines]
- Worst: [conditions where this approach struggles]
```

#### Mode Separation (Host Sequential)

When the host generates multiple perspectives sequentially (because external agents are unavailable, or because the host absorbed another agent's share), insert this preamble before each:

```
--- PERSPECTIVE SHIFT ---
Completely abandon the previous perspective. You are now a different designer
with a different philosophy. The previous approach is not your starting point;
your tensions resolve in a fundamentally different direction.
```

---

### Phase 3: COMPARE (Structured Comparison)

After all strawmans are generated, produce a comparison. Output is inline in conversation by default.

#### Comparison Structure

1. **At a Glance**

   | Perspective | Thesis | Core Bet |
   |-------------|--------|----------|
   | [Name] | [one sentence] | [what it optimizes for] |

2. **Dimension Matrix**: Each discovered tension becomes a comparison dimension. Show how each strawman resolves each tension.

   | Tension | [Perspective A] | [Perspective B] | [Perspective C] |
   |---------|-----------------|-----------------|-----------------|
   | [tension 1] | [resolution] | [resolution] | [resolution] |

3. **Conditional Guidance**: One line per tension. Do NOT recommend a single winner.

   - If you prioritize **[tension side X]** → **[Perspective A]** — because [reason]
   - If you prioritize **[tension side Y]** → **[Perspective B]** — because [reason]

4. **Tension Map**: Narrative showing key trade-offs between approaches — where choosing one approach necessarily sacrifices something another provides.

#### Save Option

If `--save`: Write full output (all strawmans + comparison) to `docs/design-explorations/[YYYY-MM-DD-problem-slug].md`

---

## Domain Classification

Signal-word detection for design sketch format adaptation. No confirmation needed — auto-classify from problem statement.

| Domain | Signal Words | Design Sketch Format |
|--------|-------------|---------------------|
| architecture | microservice, component, deployment, scaling, infrastructure, service, monolith | C4-style component diagram (text) |
| api | endpoint, REST, GraphQL, request, response, versioning, route, contract | Interface definition + example requests/responses |
| data-model | schema, entity, relationship, index, migration, table, field, query | Entity descriptions + access patterns |
| ux | user flow, wireframe, interaction, navigation, screen, modal, form | User journey steps + state transitions |
| process | workflow, pipeline, CI/CD, approval, automation, review, deploy | Step sequence + decision points |
| strategy | roadmap, build-vs-buy, migration, positioning, pricing, market | Scenario description + timeline |

If signals span multiple domains, use the primary domain for sketch format and note the secondary.

---

## Error Handling

| Scenario | Handling |
|----------|---------|
| Codex CLI not installed | Host generates that perspective sequentially; note in output |
| Gemini CLI not installed | Host generates that perspective sequentially; note in output |
| External agent produces off-topic output | Log warning, host generates replacement |
| Problem too vague for tension analysis | Ask ONE clarifying question, then proceed |
| Fewer than 2 tensions found | Supplement with domain fallback perspectives from [perspectives.md](./perspectives.md) |
| Agent timeout (>120s) | Proceed with available results; host generates missing perspectives |
| Host cannot invoke Claude (Codex/Gemini host) | Host absorbs Claude's perspective; use mode-separation preamble between host's own perspectives |

---

## Examples

### Full Flow: Authentication Service Design

```
/design-explore "How should we structure the authentication service for a multi-tenant SaaS platform?"
```

**Phase 1 output** (DISCOVER):

```
## Tensions Discovered

1. **tenant-isolation ↔ resource-efficiency**: Dedicated resources per tenant vs shared infrastructure
2. **security-rigor ↔ onboarding-friction**: Strict auth policies vs frictionless first experience
3. **per-tenant-customization ↔ operational-simplicity**: Custom auth flows per tenant vs uniform operations

## Perspectives Generated

1. **Isolation-Maximalist**: Each tenant gets its own auth domain, identity provider, and token namespace
2. **Shared-Core**: Single authentication service with tenant-scoped policies and token claims
3. **Tenant-Sovereign**: Tenants bring their own IdP; platform federates via SAML/OIDC

Domain: architecture → C4-style component diagrams
Agents (Claude as host): Claude (Shared-Core), Codex (Isolation-Maximalist), Gemini (Tenant-Sovereign)
Agents (Codex as host): Codex (Shared-Core + Isolation-Maximalist), Gemini (Tenant-Sovereign)
Agents (Gemini as host): Gemini (Shared-Core + Tenant-Sovereign), Codex (Isolation-Maximalist)
```

**Phase 2** (DIVERGE): Each agent generates its strawman with full design sketch, key decisions, known risks, and best/worst conditions.

**Phase 3 output** (COMPARE):

```
## At a Glance

| Perspective | Thesis | Core Bet |
|-------------|--------|----------|
| Isolation-Maximalist | Blast radius is everything; pay the ops cost | Security boundaries |
| Shared-Core | One service to rule them all; tenant context is just claims | Operational simplicity |
| Tenant-Sovereign | Let tenants own their identity; platform just federates | Tenant autonomy |

## Dimension Matrix

| Tension | Isolation-Maximalist | Shared-Core | Tenant-Sovereign |
|---------|---------------------|-------------|------------------|
| isolation ↔ efficiency | Full isolation, high cost | Logical isolation, efficient | Delegation to tenant |
| security ↔ friction | Maximum security, slower onboard | Balanced | Depends on tenant's IdP |
| customization ↔ simplicity | Per-tenant everything | Policy-driven variation | Tenant controls, platform simplifies |

## Conditional Guidance

- If you prioritize **blast-radius containment** → Isolation-Maximalist — because a breach in one tenant can never affect another
- If you prioritize **operational simplicity** → Shared-Core — because one service is easier to monitor, patch, and scale
- If you prioritize **enterprise sales** → Tenant-Sovereign — because large customers already have IdPs and won't adopt yours
```

### Host-Only Flow (No External Agents)

```
/design-explore "How should we design the plugin system for our CLI tool?" --perspectives 3
```

When external agents are unavailable (e.g., CLIs not installed), the host generates all three perspectives sequentially with mode-separation preambles. This works from any host — Claude, Codex, or Gemini. The anti-convergence instruction ensures each perspective commits fully to its direction rather than hedging toward middle ground.

---

## Testing

### Test Pack

| Type | JTBD | Purpose |
|------|------|---------|
| Primary | "Design auth for multi-tenant SaaS" | Core tension discovery + multi-agent divergence |
| Edge | "Improve the app" (vague problem) | Should ask ONE clarifying question |
| Edge | Claude-only (no Codex/Gemini) | Graceful degradation with mode separation |
| Baseline | Same problem without skill vs with skill | Perspective novelty + structural divergence |

### Success Criteria

- **Baseline**: Raw prompting produces hedged variations of the same middle-ground approach
- **Success**: Skill produces problem-specific tensions (not generic defaults) and perspectives that resolve tensions in genuinely different directions
- **Measurable**: (a) perspective novelty — surfaces perspectives the ad-hoc prompt didn't; (b) structural divergence — genuinely different, not variations; (c) comparison actionability — conditional guidance helps decide
