"""Renders scripts/term-dump.mjs output to a PNG (last frame) or an animated GIF (all frames).

  python scripts/render-frames.py <dump.json> <out.png|out.gif> [--scale=1] [--fps=15]

Maintainer tool (Pillow). Fonts: Consolas / DejaVu Sans Mono for text, Segoe UI Symbol / DejaVu
Sans for symbols; block elements and box lines are drawn as shapes so they join seamlessly, the
way a real terminal draws them.
"""
import base64
import io
import json
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFont

args = [a for a in sys.argv[1:] if not a.startswith('--')]
opts = dict(a[2:].split('=') for a in sys.argv[1:] if a.startswith('--'))
SCALE = float(opts.get('scale', '1'))
FONT_PX = int(16 * SCALE)
CW, CH = int(9 * SCALE), int(20 * SCALE)


def font(names, size):
    dirs = [r'C:\Windows\Fonts', '/usr/share/fonts/truetype/dejavu', '/Library/Fonts', '/System/Library/Fonts']
    for n in names:
        for d in dirs:
            p = os.path.join(d, n)
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
    return ImageFont.load_default()


REG = font(['consola.ttf', 'DejaVuSansMono.ttf'], FONT_PX)
BOLD = font(['consolab.ttf', 'DejaVuSansMono-Bold.ttf'], FONT_PX)
SYM = font(['seguisym.ttf', 'DejaVuSans.ttf'], int(FONT_PX * 0.95))

DEFAULT_FG = (233, 233, 238)
DEFAULT_BG = (15, 15, 18)
CUBE = [0, 95, 135, 175, 215, 255]
ANSI16 = [(46, 46, 52), (232, 92, 82), (34, 197, 94), (240, 190, 90), (96, 150, 245), (210, 120, 210),
          (110, 200, 220), (220, 220, 225), (150, 150, 158), (245, 130, 115), (100, 225, 140),
          (250, 215, 130), (140, 185, 250), (230, 160, 230), (160, 225, 240), (250, 250, 250)]


