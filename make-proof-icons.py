#!/usr/bin/env python3
"""Generate Proof's home-screen app icons.

Run from artifacts/gameday (the LIVE tree -- CLAUDE.md S1.1):

    python make-proof-icons.py

Writes public/proof-icon-180.png, proof-icon-192.png, proof-icon-512.png,
proof-icon-maskable-512.png. Commit the PNGs.

PLACEHOLDER MARK, drawn from scratch (no source seal exists for Proof yet):
a navy rounded square on radiant white, with a white checkmark -- the two
brand colors Jess signed off on (radiant white background, not the parchment
tone the other standalone tools use), without attempting to rasterize the
"P" letterform from the brand sheet mockup, which needs real vector art.
Swap this for a proper export once one exists; nothing else changes.

Pure stdlib zlib + struct, same reason as make-app-icons.py: no sharp/PIL/
ImageMagick on this stack, and a lockfile edit can't be verified from a
local clone.
"""
import struct
import zlib
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "public")
WHITE = (0xFF, 0xFF, 0xFF)
NAVY = (0x0E, 0x1F, 0x3C)


def write_rgb_png(path, w, h, rgb):
    stride = w * 3
    rows = bytearray()
    for y in range(h):
        rows.append(0)  # filter: none
        rows += rgb[y * stride:(y + 1) * stride]

    def chunk(typ, payload):
        return (struct.pack(">I", len(payload)) + typ + payload
                + struct.pack(">I", zlib.crc32(typ + payload) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(rows), 9))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)


def set_px(rgb, size, x, y, color):
    if 0 <= x < size and 0 <= y < size:
        o = (y * size + x) * 3
        rgb[o], rgb[o + 1], rgb[o + 2] = color


def fill_rounded_square(rgb, size, inset, radius, color):
    lo, hi = inset, size - inset
    for y in range(lo, hi):
        for x in range(lo, hi):
            # distance from the nearest corner center, only checked in the corners
            cx = lo + radius if x < lo + radius else (hi - radius if x >= hi - radius else None)
            cy = lo + radius if y < lo + radius else (hi - radius if y >= hi - radius else None)
            if cx is not None and cy is not None:
                if (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2:
                    continue
            set_px(rgb, size, x, y, color)


def draw_check(rgb, size, color, thickness):
    # Two thick line segments forming a checkmark, centered in the tile.
    def thick_line(x0, y0, x1, y1):
        steps = max(abs(x1 - x0), abs(y1 - y0)) * 2
        for i in range(steps + 1):
            t = i / steps
            cx = x0 + (x1 - x0) * t
            cy = y0 + (y1 - y0) * t
            for dx in range(-thickness, thickness + 1):
                for dy in range(-thickness, thickness + 1):
                    if dx * dx + dy * dy <= thickness * thickness:
                        set_px(rgb, size, int(cx + dx), int(cy + dy), color)
    s = size
    thick_line(int(s * 0.28), int(s * 0.52), int(s * 0.44), int(s * 0.68))
    thick_line(int(s * 0.44), int(s * 0.68), int(s * 0.74), int(s * 0.34))


def build(name, size, margin):
    rgb = bytearray(WHITE * (size * size))
    inset = int(round(size * margin))
    fill_rounded_square(rgb, size, inset, int(size * 0.16), NAVY)
    draw_check(rgb, size, WHITE, max(2, size // 22))
    path = os.path.join(PUBLIC, name)
    write_rgb_png(path, size, size, rgb)
    print("  %-28s %4dx%-4d %6.1f KB" % (name, size, size, os.path.getsize(path) / 1024))


if __name__ == "__main__":
    build("proof-icon-180.png", 180, 0.06)
    build("proof-icon-192.png", 192, 0.06)
    build("proof-icon-512.png", 512, 0.06)
    build("proof-icon-maskable-512.png", 512, 0.16)
    print("done. Placeholder mark -- swap for real vector art when it exists (see header).")
