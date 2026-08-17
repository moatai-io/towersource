# Tower Project Runtime Box — node22 LTS + python3.13 variant.
# 목적: 프로젝트별 공유 개발 컨테이너. npm / node / python / pip / uv / git 모두 제공.
# 결정: workspace/decisions/2026-06-02-project-runtime-box-product-framing.md
#
# 빌드:
#   docker build -t tower-runtime-box:node22-python313 \
#     packages/backend/sandbox-images/runtime-box-node22-python313/
#
# 사용: RUNTIME_BOX_IMAGE=tower-runtime-box:node22-python313 (config.runtimeBox.image)
#
# 설계 원칙:
#   - v1 편의성 우선. 보안 최소화는 v2(--cap-drop ALL + non-root --user)로 예정.
#   - Tower host secrets(DATABASE_URL, JWT_SECRET 등) 컨테이너에 주입 금지.
#   - Docker socket 마운트 금지 (runtime-box-manager.ts 참조).
#   - project folder는 /workspace에 rw mount됨. 이 이미지는 /workspace를 WORKDIR만 잡음.
#
# 버전 기준 (2026-07-14):
#   - Python 3.13 — python:3.13-slim 공식 이미지 기반
#   - Node.js 22 LTS — 현재 Active LTS (2027-04까지)
#   - Typst 0.15.0 / Pandoc 3.10 / Mermaid CLI 11.16.0 — upstream 최신 안정 고정

ARG BASE_IMAGE=python:3.13-slim
FROM ${BASE_IMAGE}

# ── 기본 환경 ────────────────────────────────────────────────────────────
ARG TYPST_VERSION=0.15.0
ARG TYPST_SHA256=59b207df01be2dab9f13e80f73d04d7ff8273ffd46b3dd1b9eef5c60f3eeabea
ARG PANDOC_VERSION=3.10
ARG PANDOC_SHA256=e0f8af62d0f267d22baa5bcefe6d5dda3a097ccc60de794b759fe03159923244
ARG MARP_CLI_VERSION=4.4.1
ARG PLAYWRIGHT_CORE_VERSION=1.61.1
ARG SVGO_VERSION=4.0.2
# 0.18.0+ adds Gmail helper attachment streaming via `gws gmail +send -a`,
# avoiding Linux ARG_MAX failures from embedding base64 MIME payloads in --json.
# 0.22.5 also provides draft support and verified release artifact checks.
ARG GWS_CLI_VERSION=0.22.5

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_PATH=/usr/lib/node_modules:/usr/local/lib/node_modules

# ── Node.js 22 LTS (NodeSource 공식 패키지) ─────────────────────────────
# python:3.13-slim은 Debian Bookworm 기반이라 apt에 Node가 없음 — nodesource 사용
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
      gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# ── 빌드 도구 + 일반 CLI + 문서/도면/브라우저 처리 도구 ────────────────────
# Runtime Box는 사용자가 "로컬 개발 환경"처럼 느껴야 한다. 따라서 Tower host 에서
# 기본처럼 쓰는 문서/PDF/브라우저/이미지 유틸리티도 프로젝트 경계 안에 포함한다.
# 운영/인프라 권한 도구(az/docker/kubectl/pm2/systemctl)는 intentionally 제외한다.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      fd-find \
      ffmpeg \
      file \
      fontconfig \
      fonts-nanum \
      fonts-nanum-extra \
      fonts-noto-cjk \
      fonts-noto-cjk-extra \
      fonts-noto-color-emoji \
      fonts-inter \
      ghostscript \
      git \
      imagemagick \
      jq \
      less \
      libreoffice \
      libreoffice-java-common \
      librsvg2-bin \
      libjpeg62-turbo \
      libpng16-16 \
      libtiff6 \
      openjdk-21-jre-headless \
      openssh-client \
      openssl \
      pkg-config \
      poppler-utils \
      procps \
      python3-venv \
      qpdf \
      ripgrep \
      rsync \
      tesseract-ocr \
      tesseract-ocr-eng \
      tesseract-ocr-kor \
      unzip \
      wget \
      xz-utils \
      yq \
      zip \
 && if apt-cache show chromium >/dev/null 2>&1; then apt-get install -y --no-install-recommends chromium; \
    elif apt-cache show chromium-browser >/dev/null 2>&1; then apt-get install -y --no-install-recommends chromium-browser; \
    else echo "WARN: chromium package not available in this Debian base; browser doctor may warn"; fi \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && fc-cache -f \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# 출판 toolchain은 Debian apt의 오래된 Pandoc에 기대지 않고 upstream release를
# checksum으로 고정한다. Typst/Pandoc은 x86_64 Runtime Box baseline 전용이다.
RUN curl -fsSL -o /tmp/typst.tar.xz \
      "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
 && echo "${TYPST_SHA256}  /tmp/typst.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/typst \
 && tar -xJf /tmp/typst.tar.xz --strip-components=1 -C /opt/typst \
 && ln -sf /opt/typst/typst /usr/local/bin/typst \
 && typst --version \
 && curl -fsSL -o /tmp/pandoc.tar.gz \
      "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-linux-amd64.tar.gz" \
 && echo "${PANDOC_SHA256}  /tmp/pandoc.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/pandoc \
 && tar -xzf /tmp/pandoc.tar.gz --strip-components=1 -C /opt/pandoc \
 && ln -sf /opt/pandoc/bin/pandoc /usr/local/bin/pandoc \
 && ln -sf /opt/pandoc/bin/pandoc-lua /usr/local/bin/pandoc-lua \
 && ln -sf /opt/pandoc/bin/pandoc-server /usr/local/bin/pandoc-server \
 && pandoc --version | head -1 \
 && rm -f /tmp/typst.tar.xz /tmp/pandoc.tar.gz

