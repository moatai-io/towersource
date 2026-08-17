# Tower Project Runtime Box — CAD Workbench variant.
#
# Purpose:
#   Dev-first CAD/DXF workbench image for license-free CAD inspection, preview,
#   QA, normalize, and before/after comparison loops.
#
# Build:
#   docker build -t tower-runtime-box:node22-python313-cad \
#     -f packages/backend/sandbox-images/runtime-box-node22-python313-cad/Dockerfile \
#     packages/backend/
#
# Boundary:
#   This image intentionally does NOT include QCAD/ODA-style proprietary
#   renderers. First implementation uses ezdxf + matplotlib + Pillow.

ARG BASE_IMAGE=tower-runtime-box:node22-python313
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

# License-free CAD stack. Matplotlib/Pillow already exist in the base image, but
# keeping them here documents the CAD image contract and makes standalone rebuilds
# robust if the base image changes.
RUN pip install --no-cache-dir \
      'ezdxf==1.*' \
      'pillow==11.*' \
      'matplotlib==3.*'

COPY cad-workbench/cad_workbench.py /usr/local/bin/cad-workbench
COPY sandbox-images/runtime-box-node22-python313-cad/runtime-box-cad-doctor /usr/local/bin/runtime-box-cad-doctor
RUN chmod +x /usr/local/bin/cad-workbench /usr/local/bin/runtime-box-cad-doctor \
 && ln -sf /usr/local/bin/cad-workbench /usr/local/bin/cad_workbench

LABEL tower.runtime-box.profile="node22-python313" \
      tower.runtime-box.capability="cad-workbench-beta" \
      tower.runtime-box.cad.renderer="ezdxf-matplotlib" \
      tower.runtime-box.cad.license="open-stack"
