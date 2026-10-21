{
  description = "Tower incremental Nix packages and development shell";

  inputs = {
    # Pin nixpkgs-unstable in flake.lock so the shell and immutable packages
    # can move independently from host package state while remaining reproducible.
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = pkgs.lib;
      python = pkgs.python314;
      sourceRev = self.rev or self.dirtyRev or "dirty-uncommitted";
      sourceShortRev = builtins.substring 0 12 sourceRev;
      publicRelease = if builtins.pathExists ./PUBLIC_RELEASE.json
        then builtins.fromJSON (builtins.readFile ./PUBLIC_RELEASE.json)
        else null;
      releaseChannel = if publicRelease != null then publicRelease.channel or "public" else "private";
      # Private builds preserve the historical revCount display contract. Sanitized
      # public exports have a fresh Git history, so they carry an explicit version in
      # PUBLIC_RELEASE.json rather than subtracting an unrelated private revCount.
      releaseBaseVersion = if publicRelease != null
        then publicRelease.version
        else "1.70.43";
      releaseBaseRevCount = 2186;
      sourceRevCount = self.revCount or releaseBaseRevCount;
      releaseCommitsSinceTag = if publicRelease != null
        then publicRelease.commitsSinceRelease or 0
        else sourceRevCount - releaseBaseRevCount;
      releaseVersion = if publicRelease != null
        then publicRelease.version
        else if releaseCommitsSinceTag > 0
          then "${releaseBaseVersion}+${toString releaseCommitsSinceTag}"
          else releaseBaseVersion;
      buildTime = "1970-01-01T00:00:00.000Z";
      flakeLockNarHash = "sha256-DaZXJb31rYEpOAPyp1GmlDnc8qwWtkAyVTe9Y7niOsQ=";

      rendererFonts = pkgs.symlinkJoin {
        name = "tower-renderer-fonts";
        paths = [
          pkgs.pretendard
          pkgs.noto-fonts-cjk-sans
          pkgs.noto-fonts-cjk-serif
          pkgs.nanum
          pkgs.nanum-gothic-coding
          pkgs.noto-fonts-color-emoji
          pkgs.inter
          pkgs.dejavu_fonts
          pkgs.liberation_ttf
        ];
      };
      # Harness document/CAD analysis tools execute one explicit Python runtime.
      # Keep every imported module in the signed app closure so pdf/excel/cad
      # tools never depend on mutable host pip state or PATH ordering.
      towerAnalysisPython = pkgs.python3.withPackages (ps: with ps; [
        pymupdf
        pdfplumber
        pillow
        pandas
        numpy
        openpyxl
        matplotlib
        ezdxf
      ]);
      # Project Worker baseline mirrors the Runtime Box's built-in work-computer
      # capabilities. Application dependencies remain Project-local via uv/npm.
      workerGws = pkgs.stdenv.mkDerivation {
        pname = "gws";
        version = "0.22.5";
        src = pkgs.fetchurl {
          url = "https://github.com/googleworkspace/cli/releases/download/v0.22.5/google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz";
          hash = "sha256-3njs29LxqEzKAGOn7LxEAkD8FLbrzLsX9GRreSqMXB8=";
        };
        sourceRoot = ".";
        nativeBuildInputs = [ pkgs.autoPatchelfHook pkgs.makeWrapper ];
        buildInputs = [ pkgs.stdenv.cc.cc.lib ];
        installPhase = ''
          mkdir -p "$out/bin"
          install -m755 gws "$out/bin/gws"
        '';
        # Trust belongs to the executable closure, not a controller-side
        # Credential path. Keep explicit custom CA settings for private PKI.
        postFixup = ''
          wrapProgram "$out/bin/gws" \
            --set-default SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
        '';
        doInstallCheck = true;
        installCheckPhase = ''
          "$out/bin/gws" --version | grep -F "gws 0.22.5"
        '';
      };
      workerPublishingTools = pkgs.buildNpmPackage {
        pname = "tower-worker-publishing-tools";
        version = "1.0.0";
        src = ./packages/backend/sandbox-images/runtime-box-node22-python313;
        postPatch = ''
          cp publishing-package.json package.json
          cp publishing-package-lock.json package-lock.json
        '';
        npmDepsHash = "sha256-LFh0KGxha4Z/NapkPSEd5ckvsGLi0KltpJhuWqIoAU0=";
        PUPPETEER_SKIP_DOWNLOAD = "true";
        dontNpmBuild = true;
        installPhase = ''
          mkdir -p "$out/lib/node_modules/tower-publishing-tools" "$out/bin"
          cp -R node_modules package.json package-lock.json "$out/lib/node_modules/tower-publishing-tools/"
          for command in mmdc marp svgo; do
            ln -s "$out/lib/node_modules/tower-publishing-tools/node_modules/.bin/$command" "$out/bin/$command"
          done
        '';
      };
      workerPandoc = pkgs.stdenvNoCC.mkDerivation {
        pname = "tower-worker-pandoc";
        version = "3.10";
        src = pkgs.fetchurl {
          url = "https://github.com/jgm/pandoc/releases/download/3.10/pandoc-3.10-linux-amd64.tar.gz";
          hash = "sha256-4PivYtDyZ9IrqlvO/m1d2joJfMxg3nlLdZ/gMVmSMkQ=";
        };
        sourceRoot = "pandoc-3.10";
        installPhase = ''
          mkdir -p "$out"
          cp -R bin share "$out/"
        '';
      };
      workerPython = pkgs.python313.withPackages (ps: with ps; [
        beautifulsoup4
        lxml
        matplotlib
        openpyxl
        pandas
        pdfplumber
        pillow
        pypdf
        pymupdf
        pyyaml
        python-docx
        python-pptx
        reportlab
        requests
        pip
      ]);
      workerBaseline = [
        pkgs.bash
        pkgs.bubblewrap
        pkgs.chromium
        pkgs.coreutils
        pkgs.curl
        pkgs.fd
        pkgs.ffmpeg
        pkgs.file
        pkgs.findutils
        pkgs.fontconfig
        pkgs.gawk
        pkgs.gcc
        pkgs.ghostscript
        pkgs.git
        pkgs.gnugrep
        pkgs.gnumake
        pkgs.gnused
        pkgs.gnutar
        pkgs.gzip
        pkgs.imagemagick
        pkgs.jdk21_headless
        pkgs.jq
        pkgs.less
        pkgs.libreoffice-fresh
        pkgs.librsvg
        pkgs.nodejs_22
        pkgs.openssh
        pkgs.openssl
        workerPandoc
        pkgs.pkg-config
        pkgs.pnpm
        pkgs.poppler-utils
        pkgs.qpdf
        pkgs.ripgrep
        pkgs.rsync
        (pkgs.tesseract.override { enableLanguages = [ "eng" "kor" ]; })
        pkgs.typst
        pkgs.unzip
        pkgs.util-linux
        pkgs.uv
        pkgs.wget
        pkgs.xz
        pkgs.yq-go
        pkgs.zip
        workerGws
        workerPublishingTools
        workerPython
      ];
      towerNixRender = pkgs.writeShellApplication {
        name = "tower-nix-render";
        runtimeInputs = [
          pkgs.chromium
          pkgs.coreutils
          pkgs.python3
          pkgs.which
        ];
        runtimeEnv = {
          CHROMIUM_PATH = "${pkgs.chromium}/bin/chromium";
          FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ rendererFonts ]; };
          TOWER_NIX_RENDERER_CLOSURE = "1";
        };
        text = builtins.readFile ./scripts/nix-renderer/tower-nix-render;
      };
      towerNixRendererCheck = pkgs.writeShellApplication {
        name = "tower-nix-render-check";
        runtimeInputs = [
          towerNixRender
          pkgs.coreutils
          pkgs.gnugrep
          pkgs.gawk
          pkgs.poppler-utils
        ];
        runtimeEnv = {
          TOWER_NIX_RENDER_BIN = "${towerNixRender}/bin/tower-nix-render";
          TOWER_NIX_RENDER_FIXTURES_DIR = "${./scripts/nix-renderer/fixtures}";
        };
        text = builtins.readFile ./scripts/nix-renderer/check-fixtures;
      };
      mkNpm10 = nodejs: pkgs.stdenvNoCC.mkDerivation {
        pname = "npm";
        version = "10.9.4";
        src = pkgs.fetchurl {
          url = "https://registry.npmjs.org/npm/-/npm-10.9.4.tgz";
          hash = "sha256-S/uooMgjAk0ZJuydl6N6AOtg/SrfRLPTSmhvwy6PUeQ=";
        };
        nativeBuildInputs = [ pkgs.makeWrapper ];
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          mkdir -p "$out/lib/node_modules/npm" "$out/bin"
          cp -R . "$out/lib/node_modules/npm/"
          makeWrapper ${nodejs}/bin/node "$out/bin/npm" \
            --add-flags "$out/lib/node_modules/npm/bin/npm-cli.js"
          makeWrapper ${nodejs}/bin/node "$out/bin/npx" \
            --add-flags "$out/lib/node_modules/npm/bin/npx-cli.js"
          runHook postInstall
        '';
        doInstallCheck = true;
        installCheckPhase = ''
          test "$("$out/bin/npm" --version)" = "10.9.4"
          test "$("$out/bin/npx" --version)" = "10.9.4"
        '';
      };
      npm10 = mkNpm10 pkgs.nodejs_24;
      npm10Node22 = mkNpm10 pkgs.nodejs_22;

      towerAppSrc = lib.cleanSourceWith {
        src = ./.;
        filter = path: type:
          let
            root = toString ./.;
            rel = lib.removePrefix (root + "/") (toString path);
            first = builtins.head (lib.splitString "/" rel);
            base = baseNameOf (toString path);
            forbiddenRoots = [ ".git" ".env" ".pi" "data" "dist" "node_modules" "workspace" "uploads" "published" ];
          in
            !(builtins.elem first forbiddenRoots)
            && !(lib.hasPrefix ".worktrees/" rel)
            && base != ".DS_Store"
            && base != "result";
      };

      # npm ci only depends on manifests and the lockfile, not application source
      # or the human +N release label. Keep this source stable across ordinary
      # code commits so Nix can reuse the fixed-output dependency closure.
      towerAppNpmDepsSrc = pkgs.runCommand "tower-app-npm-inputs" { } ''
        mkdir -p "$out/packages/backend" "$out/packages/frontend" "$out/packages/shared"
        cp ${./package.json} "$out/package.json"
        cp ${./package-lock.json} "$out/package-lock.json"
        cp ${./packages/backend/package.json} "$out/packages/backend/package.json"
        cp ${./packages/frontend/package.json} "$out/packages/frontend/package.json"
        cp ${./packages/shared/package.json} "$out/packages/shared/package.json"
      '';
      npmDepsVersion = "lock-${builtins.substring 0 16 (builtins.hashFile "sha256" ./package-lock.json)}";

      # package-lock.json currently contains many npm workspace entries without
      # resolved/integrity fields, which the nixpkgs npm cache fetcher cannot
      # parse. Keep the lockfile unchanged and isolate the one networked step in
      # a fixed-output dependency derivation instead. Its recursive hash pins the
      # complete npm ci result; towerApp itself builds with no network access.
      towerAppNpmDeps = pkgs.stdenvNoCC.mkDerivation {
        pname = "tower-app-npm-deps";
        version = npmDepsVersion;
        src = towerAppNpmDepsSrc;
        nativeBuildInputs = [ npm10Node22 pkgs.nodejs_22 pkgs.cacert ];
        dontConfigure = true;
        buildPhase = ''
          runHook preBuild
          export HOME="$TMPDIR/home"
          export NODE_EXTRA_CA_CERTS=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
          export NIX_SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
          mkdir -p "$HOME" "$out"
          test "$(node --version | cut -d. -f1)" = "v22"
          test "$(npm --version)" = "10.9.4"
          npm ci --ignore-scripts --no-audit --no-fund
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          cp -R node_modules "$out/node_modules"
          for linkedWorkspace in node_modules/@tower/*; do
            [[ -L "$linkedWorkspace" ]] || continue
            package="$(basename "$linkedWorkspace")"
            rm "$linkedWorkspace"
            mkdir -p "$linkedWorkspace"
            cp "packages/$package/package.json" "$linkedWorkspace/package.json"
          done
          for workspace in packages/*; do
            if [[ -d "$workspace/node_modules" ]]; then
              mkdir -p "$out/$workspace"
              cp -R "$workspace/node_modules" "$out/$workspace/node_modules"
            fi
          done
          runHook postInstall
        '';
        dontFixup = true;
        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-gFUAP65VtoXipcsFeYJjeUcY8N5KEKZ0nVmdhTBbELE=";
      };

      # Runtime dependencies are ~1.08 GB but change only with the lockfile or
      # Tower's small defensive Pi patch. Keep them in a stable store path so an
      # ordinary app commit produces a small closure root instead of copying and
      # compressing the full dependency tree again.
      towerAppRuntime = pkgs.stdenvNoCC.mkDerivation {
        pname = "tower-app-runtime";
        version = npmDepsVersion;
        nativeBuildInputs = [ pkgs.nodejs_22 ];
        dontUnpack = true;
        dontConfigure = true;
        buildPhase = ''
          runHook preBuild
          mkdir -p work/packages/backend
          cp -R ${towerAppNpmDeps}/node_modules work/node_modules
          cp -R ${towerAppNpmDeps}/packages/backend/node_modules work/packages/backend/node_modules
          chmod -R u+w work/node_modules work/packages/backend/node_modules
          mkdir -p pi-sdk-checks
          cp ${./scripts/pi-sdk-behavior.mjs} pi-sdk-checks/pi-sdk-behavior.mjs
          cp ${./scripts/apply-pi-eventstream-patch.mjs} pi-sdk-checks/apply-pi-eventstream-patch.mjs
          cp ${./scripts/check-pi-sdk-runtime.mjs} pi-sdk-checks/check-pi-sdk-runtime.mjs
          (cd work && node ../pi-sdk-checks/apply-pi-eventstream-patch.mjs)
          (cd work && node ../pi-sdk-checks/check-pi-sdk-runtime.mjs)
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p "$out/packages/backend"
          cp -R work/node_modules "$out/node_modules"
          cp -R work/packages/backend/node_modules "$out/packages/backend/node_modules"
          rm -rf "$out/node_modules/@tower"
          runHook postInstall
        '';
        dontFixup = true;
      };

      mkTowerApp = { prebuiltDist ? null }: pkgs.stdenvNoCC.mkDerivation {
        pname = "tower-app";
        version = releaseVersion;
        src = towerAppSrc;
        nativeBuildInputs = [ npm10Node22 pkgs.nodejs_22 pkgs.makeWrapper pkgs.python3 ];
        dontConfigure = true;
        NODE_ENV = "production";
        # Vite cannot read .git from a Nix source; embed this closure's revision.
        SOURCE_REV = sourceRev;

        buildPhase = if prebuiltDist != null then ''
          runHook preBuild
          export HOME="$TMPDIR/home"
          mkdir -p "$HOME"
          test -f ${prebuiltDist}/artifact-manifest.json
          test -f ${prebuiltDist}/dist/frontend/index.html
          test -f ${prebuiltDist}/dist/backend/packages/backend/index.js
          test -f ${prebuiltDist}/dist/runtime-packages/@tower/shared/package.json
          rm -rf dist
          cp -R ${prebuiltDist}/dist ./dist
          # Nix inputs are read-only; only this build-local copy may be extended
          # during install (e.g. authoritative migration SQL). Never chmod the input.
          chmod -R u+w ./dist
          runHook postBuild
        '' else ''
          runHook preBuild
          export HOME="$TMPDIR/home"
          mkdir -p "$HOME"
          cp -R ${towerAppNpmDeps}/node_modules ./node_modules
          for workspaceDeps in ${towerAppNpmDeps}/packages/*/node_modules; do
            [[ -d "$workspaceDeps" ]] || continue
            workspace="$(basename "$(dirname "$workspaceDeps")")"
            mkdir -p "packages/$workspace"
            cp -R "$workspaceDeps" "packages/$workspace/node_modules"
          done
          chmod -R u+w node_modules packages/*/node_modules
          patchShebangs node_modules packages/*/node_modules
          test "$(node --version | cut -d. -f1)" = "v22"
          test "$(npm --version)" = "10.9.4"
          node scripts/apply-pi-eventstream-patch.mjs
          npm run build
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          app="$out/lib/tower"
          mkdir -p "$app/dist" "$app/packages/backend" "$app/docs/tower-guide" "$app/scripts" "$out/bin" "$out/share/tower"
          cp -R dist/frontend dist/backend "$app/dist/"
          cp scripts/deploy-verify.mjs "$app/scripts/deploy-verify.mjs"
          cp scripts/deploy-verify-lib.mjs "$app/scripts/deploy-verify-lib.mjs"
          cp package.json "$app/package.json"
          cp packages/backend/models.json "$app/packages/backend/models.json"
          cp -R packages/backend/db "$app/packages/backend/db"
          mkdir -p "$app/dist/backend/packages/backend/db/migrations"
          cp packages/backend/db/migrations/*.sql "$app/dist/backend/packages/backend/db/migrations/"
          # Provisioning bootstrap/Worker need the same versioned scaffold and skills.
          mkdir -p "$app/templates" "$app/skills"
          cp -R templates/workspace "$app/templates/workspace"
          cp -R skills/managed "$app/skills/managed"
          cp -R docs/tower-guide/resources "$app/docs/tower-guide/resources"
          mkdir -p "$app/node_modules"
          for runtimeDependency in ${towerAppRuntime}/node_modules/* ${towerAppRuntime}/node_modules/.[!.]*; do
            [[ -e "$runtimeDependency" ]] || continue
            ln -s "$runtimeDependency" "$app/node_modules/$(basename "$runtimeDependency")"
          done
          mkdir -p "$app/packages/shared" "$app/packages/frontend"
          cp packages/shared/package.json "$app/packages/shared/package.json"
          cp -R dist/backend/packages/shared/. "$app/packages/shared/"
          mkdir -p "$app/node_modules/@tower"
          ln -s ../../packages/shared "$app/node_modules/@tower/shared"
          cp packages/frontend/package.json "$app/packages/frontend/package.json"
          ln -s ${towerAppRuntime}/packages/backend/node_modules "$app/packages/backend/node_modules"
          # The public package supports scripts/oss/install.sh's single-host
          # deployment. Managed provisioning, shared-host enrollment/ACL repair,
          # and owner-initiated cross-identity publication are operator tooling;
          # do not package private helpers or silently substitute permission repair.
          # Canonical migration still fails closed if its required preflight is absent.
          cp ${./scripts/nix-app/tower-app-probe} "$out/bin/tower-app-probe"
          cp ${./scripts/nix-app/tower-app-start-shadow} "$out/bin/tower-app-start-shadow"
          cp ${./scripts/nix-app/tower-app-start-production} "$out/bin/tower-app-start-production"
          ln -s ${pkgs.bubblewrap}/bin/bwrap "$out/bin/tower-provisioning-bwrap"
          cp ${./scripts/nix-app/tower-app-deploy-verify} "$out/bin/tower-app-deploy-verify"
          cp ${./scripts/nix-app/tower-app-probe-isolated-db} "$out/bin/tower-app-probe-isolated-db"
          cp ${./scripts/nix-app/tower-app-pdf-smoke} "$out/bin/tower-app-pdf-smoke"
          cp ${./scripts/nix-app/tower-app-document-smoke} "$out/bin/tower-app-document-smoke"
          printf '%s\n' '{"version":1}' > "$out/share/tower/worker-maintenance-protocol.json"
          cp ${./scripts/nix-app/worker-maintenance-readiness.py} "$out/bin/worker-maintenance-readiness.py"
          chmod +x "$out/bin/worker-maintenance-readiness.py"
          patchShebangs "$out/bin/worker-maintenance-readiness.py"
          wrapProgram "$out/bin/worker-maintenance-readiness.py" \
            --prefix PATH : ${lib.makeBinPath [ pkgs.python3 pkgs.systemd ]}
          cp ${./scripts/nix-app/tower-worker-maintenance} "$out/bin/tower-worker-maintenance"
          cp ${./scripts/nix-app/install-worker-maintenance} "$out/bin/install-worker-maintenance"
          chmod +x "$out/bin/tower-worker-maintenance" "$out/bin/install-worker-maintenance"
          patchShebangs "$out/bin/tower-worker-maintenance" "$out/bin/install-worker-maintenance"
          wrapProgram "$out/bin/tower-worker-maintenance" \
            --set PYTHONDONTWRITEBYTECODE 1 \
            --prefix PATH : ${lib.makeBinPath [ pkgs.python3 pkgs.nodejs_22 pkgs.nix pkgs.systemd ]}
          wrapProgram "$out/bin/install-worker-maintenance" \
            --set PYTHONDONTWRITEBYTECODE 1 \
            --prefix PATH : ${lib.makeBinPath [ pkgs.python3 pkgs.nodejs_22 pkgs.nix pkgs.systemd ]}
          cp ${./scripts/nix-app/tower-workbench-worker} "$out/bin/tower-workbench-worker"
          cp ${./scripts/nix-app/tower-workbench-worker-heartbeat} "$out/bin/tower-workbench-worker-heartbeat"
          cp ${./scripts/nix-app/runtime-compute-doctor} "$out/bin/runtime-compute-doctor"
          cp ${./packages/backend/sandbox-images/runtime-box-node22-python313/tower-html-render} "$out/bin/tower-html-render"
          cp ${./packages/backend/project-compute-baseline.json} "$out/share/tower/compute-baseline.json"
          cp ${./scripts/nix-app/install-local-workbench-worker-units} "$out/bin/install-local-workbench-worker-units"
          cp ${./scripts/nix-app/install-system-workbench-worker-units} "$out/bin/install-system-workbench-worker-units"
          cp ${./scripts/nix-app/tower-workbench-assignment-reconciler} "$out/bin/tower-workbench-assignment-reconciler"
          cp ${./scripts/nix-app/install-workbench-assignment-reconciler-unit} "$out/bin/install-workbench-assignment-reconciler-unit"
          ln -s ${towerNixRender}/bin/tower-nix-render "$out/bin/tower-nix-render"
          chmod +x "$out/bin/tower-app-probe" "$out/bin/tower-app-start-shadow" "$out/bin/tower-app-start-production" "$out/bin/tower-app-deploy-verify" "$out/bin/tower-app-probe-isolated-db" "$out/bin/tower-app-pdf-smoke" "$out/bin/tower-app-document-smoke" "$out/bin/tower-workbench-worker" "$out/bin/tower-workbench-worker-heartbeat" "$out/bin/runtime-compute-doctor" "$out/bin/tower-html-render" "$out/bin/install-local-workbench-worker-units" "$out/bin/install-system-workbench-worker-units" "$out/bin/tower-workbench-assignment-reconciler" "$out/bin/install-workbench-assignment-reconciler-unit"
          patchShebangs "$out/bin/tower-app-probe" "$out/bin/tower-app-start-shadow" "$out/bin/tower-app-start-production" "$out/bin/tower-app-deploy-verify" "$out/bin/tower-app-probe-isolated-db" "$out/bin/tower-app-pdf-smoke" "$out/bin/tower-app-document-smoke" "$out/bin/tower-workbench-worker" "$out/bin/tower-workbench-worker-heartbeat" "$out/bin/runtime-compute-doctor" "$out/bin/tower-html-render" "$out/bin/install-local-workbench-worker-units" "$out/bin/install-system-workbench-worker-units" "$out/bin/tower-workbench-assignment-reconciler" "$out/bin/install-workbench-assignment-reconciler-unit"
          wrapProgram "$out/bin/tower-app-probe" \
            --prefix PATH : ${lib.makeBinPath [ pkgs.nodejs_22 pkgs.python3 pkgs.coreutils pkgs.gh ]}
          wrapProgram "$out/bin/tower-app-start-shadow" \
            --set TOWER_PROJECT_SETFACL_BIN "${lib.getBin pkgs.acl}/bin/setfacl" \
            --prefix PATH : ${lib.makeBinPath [ pkgs.nodejs_22 pkgs.coreutils ]}
          # Backend issue MCP invokes gh; do not depend on mutable host packages.
          wrapProgram "$out/bin/tower-app-start-production" \
            --set TOWER_PROJECT_SETFACL_BIN "${lib.getBin pkgs.acl}/bin/setfacl" \
            --prefix PATH : ${lib.makeBinPath [ pkgs.nodejs_22 towerAnalysisPython pkgs.coreutils pkgs.gh ]} \
            --set TOWER_DOCUMENT_PYTHON "${towerAnalysisPython}/bin/python3" \
            --set TOWER_CAD_PYTHON "${towerAnalysisPython}/bin/python3" \
            --set PDF_EXPORT_RENDERER_MODE nix \
            --set NIX_RENDERER_BIN "$out/bin/tower-nix-render"
          wrapProgram "$out/bin/tower-app-deploy-verify" \
            --prefix PATH : ${lib.makeBinPath [ pkgs.nodejs_22 pkgs.coreutils ]} \
            --set TOWER_APP_ROOT "$out"
          wrapProgram "$out/bin/tower-app-probe-isolated-db" \
            --prefix PATH : ${lib.makeBinPath [ pkgs.nodejs_22 pkgs.coreutils ]}
          wrapProgram "$out/bin/tower-app-pdf-smoke" \
            --prefix PATH : ${lib.makeBinPath [ pkgs.nodejs_22 pkgs.poppler-utils pkgs.coreutils ]} \
            --set TOWER_APP_ROOT "$out" \
            --set PDF_EXPORT_RENDERER_MODE nix \
            --set NIX_RENDERER_BIN "$out/bin/tower-nix-render"
          wrapProgram "$out/bin/tower-app-document-smoke" \
            --prefix PATH : ${lib.makeBinPath [ towerAnalysisPython pkgs.coreutils ]}
          wrapProgram "$out/bin/tower-workbench-worker" \
            --prefix PATH : "$out/bin" \
            --prefix PATH : ${lib.makeBinPath workerBaseline} \
            --set TOWER_APP_ROOT "$out" \
            --set TOWER_WORKER_BWRAP_BIN "${pkgs.bubblewrap}/bin/bwrap" \
            --set TOWER_COMPUTE_BASELINE_MANIFEST "$out/share/tower/compute-baseline.json" \
            --set NODE_PATH "${workerPublishingTools}/lib/node_modules/tower-publishing-tools/node_modules" \
            --set SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
            --set NODE_EXTRA_CA_CERTS "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
            --set NIX_SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
            --set FONTCONFIG_FILE "${pkgs.makeFontsConf { fontDirectories = [ rendererFonts ]; }}"
          wrapProgram "$out/bin/runtime-compute-doctor" \
            --prefix PATH : "$out/bin" \
            --prefix PATH : ${lib.makeBinPath workerBaseline} \
            --set TOWER_COMPUTE_BASELINE_MANIFEST "$out/share/tower/compute-baseline.json" \
            --set NODE_PATH "${workerPublishingTools}/lib/node_modules/tower-publishing-tools/node_modules" \
            --set SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
            --set NODE_EXTRA_CA_CERTS "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
            --set NIX_SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
            --set FONTCONFIG_FILE "${pkgs.makeFontsConf { fontDirectories = [ rendererFonts ]; }}"
          wrapProgram "$out/bin/tower-workbench-worker-heartbeat" \
            --prefix PATH : ${lib.makeBinPath [ pkgs.nodejs_22 pkgs.coreutils ]} \
            --set TOWER_APP_ROOT "$out"
          wrapProgram "$out/bin/install-local-workbench-worker-units" \
            --prefix PATH : ${lib.makeBinPath [ pkgs.nodejs_22 pkgs.coreutils pkgs.systemd ]} \
            --set TOWER_APP_ROOT "$out"
          wrapProgram "$out/bin/install-system-workbench-worker-units" \
            --prefix PATH : ${lib.makeBinPath [ pkgs.nodejs_22 pkgs.python3 pkgs.coreutils pkgs.systemd pkgs.shadow pkgs.util-linux ]} \
            --set TOWER_APP_ROOT "$out"
          wrapProgram "$out/bin/tower-workbench-assignment-reconciler" \
            --prefix PATH : ${lib.makeBinPath [ pkgs.nodejs_22 pkgs.coreutils pkgs.systemd pkgs.util-linux ]} \
            --set TOWER_APP_ROOT "$out"
          wrapProgram "$out/bin/install-workbench-assignment-reconciler-unit" \
            --prefix PATH : ${lib.makeBinPath [ pkgs.coreutils pkgs.systemd ]} \
            --set TOWER_APP_ROOT "$out"
          cat > "$out/share/tower/release-manifest.json" <<'JSON'
          ${builtins.toJSON {
            schemaVersion = 1;
            package = "tower-app";
            version = releaseVersion;
            baseVersion = releaseBaseVersion;
            channel = releaseChannel;
            releaseId = if publicRelease != null then publicRelease.releaseId or null else null;
            exportPolicyVersion = if publicRelease != null then publicRelease.exportPolicyVersion or null else null;
            commitsSinceTag = releaseCommitsSinceTag;
            gitSha = sourceShortRev;
            inherit sourceRev buildTime flakeLockNarHash;
            nodeMajor = 22;
            nodeVersion = pkgs.nodejs_22.version;
            npmVersion = "10.9.4";
          }}
          JSON
          runHook postInstall
        '';

        doInstallCheck = true;
        nativeInstallCheckInputs = [ pkgs.python3 pkgs.coreutils ];
        installCheckPhase = ''
          "$out/bin/tower-app-probe" "$out"
          test -x "$out/bin/tower-app-start-shadow"
          test -x "$out/bin/tower-app-start-production"
          test -x "${lib.getBin pkgs.acl}/bin/setfacl"
          grep -F '${lib.getBin pkgs.acl}/bin/setfacl' "$out/bin/tower-app-start-production"
          grep -F '${lib.getBin pkgs.acl}/bin/setfacl' "$out/bin/tower-app-start-shadow"
          test -x "$out/bin/tower-app-deploy-verify"
          test -x "$out/bin/tower-app-probe-isolated-db"
          test -x "$out/bin/tower-app-pdf-smoke"
          test -x "$out/bin/tower-app-document-smoke"
          test -x "$out/bin/tower-workbench-worker"
          test -x "$out/bin/tower-workbench-worker-heartbeat"
          test -x "$out/bin/runtime-compute-doctor"
          test -s "$out/share/tower/compute-baseline.json"
          test -x "$out/bin/install-local-workbench-worker-units"
          test -x "$out/bin/install-system-workbench-worker-units"
          test -x "$out/bin/tower-workbench-assignment-reconciler"
          test -x "$out/bin/install-workbench-assignment-reconciler-unit"
          test -x "$out/bin/tower-nix-render"
          "$out/bin/tower-app-pdf-smoke"
          "$out/bin/tower-app-document-smoke"
          TOWER_CAD_PYTHON="${towerAnalysisPython}/bin/python3" TOWER_CAD_SMOKE_MODULE="$out/lib/tower/dist/backend/packages/backend/engines/pi-cad-view-tool.js" "${pkgs.nodejs_22}/bin/node" --input-type=module - <<'NODE'
          import { mkdtemp, writeFile } from 'node:fs/promises';
          import { tmpdir } from 'node:os';
          import path from 'node:path';
          const { renderCadToCachedImage } = await import(process.env.TOWER_CAD_SMOKE_MODULE);
          const dir = await mkdtemp(path.join(tmpdir(), 'tower-cad-smoke-'));
          const dxf = path.join(dir, 'tiny.dxf');
          await writeFile(dxf, '0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n10\n21\n10\n0\nENDSEC\n0\nEOF\n');
          const rendered = await renderCadToCachedImage({ cwd: dir, path: dxf, width: 600, height: 600 });
          if (rendered.renderer !== 'ezdxf') throw new Error('unexpected CAD renderer: ' + rendered.renderer);
          NODE
          test -f "$out/lib/tower/dist/backend/packages/backend/artifact-shadow.js"
          test -f "$out/lib/tower/dist/backend/packages/backend/isolated-db-shadow.js"
          test -f "$out/lib/tower/packages/shared/index.js"
          test -f "$out/lib/tower/packages/shared/agent-career.js"
          test "$(readlink "$out/lib/tower/node_modules/@tower/shared")" = "../../packages/shared"
          TOWER_PACKAGED_RELEASE=true TOWER_VERSION='${releaseVersion}' TOWER_BASE_VERSION='${releaseBaseVersion}' GIT_SHA='${sourceShortRev}' SOURCE_REV='${sourceRev}' \
            node -e "import('$out/lib/tower/dist/backend/packages/backend/routes/api.js')"
          if grep -R -a -F "${toString ./.}" "$out/lib/tower/dist"; then
            echo "source checkout path leaked into compiled dist" >&2
            exit 1
          fi
        '';
      };
      towerApp = mkTowerApp { };
    in {
      lib.${system}.mkTowerAppFromDist = artifact: mkTowerApp { prebuiltDist = artifact; };

      packages.${system} = {
        inherit npm10 npm10Node22 towerNixRender towerNixRendererCheck workerPandoc workerGws towerAppNpmDeps towerAppRuntime towerApp;
        # Small independently buildable ACL dependency used by Backend wrappers.
        towerProjectAcl = lib.getBin pkgs.acl;
        default = towerNixRender;
      };

      apps.${system} = {
        renderer = {
          type = "app";
          program = "${towerNixRender}/bin/tower-nix-render";
        };
        renderer-check = {
          type = "app";
          program = "${towerNixRendererCheck}/bin/tower-nix-render-check";
        };
        app-probe = {
          type = "app";
          program = "${towerApp}/bin/tower-app-probe";
        };
      };

      checks.${system} = {
        renderer-package = towerNixRender;
        app-package = towerApp;
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          npm10
          pkgs.nodejs_24
          towerAnalysisPython
          pkgs.git
          pkgs.pkg-config
        ];

        shellHook = ''
          export TOWER_NIX_PILOT=1
          echo "Tower Nix pilot: Node $(node --version), npm $(npm --version), Python $(python3 --version 2>&1)"
        '';
      };
    };
}
