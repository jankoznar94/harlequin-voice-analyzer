#!/usr/bin/env bash
# Kontrola PWA před nasazením — bez tohohle mobil nezobrazí "nainstalovat".
set -uo pipefail
# skript leží v test/, ale soubory projektu jsou v kořeni
cd "$(dirname "$0")/.."

ok=0; bad=0
chk() { if eval "$2" >/dev/null 2>&1; then echo "  ✓ $1"; ok=$((ok+1)); else echo "  ✗ $1"; bad=$((bad+1)); fi; }

echo "=== PWA checklist ==="
chk "manifest je propojený v index.html"  "grep -q 'rel=\"manifest\"' index.html"
chk "manifest obsahuje ikony"             "grep -q '\"icons\"' manifest.webmanifest"
chk "manifest má start_url"               "grep -q '\"start_url\"' manifest.webmanifest"
chk "manifest má display standalone"      "grep -q '\"display\": \"standalone\"' manifest.webmanifest"
chk "manifest má theme_color"             "grep -q 'theme_color' manifest.webmanifest"
chk "ikona existuje"                      "test -f icon.svg"
chk "service worker soubor existuje"      "test -f sw.js"
chk "SW registrace v app.js"              "grep -q 'serviceWorker.register' src/app.js"
chk "SW registrace má .catch()"           "grep -q \"register('sw.js').catch\" src/app.js"
chk "SW cachuje všechny assety"           "grep -q 'src/analysis.js' sw.js && grep -q 'src/charts.js' sw.js"
chk "apple-touch-icon přítomen"           "grep -q 'apple-touch-icon' index.html"
chk "iOS meta tag přítomen"               "grep -q 'apple-mobile-web-app-capable' index.html"
chk "js/css mají ?v= (cache busting)"     "grep -q 'style.css?v=' index.html && grep -q 'app.js?v=' index.html"
chk "JS syntaxe je platná"                "node --check src/app.js"
chk "DSP jádro je platné"                 "node --check src/analysis.js"
chk "charts je platné"                    "node --check src/charts.js"

echo
echo "=== soubory, které se nasazují ==="
for f in index.html manifest.webmanifest sw.js icon.svg src/style.css src/app.js src/analysis.js src/charts.js; do
  if [ -f "$f" ]; then printf "  %-28s %6s B\n" "$f" "$(stat -c%s "$f")"; else echo "  CHYBÍ: $f"; bad=$((bad+1)); fi
done

echo
echo "=== velikost celkem ==="
du -sh --exclude=.git --exclude=node_modules . | cut -f1

echo
echo "PWA: $ok v pořádku, $bad problémů"
exit $(( bad > 0 ))
