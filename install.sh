#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 22.16+ (LTS) from https://nodejs.org/ and run this installer again.'
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<16))process.exit(1)' || { echo 'Node.js 22.16+ is required.'; exit 1; }
npm ci --omit=dev --ignore-scripts
node bin/neurover.mjs install-browser || {
  echo 'Browser installation failed. On supported Linux distributions run: npx playwright install-deps chromium'
  echo 'You can still use one-time terminal login without a browser.'
}
node bin/neurover.mjs setup
