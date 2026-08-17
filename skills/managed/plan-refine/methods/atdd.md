# ATDD

Trigger sentences are fully self-contained — do NOT paraphrase, abbreviate, or substitute variables.

## Trigger Sentences

**Software**:
> For each requirement and design decision in this plan, write a concrete acceptance test that would verify correct implementation — flag anything that cannot be tested as underspecified.

**Research**:
> For each methodological choice and expected outcome in this study design, write a concrete verification criterion that would confirm the choice was sound — flag anything that cannot be empirically verified as underspecified.

## Artefact Format

```markdown
## Grounding Report (ATDD)

### Acceptance Criteria

| # | Requirement/Decision | Acceptance Test | Status |
|---|---------------------|-----------------|--------|
| 1 | [from plan] | [concrete test] | Testable / Underspecified |
| 2 | [from plan] | [concrete test] | Testable / Underspecified |

### Underspecification Flags

- **[Requirement]**: Cannot be tested because [specific reason]. Needs: [what would make it testable].
```
