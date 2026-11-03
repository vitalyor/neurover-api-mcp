#!/bin/sh
# Neurover MCP one-line installer for macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/vitalyor/neurover-api-mcp/main/get.sh | sh
set -eu
data=${NEUROVER_DATA_DIR:-}
if [ -z "$data" ]; then
  case $(uname -s) in Darwin) data="$HOME/Library/Application Support/NeuroverMCP";; *) data="${XDG_DATA_HOME:-$HOME/.local/share}/neurover-mcp";; esac
fi
ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)' >/dev/null 2>&1; }
fail() { echo "$1"; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ -x "$data/node/bin/node" ] && ok "$data/node/bin/node"; then node="$data/node/bin/node"
elif command -v node >/dev/null 2>&1 && ok node; then node=$(command -v node)
else
  # No suitable Node.js: a private copy in the data folder. No sudo; other programs and PATH are not touched.
  echo 'Node.js 22.16+ не найден. Скачиваю отдельную копию только для Neurover MCP (другие программы она не затрагивает)…'
  manual='Установите Node.js LTS с https://nodejs.org/ и запустите эту команду снова.'
  case $(uname -s) in Darwin) os=darwin;; Linux) os=linux;; *) fail "$manual";; esac
  case $(uname -m) in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) fail "$manual";; esac
  v=$(curl -fsSL https://nodejs.org/dist/index.tab | awk -F'\t' 'NR>1 && $10!="-" {print $1; exit}')
  name="node-$v-$os-$arch.tar.gz"
  curl -fsSL "https://nodejs.org/dist/$v/$name" -o "$tmp/node.tgz"
  sum=$(curl -fsSL "https://nodejs.org/dist/$v/SHASUMS256.txt" | awk -v f="$name" '$2==f {print $1}')
  got=$( (sha256sum "$tmp/node.tgz" 2>/dev/null || shasum -a 256 "$tmp/node.tgz") | awk '{print $1}')
  [ -n "$sum" ] && [ "$sum" = "$got" ] || fail 'Загрузка Node.js повреждена. Запустите команду снова.'
  mkdir -p "$data" && chmod 700 "$data"
  rm -rf "$data/node" && mkdir "$data/node"
  tar -xzf "$tmp/node.tgz" -C "$data/node" --strip-components=1
  node="$data/node/bin/node"
  ok "$node" || fail "Скачанный Node.js не запускается на этой системе. $manual"
  echo "Node.js $v готов."
fi
mkdir "$tmp/src"
curl -fsSL https://codeload.github.com/vitalyor/neurover-api-mcp/tar.gz/refs/heads/main | tar -xz -C "$tmp/src" --strip-components=1
# Under "curl | sh" stdin is this script; give the installer the real terminal when there is one.
if (: </dev/tty) 2>/dev/null; then "$node" "$tmp/src/scripts/install.mjs" </dev/tty; else "$node" "$tmp/src/scripts/install.mjs"; fi
