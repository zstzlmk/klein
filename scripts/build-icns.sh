#!/bin/bash
# Build app/assets/AppIcon.icns from app/assets/icon.png (must be 1024x1024).
set -e
SRC="app/assets/icon.png"
ICONSET="app/assets/AppIcon.iconset"
OUT="app/assets/AppIcon.icns"

if [ ! -f "$SRC" ]; then echo "missing $SRC"; exit 1; fi

rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for sz in 16 32 64 128 256 512 1024; do
    sips -z $sz $sz "$SRC" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null
done
# @2x variants
cp "$ICONSET/icon_32x32.png"   "$ICONSET/icon_16x16@2x.png"
cp "$ICONSET/icon_64x64.png"   "$ICONSET/icon_32x32@2x.png"
cp "$ICONSET/icon_256x256.png" "$ICONSET/icon_128x128@2x.png"
cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_256x256@2x.png"
cp "$ICONSET/icon_1024x1024.png" "$ICONSET/icon_512x512@2x.png"
rm "$ICONSET/icon_64x64.png" "$ICONSET/icon_1024x1024.png"

iconutil -c icns "$ICONSET" -o "$OUT"
rm -rf "$ICONSET"
echo "wrote $OUT"
