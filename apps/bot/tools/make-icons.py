#!/usr/bin/env python3
"""Regenerate the Vaporzr PWA icons from the 240px master (public/logo.png).

The previous icon-512 and icon-maskable were plain upscales of the 240px
master and looked soft on phone home screens. Pillow's Lanczos resampler plus
a light unsharp mask fixes that. icon-maskable is additionally padded so the
badge survives Android's circular mask (the safe zone is the centre 80%).

Run from apps/bot:  python tools/make-icons.py
"""
from pathlib import Path

from PIL import Image, ImageFilter

PUBLIC = Path(__file__).resolve().parent.parent / "public"
MASTER = PUBLIC / "logo.png"


def load_master() -> Image.Image:
    img = Image.open(MASTER).convert("RGBA")
    if img.size != (240, 240):
        raise SystemExit(f"master is {img.size}, expected 240x240")
    return img


def crisp(img: Image.Image, size: int) -> Image.Image:
    """Lanczos resize + a light unsharp mask — upscales stay crisp."""
    out = img.resize((size, size), Image.LANCZOS)
    return out.filter(ImageFilter.UnsharpMask(radius=2, percent=80, threshold=3))


def main() -> None:
    master = load_master()
    # The badge's own corner colour — used as the backdrop so the maskable and
    # touch icons blend seamlessly with the badge's own background.
    corner = master.getpixel((2, 2))[:3]

    crisp(master, 512).save(PUBLIC / "icon-512.png", optimize=True)
    crisp(master, 192).save(PUBLIC / "icon-192.png", optimize=True)
    crisp(master, 64).save(PUBLIC / "favicon.png", optimize=True)

    # apple-touch-icon: 180px, opaque (iOS ignores alpha on the home screen).
    logo180 = crisp(master, 180)
    touch = Image.new("RGB", (180, 180), corner)
    touch.paste(logo180, (0, 0), logo180)
    touch.save(PUBLIC / "apple-touch-icon.png", optimize=True)

    # maskable: centre 80% safe zone — badge at ~72% of the canvas.
    inner = int(512 * 0.72)
    mask = Image.new("RGB", (512, 512), corner)
    logo_inner = crisp(master, inner)
    mask.paste(logo_inner, ((512 - inner) // 2, (512 - inner) // 2), logo_inner)
    mask.save(PUBLIC / "icon-maskable.png", optimize=True)

    print("wrote icon-512, icon-192, favicon, apple-touch-icon, icon-maskable")


if __name__ == "__main__":
    main()
