# CAD Workbench

License-free CAD/DXF inspection and QA loop for Tower Runtime Box.

## Responsibility

This module owns the first CAD Workbench beta CLI used by the CAD-included Runtime Box image. It lets AI inspect, render, QA, normalize, and compare DXF files before handing them to users.

## Public API

- `cad_workbench.py inspect <file.dxf>` — structure, layers, text count, entity count, modelspace bounds
- `cad_workbench.py render <file.dxf> --view full|content --out preview.png` — open-stack preview render
- `cad_workbench.py qa <file.dxf> --out <dir>` — inspect + full/content previews + `qa.json`
- `cad_workbench.py normalize <file.dxf> --out normalized.dxf` — write a translated copy near origin
- `cad_workbench.py compare before.dxf after.dxf --out <dir>` — before/after content previews and diff

Docker image:

- `packages/backend/sandbox-images/runtime-box-node22-python313-cad/Dockerfile`
- tag: `tower-runtime-box:node22-python313-cad`

## Important boundaries

- DXF-first. DWG conversion is not part of the MVP.
- License-free/open-stack only: `ezdxf + matplotlib + Pillow`.
- This is a preview/QA workbench, not native CAD sign-off.
- Original files are preserved; mutation commands write copies and operation logs.

## Smoke test

From repo root:

```bash
packages/backend/cad-workbench/tests/smoke.sh
```

Docker image:

```bash
docker build -t tower-runtime-box:node22-python313-cad \
  -f packages/backend/sandbox-images/runtime-box-node22-python313-cad/Dockerfile \
  packages/backend/

docker run --rm tower-runtime-box:node22-python313-cad runtime-box-cad-doctor
```

## Related decision

- `~/workspace/decisions/2026-07-05-runbox-cad-workbench-beta.md`
