# Tower sandbox python-web variant — FastAPI + 표준 web stack.
# 결정: workspace/decisions/2026-04-28-execution-sandbox-q4-package-scope.md
#       workspace/decisions/2026-05-18-sandbox-policy-vs-enforcement-gap.md (curl/jq/uv 추가)
# 사용: sandbox.run({ runtime: 'python-web' })
FROM python:3.12-slim

# OS-level 기본 도구 — AI 가 흔히 호출하는 CLI 가 컨테이너 안에서 곧장 동작하도록.
# (이전엔 빠져있어서 모든 sandbox 호출에서 마찰 발생. 발견: 2026-05-18 검증)
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl wget jq ca-certificates \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# uv (Q4 표준 — pip 보다 빠르고 의존성 격리)
RUN pip install --no-cache-dir uv \
 && rm -rf /root/.cache

# 백엔드 핵심 (사용자 dogfooding 결과 — demo-org 의 FastAPI 시도가 막힘)
RUN pip install --no-cache-dir \
    'fastapi==0.118.*' \
    'uvicorn[standard]==0.32.*' \
    'httpx==0.27.*' \
    'pydantic==2.10.*' \
    'requests==2.32.*' \
 && rm -rf /root/.cache

# 컨테이너 안 working dir 은 Mode B 마운트가 덮어씀
WORKDIR /workspace

# 기본 명령은 sandbox.ts 가 sh -c 로 덮어쓰므로 의미 없지만 default 안전
CMD ["python", "-V"]