def pal(i):
    if i < 16:
        return ANSI16[i]
    if i >= 232:
        v = 8 + (i - 232) * 10
        return (v, v, v)
    i -= 16
    return (CUBE[i // 36], CUBE[(i // 6) % 6], CUBE[i % 6])


def color(v, default):
    if v == -1:
        return default
    if v <= -100:
        return pal(-100 - v)
    return ((v >> 16) & 255, (v >> 8) & 255, v & 255)


BLOCKS = {
    '█': (0, 0, 8, 8), '▀': (0, 0, 8, 4), '▄': (0, 4, 8, 8), '▌': (0, 0, 4, 8), '▐': (4, 0, 8, 8),
    '▏': (0, 0, 1, 8), '▎': (0, 0, 2, 8), '▍': (0, 0, 3, 8), '▋': (0, 0, 5, 8), '▊': (0, 0, 6, 8),
    '▉': (0, 0, 7, 8),
}
# (left, right, up, down) arm weights: 1 light, 2 heavy
BOX = {
    '─': (1, 1, 0, 0), '│': (0, 0, 1, 1), '━': (2, 2, 0, 0), '┃': (0, 0, 2, 2),
    '┌': (0, 1, 0, 1), '┐': (1, 0, 0, 1), '└': (0, 1, 1, 0), '┘': (1, 0, 1, 0),
    '┏': (0, 2, 0, 2), '┓': (2, 0, 0, 2), '┗': (0, 2, 2, 0), '┛': (2, 0, 2, 0),
    '╸': (2, 0, 0, 0), '├': (0, 1, 1, 1), '┤': (1, 0, 1, 1), '┬': (1, 1, 0, 1), '┴': (1, 1, 1, 0),
    '┼': (1, 1, 1, 1),
}
ROUND = {'╭': ('r', 'd'), '╮': ('l', 'd'), '╰': ('r', 'u'), '╯': ('l', 'u')}


def draw_cell(d, x, y, ch, fg, bold):
    px, py = x * CW, y * CH
    if ch in BLOCKS:
        a, b, c, e = BLOCKS[ch]
        d.rectangle([px + a * CW / 8, py + b * CH / 8, px + c * CW / 8 - 1, py + e * CH / 8 - 1], fill=fg)
        return
    cx, cy = px + CW // 2, py + CH // 2
    lw = max(1, round(CW / 9))
    if ch in BOX:
        arms = BOX[ch]
        boxes = ((px, cy, cx, cy), (cx, cy, px + CW - 1, cy), (cx, py, cx, cy), (cx, cy, cx, py + CH - 1))
        for on, (x0, y0, x1, y1) in zip(arms, boxes):
            if not on:
                continue
            w = lw * (2 if on == 2 else 1)
            if y0 == y1:
                d.rectangle([x0, y0 - w // 2, x1, y0 - w // 2 + w - 1], fill=fg)
            else:
                d.rectangle([x0 - w // 2, y0, x0 - w // 2 + w - 1, y1], fill=fg)
        return
    if ch in ROUND:
        h, v = ROUND[ch]
        rad = min(CW, CH) // 2
        if h == 'r':
            d.rectangle([cx + rad, cy, px + CW - 1, cy + lw - 1], fill=fg)
        else:
            d.rectangle([px, cy, cx - rad, cy + lw - 1], fill=fg)
        if v == 'd':
            d.rectangle([cx, cy + rad, cx + lw - 1, py + CH - 1], fill=fg)
        else:
            d.rectangle([cx, py, cx + lw - 1, cy - rad], fill=fg)
        bx0 = cx if h == 'r' else cx - 2 * rad
        by0 = cy if v == 'd' else cy - 2 * rad
        start = {('r', 'd'): 180, ('l', 'd'): 270, ('r', 'u'): 90, ('l', 'u'): 0}[(h, v)]
        d.arc([bx0, by0, bx0 + 2 * rad + lw - 1, by0 + 2 * rad + lw - 1], start, start + 90, fill=fg, width=lw)
        return
    o = ord(ch[0]) if ch else 32
    f = BOLD if bold else REG
    if 0x2190 <= o <= 0x2BFF and not (0x2500 <= o < 0x2580):
        f = SYM
    if f is not SYM and ch.strip() and f.getmask(ch).getbbox() is None:
        f = SYM
    d.text((px + (CW - d.textlength(ch, font=f)) / 2, py + CH * 0.08), ch, font=f, fill=fg)


def render(frame, cols, rows):
    im = Image.new('RGB', (cols * CW, rows * CH), DEFAULT_BG)
    d = ImageDraw.Draw(im)
    for y, row in enumerate(frame['grid']):
        for x, (ch, w, fgv, bgv, flags) in enumerate(row):
            fg, bg = color(fgv, DEFAULT_FG), color(bgv, DEFAULT_BG)
            if flags & 2:
                fg, bg = bg, fg
            if bg != DEFAULT_BG:
                d.rectangle([x * CW, y * CH, x * CW + CW * max(1, w) - 1, y * CH + CH - 1], fill=bg)
        for x, (ch, w, fgv, bgv, flags) in enumerate(row):
            if not ch or ch == ' ' or w == 0:
                continue
            fg, bg = color(fgv, DEFAULT_FG), color(bgv, DEFAULT_BG)
            if flags & 2:
                fg, bg = bg, fg
            draw_cell(d, x, y, ch, fg, flags & 1)
    for img in frame.get('images', []):
        logo = Image.open(io.BytesIO(base64.b64decode(img['png']))).convert('RGBA')
        size = CH - 4
        logo = logo.resize((size, size), Image.LANCZOS)
        # the badge cells under the image are painted over with the tile background first
        under = im.getpixel((img['x'] * CW, img['y'] * CH + CH - 1))
        d.rectangle([img['x'] * CW, img['y'] * CH, img['x'] * CW + 2 * CW - 1, img['y'] * CH + CH - 1], fill=under)
        im.paste(logo, (img['x'] * CW + (2 * CW - size) // 2, img['y'] * CH + 2), logo)
    return im


def content_height(im):
    bg = Image.new('RGB', im.size, DEFAULT_BG)
    box = ImageChops.difference(im, bg).getbbox()
    return im.size[1] if not box else min(im.size[1], box[3] + CH // 2)


data = json.load(open(args[0], encoding='utf8'))
out = args[1]
if out.endswith('.gif'):
    frames = [render(f, data['cols'], data['rows']) for f in data['frames']]
    h = max(content_height(f) for f in frames)
    frames = [f.crop((0, 0, f.size[0], h)) for f in frames]
    fps = float(opts.get('fps', '15'))
    pal_frames = [f.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in frames]
    pal_frames[0].save(out, save_all=True, append_images=pal_frames[1:], duration=int(1000 / fps), loop=0)
else:
    im = render(data['frames'][-1], data['cols'], data['rows'])
    im.crop((0, 0, im.size[0], content_height(im))).save(out, optimize=True)
print('wrote', out)
