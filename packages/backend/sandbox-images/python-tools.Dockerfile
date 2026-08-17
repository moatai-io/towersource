# Tower sandbox python-tools variant — Python + 흔한 binary 도구 사전 설치
#
# 결정: workspace/decisions/2026-05-11-sandbox-binary-tool-policy.md (D15 Track A)
# 사용: sandbox.run({ runtime: 'python-tools', ... })
#
# 포함:
#   - python3.12 stdlib + Pillow/pypdf/openpyxl/python-docx/pdfplumber (자주 쓰는 문서 처리)
#   - FFmpeg (영상)
#   - LibreOffice headless (.docx/.pptx/.xlsx → PDF 변환)
#   - Tesseract OCR + 한글/영문 traineddata
#   - Pandoc (마크다운 → PDF/DOCX 등)
#   - GhostScript + ImageMagick (PDF/이미지 처리)
#   - 한글 폰트 (Noto Sans CJK, Pretendard)
#   - qpdf, poppler-utils (PDF 인스펙션)
#
# 이미지 크기 예상: 1.5~2GB. 첫 pull 후 layer caching 으로 컨테이너 시작 < 1초.
# 새 도구 추가는 이 파일 PR. admin + operator 가 갱신 가능 (PR 코드 리뷰 거침).

FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# system binaries
RUN apt-get update && apt-get install -y --no-install-recommends \
    # 영상 / 오디오
    ffmpeg \
    # 문서 변환
    libreoffice-core \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    pandoc \
    # PDF / 이미지
    ghostscript \
    imagemagick \
    qpdf \
    poppler-utils \
    # OCR
    tesseract-ocr \
    tesseract-ocr-kor \
    tesseract-ocr-eng \
    # 한글 폰트
    fonts-noto-cjk \
    fonts-noto-cjk-extra \
    # 빌드 보조 (Pillow 등이 필요할 때)
    libjpeg62-turbo \
    libpng16-16 \
    libtiff6 \
    # 유틸 (curl/wget/jq — 2026-05-18 sandbox-policy-vs-enforcement-gap 후속)
    curl \
    wget \
    jq \
    unzip \
    git \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Pretendard 폰트 (한국어 UI 자료에 자주 쓰임)
RUN mkdir -p /usr/share/fonts/truetype/pretendard \
 && curl -fsSL -o /tmp/pretendard.zip \
    https://github.com/orioncactus/pretendard/releases/download/v1.3.9/Pretendard-1.3.9.zip \
 && unzip -q /tmp/pretendard.zip -d /tmp/pretendard \
 && cp /tmp/pretendard/public/static/*.otf /usr/share/fonts/truetype/pretendard/ \
 && fc-cache -fv \
 && rm -rf /tmp/pretendard /tmp/pretendard.zip

# ImageMagick 의 기본 policy 가 PDF read 를 막아둠 — 컨테이너 격리 환경이라 풀어줌
RUN if [ -f /etc/ImageMagick-6/policy.xml ]; then \
    sed -i 's|<policy domain="coder" rights="none" pattern="PDF" />|<policy domain="coder" rights="read|write" pattern="PDF" />|' /etc/ImageMagick-6/policy.xml; \
    fi

# uv (Q4 표준 — 2026-05-18 sandbox-policy-vs-enforcement-gap)
RUN pip install --no-cache-dir uv \
 && rm -rf /root/.cache

# python 라이브러리 — 문서 / 데이터 처리 표준
RUN pip install --no-cache-dir \
    'Pillow==10.*' \
    'pypdf==4.*' \
    'pdfplumber==0.11.*' \
    'openpyxl==3.1.*' \
    'python-docx==1.1.*' \
    'python-pptx==1.0.*' \
    'reportlab==4.*' \
    'beautifulsoup4==4.12.*' \
    'lxml==5.*' \
    'pyyaml==6.*' \
    'requests==2.32.*' \
 && rm -rf /root/.cache

WORKDIR /workspace
CMD ["python", "-V"]
