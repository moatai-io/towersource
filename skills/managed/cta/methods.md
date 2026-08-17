# CTA Methods Reference

This document provides background on the Cognitive Task Analysis methods used in this skill.

---

## Cognitive Architecture of Text-Based Play

Understanding how real players cognitively process text-based games is essential for creating authentic simulated personas.

### The Core Insight

> **Real players are cognitive misers who constantly calculate ROI on mental effort. LLM personas are infinitely patient and perfectly attentive.**

This is why simulated personas feel fake — they read every word, connect every clue, and never forget anything. Real players skim, assume, forget, and doubt.

### What Makes Text-Based Games Unique

Text IF differs from both passive reading and visual games:

1. **Construction-Integration Loop**: Read → Build mental model → Formulate action → Execute
2. **No GPU**: The player must hold the room's topology, objects, and lighting in working memory (high cognitive load)
3. **Gulf of Execution**: Gap between "knowing what I want" and "knowing how to express it"
4. **Presence via Gap-Filling**: Player co-creates by filling indeterminacy gaps with their own imagery

### Internal State Variables to Model

| Variable | What It Models | Effect |
|----------|----------------|--------|
| **Working Memory Buffer** | What they can hold | Real players dump info to make room — model forgetting |
| **Mental Model Divergence** | Imagined world vs. actual game | When high → confusion, wrong assumptions |
| **Motivation Level** | Current engagement | Below threshold → skip/skim mode |
| **Epistemic Vigilance** | Narrator trust | Skeptical players test claims, try to break rules |
| **Arousal/Frustration** | Emotional state | When high → cognitive tunneling, brute-force choices |

### The Cost Function

**Before every action, a real player implicitly calculates:**

```
Is reading this worth the effort?

If Motivation < TextDensity:
  → SKIM for nouns, ignore flavor
  → Issue generic action
  → Miss key clues
  → Model resulting confusion
```

### Why This Matters for CTA

When conducting simulated player interviews:
- **Don't** generate Think Aloud that processes everything
- **Do** model what they actually processed (often less than written)
- **Do** create authentic forgetting, confusion, and wrong assumptions
- **Do** model when they would doubt the narrator and test boundaries

## Methods Combined in This Skill

### 1. Simulation Interview (from ACTA)

**Origin**: Applied Cognitive Task Analysis (ACTA) by Militello & Hutton, 1998

**Purpose**: Explore cognitive processes within the context of a specific incident/scenario.

**How we use it**: Walk the persona through the game scenario turn-by-turn, tracking decisions and reactions.

**Key principle**: The scenario provides concrete anchors that prevent abstract theorizing. "What did you do here?" beats "What would you usually do?"

**Reading Stance**: Read responses for decision cues and action rationale. Bracket theoretical explanations — the expert's in-scenario choices reveal more than their post-hoc explanations.

### 2. Think Aloud Protocol

**Origin**: Ericsson & Simon, 1984; Applied to usability by Clayton Lewis, 1982

**Purpose**: Access real-time cognitive processes by verbalizing thoughts during task performance.

**How we use it**: Generate the persona's internal monologue as they experience the game.

**Key principle**: Captures the "why" behind actions that observation alone would miss. Reveals hesitations, expectations, and emotional responses.

**Two variants**:
- **Concurrent**: Verbalize during the task (more complete, may affect performance)
- **Retrospective**: Verbalize after, often cued by recording (less interference, more omissions)

We use a simulated concurrent approach - generating what the persona would think in real-time.

**Reading Stance**: Read for the structure of attention — what the expert notices first, what they skip, what they revisit. Sequence matters more than content.

### 3. Laddering

**Origin**: Clinical psychology, 1960s; Adapted for UX by Reynolds & Gutman, 1988

**Purpose**: Uncover the deeper values and motivations behind surface-level choices.

**How we use it**: At key decision points, repeatedly ask "why" to drill from behavior → consequence → value.

**The ladder structure**:
```
Attribute → Consequence → Value
"I clicked X" → "Because it seemed safer" → "I don't like feeling out of control"
```

