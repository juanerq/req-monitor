#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_DIR="/home/juanerq/projects/playwright"
readonly NODE_BIN="/home/juanerq/.local/share/fnm/node-versions/v24.18.1/installation/bin"

export PATH="${NODE_BIN}:${PATH}"
cd "${PROJECT_DIR}"
exec "${PROJECT_DIR}/node_modules/.bin/tsx" monitor-req.ts
