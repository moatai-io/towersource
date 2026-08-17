---
name: cta
description: Conduct Cognitive Task Analysis to elicit tacit knowledge from domain experts. Use for expertise mapping, decision rationale, mental models.
context: fork
agent: general-purpose
allowed-tools: Read, Glob, Grep, WebSearch, WebFetch
argument-hint: "\"expert description\" [intention]"
---

# CTA: Applied Cognitive Task Analysis

Conduct semi-structured Cognitive Task Analysis (CTA) sessions to elicit tacit knowledge from domain experts. This skill focuses on **expertise elicitation** - understanding how experts think, decide, and recognize patterns.

## Why Tacit Knowledge Matters

**Tacit knowledge** is what experts know but cannot easily articulate. It's the difference between reading a textbook and having 10,000 hours of practice.

| Knowledge Type | Characteristics | How to Access |
|----------------|-----------------|---------------|
| **Explicit** | Can be written down, taught directly | Ask directly |
| **Tacit** | Compiled through practice, feels like "intuition" | CTA methods required |

**Why experts can't just tell you:**
- Knowledge becomes **automated** - they no longer consciously access the steps
- They **recognize patterns holistically** - can't decompose into rules
- They **know more than they can say** - the knowledge is in the doing, not the describing

**Why this matters for our work:**
- Textbooks give explicit knowledge (theory.md)
- CTA surfaces tacit knowledge (cognitive-framework.md)
- The gap between them is where expert-novice differences live

## How CTA Methods Surface Tacit Knowledge

Each method targets different aspects of tacit knowledge:

| Method | What It Surfaces | The Trick |
|--------|------------------|-----------|
| **Simulation Interview** | Decision cues experts notice | Concrete scenario prevents theorizing |
| **Think Aloud** | Real-time pattern recognition | Captures before rationalization happens |
| **Laddering** | Values beneath surface reasons | "Why?" repeated bypasses first explanation |
| **RPD Probes** | Recognition-primed patterns | "How did you know?" accesses pre-verbal |

**The core insight**: Direct questions get **explicit knowledge** (what they think they do). Scenario-based probing gets **tacit knowledge** (what they actually do).

### Supporting Files

| File | Purpose | Loaded When |
|------|---------|-------------|
| [methods.md](./methods.md) | CTA methods (Simulation Interview, Think Aloud, Laddering, RPD), switch signals, output format templates | Method selection and synthesis |
| [probes.md](./probes.md) | Standard and domain-specific probe templates | During elicitation |
| [testing.md](./testing.md) | Worked examples, Classification Gym, scoring rubrics, test pack | Testing and validation |

---

## Analytical Stance: Phenomenological Reduction + Constant Comparative

CTA elicitation surfaces tacit knowledge. The analytical stance determines whether you preserve or distort that knowledge when processing it.

### Phenomenological Reduction (Reading Posture)

Before reading expert responses, operationalize phenomenological reduction:
1. **State default expectations** — Before reading, list what you expect the expert to say. This makes your "assumptions" visible and checkable.
2. **Mark divergences** — As you read, flag where the expert's account diverges from your expectations. Divergences are the high-signal content.
3. **Preserve the expert's language** — Use their words in codes and labels, not your technical vocabulary. (This overrides the default RLHF tendency to summarize and professionalize.)
4. **Separate observation from interpretation** — When you go beyond what was said, mark it explicitly: `[analyst inference: ...]`. Keep inferences sparse.

**Why not adversarial reading**: Pre-Mortem and Devil's Advocate would crush the nuance CTA is designed to surface. Expert knowledge is fragile — it must be received before it can be scrutinized.

### Constant Comparative Method (Cross-Probe Analysis)