**Key probes**:
- "왜?" (Why?)
- "그래서 뭐가 좋아요/싫어요?" (So what's good/bad about that?)
- "그게 안 됐으면?" (What if that wasn't an option?)

**Reading Stance**: Read for value hierarchies — each 'why' answer reveals a deeper layer. Don't challenge the hierarchy; map it.

### 4. Recognition-Primed Decision (RPD) Model

**Origin**: Gary Klein, Roberta Calderwood, Anne Clinton-Cirocco, 1985; Naturalistic Decision Making research

**Purpose**: Understand how experts make rapid decisions through pattern recognition rather than option comparison.

**How we use it**: Model how expert writers "see" a scene and immediately recognize what's alive vs. dead, rather than checking against rules.

**The RPD loops**:
1. **Pattern Matching**: Expert recognizes situation type → activates relevant cues, goals, expectations, typical actions
2. **Mental Simulation**: Quick visualization of outcome → if it works, proceed; if not, modify or try next pattern

**Key insight for writing prompts**: Experienced writers don't follow checklists. They:
- Recognize "dead prose" by pattern (not by rule violation)
- Feel when something is "off" before analyzing why
- Generate alternatives through pattern-based intuition, not systematic comparison

**How to elicit RPD knowledge**:
- "뭔가 이상한데?" (Something feels off) → What pattern is violated?
- "이건 살아있다" (This is alive) → What makes it recognizable as good?
- "여기서 보통은..." (Usually here...) → What's the expert's prototype?

**Reading Stance**: Read for recognition patterns — the 'how did you know?' response reveals compiled expertise. Code the cues, not the explanation.

**Application to fiction writing**:
```
Dead prose pattern: "방에 세 개의 물건이 있습니다"
Expert recognition: "이건 인벤토리 목록이지 묘사가 아니야"
Pattern activated: [시선이동], [감각질감], [불완전정보]
Mental simulation: "시계 → 메모 → 열쇠, 순서대로 눈이 가겠지..."
Output: Rewrite following natural attention flow
```

---

## Method Switch Signals (Adaptive CTA)

When conducting semi-structured CTA, watch for these signals to know when to switch methods mid-session.

### Abstraction Alarm
| Signal | Detection | Action |
|--------|-----------|--------|
| Generalization | Persona uses "보통", "항상", "대부분", "일반적으로" | Ground back: "이 화면에서 구체적으로 뭐가 보여요?" |
| Theorizing | "RPG에서는 보통...", "이런 게임은 대체로..." | Return to simulation: "지금 이 순간으로 돌아가서..." |
| Theorizing loop | Same abstract answer appears 2x | Hard stop: Drop laddering, resume gameplay |

**Klein's insight**: When players say "Well, usually in RPGs I like to feel powerful..." — STOP. They're theorizing about themselves, which is often wrong.

### Surface Answer Detection
| Signal | Detection | Action |
|--------|-----------|--------|
| Generic positive | "재밌어서요", "좋아 보여서요", "그냥요" | Push to Cue: "어떤 글자/그림이 그렇게 느끼게 했어요?" |
| Rationalization | Clean logical explanation that feels too neat | Probe Cue: "화면에서 뭐가 먼저 눈에 들어왔어요?" |
| Post-hoc reasoning | Explanation doesn't match observed behavior | Ask about perception, not intention |

### Method Switch Triggers
| Signal | Detection | Action |
|--------|-----------|--------|
| Contradiction | Choice contradicts stated preference | Switch TO Laddering |
| Emotional spike | Strong reaction (frustration, delight) | Switch TO Emotional Probes |
| Confusion | "뭐지?", hesitation, re-reading | Switch TO Expectation Probes |
| Constraint hit | "이건 못 하네", limited options | Switch TO Phantom Option Probe |

### The Ladder-Return Pattern
After laddering up to a core value, immediately drop back to the game:

```
Q: 왜 이 선택지가 좋았어요?
A: 더 안전해 보여서요.
Q: 안전하면 뭐가 좋아요?
A: 실수 안 하니까요.
Q: 실수 안 하면 뭐가 좋아요?
A: 바보처럼 안 보이니까요. → [Core value: competence/image]

[IMMEDIATELY RETURN TO GAME]
Q: 자, 다음 화면을 보면서... 그 '바보처럼 안 보이고 싶다'는 마음이 여기서 어떻게 작동해요?
```

---

## Methods NOT Used (and Why)

### Critical Decision Method (CDM)

**What it is**: Deep retrospective interview about a past critical incident.

**Why not here**: Requires a real incident that already happened. We're simulating, not recalling.

**When to use**: Post-playtest interviews with real players about memorable moments.

### Stimulated Recall

**What it is**: Show participant a recording of their behavior to prompt deeper recall.

**Why not here**: Requires actual recording. In simulation, we generate rather than recall.

**When to use**: After real playtests, showing players video of their session.

---

## Persona Roughness Patterns (Authenticity)

Simulated personas often feel fake because they're too **coherent, cooperative, and focused**. Real users—especially tired/stressed ones—are messy.

### The "Expository Coherence" Anti-Pattern

**Bad** (persona narrates designer's intent):
> "오 뭐지 이거? 손에 뭐 묻었나? 아 피곤해서 그런가... 근데 '손을 보라'라... 뭔가 있나 보네."

**Good** (persona experiences actual confusion):
> "아.. 눈 아파. ...뭐야 이거? 손에 뭐 묻은 건가? 아, 화면이구나. 그래, 뭐... 알겠어. 넘어가자."

### Five Humanity Markers

Inject these into Think Aloud generation:

| Marker | Description | Korean Example |
|--------|-------------|----------------|
| **"음" Filter** | Dismissive acknowledgment before engaging | "음... 그래. 손이네." (not "오 뭐지 이거?") |
| **Sensory Glitch** | Physical/environmental interruption | "...잠깐, 슬랙인가? 아니네. 어디까지 했지?" |
| **Brute Force** | Choose fastest option when confused | "무슨 말인지 모르겠고. 그냥 이거." |
| **Semantic Drift** | Trail off, lose thread | "이거 열면 아마... 아 라떼 시킬 걸. 잠깐, 열렸네." |
| **Job Deformation** | Critique using work jargon | "이 온보딩 너무 느린데." / "밸류 프랍이 뭐야?" |

### Roughness Patterns by Persona State

| If persona is... | Add these patterns |
|------------------|--------------------|
| **Tired/Stressed** | Low-resolution processing, skip impulse, physical discomfort |
| **Skeptical** | "Bug" bias ("화면 더러운 건가?"), default cynicism |
| **Busy** | Context bleed (work thoughts), click-through impulse |
| **Experienced gamer** | Interface critique, comparison to other games |
| **Casual/New** | Confusion without curiosity, "this isn't for me" |

### Tired Person Think Aloud Patterns

Real tired people are **reductive** and **visceral**:

```
Scanning, not reading: "그래 다음. 어디... 됐고, 버튼."
Bug bias first: "화면 이상한가?" (not "마법이다!")
Default cynicism: System wastes my time assumption
Cognitive miserliness: Annoyance over curiosity at ambiguity
```

### Resistance Triggers

Real users push back when they hit:

| Trigger | Response |
|---------|----------|
| **Unclear ROI** | "이거 해서 뭐가 되는데?" |
| **Flowery prose** | "너무 길어. 안 읽을래." |
| **False agency** | "어차피 다 똑같은 거 아니야?" |
| **Broken mental model** | "이게 왜 여기 있어?" |

### Example: Before/After

**Original (too clean):**
> "와 진짜 열렸네!! 내 추론이 맞았어!"
> "목소리다! 누군데?? '아직 다 빼지 마라'... 뭔가 알고 있네?"

**Revised (messy, human):**
> "어? 열렸네. 그냥 찍었는데. (허탈한 웃음)"
> "근데 흰색? 목소리... 아 텍스트 읽기 귀찮은데. 누구세요- 빨리 좀. 뭔 말이 이렇게 많아."

---

## Cognitive Realism Patterns

### Inarticulation Markers

Real people don't speak in clean, complete sentences. Inject these into Think Aloud generation to increase authenticity.

| Marker | Description | Korean Example |
|--------|-------------|----------------|
| **Trailing thought** | Abandons thought mid-stream | "이거 왜... 아 됐고." |
| **False start** | Restarts sentence with different framing | "그러니까 이게- 아니 저게-" |
| **Placeholder hedging** | Uses vague words when thinking | "뭔가... 그냥... 이상해." |
| **Self-correction** | Revises claim while speaking | "무섭다기보다는... 아니 무섭긴 한데..." |
| **Filler sounds** | Non-word vocalizations | "음...", "어...", "그..." |
| **Repetition** | Repeats words while processing | "그래서 그래서... 이게..." |

**Usage rule**: 1 inarticulate marker per 3 articulate thoughts.

### Forgetting Mechanics

Real people have limited working memory. Model this explicitly to create authentic confusion and errors.

**Forgetting Roll (before each Think Aloud)**

| Working Memory Level | Forgetting Probability | What Gets Dumped |
|---------------------|------------------------|------------------|
| Low WM | 60% | Oldest 2 items |
| Medium WM | 40% | Oldest 1 item |
| High WM | 20% | Random item if buffer full |

**After Forgetting Occurs**

| Response Type | Description | Example |
|---------------|-------------|---------|
| **Gap awareness** | Notices missing info | "잠깐, 아까 뭐라고 했지?" |
| **Gap unawareness** | Proceeds with wrong assumption | (acts on incomplete info) |
| **Confabulation** | Invents detail to fill gap | (wrong but confident) |

**Working Memory Buffer Template**

Track explicitly for each persona:

```
Working Memory Buffer [Capacity: 5 items]
- [1] "문 손잡이가 따뜻함" (turn 2)
- [2] "경고문이 있었음" (turn 2)
- [3] [DUMPED - was "창문이 열려있음"]
- [4] "목소리가 들림" (turn 4)
- [5] [EMPTY]

Confused about: "창문" → thinks it was closed (wrong)
```

### Drive-Adaptive Think Aloud

Different exploration drives produce different verbalization patterns.

| Drive | Focus | Voice Quality | Example |
|-------|-------|---------------|---------|
| **ARCHITECT** | Rules, systems | Analytical, questioning | "손잡이가 따뜻하면 위험하다고 했나?" |
| **LITERARY** | Prose, themes | Aesthetic, appreciative | "빛의 부재가... 괜찮은 표현이네." |
| **SENSORY** | Actions, outcomes | Impatient, terse | "그래그래. 열었다. 뭐?" |
| **REFUGE** | Exits, completion | Depleted, minimal | "이것만 하면 되지?" |

**Voice Modulation by Energy Level**

| Energy | Voice Quality | Example Transformation |
|--------|---------------|------------------------|
| High (4-5) | Full sentences, curiosity | "이거 뭐지? 왜 이렇게 만들었을까?" |
| Medium (3) | Normal processing | "음, 그래. 다음은..." |
| Low (1-2) | Fragments, dismissive | "됐고. 다음." |

---

## Research-Backed Enhancements (2026)

The following patterns are derived from cross-model research (Claude, Codex, Gemini) on ACTA methods, cognitive architectures, working memory, and verbal protocol validity.

### Compressed CDM + Knowledge Audit Hybrid

Use this 5-phase structure for 20-30 minute sessions:

| Phase | Duration | Focus | Key Probe |
|-------|----------|-------|-----------|
| 1. Micro-Incident Identification | 3 min | Find 1-2 "interpretation choke points" | "어디서 혼란스러웠어요?" |
| 2. Timeline + Affect Pass | 5 min | Reconstruct sequence with emotional state | "그때 기분이 어땠어요?" |
| 3. Cue/Expectation Pass | 5 min | What they noticed, what they expected | "뭐가 보였어요? 뭐가 나올 줄 알았어요?" |
| 4. Alternative/What-If Pass | 5 min | Explore rejected options | "다른 건 왜 안 했어요?" |
| 5. Consistency Check | 5 min | Replay with slight reframe to validate | "만약 [X 달랐다면]?" |

**Critical Rule**: Concrete-Before-Abstract. Never ask "why" before reconstructing what happened.

### Interpretation Points vs Decision Points

For player personas, replace "decision points" with **interpretation points**:

| Traditional CTA | Game Persona Adaptation |
|-----------------|-------------------------|
| Noticing | What did you think the game was telling you? |
| Diagnosing | What did you think was going wrong? |
| Predicting | What did you expect would happen next? |
| Acting | What did you think your options were? |
| Improvising | Did you try anything the game "wasn't asking"? |

### Validation Mechanisms

| Mechanism | Purpose | Probe |
|-----------|---------|-------|
| **Consistency Check** | Authentic personas maintain coherent logic | Replay same incident with slight reframe |
| **What-If Hypotheticals** | Test model depth | "만약 [X] 달랐다면 뭐 했을까요?" |
| **Pathological Heuristics** | Capture irrational patterns | "이건 왜 절대 안 하세요?" |

### Interpretation Choke Point Library

Common points where player understanding diverges from designer intent:

| Choke Point | Description | Example Probe |
|-------------|-------------|---------------|
| Ambiguous verb parsing | "examine" vs "use" vs "take" | "이 버튼이 뭘 할 것 같았어요?" |
| Unclear stakes | What is actually at risk? | "뭐가 걸려있다고 생각했어요?" |
| False affordances | UI suggests non-existent options | "이거 클릭하면 뭐가 될 줄 알았어요?" |
| Goal misalignment | Player vs designer objectives differ | "뭘 하려고 했어요?" |

---

### Framework-Based Persona Templates

Map personas to cognitive frameworks based on research on ACT-R, SOAR, NDM, and Bounded Rationality:

| Persona Type | Cognitive Framework | Characteristic Pattern |
|--------------|---------------------|------------------------|
| **Novice** | Bounded Rationality | Satisficing, first-acceptable choice |
| **Expert** | NDM/RPD | Pattern recognition, mental simulation |
| **Strategist** | SOAR | Impasse detection, subgoaling |
| **Tired/Depleted** | ACT-R Decay | Memory failures, serial bottlenecks |
| **Skeptic** | Epistemic Vigilance | Narrator distrust, boundary testing |

### Diegetic Cognitive Load Effects

High cognitive load should degrade Think Aloud syntax:

| Load Level | Speech Pattern | Example |
|------------|----------------|---------|
| Low | Complete sentences | "문을 열면 아마 뭔가 있을 것 같아." |
| Medium | Abbreviated | "문... 열어볼게." |
| High | Fragments, placeholders | "고블린... 칼... 잠깐..." |
| Overload | Silence or tunnel vision | [silence] or "일단 이거!" |

### Error Taxonomy

Distinguish error types for authentic simulation:

| Error Type | Source | Example |
|------------|--------|---------|
| **Misread** | Perceptual | Skimmed too fast, missed key word |
| **Misconstrual** | Model | Built wrong mental model from text |
| **Misremembered** | Memory | Forgot or conflated earlier details |

---

### Working Memory Constraints (Baddeley Model)

**4-Chunk Filter**: Only 4 elements in conscious awareness at once.

**2-Second Decay**: Thoughts in phonological loop decay within ~2 seconds.
- If interrupted: "뭐였지... 아 맞다, 그거."
- If lost: Acts on incomplete info without awareness.

**Articulatory Suppression**: During verbally-heavy tasks (reading dense text), verbalization capacity is reduced.

**Implementation**:
```
Before Think Aloud:
1. Roll for forgetting (per Forgetting Mechanics section)
2. Check if task is verbally-heavy → reduce output
3. Apply 4-chunk limit to current awareness
4. Generate based on what survives, not full game state
```

### Shallow Placeholders Over Rationalizations

When personas don't know why they did something:

| Bad (LLM default) | Good (authentic) |
|-------------------|------------------|
| "안전해 보여서 선택했어요." | "몰라... 그냥?" |
| "논리적으로 A가 더 나았어요." | "음... 뭐지? 됐고, 이거." |
| "이 선택이 결과적으로..." | "아 그랬나?" |

**Rule**: Prefer confusion/uncertainty over invented rationalization.

---

### Ericsson & Simon Verbalization Levels

| Level | Description | Reactivity | Use When |
|-------|-------------|------------|----------|
| **Level 1** | Direct vocalization of verbal info in WM | Non-reactive | Reading text, immediate reactions |
| **Level 2** | Recoding non-verbal to speech | Non-reactive (temporal) | Visual processing, spatial reasoning |
| **Level 3** | Explanation, introspection | **Reactive** | NEVER during gameplay; only at natural pauses |

**Critical**: LLMs default to Level 3 (trained to be helpful/explanatory). Force Level 1/2 by:
- Using "What are you noticing?" not "Why did you choose that?"
- Injecting linguistic entropy (false starts, incomplete thoughts)
- Modeling silence during high-load moments

### Probe Phrasing (Non-Reactive)

| Reactive (avoid) | Non-Reactive (use) |
|------------------|-------------------|
| "왜 그걸 선택했어요?" | "뭐가 눈에 들어왔어요?" |
| "어떤 전략을 쓰고 있어요?" | "지금 뭘 보고 있어요?" |
| "그게 옳은 선택인 것 같아요?" | "다음에 뭐가 나올 것 같아요?" |

### Silence Management

| Silence Type | Interpretation | Action |
|--------------|----------------|--------|
| **Meditative** (3-5 sec) | Deep processing | Wait, never interrupt |
| **Searching** (5-10 sec) | Trying to remember/decide | Gentle restatement if needed |
| **Stuck** (10+ sec) | Cognitive overload or confusion | Offer simplifying probe |

**Rule**: Wait 3-5 seconds after participant finishes before next probe.

### Fatigue Detection Signals

| Signal | Validated Response |
|--------|-------------------|
| Reduced verbalization | Pause, offer break |
| Strategy simplification | Shift to easier questions |
| Binary answers | Ask for elaboration |
| Explicit end request | Honor immediately |
| Increased errors | Note as data, don't correct |

---

## Output Format Templates

Used during Phase 5 (Synthesis) based on the session intention.

### Expert Patterns Map

For `expertise-map` intention:

```markdown
## Expert Patterns Map: [Expert Description]

### Pattern Library
| Pattern Name | Recognition Cues | Typical Response | When It Fails |
|--------------|------------------|------------------|---------------|
| [Name] | [What they notice] | [What they do] | [Edge cases] |

### Tacit Knowledge Surfaced
- [Insight that expert couldn't easily articulate]
- [Implicit assumption revealed]

### Expert vs Novice Delta
What does this expert see that novices miss?
```

### Decision Framework

For `decision-rationale` intention:

```markdown
## Decision Framework: [Expert Description]

### Decision Factors (Ranked)
1. [Most important factor] - Weight: High
2. [Secondary factor] - Weight: Medium
...

### Trade-off Patterns
| When facing... | Expert trades... | For... |
|----------------|------------------|--------|

### Decision Heuristics
Rules of thumb the expert uses
```

### Mental Model

For `mental-model` intention:

```markdown
## Mental Model: [Expert Description]

### System Representation
How the expert conceptualizes the domain

### Key Entities
What objects/concepts exist in their model

### Relationships
How entities interact in their understanding

### Boundaries
What's inside vs outside their model
```

### Unknown Unknowns

For `knowledge-gap` intention:

```markdown
## Unknown Unknowns: [Expert Description]

### Edge Cases Handled
Unusual situations the expert has encountered

### Failure Modes Known
What can go wrong and how they detect it

### Boundary of Expertise
Where the expert's knowledge runs out

### Transfer Questions
What would the expert need to learn for new contexts?
```

---

## Sources

- Klein, G. A. (1993). A Recognition-Primed Decision (RPD) Model of Rapid Decision Making. In G. A. Klein, J. Orasanu, R. Calderwood, & C. E. Zsambok (Eds.), Decision Making in Action: Models and Methods (pp. 138-147). Ablex.
- Militello, L. G., & Hutton, R. J. (1998). Applied cognitive task analysis (ACTA): a practitioner's toolkit for understanding cognitive task demands. Ergonomics, 41(11), 1618-1641.
- Ericsson, K. A., & Simon, H. A. (1984). Protocol analysis: Verbal reports as data. MIT Press.
- Nielsen, J. (1993). Usability Engineering. Academic Press.
- Reynolds, T. J., & Gutman, J. (1988). Laddering theory, method, analysis, and interpretation. Journal of Advertising Research, 28(1), 11-31.
- Fox, M. C., Ericsson, K. A., & Best, R. (2011). Do procedures for verbal reporting of thinking have to be reactive? A meta-analysis and recommendations for best reporting methods. Psychological Bulletin, 137(2), 316-344.
- Hoffman, R. R., Crandall, B., & Shadbolt, N. (1998). Use of the Critical Decision Method to elicit expert knowledge: A case study in the methodology of cognitive task analysis. Human Factors, 40(2), 254-276.
- Baddeley, A. D. (2000). The episodic buffer: a new component of working memory? Trends in Cognitive Sciences, 4(11), 417-423.
- Kahneman, D. (2011). Thinking, Fast and Slow. Farrar, Straus and Giroux.
