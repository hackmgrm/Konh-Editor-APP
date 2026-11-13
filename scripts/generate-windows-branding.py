#!/usr/bin/env python3
"""Derive transparent desktop branding from the existing, opaque master (Pillow required)."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
master = Image.open(ROOT / 'assets/branding/konh-icon-master.png').convert('RGBA')
if master.size != (1254, 1254):
    raise ValueError('Unexpected master dimensions; verify tile geometry before regenerating')

# The rounded tile occupies (50, 52) through (1198, 1198). Only mask its exterior.
scale = 4
mask = Image.new('L', (1254 * scale, 1254 * scale))
ImageDraw.Draw(mask).rounded_rectangle(
    (50 * scale, 52 * scale, 1198 * scale, 1198 * scale), radius=260 * scale, fill=255
)
master.putalpha(mask.resize(master.size, Image.Resampling.LANCZOS))

def resized(size):
    return master.resize((size, size), Image.Resampling.LANCZOS)

resized(512).save(ROOT / 'public/brand-icon.png')
resized(32).save(ROOT / 'src-tauri/icons/tray-windows.png')
master.save(ROOT / 'src-tauri/icons/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
