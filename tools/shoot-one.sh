#!/usr/bin/env bash
# Rebuild one city and take just its establishing shot, framed tight.
#   tools/shoot-one.sh <city> <outdir> [port]
set -euo pipefail
cd "$(dirname "$0")/.."
CITY="${1:?usage: shoot-one.sh <city> <outdir> [port]}"
OUT="${2:?usage: shoot-one.sh <city> <outdir> [port]}"
PORT="${3:-5188}"
mkdir -p "$OUT"
node pipeline/build-city.mjs "$CITY" | grep -E "lots on|COVERAGE"
node pipeline/process.mjs >/dev/null
node pipeline/tiles.mjs >/dev/null
BBOX=$(node -e "console.log(JSON.stringify(require('./public/data/manifest.json').bbox))")
node tools/shoot.mjs "http://127.0.0.1:$PORT/" "$OUT/$CITY-city.png" \
  --wait 13000 --w 1600 --h 1000 --settle 4000 \
  --eval "(function(){var b=$BBOX;__map.fitBounds([[b[0],b[1]],[b[2],b[3]]],{padding:{top:112,bottom:22,left:22,right:22},bearing:-14,duration:0});__map.setPitch(26);})()"
