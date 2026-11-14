#!/bin/sh
# agent-tabs installer for macOS and Linux.
#
# Writes the native messaging host manifest (com.agenttabs.host.json) into the
# NativeMessagingHosts folder of every Chromium-family browser found (Chrome,
# Chromium, Brave, Edge, Arc, Vivaldi, ...), plus a launcher script that Chrome
# starts. Nothing is installed system-wide and no sudo is needed.
#
#   ./install.sh                       # auto-detect browsers
#   ./install.sh --dry-run             # show what would be written
#   ./install.sh --extension-id ID     # allow another extension id (repeatable)
#   ./install.sh --target-dir DIR      # write the manifest into DIR instead
#
# Undo with: node bin/agent-tabs.js uninstall
set -eu
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "agent-tabs needs Node.js 18+ (e.g. brew install node)" >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
  || { echo "agent-tabs needs Node.js 18+, found $(node -v)" >&2; exit 1; }
exec node bin/agent-tabs.js install "$@"
