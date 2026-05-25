#!/usr/bin/env bash
# Build AppIcon.icns from app/assets/icon.png (1024x1024 PNG).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/app/assets/icon.png"
OUT_ICNS="$ROOT/Kleinanzeigen Upload.app/Contents/Resources/AppIcon.icns"
ICONSET="$ROOT/scripts/AppIcon.iconset"

rm -rf "$ICONSET"
mkdir -p "$ICONSET"

gen() {
  local size="$1"
  local name="$2"
  sips -z "$size" "$size" "$SRC" --out "$ICONSET/$name" >/dev/null
}

gen 16    icon_16x16.png
gen 32    icon_16x16@2x.png
gen 32    icon_32x32.png
gen 64    icon_32x32@2x.png
gen 128   icon_128x128.png
gen 256   icon_128x128@2x.png
gen 256   icon_256x256.png
gen 512   icon_256x256@2x.png
gen 512   icon_512x512.png
gen 1024  icon_512x512@2x.png

iconutil -c icns "$ICONSET" -o "$OUT_ICNS"
rm -rf "$ICONSET"
echo "wrote $OUT_ICNS"
