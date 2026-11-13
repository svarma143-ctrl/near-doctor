"""Replay a record.py capture through a terminal emulator (pyte) and render it to an MP4 (Pillow + ffmpeg).

usage: render.py CAPTURE.json OUT.mp4 [--fps 30] [--tail 2.5] [--keep-frames DIR]
Draws only what the real terminal output produced; nothing is added except the window frame and title.
macOS fonts (Menlo, Helvetica) are used; set FFMPEG=/path/to/ffmpeg if ffmpeg is not on PATH.
Setup: python3 -m venv v && v/bin/pip install pillow pyte
"""
import base64, hashlib, json, os, shutil, subprocess, sys, tempfile
import pyte
from PIL import Image, ImageDraw, ImageFont

args = sys.argv[1:]
cap_path, out_mp4 = args[0], args[1]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
FPS = int(opt("--fps", 30))
TAIL = float(opt("--tail", 2.5))
cap = json.load(open(cap_path))
COLS, ROWS = cap["cols"], cap["rows"]
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")

W, H = 1920, 1080
FS = 19
reg = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", FS, index=0)
bold = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", FS, index=1)
ui = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 20)
CW = reg.getlength("M")
asc, desc = reg.getmetrics()
CH = asc + desc + 1
PAD = 26
CHROME = 52
WIN_W, WIN_H = int(COLS * CW + 2 * PAD), int(ROWS * CH + 2 * PAD + CHROME)
WX, WY = (W - WIN_W) // 2, (H - WIN_H) // 2

FG = (214, 218, 226)
THEME = {
    "default": FG, "black": (72, 78, 92), "red": (240, 100, 112), "green": (140, 205, 124), "brown": (232, 195, 125),
    "blue": (100, 178, 242), "magenta": (200, 124, 224), "cyan": (88, 186, 198), "white": (226, 229, 234),
    "brightblack": (130, 138, 156), "brightred": (255, 130, 140), "brightgreen": (165, 228, 150), "brightbrown": (250, 215, 150),
    "brightblue": (130, 195, 255), "brightmagenta": (220, 150, 240), "brightcyan": (115, 210, 220), "brightwhite": (255, 255, 255),
}
BG_WIN = (22, 25, 34)


def colour(name, default):
    if name == "default":
        return default
    if name in THEME:
        return THEME[name]
    if len(name) == 6:
        try:
            return tuple(int(name[i : i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    return default


def background():
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        for x in range(0, W):
            t = (x / W * 0.5 + y / H * 0.5)
            px[x, y] = (int(14 + 12 * t), int(16 + 14 * t), int(26 + 30 * t))
    d = ImageDraw.Draw(img)
    # window shadow, body, title bar
    for i in range(18, 0, -2):
        d.rounded_rectangle((WX - i, WY - i + 14, WX + WIN_W + i, WY + WIN_H + i + 14), 18 + i, fill=(10, 11, 18))
    d.rounded_rectangle((WX, WY, WX + WIN_W, WY + WIN_H), 16, fill=BG_WIN)
    d.rounded_rectangle((WX, WY, WX + WIN_W, WY + CHROME), 16, fill=(38, 42, 54))
    d.rectangle((WX, WY + CHROME - 16, WX + WIN_W, WY + CHROME), fill=(38, 42, 54))
    for i, c in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        cx = WX + 30 + i * 30
        d.ellipse((cx - 9, WY + CHROME // 2 - 9, cx + 9, WY + CHROME // 2 + 9), fill=c)
    title = "near-doctor  \u2014  node scripts/showcase.mjs"
    d.text((WX + WIN_W // 2 - ui.getlength(title) / 2, WY + CHROME // 2 - 12), title, font=ui, fill=(170, 176, 192))
    return img


BASE = background()
TX, TY = WX + PAD, WY + CHROME + PAD


def render(screen):
    img = BASE.copy()
    d = ImageDraw.Draw(img)
    cx, cy, chidden = screen.cursor.x, screen.cursor.y, screen.cursor.hidden
    for y in range(ROWS):
        row = screen.buffer[y]
        x = 0
        while x < COLS:
            ch = row[x]
            style = (ch.fg, ch.bg, ch.bold, ch.reverse)
            run = [ch.data or " "]
            x2 = x + 1
            while x2 < COLS:
                c2 = row[x2]
                if (c2.fg, c2.bg, c2.bold, c2.reverse) != style:
                    break
                run.append(c2.data or " ")
                x2 += 1
            text = "".join(run)
            fg = colour(ch.fg, FG)
            bg = colour(ch.bg, None)
            if ch.reverse:
                fg, bg = (bg or BG_WIN), (fg if ch.fg != "default" else FG)
            if ch.bold and ch.fg == "default":
                fg = (255, 255, 255)
            px, py = TX + x * CW, TY + y * CH
            if bg is not None:
                d.rectangle((px, py, px + len(text) * CW, py + CH), fill=bg)
            if text.strip():
                d.text((px, py), text, font=bold if ch.bold else reg, fill=fg)
            x = x2
    if not chidden and cx < COLS and cy < ROWS:
        px, py = TX + cx * CW, TY + cy * CH
        d.rectangle((px, py + 1, px + CW, py + CH - 1), fill=(205, 210, 222))
    return img


screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
chunks = [(t, base64.b64decode(b)) for t, b in cap["chunks"]]
# pyte ignores SGR 2 (faint); show it as a muted grey instead.
chunks = [(t, b.replace(b"\x1b[2m", b"\x1b[38;5;245m")) for t, b in chunks]

total = cap["duration"] + TAIL
nframes = int(total * FPS) + 1
tmp = args[args.index("--keep-frames") + 1] if "--keep-frames" in args else tempfile.mkdtemp(prefix="frames-")
os.makedirs(tmp, exist_ok=True)
ci = 0
last_sig, last_png = None, None
renders = 0
for f in range(nframes):
    t = f / FPS
    while ci < len(chunks) and chunks[ci][0] <= t:
        stream.feed(chunks[ci][1])
        ci += 1
    sig = hashlib.md5(repr(([ [(c.data, c.fg, c.bg, c.bold, c.reverse) for c in (screen.buffer[y][x] for x in range(COLS))] for y in range(ROWS)], screen.cursor.x, screen.cursor.y, screen.cursor.hidden)).encode()).hexdigest()
    path = os.path.join(tmp, f"{f:05d}.png")
    if sig != last_sig:
        render(screen).save(path, optimize=False, compress_level=1)
        renders += 1
        last_sig = sig
        last_png = path
    else:
        shutil.copyfile(last_png, path)
print(f"frames={nframes} unique_renders={renders} size={WIN_W}x{WIN_H} on {W}x{H}")

subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", os.path.join(tmp, "%05d.png"),
                "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_mp4], check=True)
if "--keep-frames" not in args:
    shutil.rmtree(tmp, ignore_errors=True)
print("wrote", out_mp4, f"{os.path.getsize(out_mp4)/1e6:.2f} MB")
