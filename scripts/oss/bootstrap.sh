#!/usr/bin/env bash
set -Eeuo pipefail

# Minimal entry point for a blank supported Ubuntu VM. It installs only the
# tools needed to fetch Tower, then delegates every product dependency and
# service change to scripts/oss/install.sh from the checked-out revision.

REPO_URL="${TOWER_OSS_REPO_URL:-https://github.com/moatai-io/towersource.git}"
REF="${TOWER_OSS_REF:-main}"
SOURCE_DIR="${TOWER_OSS_SOURCE_DIR:-/usr/local/src/tower}"

fail(){ printf '\033[0;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
log(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || fail "Run with sudo: sudo bash bootstrap.sh ..."
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || fail "Tower bootstrap currently supports Ubuntu only"
case "${VERSION_ID:-}" in 22.04|24.04) ;; *) fail "Ubuntu 22.04 or 24.04 required (found ${VERSION_ID:-unknown})" ;; esac
[[ ! -e "$SOURCE_DIR" ]] || fail "Source directory already exists: $SOURCE_DIR"

export DEBIAN_FRONTEND=noninteractive
log "Installing source download prerequisites"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git

log "Cloning Tower OSS $REF"
install -d "$(dirname "$SOURCE_DIR")"
git clone --filter=blob:none --branch "$REF" --single-branch "$REPO_URL" "$SOURCE_DIR"
commit="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
printf 'Tower OSS source: %s\n' "$commit"

exec bash "$SOURCE_DIR/scripts/oss/install.sh" --source-dir "$SOURCE_DIR" "$@"
