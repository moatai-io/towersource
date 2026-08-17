# Pre-Mortem

Trigger sentences are fully self-contained — do NOT paraphrase, abbreviate, or substitute variables.

## Trigger Sentences

**Software**:
> Assume this plan was implemented exactly as written and failed badly in production — write a post-mortem identifying the most likely root causes, with specific references to gaps or assumptions in this document.

**Business**:
> Assume this strategy was executed exactly as written and the company lost significant market share within 18 months — write a post-mortem identifying the most likely root causes, with specific references to gaps or assumptions in this document.

**Research**:
> Assume this study was conducted exactly as designed and the results were rejected by peer reviewers as methodologically unsound — write a post-mortem identifying the most likely root causes, with specific references to gaps or assumptions in this design.

**Education**:
> Assume this curriculum was delivered exactly as designed and students consistently failed to achieve the stated learning objectives — write a post-mortem identifying the most likely root causes, with specific references to gaps or assumptions in this plan.

**Policy**:
> Assume this policy was enacted exactly as written and produced significant unintended consequences that harmed the populations it was designed to protect — write a post-mortem identifying the most likely root causes, with specific references to gaps or assumptions in this document.

**Creative**:
> Assume this project was executed exactly as planned and was widely criticized by the target audience as a failure — write a post-mortem identifying the most likely root causes, with specific references to gaps or assumptions in this brief.

## Artefact Format

```markdown
## Risk Report (Pre-Mortem)

### Failure Scenario

[Narrative: what went wrong, written as a past-tense post-mortem]

### Root Causes

| # | Root Cause | Plan Section | Severity |
|---|-----------|-------------|----------|
| 1 | [cause] | [section/heading reference] | Critical / High / Medium |
| 2 | [cause] | [section/heading reference] | Critical / High / Medium |

### Assumptions Exposed

- **[Assumption]**: Assumed in [section]. Would fail if [condition].
```
