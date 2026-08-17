# CTA Testing

Worked examples, Classification Gym, decision requirement table, scoring rubrics, and test pack.

---

## Examples

### Expertise Map
```
/cta "senior incident responder, 15 years in ops" expertise-map
```

### Decision Rationale
```
/cta "product manager, B2B SaaS background" decision-rationale
```

### Mental Model
```
/cta "database architect, distributed systems focus" mental-model
```

### Knowledge Gap
```
/cta "security auditor, web application focus" knowledge-gap
```

---

## Testing

### Critical Decision (CDM)

**Decision Requirement:** "When should I switch CTA methods mid-session?"

Expert interviewers detect signals that require method pivots. Novices stick to one method regardless of signals.

### Decision Requirement Table

| Cue Type | Expert Recognition | Novice Miss |
|----------|-------------------|-------------|
| **Abstraction alarm** | "보통", "항상", "일반적으로" → return to scenario | Accepts abstract answers |
| **Surface answer** | "경험이요", "직감이요" → probe for cue | Accepts "intuition" as final answer |
| **Rationalization** | Clean logical explanation → probe first impression | Accepts post-hoc rationalization |
| **Knowledge boundary** | Hesitation, uncertainty → note and explore | Pushes past expertise limits |
| **Method exhaustion** | Current method stops yielding → switch methods | Keeps using same method |

### Classification Gym

Train signal detection with these scenarios:

#### Scenario 1
**Expert says**: "I usually just know when the system is about to fail."
**What signal?**
- A) Surface answer (probe for cue)
- B) Abstraction alarm (return to scenario)

**Expert answer**: A (Surface answer) — "Just know" is surface. Probe: "What do you notice that tells you it's about to fail?"
**Novice trap**: Accepting "just know" as the final answer. This is where tacit knowledge hides.

#### Scenario 2
**Expert says**: "Generally, you always want to check the logs first."
**What signal?**
- A) Surface answer
- B) Abstraction alarm

**Expert answer**: B (Abstraction alarm) — "Generally" + "always" = abstract rule. Return to scenario: "In this specific incident, what did you check first?"
**Novice trap**: Accepting the abstract rule. Concrete scenario probing yields what they actually do.

#### Scenario 3
**Expert says**: "Well, I thought through the options logically: A was too slow, B had security issues, so C was the obvious choice."
**What signal?**
- A) Rationalization (probe first impression)
- B) Valid reasoning

**Expert answer**: A (Rationalization) — Too clean, too logical. Probe: "Before you analyzed the options, what was your first instinct?"
**Novice trap**: Accepting post-hoc rationalization as the actual decision process. Experts often decide first, justify later.

#### Scenario 4
**Expert says**: "Hmm... I'm not really sure about that part. We never had to deal with that."
**What signal?**
- A) Knowledge boundary (note and explore)
- B) Needs more probing

**Expert answer**: A (Knowledge boundary) — Hesitation + "not sure" = expertise limit. Note it, then ask: "What would you need to figure that out?"
**Novice trap**: Pushing harder to get an answer. Knowledge boundaries are valuable data, not failures.

#### Scenario 5
**Expert says**: "From my experience over the years, this type of problem usually requires a careful approach."
**What signal?**
- A) Valuable experience
- B) Abstraction alarm + Surface answer

**Expert answer**: B (Both signals) — "From my experience" is surface, "usually" is abstraction. Double probe needed.
**Novice trap**: Being satisfied with experience-based answer. This is exactly where tacit knowledge needs extraction.

### Test Pack

| Type | JTBD | Purpose |
|------|------|---------|
| Primary | "Interview me about how I debug production issues" | Tests method selection + switch detection |
| Edge | "Just give me a list of questions to ask" | Should refuse, explain why scenario-based |

### Success Criteria

- **Baseline Criterion**: Generic interview questions (checklist style)
- **Success Criterion**: Scenario-based probing, detects abstraction alarms, method switching when needed

### Expert Cues for Scoring

**Expert Interviewing (score 2-3)**:
- Starts with scenario anchor, not abstract questions
- Detects switch signals (abstraction, surface answers, rationalization)
- Pivots methods when signals detected
- Notes knowledge boundaries without pushing past
- Refuses to give "list of questions" without scenario context

**Novice Pattern (score 0-1)**:
- Generic question list without scenario
- Same method throughout regardless of signals
- Accepts "intuition" or "experience" as final answers
- Pushes when expert shows uncertainty
- Provides checklist when asked

### Scoring Rubric

**Method Switching (Most Critical)**

| Score | Criteria | Expert Cue |
|-------|----------|------------|
| 0 | Same method throughout | No signal detection |
| 1 | Detects signals, doesn't switch | Recognizes but ignores |
| 2 | Switches appropriately, minor lapses | May miss some signals |
| 3 | Expert switching | Detects + pivots + notes boundaries |

**Task Completion**

| Score | Criteria |
|-------|----------|
| 0 | No elicitation attempt, just questions list |
| 1 | Generic interview questions without scenario |
| 2 | Scenario-based but doesn't adapt |
| 3 | Full elicitation with method adaptation |

**Output Consistency**

| Score | Criteria |
|-------|----------|
| 0 | Unpredictable interview structure |
| 1 | Variable (sometimes scenario-based, sometimes checklist) |
| 2 | Mostly follows: scenario → probes → synthesis |
| 3 | Consistently follows CTA protocol |

**User Effort**

| Score | Criteria |
|-------|----------|
| 0 | User must guide entire interview |
| 1 | User must redirect to scenario-based |
| 2 | Minor guidance needed |
| 3 | Fully autonomous elicitation |

### Test Evidence

Run `/skill-architect test skills/cta "Interview me about how I debug production issues"`.
