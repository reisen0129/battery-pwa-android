#!/usr/bin/env python3
"""生成电池主题的 PWA 图标（纯标准库，无需 Pillow / 网络）。

输出：
  ../icons/icon-192.png
  ../icons/icon-512.png
maskable 图标与 any 图标共用 512 版本（整张画布为安全背景，主体居中）。
"""
import struct
import zlib
import os

GREEN_BG = (22, 163, 74)      # 背景 #16a34a
WHITE = (255, 255, 255)
GREEN_FILL = (34, 197, 94)    # 电量填充 #22c55e
DARK = (15, 118, 52)


def make_png(path, size, draw):
    buf = bytearray(size * size * 4)

    def setpx(x, y, r, g, b, a=255):
        if 0 <= x < size and 0 <= y < size:
            i = (y * size + x) * 4
            er, eg, eb, ea = buf[i], buf[i + 1], buf[i + 2], buf[i + 3]
            sa = a / 255.0
            ea2 = ea / 255.0
            nr = int(r * sa + er * ea2 * (1 - sa))
            ng = int(g * sa + eg * ea2 * (1 - sa))
            nb = int(b * sa + eb * ea2 * (1 - sa))
            na = int(255 * (sa + ea2 * (1 - sa)))
            buf[i], buf[i + 1], buf[i + 2], buf[i + 3] = nr, ng, nb, na

    draw(setpx, size)

    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            i = (y * size + x) * 4
            raw += bytes((buf[i], buf[i + 1], buf[i + 2], buf[i + 3]))
    comp = zlib.compress(bytes(raw), 9)

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        crc = zlib.crc32(typ + data) & 0xFFFFFFFF
        return c + struct.pack(">I", crc)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", comp)
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def rounded_rect(setpx, x0, y0, x1, y1, r, color):
    x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
    r = int(min(r, (x1 - x0) / 2, (y1 - y0) / 2))
    for y in range(y0, y1):
        for x in range(x0, x1):
            inside = True
            if x < x0 + r and y < y0 + r and (x - x0 - r) ** 2 + (y - y0 - r) ** 2 > r * r:
                inside = False
            elif x > x1 - r and y < y0 + r and (x - (x1 - r)) ** 2 + (y - y0 - r) ** 2 > r * r:
                inside = False
            elif x < x0 + r and y > y1 - r and (x - x0 - r) ** 2 + (y - (y1 - r)) ** 2 > r * r:
                inside = False
            elif x > x1 - r and y > y1 - r and (x - (x1 - r)) ** 2 + (y - (y1 - r)) ** 2 > r * r:
                inside = False
            if inside:
                setpx(x, y, *color)


def draw_battery(setpx, size):
    # 整张背景（maskable 需要全 bleed）
    for y in range(size):
        for x in range(size):
            setpx(x, y, *GREEN_BG)

    # 电池主体（白色圆角矩形）
    bw, bh = size * 0.34, size * 0.55
    bx = (size - bw) / 2
    by = (size - bh) / 2 + size * 0.02
    rounded_rect(setpx, bx, by, bx + bw, by + bh, size * 0.06, WHITE)

    # 电池顶部电极（小矩形）
    tw, th = bw * 0.42, size * 0.035
    tx = (size - tw) / 2
    rounded_rect(setpx, tx, by - th + 2, tx + tw, by + 2, size * 0.012, WHITE)

    # 内部电量填充（从下往上约 68%）
    pad = size * 0.03
    ix0, iy0, ix1, iy1 = bx + pad, by + pad, bx + bw - pad, by + bh - pad
    fill_ratio = 0.68
    fill_top = iy1 - (iy1 - iy0) * fill_ratio
    rounded_rect(setpx, ix0, fill_top, ix1, iy1, size * 0.025, GREEN_FILL)

    # 电量填充顶部一条深色高亮，增加层次
    rounded_rect(setpx, ix0, fill_top, ix1, fill_top + size * 0.02, size * 0.01, DARK)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    icons = os.path.join(here, "..", "icons")
    os.makedirs(icons, exist_ok=True)
    make_png(os.path.join(icons, "icon-192.png"), 192, draw_battery)
    make_png(os.path.join(icons, "icon-512.png"), 512, draw_battery)
    print("icons generated:", os.path.join(icons, "icon-192.png"),
          os.path.join(icons, "icon-512.png"))


if __name__ == "__main__":
    main()
