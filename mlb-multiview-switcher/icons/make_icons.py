"""Generate the extension's PNG icons with no third-party deps.

Renders at 4x with a distance-field and box-downsamples for antialiasing.
Motif: a baseball on a navy rounded square, with a small amber dot marking the
'active pane' the extension is chasing.
"""
import math, struct, zlib, os

NAVY = (10, 35, 81)
WHITE = (246, 246, 244)
RED = (196, 42, 50)
AMBER = (240, 170, 40)

SS = 4  # supersample factor


def over(dst, src, a):
    return tuple(int(round(s * a + d * (1 - a))) for d, s in zip(dst, src))


def render(size):
    S = size * SS
    rows = []
    c = S / 2.0
    corner = S * 0.22
    ball_r = S * 0.32
    # Seam arcs come from big circles centred well outside the ball, so only a
    # shallow bow crosses it — offset chosen to land each seam at 0.55 of the
    # ball radius rather than through the middle.
    seam_r = S * 0.78
    seam_off = seam_r + 0.55 * ball_r
    seam_w = max(S * 0.022, 1.1)
    dot_r = S * 0.085
    dot_c = (S * 0.775, S * 0.775)

    for y in range(S):
        row = []
        for x in range(S):
            px, py = x + 0.5, y + 0.5

            # Rounded-square background; everything outside is transparent.
            qx = max(abs(px - c) - (S / 2 - corner), 0.0)
            qy = max(abs(py - c) - (S / 2 - corner), 0.0)
            if math.hypot(qx, qy) > corner:
                row.append((0, 0, 0, 0))
                continue

            color = NAVY
            d_ball = math.hypot(px - c, py - c)
            if d_ball <= ball_r:
                color = WHITE
                # Two seams: arcs of circles centred left and right of the ball.
                for cx in (c - seam_off, c + seam_off):
                    if abs(math.hypot(px - cx, py - c) - seam_r) <= seam_w:
                        color = RED
                        break

            if math.hypot(px - dot_c[0], py - dot_c[1]) <= dot_r:
                color = AMBER

            row.append((*color, 255))
        rows.append(row)

    # Box downsample.
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            r = g = b = a = 0
            for dy in range(SS):
                for dx in range(SS):
                    pr, pg, pb, pa = rows[y * SS + dy][x * SS + dx]
                    r += pr * pa; g += pg * pa; b += pb * pa; a += pa
            n = SS * SS
            if a == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((r // a, g // a, b // a, a // n))
        out.append(row)
    return out


def write_png(path, pixels):
    size = len(pixels)
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("BBBB", *p) for p in row) for row in pixels
    )

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


dest = os.path.join(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(dest, exist_ok=True)
for s in (16, 32, 48, 128):
    p = os.path.join(dest, f"icon{s}.png")
    write_png(p, render(s))
    print(f"{p}  {os.path.getsize(p)} bytes")