# Pretendard 폰트 (한국어 UI/슬라이드/리포트에서 가장 자주 쓰는 품질 기준).
# Host VM의 ensure-rendering-baseline.sh와 같은 HTML 렌더링 baseline을 맞춘다.
# Runbox preview/crop과 host pdf_export 결과의 폰트 fallback 차이를 줄이는 것이 목적이다.
RUN mkdir -p /usr/share/fonts/truetype/pretendard \
 && curl -fsSL -o /tmp/pretendard.zip \
    https://github.com/orioncactus/pretendard/releases/download/v1.3.9/Pretendard-1.3.9.zip \
 && unzip -q /tmp/pretendard.zip -d /tmp/pretendard \
 && cp /tmp/pretendard/public/static/*.otf /usr/share/fonts/truetype/pretendard/ \
 && fc-cache -f \
 && rm -rf /tmp/pretendard /tmp/pretendard.zip

# ImageMagick 기본 policy는 PDF read/write를 막는 경우가 있다. Runtime Box는 프로젝트
# 격리 컨테이너이므로 PDF contact sheet/thumbnail 워크플로우가 작동하도록 풀어둔다.
RUN if [ -f /etc/ImageMagick-6/policy.xml ]; then \
      sed -i 's|<policy domain="coder" rights="none" pattern="PDF" />|<policy domain="coder" rights="read|write" pattern="PDF" />|' /etc/ImageMagick-6/policy.xml; \
    fi

# ── Python 기본 유틸 + PDF/도면 분석 라이브러리 ───────────────────────────
# python:3.13-slim 공식 이미지는 /usr/local/bin/python — PEP 668 차단 없음
# Runtime Box는 프로젝트 폴더를 /workspace에 직접 mount하므로, 큰 PDF/스캔 도면은
# sandbox tar 전송 대신 여기서 바로 렌더링/텍스트 추출/OCR 전처리한다.
RUN pip install --no-cache-dir \
      uv \
      'pillow==11.*' \
      'pypdf==5.*' \
      'pdfplumber==0.11.*' \
      'pymupdf==1.*' \
      'openpyxl==3.1.*' \
      'python-docx==1.1.*' \
      'python-pptx==1.0.*' \
      'reportlab==4.*' \
      'pandas==2.*' \
      'matplotlib==3.*' \
      'pyyaml==6.*' \
      'beautifulsoup4==4.12.*' \
      'lxml==5.*' \
      'requests==2.32.*' \
 && rm -rf /root/.cache/pip

# ── npm 글로벌 도구 ───────────────────────────────────────────────────────
# Marp/Mermaid CLI 는 브라우저 기반 렌더링 계열 스킬의 편의 경로다. Chromium 은
# system package 를 우선 사용하도록 다운로드를 막아 이미지 drift 를 줄인다.
# Mermaid와 transitive dependencies는 lockfile + npm integrity로 재현한다.
# web-capture 는 playwright-core + /usr/bin/chromium 조합을 기본으로 쓴다.
# Playwright browser bundle 은 다운로드하지 않는다 (용량/드리프트/중복 방지).
COPY publishing-package.json /opt/tower-publishing/package.json
COPY publishing-package-lock.json /opt/tower-publishing/package-lock.json
RUN cd /opt/tower-publishing \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --quiet \
 && ln -sf /opt/tower-publishing/node_modules/.bin/mmdc /usr/local/bin/mmdc \
 && npm install -g \
      pnpm \
      "playwright-core@${PLAYWRIGHT_CORE_VERSION}" \
      "@marp-team/marp-cli@${MARP_CLI_VERSION}" \
      "svgo@${SVGO_VERSION}" \
      "@googleworkspace/cli@${GWS_CLI_VERSION}" \
      --no-audit --no-fund --quiet \
 && npm cache clean --force \
 && test "$(mmdc --version)" = "11.16.0" \
 && gws --version | grep -q "${GWS_CLI_VERSION}"

# ── Runtime readiness doctors / rendering wrappers ───────────────────────
COPY runtime-box-doctor /usr/local/bin/runtime-box-doctor
COPY runtime-skill-doctor /usr/local/bin/runtime-skill-doctor
COPY tower-html-render /usr/local/bin/tower-html-render
RUN chmod +x /usr/local/bin/runtime-box-doctor /usr/local/bin/runtime-skill-doctor /usr/local/bin/tower-html-render

# ── non-root user (Phase 2 준비) ─────────────────────────────────────────
# v1에서는 root로 실행. --cap-drop ALL + --user 1001:1001 은 Phase 2에서 적용.
RUN groupadd -g 1001 boxuser \
 && useradd -u 1001 -g boxuser -m -s /bin/bash boxuser

# ── 기본 작업 디렉토리 ───────────────────────────────────────────────────
WORKDIR /workspace

# ── 기본 명령 ────────────────────────────────────────────────────────────
# runtime-box-manager.ts가 sleep infinity 로 override하므로 실제 사용 안 됨
CMD ["bash"]