After each probe response, compare against accumulated understanding:
1. **Compare new response to existing codes** — Does this confirm, extend, or contradict what we've seen?
2. **Note boundary conditions** — When does the expert's pattern apply vs. not?
3. **Track saturation signal** — When the last 3 probes produce findings already captured in existing codes, signal to the user that this area is saturated. (Operationalized for stateless execution: check accumulated codes against current response, not a running counter.)
4. **Build memo** — Capture analytical decisions in running notes (why you coded X as Y, not Z).

### Integration with Method Switching

| Reading Signal | Analytical Action |
|---------------|-------------------|
| Expert uses unexpected term | Preserve it as new code (don't normalize to known vocabulary) |
| Response contradicts earlier response | Don't resolve immediately — code both, flag for probe |
| Expert says "it depends" | Branch the category — this is a boundary condition worth exploring |
| Expert gives theory, not practice | Note the gap — CTA seeks practice, probe for concrete instance |
| Response matches existing code exactly | Check saturation — if 3+ repetitions, move to new territory |

---

## Input Parsing

Parse the user's input for:
- **Domain Expert**: Description of the expert (required)
- **Intention**: Session goal (optional, defaults to `expertise-map`)

```
/cta "expert description" [intention]

Intentions:
- expertise-map      (Default) Surface tacit knowledge and expert patterns
- decision-rationale Understand decision factors and trade-offs
- mental-model       Elicit internal system models and representations
- knowledge-gap      Find unknown unknowns, edge cases experts handle
```

Example: `/cta "senior UX designer, 10 years experience" decision-rationale`

---

## Session Protocol

### Phase 1: Expert Profile Construction

Build a **cognitive model** of the expert, not a demographic summary.

**Expertise Indicators**
| Variable | Setting | Effect |
|----------|---------|--------|
| Experience Depth | [novice/intermediate/expert] | Affects pattern recognition richness |
| Domain Breadth | [narrow/broad] | Narrow = deep patterns; Broad = transfer patterns |
| Teaching Exposure | [low/high] | High = more articulate about tacit knowledge |
| Metacognitive Awareness | [low/high] | High = can explain their own thinking |

**Recognition-Primed Decision Profile**
- **Typical situations**: What scenarios does this expert encounter daily?
- **Pattern library**: What patterns do they recognize instantly?
- **Anomaly sensitivity**: What would make them say "something's wrong here"?
- **Mental simulation**: How do they test ideas before acting?

**Knowledge Structure**
- **Explicit knowledge**: What they can easily articulate
- **Tacit knowledge**: What they "just know" but struggle to explain
- **Boundary knowledge**: Where their expertise ends

### Phase 2: Select Primary Lens

Based on the intention, select your primary probing focus:

| Intention | Primary Lens | Key Probe | Target Output |
|-----------|--------------|-----------|---------------|
| `expertise-map` | Pattern Recognition | "How did you know that?" | Expert Patterns Map |
| `decision-rationale` | Trade-off Analysis | "What made you choose X over Y?" | Decision Framework |
| `mental-model` | System Representation | "How do you think about this?" | Mental Model Diagram |
| `knowledge-gap` | Edge Cases | "What would surprise you here?" | Unknown Unknowns List |

### Phase 3: Scenario-Based Elicitation

**The scenario is the anchor.** Abstract questions get abstract answers. Concrete scenarios surface tacit knowledge.

#### 3a. Present Scenario
Use a realistic situation from the expert's domain. Can be:
- A past incident they handled
- A hypothetical challenge
- A document/artifact to review

#### 3b. Elicit with Probes

**Pattern Recognition Probes**
```
"이 상황을 보자마자 뭐가 떠올랐어요?"
"어떻게 바로 알았어요?"
"다른 사람은 뭘 놓칠 것 같아요?"
```

**Decision Rationale Probes**
```
"왜 이걸 선택했어요?"
"다른 옵션은 왜 안 됐어요?"
"어떤 정보가 가장 중요했어요?"
```

**Mental Model Probes**
```
"이걸 어떻게 이해해요?"
"머릿속에 어떤 그림이 있어요?"
"이 시스템이 어떻게 작동한다고 생각해요?"
```

**Knowledge Gap Probes**
```
"여기서 뭐가 잘못될 수 있어요?"
"예상 밖의 상황은 어떤 게 있었어요?"
"어떤 상황에서는 이 방법이 안 통해요?"
```

#### 3c. Watch for Method Switch Signals

Watch for abstraction alarms, surface answers, rationalization, and knowledge boundaries. See [methods.md — Method Switch Signals](./methods.md#method-switch-signals-adaptive-cta) for detection cues and actions.

### Phase 4: Laddering Deep

At key insights, ladder up to underlying principles:

```
Q: 왜 이렇게 했어요?
A: 이게 더 안전해 보여서요.
Q: 안전하다는 걸 어떻게 알았어요?
A: 이 패턴은 보통 문제가 안 생겨요.
Q: 그 패턴을 어떻게 인식했어요?
A: [X], [Y], [Z]가 있으면 대체로... → [Expert Pattern Identified]
```

### Phase 5: Synthesis

Produce output based on intention. Read [methods.md — Output Format Templates](./methods.md#output-format-templates) for the template matching the session intention (expertise-map, decision-rationale, mental-model, knowledge-gap).

---

## Guidelines

- **Scenario anchoring**: Always ground in concrete situations, not abstractions
- **Push past first answer**: The first "why" gets rationalization; keep probing
- **Surface cues**: Find what they actually noticed, not what they think they noticed
- **Respect expertise**: You're eliciting, not testing
- **Note boundaries**: Where expertise ends is as valuable as where it exists

---

## Integration with Other Skills

- **/pattern distill**: Turn elicited expert knowledge into patterns
- **/generative-sequencer**: Plan expertise elicitation sequences

---

See [testing.md](./testing.md) — worked examples, Classification Gym, scoring rubrics, and test pack.

---

## RPD Card: CTA Method Switching

Based on Gary Klein's Recognition-Primed Decision model (*Sources of Power*, 1998). Use this card when conducting CTA sessions. **Mandatory when**: signal detected, current method stops yielding, or expert shows boundary behavior.

### Pattern Recognition

**Signals** (switch triggers):
1. **ABSTRACTION_ALARM**: "usually", "always", "generally" → return to scenario
2. **SURFACE_ANSWER**: "intuition", "experience" → probe for underlying cue
3. **RATIONALIZATION**: Clean logical story → probe first impression
4. **KNOWLEDGE_BOUNDARY**: Hesitation, uncertainty → note and explore edge
5. **METHOD_EXHAUSTION**: Current method stops yielding → switch methods

**Dominant cues** (top 3):
1. **Language markers**: generalization words, certainty words
2. **Response quality**: decreasing information per probe
3. **Behavioral signals**: hesitation, backtracking, defensiveness

**Expectancies**:
- If ABSTRACTION_ALARM, concrete scenario probe should yield specific details
- If KNOWLEDGE_BOUNDARY, exploring edge should reveal actual limits

### First Script

**Default method sequence**:
1. Start: Simulation Interview (scenario anchor)
2. If surface answers: Switch to RPD Probes ("how did you know?")
3. If rationalization: Switch to Think Aloud (capture before post-hoc)
4. If values needed: Switch to Laddering ("why does that matter?")

**Quick simulate**: Will this method yield tacit knowledge, or just explicit?

### Replan Triggers

**Switch when**:
- 3+ probes with diminishing returns → switch method
- Expert shows discomfort with current method → switch or note boundary
- Abstraction alarm fires → immediately return to scenario

### Confounders

**False friends**:
- Confident detailed answer → could be real expertise OR polished rationalization
- Hesitation → could be knowledge boundary OR thinking time

**Boundary case**: Expert gives abstract answer but IS an expert → they may have compiled knowledge; probe specific incident to decompress

---

Run `/skill-architect test skills/cta "Interview me about how I debug production issues"` to validate.
