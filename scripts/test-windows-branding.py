#!/usr/bin/env python3
"""Check transparency and retained robot colors in generated desktop assets."""
from pathlib import Path
from PIL import Image, ImageChops

root = Path(__file__).resolve().parent.parent
master = Image.open(root / 'assets/branding/konh-icon-master.png').convert('RGB')
for path, size in [('public/brand-icon.png', 512), ('src-tauri/icons/tray-windows.png', 32)]:
    image = Image.open(root / path).convert('RGBA')
    assert image.size == (size, size)
    assert all(image.getpixel(point)[3] == 0 for point in [(0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)])
    assert image.getpixel((size // 2, size // 2))[3] == 255
    # The central robot is wholly inside the mask; its original colors must survive.
    expected = master.resize((size, size), Image.Resampling.LANCZOS)
    box = (size // 4, size // 4, 3 * size // 4, 3 * size // 4)
    assert ImageChops.difference(image.convert('RGB').crop(box), expected.crop(box)).getbbox() is None
ico = Image.open(root / 'src-tauri/icons/icon.ico')
assert {(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)} <= ico.info['sizes']
for size in ico.info['sizes']:
    image = ico.ico.getimage(size).convert('RGBA')
    # Resampling the 16px frame can leave a negligible edge alpha.
    assert image.getpixel((0, 0))[3] <= 2
    assert image.getpixel((size[0] // 2, size[1] // 2))[3] == 255
print('Windows branding assets verified')
