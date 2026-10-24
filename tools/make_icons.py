"""Generate the plugin icon set without any image library.

Writes PNGs with zlib only. The mark is a rounded square with five waveform
bars (Stability AI tokens: Artist Purple #A381FF on Studio Black #1E1E1E for
dark themes, Studio Black bars on Canvas White #EEEEEE for light themes, and a
purple-on-black tile for the Marketplace listing).

Usage:  python tools/make_icons.py
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"

PURPLE = (0xA3, 0x81, 0xFF)
BLACK = (0x1E, 0x1E, 0x1E)
WHITE = (0xEE, 0xEE, 0xEE)


def png(path, size, pixels):
    """pixels: list of rows, each a list of (r, g, b, a)."""
    raw = b"".join(b"\x00" + bytes(c for px in row for c in px) for row in pixels)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(data)


def coverage(px, py, shape, ss=4):
    """Supersampled coverage of a pixel by a shape(x, y) -> bool predicate."""
    hits = 0
    for i in range(ss):
        for j in range(ss):
            if shape(px + (i + 0.5) / ss, py + (j + 0.5) / ss):
                hits += 1
    return hits / (ss * ss)


def rounded_rect(x0, y0, x1, y1, r):
    def inside(x, y):
        if x < x0 or x > x1 or y < y0 or y > y1:
            return False
        cx = min(max(x, x0 + r), x1 - r)
        cy = min(max(y, y0 + r), y1 - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    return inside


def bars(size, bg_tile):
    """Five waveform bars, heights as fractions of the drawable area."""
    heights = [0.36, 0.68, 1.0, 0.56, 0.30]
    pad = size * (0.22 if bg_tile else 0.12)
    area = size - 2 * pad
    n = len(heights)
    gap = area * 0.10
    w = (area - gap * (n - 1)) / n
    cy = size / 2
    shapes = []
    for i, h in enumerate(heights):
        x0 = pad + i * (w + gap)
        half = area * h / 2
        shapes.append(rounded_rect(x0, cy - half, x0 + w, cy + half, w / 2))
    return lambda x, y: any(s(x, y) for s in shapes)


def render(size, fg, bg=None, tile_radius=0.22):
    tile = rounded_rect(0, 0, size, size, size * tile_radius) if bg else None
    mark = bars(size, bg is not None)
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            if tile:
                t = coverage(x, y, tile)
                m = coverage(x, y, mark)
                r = tuple(int(bg[k] * (1 - m) + fg[k] * m) for k in range(3))
                row.append((r[0], r[1], r[2], int(255 * t)))
            else:
                m = coverage(x, y, mark)
                row.append((fg[0], fg[1], fg[2], int(255 * m)))
        rows.append(row)
    return rows


def main():
    OUT.mkdir(exist_ok=True)
    # Panel chrome icons (23 px, 1x and 2x), glyph only, themed.
    for name, fg in (("dark", WHITE), ("light", BLACK)):
        png(OUT / f"{name}.png", 23, render(23, fg))
        png(OUT / f"{name}@2x.png", 46, render(46, fg))
    # Plugins panel list icon, declared at 48 px with a 2x file, as in Adobe's
    # Premiere samples (sample-panels/metadata-handler/manifest.json).
    png(OUT / "plugin-icon.png", 48, render(48, PURPLE, BLACK))
    png(OUT / "plugin-icon@2x.png", 96, render(96, PURPLE, BLACK))
    # Marketplace listing icons, uploaded in the Developer Distribution portal.
    for s in (48, 96, 192):
        png(OUT / f"marketplace-{s}.png", s, render(s, PURPLE, BLACK))
    # Publisher logo placeholder (250 px) and a 1360x800 screenshot are also
    # required by the portal; the screenshot must be a real capture.
    png(OUT / "publisher-250.png", 250, render(250, PURPLE, BLACK))
    print("wrote", sorted(p.name for p in OUT.iterdir()))


if __name__ == "__main__":
    main()
