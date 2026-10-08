#!/bin/sh
# nsq installer for macOS and Linux — installs the npm package globally with the npm you have.
#
#   curl -fsSL https://raw.githubusercontent.com/glmn-ai/neurosquad-cli/main/packaging/install/install.sh | sh
#
# Environment: NSQ_VERSION (default: latest), NSQ_PACKAGE (default: neurosquad),
# NSQ_PREFIX (npm global prefix to use; default: npm's own, or ~/.local when that is not writable).
# Needs Node.js >= 22.13 with npm. Installs nothing else and never uses sudo.
set -eu

PACKAGE="${NSQ_PACKAGE:-neurosquad}"
VERSION="${NSQ_VERSION:-latest}"
MIN_NODE="22.13.0"

say() { printf 'nsq: %s\n' "$*"; }
die() { printf 'nsq: error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js $MIN_NODE or newer is required (https://nodejs.org, or: brew install node / fnm / nvm)."
command -v npm >/dev/null 2>&1 || die "npm was not found next to Node.js."

node -e '
  const want = process.argv[1].split(".").map(Number)
  const have = process.versions.node.split(".").map(Number)
  for (let i = 0; i < 3; i++) { if (have[i] > want[i]) process.exit(0); if (have[i] < want[i]) process.exit(1) }
' "$MIN_NODE" || die "Node.js $(node -v) is too old; nsq needs $MIN_NODE or newer."

case "$VERSION" in
  latest | [0-9]*) ;;
  *) die "NSQ_VERSION must be 'latest' or a version like 0.1.0" ;;
esac

PREFIX="${NSQ_PREFIX:-}"
if [ -z "$PREFIX" ]; then
  GLOBAL="$(npm prefix -g)"
  if [ -w "$GLOBAL/lib" ] 2>/dev/null || { [ ! -e "$GLOBAL/lib" ] && [ -w "$GLOBAL" ]; }; then
    PREFIX="$GLOBAL"
  else
    PREFIX="$HOME/.local"
    say "npm's global folder ($GLOBAL) is not writable; installing into $PREFIX instead (no sudo)."
  fi
fi

say "installing $PACKAGE@$VERSION with npm $(npm -v) (Node $(node -v)) into $PREFIX"
npm install --global --prefix "$PREFIX" --no-audit --no-fund "$PACKAGE@$VERSION"

BIN="$PREFIX/bin"
if command -v nsq >/dev/null 2>&1 && [ "$(command -v nsq)" = "$BIN/nsq" ]; then
  say "done: $(nsq --version 2>/dev/null || echo installed). Run 'nsq' to start."
else
  say "done. Add $BIN to your PATH, e.g.:"
  say "  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile && . ~/.profile"
fi
