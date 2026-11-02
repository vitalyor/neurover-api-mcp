#!/bin/sh
# Neurover MCP one-line installer for macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/vitalyor/neurover-api-mcp/main/get.sh | sh
set -eu
need='Нужен Node.js 22.16 или новее. Скачайте версию LTS с https://nodejs.org/, установите её и запустите эту команду снова.'
command -v node >/dev/null 2>&1 || { echo "$need"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)' || { echo "$need"; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL https://codeload.github.com/vitalyor/neurover-api-mcp/tar.gz/refs/heads/main | tar -xz -C "$tmp" --strip-components=1
# Under "curl | sh" stdin is this script; give the installer the real terminal when there is one.
if (: </dev/tty) 2>/dev/null; then node "$tmp/scripts/install.mjs" </dev/tty; else node "$tmp/scripts/install.mjs"; fi
