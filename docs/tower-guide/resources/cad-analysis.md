# Tower CAD Analysis Guide Resource

Use this guide when inspecting or understanding CAD/DXF/DWG drawings visually.

## Core rule

`cad_view` is a visual preview tool. It helps the AI inspect drawings, but it is not a substitute for native CAD review when dimensions, tolerances, compliance, or legal/engineering sign-off are critical.

## Tool choice

- `cad_view`: render DXF/DWG into an internal cached image and inspect with vision.
- Do not use OCR/text extraction as a CAD fallback unless the user specifically asks for text labels only.
- Do not write rendered CAD images into the project unless the user explicitly asks for image artifacts.

## DXF vs DWG

- DXF is supported through Tower's fleet-baseline Python `ezdxf` renderer.
- DWG requires a configured global QCAD/ODA-style renderer.
- If DWG rendering fails because no global renderer is available, report that concrete dependency gap. Do not try unrelated OCR or generic text tools as if they could replace CAD rendering.

## Rendering options

- Increase width/height for dense drawings or small annotations.
- Use higher contrast background when linework is hard to see.
- Monochrome line art is usually best for structural/technical review; color can matter when layers encode semantics.

## Reporting guidance

When reporting CAD findings:

1. State that the result is from a visual preview.
2. Mention visible sheets/regions, major drawing elements, annotations, and obvious inconsistencies.
3. Avoid pretending exact scale/tolerance certainty unless dimensions are legible and the user accepts preview-level confidence.
4. For operationally critical dimensions, ask for native CAD review or provide a checklist for a human CAD reviewer.

## Cache and artifacts

Rendered images are kept in Tower internal cache and are not written into the project folder. If the user requests exported images, create explicit project artifacts and hand off their workspace paths.
