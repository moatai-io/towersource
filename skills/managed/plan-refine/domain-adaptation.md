# Domain Adaptation Reference

Classification heuristics, methodology-domain fit matrix, and perspective sets for adaptive plan review.

---

## Domain Classification Heuristics

Scan the plan for signal words. The domain with the strongest signal cluster is the primary classification. If signals span domains, note the secondary.

### Signal Word Lists

**Software**:
- API, endpoint, database, schema, deployment, CI/CD, microservice, latency
- Component, module, service, architecture, infrastructure, migration
- Test, integration, rollback, monitoring, alerting, SLA
- Code, function, class, interface, protocol, SDK, CLI

**Business**:
- Revenue, profit, margin, cost structure, unit economics, burn rate
- Market, segment, TAM/SAM/SOM, competitive advantage, moat
- Customer acquisition, retention, churn, LTV, CAC, funnel
- Stakeholder, board, investor, fundraising, valuation, exit

**Research**:
- Hypothesis, null hypothesis, variable, control group, treatment
- Methodology, protocol, sample size, statistical significance, p-value
- Validity (internal, external, construct), reliability, replicability
- Literature review, citation, IRB, informed consent, ethics approval

**Education**:
- Learning objective, outcome, competency, rubric, assessment
- Pedagogy, andragogy, scaffolding, differentiation, formative/summative
- Curriculum, module, lesson plan, syllabus, credit hour
- Student, learner, instructor, facilitator, cohort, enrollment

**Policy**:
- Compliance, regulation, statute, ordinance, enforcement, penalty
- Jurisdiction, authority, mandate, oversight, accountability
- Public comment, stakeholder input, impact assessment, equity
- Implementation timeline, phase-in, grandfather clause, exemption

**Creative**:
- Audience, reader, viewer, listener, user experience
- Narrative, story, arc, character, theme, tone, voice
- Aesthetic, visual, design language, medium, format, platform
- Portfolio, exhibition, publication, release, premiere, launch

### Disambiguation Rules

When signals are ambiguous:

| Ambiguity | Resolution |
|-----------|-----------|
| Technical + business signals | Ask: Is the core decision technical (-> software) or market-facing (-> business)? |
| Research + software signals | Ask: Is the output a study/paper (-> research) or a system (-> software)? |
| Policy + software signals | Ask: Is the audience regulators (-> policy) or engineers (-> software)? |
| Education + research signals | Ask: Is the goal teaching (-> education) or investigating (-> research)? |
| Creative + business signals | Ask: Is the core concern artistic quality (-> creative) or commercial viability (-> business)? |
| Creative + education signals | Ask: Is the goal producing a work (-> creative) or teaching how to produce (-> education)? |

---

## Methodology-Domain Fit Matrix

### GROUND Phase

| Domain | Method | Rationale |
|--------|--------|-----------|
| software | ATDD | Testability is the primary quality gate for engineering plans |
| research | ATDD | Empirical verifiability parallels testability |
| business | IRAC | Strategic choices are governed by principles, not tests |
| education | IRAC | Pedagogical choices are governed by learning science principles |
| policy | IRAC | Regulatory choices are governed by legal and governance principles |
| creative | IRAC | Creative choices are governed by craft principles and conventions |

### STRESS Phase

| Domain | Maturity: sketch | Maturity: draft | Maturity: review-ready |
|--------|-----------------|-----------------|----------------------|
| software | Devil's Advocate | Pre-Mortem | HAZOP |
| business | Devil's Advocate | Pre-Mortem | Pre-Mortem |
| research | Devil's Advocate | Pre-Mortem | Pre-Mortem |
| education | Devil's Advocate | Pre-Mortem | Pre-Mortem |
| policy | Devil's Advocate | Pre-Mortem | Pre-Mortem |
| creative | Devil's Advocate | Pre-Mortem | Pre-Mortem |

**Why HAZOP only for review-ready software**: HAZOP's guideword analysis is most productive when applied to concrete data flows and state transitions. Non-software domains lack the parametric specificity that makes HAZOP shine. Pre-Mortem's narrative approach works across all domains at all maturities.

### WIDEN Phase

Always PBR. Perspectives vary by domain (see below).

---

## Perspective Sets (PBR)

Each domain uses three perspectives chosen to maximize coverage of blind spots.

These are default starting points. Override when the plan's context suggests more relevant stakeholders.

### Software

| Perspective | Blind Spot Covered |
|-------------|-------------------|
| **End user** | Usability, workflow fit, error recovery, accessibility |
| **On-call engineer** | Operability, debugging, monitoring, failure modes, runbooks |
| **Security adversary** | Security, abuse vectors, trust boundaries, data exposure |

### Business

| Perspective | Blind Spot Covered |
|-------------|-------------------|
| **Customer** | Value proposition clarity, switching costs, alternatives, pain points |
| **Investor/board member** | Financial viability, risk profile, scalability, governance |
| **Competitor** | Defensibility, response strategies, market positioning, timing |

### Research

| Perspective | Blind Spot Covered |
|-------------|-------------------|
| **Peer reviewer** | Methodological rigor, statistical validity, novelty, literature gaps |
| **Practitioner applying findings** | Practical applicability, generalizability, implementation barriers |
| **Ethics board member** | Participant welfare, informed consent, data privacy, societal impact |

### Education

| Perspective | Blind Spot Covered |
|-------------|-------------------|
| **Student/learner** | Cognitive load, motivation, accessibility, prerequisite gaps |
| **Instructor implementing** | Feasibility, time constraints, resource requirements, assessment burden |
| **Assessment evaluator** | Alignment with objectives, measurement validity, fairness, standards compliance |

### Policy

| Perspective | Blind Spot Covered |
|-------------|-------------------|
| **Affected citizen** | Practical impact, compliance burden, equity, access to recourse |
| **Implementing bureaucrat** | Administrative feasibility, resource needs, ambiguity in rules, edge cases |
| **Opposition critic** | Political vulnerabilities, unintended consequences, precedent risks, alternatives |

### Creative

| Perspective | Blind Spot Covered |
|-------------|-------------------|
| **Audience/reader** | Engagement, emotional resonance, accessibility, expectations |
| **Collaborator/performer** | Feasibility, technical demands, creative constraints, collaboration friction |
| **Published critic** | Originality, craft quality, contextual positioning, artistic ambition |

---

## Maturity Assessment Criteria

### Sketch

- Predominantly bullet points or sentence fragments
- Multiple TBD, TODO, or placeholder markers
- Incomplete sections or missing sections referenced elsewhere
- No concrete timelines, metrics, or specifications
- Reads as thinking-aloud rather than a proposal

### Draft

- Structured with clear sections and headings
- Most sections have substantive content
- Some gaps remain (marked or unmarked)
- Partial specifications — some areas detailed, others high-level
- Reads as a work-in-progress intended for feedback

### Review-Ready

- All sections complete with substantive content
- Specific metrics, timelines, or acceptance criteria present
- Few or no placeholder markers
- Consistent level of detail throughout
- Reads as a proposal ready for decision-making
