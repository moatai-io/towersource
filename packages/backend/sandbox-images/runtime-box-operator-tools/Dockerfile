# Tower Project Runtime Box — operator-tools variant.
#
# Purpose:
#   Reproducible operator workbench profile for Tower ops projects.
#   This image adds client/operator CLIs on top of the default Runtime Box.
#
# Build:
#   docker build -t tower-runtime-box:operator-tools \
#     packages/backend/sandbox-images/runtime-box-operator-tools/
#
# Important boundary:
#   This image adds tools, not authority. Credentials, SSH access, DB access,
#   and mutating operations still require Credential Vault / user authority /
#   Execution Gate confirmation.
#
# Intentionally excluded:
#   - Docker socket / Docker CLI authority
#   - host PM2 control semantics. A container-local pm2 would not control host
#     tower-prod and would be misleading, so pm2 is not installed here.

ARG BASE_IMAGE=tower-runtime-box:node22-python313
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

# Operator client tools.
# - postgresql-client: DB metadata/query client only; credentials are not baked in.
# - gh: GitHub CLI binary only; tokens must come from Vault/trusted project policy.
#
# Debian bookworm has a `gh` package in most environments. If a downstream base
# lacks it, the build should fail loudly so the image definition stays explicit.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-client \
      gh \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

LABEL tower.runtime-box.profile="operator-tools" \
      tower.runtime-box.base="node22-python313" \
      tower.runtime-box.authority="tools-only-no-secrets"
