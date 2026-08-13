#!/usr/bin/env bash
# Build sample generated islands and photograph them in the running game.
# Expects a dev server already listening (default 5188).
#   tools/shoot-cities.sh <outdir> [port]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:?usage: shoot-cities.sh <outdir> [port]}"
PORT="${2:-5188}"
mkdir -p "$OUT"

for SEED in 1 20261 481923 550991 73303; do
  echo "=== seed $SEED"
  node pipeline/build-city.mjs "$SEED" | grep -E "lots on|COVERAGE"
  node pipeline/process.mjs >/dev/null
  node pipeline/tiles.mjs >/dev/null
  BBOX=$(node -e "console.log(JSON.stringify(require('./public/data/manifest.json').bbox))")
  CORE=$(node -e "console.log(JSON.stringify(require('./public/data/manifest.json').core))")

  node tools/shoot.mjs "http://127.0.0.1:$PORT/" "$OUT/$SEED-city.png" \
    --wait 13000 --w 1600 --h 1000 --settle 3500 \
    --eval "(()=>{const b=$BBOX;__map.fitBounds([[b[0],b[1]],[b[2],b[3]]],{padding:70,bearing:-14,pitch:36,duration:0});})()"

  node tools/shoot.mjs "http://127.0.0.1:$PORT/" "$OUT/$SEED-core.png" \
    --wait 13000 --w 1600 --h 1000 --settle 3500 \
    --eval "(()=>{const c=$CORE;__map.jumpTo({center:c,zoom:16.1,pitch:62,bearing:-24});})()"
done
echo "done -> $OUT"
