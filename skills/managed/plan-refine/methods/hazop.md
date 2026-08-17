# HAZOP

Trigger sentences are fully self-contained — do NOT paraphrase, abbreviate, or substitute variables.

## Trigger Sentences

**Software**:
> Apply HAZOP-style guideword analysis to the key data flows and state transitions in this plan: for each, consider what happens if the value is missing, duplicated, reversed, delayed, partial, or comes from an unexpected source — report only deviations that would cause user-visible or data-integrity impact.

**Business**:
> Apply HAZOP-style guideword analysis to the key revenue streams and market assumptions in this plan: for each, consider what happens if the value is zero, doubled, halved, reversed in direction, only partially realized, or comes from an unexpected segment — report only deviations that would cause significant financial or strategic impact.

**Research**:
> Apply HAZOP-style guideword analysis to the key variables and data collection procedures in this study design: for each, consider what happens if the measurement is missing, inflated, reduced, reversed, partial, or contaminated by an unexpected source — report only deviations that would threaten validity or replicability.

**Education**:
> Apply HAZOP-style guideword analysis to the key learning activities and assessment methods in this plan: for each, consider what happens if participation is zero, doubled, halved, misdirected, only partially completed, or disrupted by an unexpected factor — report only deviations that would significantly impact learning outcomes.

**Policy**:
> Apply HAZOP-style guideword analysis to the key enforcement mechanisms and compliance requirements in this policy: for each, consider what happens if compliance is zero, excessive, partial, reversed in intent, only selectively applied, or triggered by an unexpected population — report only deviations that would cause significant harm or undermine policy goals.

**Creative**:
> Apply HAZOP-style guideword analysis to the key audience interactions and creative elements in this plan: for each, consider what happens if engagement is zero, overwhelming, reduced, opposite to intended, only partial, or comes from an unintended audience — report only deviations that would significantly undermine the creative vision.

## Artefact Format

```markdown
## Risk Report (HAZOP)

### Deviation Register

| # | Parameter | Guideword | Deviation | Consequence | Severity |
|---|-----------|-----------|-----------|-------------|----------|
| 1 | [data flow/parameter] | NO / MORE / LESS / REVERSE / OTHER THAN / PART OF | [what happens] | [impact] | High / Medium |
| 2 | [data flow/parameter] | [guideword] | [what happens] | [impact] | High / Medium |

*Filtered to high-severity deviations only. Low-severity deviations omitted.*
```
