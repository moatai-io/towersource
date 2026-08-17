# Perspective Discovery Engine

How to extract problem-specific tensions and generate non-obvious perspectives.

## Tension Discovery Protocol

Three patterns for extracting inherent tensions from any design problem.

### Pattern 1: Constraint Pairs

Properties where optimizing one degrades the other. Detect from problem nouns and adjectives.

- "multi-tenant" → tenant-isolation ↔ resource-efficiency
- "real-time" → consistency ↔ latency
- "self-service" → flexibility ↔ guardrails
- "distributed" → availability ↔ consistency
- "zero-trust" → security-rigor ↔ developer-velocity
- "pluggable" → extensibility ↔ coherence

**Detection method**: For each significant noun/adjective in the problem statement, ask: "What does maximizing this force you to sacrifice?"

### Pattern 2: Stakeholder Conflicts

Groups embedded in the problem with opposing needs.

- "developer platform" → platform team (consistency, stability) ↔ app developers (autonomy, velocity)
- "marketplace" → buyers (trust, safety, comparison) ↔ sellers (freedom, speed, differentiation)
- "enterprise SaaS" → end users (simplicity, speed) ↔ admins (control, compliance) ↔ procurement (cost, risk)
- "open-source project" → maintainers (sustainability, focus) ↔ contributors (influence, recognition) ↔ users (stability, features)

**Detection method**: Identify every group mentioned or implied in the problem. For each pair, find where their incentives diverge.

### Pattern 3: Temporal Tensions

Short-term vs long-term trade-offs specific to this context.

- "MVP for enterprise" → ship fast (prove value) ↔ build foundations (avoid rewrite)
- "migration" → maintain compatibility (safety) ↔ break free (clean design)
- "scaling startup" → move fast (capture market) ↔ build discipline (sustain growth)
- "tech debt" → fix now (compound interest) ↔ defer (ship features)

**Detection method**: Ask "What would we do if we only had 2 weeks?" vs "What would we do if we had 2 years?" Where the answers conflict reveals temporal tensions.

---

## Worked Examples

### Example 1: Authentication for Multi-Tenant SaaS

**Problem**: "How should we structure the authentication service for a multi-tenant SaaS platform?"

**Tension extraction**:
- Constraint pairs: tenant-isolation ↔ resource-efficiency, security-rigor ↔ onboarding-friction, per-tenant-customization ↔ operational-simplicity
- Stakeholder conflicts: tenant admins (control over auth policies) ↔ platform team (manageable blast radius) ↔ end users (seamless experience)
- Temporal: build multi-tenant from day one (correct but slow) ↔ start single-tenant and migrate (fast but painful later)

**Generated perspectives**:
1. **Isolation-Maximalist**: Each tenant gets its own auth domain, identity provider, and token namespace. Maximizes security boundaries at the cost of operational overhead.
2. **Shared-Core**: Single authentication service with tenant-scoped policies and token claims. Optimizes for operational simplicity while encoding tenant context.
3. **Tenant-Sovereign**: Tenants bring their own IdP; platform federates via SAML/OIDC. Maximizes tenant control, platform becomes a relying party.

### Example 2: CLI Plugin Architecture

**Problem**: "How should our CLI tool support third-party plugins?"

**Tension extraction**:
- Constraint pairs: extensibility ↔ coherence (UX consistency), plugin-freedom ↔ security (sandboxing)
- Stakeholder conflicts: plugin authors (power, flexibility) ↔ CLI users (reliability, consistency) ↔ core team (maintainability)
- Temporal: open everything now (attract ecosystem) ↔ narrow surface (avoid breaking changes)

**Generated perspectives**:
1. **Bazaar**: Minimal plugin API, maximal freedom. Plugins can hook into anything. Ecosystem grows fast, quality varies.
2. **Curated-Garden**: Strict plugin contract with capability-based permissions. Plugins declare what they need; runtime enforces boundaries.
3. **Embedded-DSL**: Plugins are configuration, not code. A declarative extension language that composes built-in primitives. No arbitrary execution.

