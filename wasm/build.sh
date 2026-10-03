#!/usr/bin/env bash
# Překlad WASM jádra. Používá se lokálně i v CI.
#
# AssemblyScript se nechává v ~/.cache, ne v repu — projekt je jinak bez
# závislostí a nechceme do něj přidávat node_modules. Když `asc` není,
# skript ho doinstaluje sám.
set -euo pipefail

cd "$(dirname "$0")"
CACHE="${HOME}/.cache/va-wasm"

if ! command -v asc >/dev/null 2>&1 && [ ! -x "${CACHE}/node_modules/.bin/asc" ]; then
  echo "AssemblyScript není k dispozici, instaluji do ${CACHE}…"
  mkdir -p "${CACHE}"
  (cd "${CACHE}" && npm init -y >/dev/null 2>&1 && npm i assemblyscript --no-audit --no-fund >/dev/null)
fi

ASC="$(command -v asc || echo "${CACHE}/node_modules/.bin/asc")"
mkdir -p build

"$ASC" src/dsp.ts --config asconfig.json --target release \
  --outFile build/dsp.wasm --textFile build/dsp.wat

echo "Hotovo: $(ls -la build/dsp.wasm | awk '{print $5}') B  →  build/dsp.wasm"
echo
echo "POZOR: po každé změně jádra musí projít:"
echo "  node tools/wasm-parity.mjs     # WASM musí dávat stejná čísla jako JS"
echo "  node tools/live-check.mjs      # živá cesta musí dávat stejná čísla jako offline"
