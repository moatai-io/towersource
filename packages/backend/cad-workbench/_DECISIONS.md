# CAD Workbench decisions

## 2026-07-05 — DXF-first, license-free, dev-first

- Start with current Tower dev environment, not direct demo-org VM testing.
- Keep RuntimeProfile unified for the first beta.
- Use a CAD-included image variant: `tower-runtime-box:node22-python313-cad`.
- Do not include QCAD/ODA-style proprietary renderers in the first implementation.
- Use `ezdxf` as the model/parser/editor layer and `matplotlib + Pillow` for preview rendering and image metrics.
- Treat visual output as preview/QA evidence, not engineering sign-off.
- Preserve originals and write normalized/fixed copies with operation logs.

Rationale: prove the AI CAD closed loop first — inspect, render, QA, normalize, compare — without introducing licensing, profile switching, or self-hosted server rollout complexity.

Related: `~/workspace/decisions/2026-07-05-runbox-cad-workbench-beta.md`