### Example 3: Team Workflow Process

**Problem**: "How should we structure our code review process for a 12-person team?"

**Tension extraction**:
- Constraint pairs: review-thoroughness ↔ review-speed, knowledge-sharing ↔ specialization-efficiency
- Stakeholder conflicts: authors (fast merges) ↔ reviewers (manageable load) ↔ team leads (quality, consistency)
- Temporal: strict process now (slow but catches issues) ↔ trust-based (fast but risks quality drift)

**Generated perspectives**:
1. **Gateway**: Every PR requires 2 approvals from designated reviewers. Optimizes for correctness and knowledge distribution at the cost of throughput.
2. **Trust-and-Verify**: Authors self-merge with post-merge async review. Optimizes for velocity; catches issues through monitoring and periodic audits.
3. **Tiered-Risk**: Review depth scales with change risk (auto-classified). Trivial changes auto-merge; high-risk changes get design review. Optimizes for proportional effort.

---

## Domain Fallback Perspectives

Use ONLY when tension analysis yields fewer than N perspectives. These are generic starting points, not substitutes for problem-specific tension resolution.

| Domain | Perspective | Worldview | Best when |
|--------|------------|-----------|-----------|
| architecture | Simplicity-First | Fewer moving parts always wins. Complexity is the real enemy. | Team is small, problem is well-understood, maintenance burden matters most. |
| architecture | Performance-First | Optimize the critical path. Architectural elegance yields to measured throughput. | Latency/throughput SLAs are non-negotiable, workload is well-characterized. |
| architecture | Extensibility-First | Build for the requirements you'll discover next quarter. Seams and interfaces over monoliths. | Problem space is evolving, multiple integration points expected. |
| api | Consumer-Friendly | The best API is the one developers never need docs for. Optimize for discoverability. | Public-facing API, diverse consumer base, adoption matters. |
| api | Backend-Optimal | The API serves the system's needs; consumers adapt. Optimize for backend simplicity. | Internal API, small consumer set, operational efficiency matters. |
| api | Evolution-Ready | Version everything. Every field is optional. Never break a running client. | Long-lived API, external consumers you can't coordinate with. |
| data-model | Normalized-Relational | Single source of truth. Joins are cheap; inconsistency is expensive. | Write-heavy, complex queries, data integrity is paramount. |
| data-model | Denormalized-Performance | Pre-compute the read path. Storage is cheap; user patience is not. | Read-heavy, latency-sensitive, access patterns are known. |
| data-model | Event-Sourced | Store what happened, derive what is. Full audit trail, temporal queries. | Compliance requirements, complex business rules, undo/replay needed. |
| ux | Power-User | Expose the full model. Keyboard shortcuts, bulk operations, customization. | Professional tools, daily-use applications, expert users. |
| ux | Novice-User | Progressive disclosure. Guide the happy path, hide the machinery. | Consumer products, onboarding-sensitive, broad audience. |
| ux | Accessibility-First | Design for constraints first; everyone benefits. Semantic, navigable, perceivable. | Public-sector, healthcare, or any product where exclusion is unacceptable. |
| process | Lean-Minimal | Every process step must justify its existence. Default is no process. | Small teams, high-trust environments, rapid iteration. |
| process | Compliance-Heavy | Auditability and traceability over speed. Every decision is documented. | Regulated industries, enterprise contracts, legal exposure. |
| process | Automation-First | If a human does it twice, automate it. Process is code. | Scaling teams, repeatable workflows, operational maturity. |
| strategy | Conservative-Incremental | Small bets, fast feedback. Never bet the company on one move. | Uncertain markets, limited runway, reversibility matters. |
| strategy | Ambitious-Leap | Leapfrog the competition. First-mover advantage compounds. | Clear market window, strong conviction, sufficient resources. |
| strategy | Contrarian | The consensus is wrong. Find the non-obvious truth and exploit it. | Crowded markets, when conventional wisdom produces mediocre results. |
