#!/usr/bin/env python3
"""Build a clean macOS app icon from app/assets/icon.png.

Source has the lime "K" tile sitting inside a white card with extra padding.
We extract the lime tile, place it on a 1024x1024 transparent canvas at the
Apple icon grid size (~824px), and round the corners. macOS does NOT mask
arbitrary icons, so we round the corners ourselves to match the native look.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "app" / "assets" / "icon.png"
OUT = ROOT / "app" / "assets" / "icon.png"  # overwrite

# Lime tile bounds in source (detected previously)
LIME_BOX = (60, 60, 452, 452)  # right/bottom exclusive

CANVAS = 1024
TILE = 824           # Apple icon grid: artwork ~80% of canvas
RADIUS = 185         # ~22.5% — close to the macOS continuous corner

src = Image.open(SRC).convert("RGBA")
tile = src.crop(LIME_BOX).resize((TILE, TILE), Image.LANCZOS)

# Round the tile corners
mask = Image.new("L", (TILE, TILE), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, TILE, TILE), RADIUS, fill=255)
tile.putalpha(mask)

canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
offset = (CANVAS - TILE) // 2
canvas.paste(tile, (offset, offset), tile)
canvas.save(OUT, "PNG")
print(f"wrote {OUT} ({CANVAS}x{CANVAS})")
