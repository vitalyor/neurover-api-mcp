#!/bin/sh
# Neurover MCP command: works from any folder and does not depend on PATH.
d=$(cd "$(dirname "$0")" && pwd)
n="$d/node/bin/node"; [ -x "$n" ] || n=node
NEUROVER_DATA_DIR="$d" exec "$n" "$d/app/neurover.mjs" "$@"
