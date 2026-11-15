#!/usr/bin/env python3
"""PopoutX 的命令行版本（独立于网页，全部在本机运行，不联网）。
Command-line companion of PopoutX. Fully local, no network access.

把一张照片切成最多 20 份；你提供主体蒙版（白色 = 主体，黑色 = 背景）时，
主体覆盖的列会合成一张「主图」：图内的缝画成竖槽，主体盖在槽前面。
其余图片是原图原宽的普通切片。输出按发帖顺序编号：01.png、02.png……

Splits a photo into up to 20 slices. If you pass a subject mask (white = subject),
the columns the subject covers become one "main image" with slot gaps drawn behind the subject;
the rest are plain slices. Output is numbered in posting order: 01.png, 02.png, ...

注意 / Note: 这里没有 AI 抠图，需要自己准备蒙版（可用任何抠图工具导出）；
合并规则按「主体覆盖范围」判断，不含网页版里“缝是否完整”的逐条编辑。
No cutout model here — bring your own mask. Merging follows the subject's extent only
(no per-gap editing like the web app).

用法 / Usage:
    python3 scripts/slice.py photo.jpg -o out --images 10 --mask mask.png --theme dark
依赖 / Requires: pip install numpy pillow
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageOps

MAX_LONG = 2400


def fit_size(w: int, h: int) -> tuple[int, int]:
    long_side = max(w, h)
    if long_side <= MAX_LONG:
        return w, h
    scale = MAX_LONG / long_side
    return max(1, int(round(w * scale))), max(1, int(round(h * scale)))


def build_lines_mask(w: int, h: int, centers: list[float], slot_w: int, corner: int) -> np.ndarray:
    """255 where the picture is kept. Each separator line (center = fraction of width) is a vertical
    slot of width slot_w; the pillars between slots have rounded top/bottom ends.
    Outer image edges stay square."""
    xs = sorted({min(w - 1, max(1, int(round(c * w)))) for c in centers})
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    half = slot_w / 2.0
    edges = [0.0]
    for x in xs:
        edges += [x - half, x + half]
    edges.append(float(w))
    for i in range(0, len(edges), 2):
        x0, x1 = edges[i], edges[i + 1]
        if x1 - x0 < 1:
            continue
        r = int(min(corner, (x1 - x0) / 2.0 - 1, h / 2.0))
        first, last = (i == 0), (i + 2 >= len(edges))
        if r < 1:
            draw.rectangle((x0, 0, x1 - 1, h - 1), fill=255)
        else:
            draw.rounded_rectangle((x0, 0, x1 - 1, h - 1), radius=r, fill=255,
                                   corners=(not first, not last, not last, not first))
    arr = np.asarray(mask)
    return np.where(arr > 127, 255, 0).astype(np.uint8)


def render_main_image(image: Image.Image, subject: np.ndarray, keep: np.ndarray, theme: str) -> Image.Image:
    """A pixel stays visible if it is in a pillar or belongs to the subject; otherwise it becomes the
    slot colour (black or white). The result is fully opaque (X flattens transparency anyway)."""
    rgb = np.asarray(ImageOps.exif_transpose(image).convert("RGB"))
    h, w = rgb.shape[:2]
    visible = (keep == 255) | (subject == 255)
    out = rgb.copy()
    out[~visible] = [255, 255, 255] if theme == "white" else [0, 0, 0]
    return Image.fromarray(out, "RGB")


def main() -> int:
    p = argparse.ArgumentParser(description="PopoutX command-line version (local only)")
    p.add_argument("image", type=Path, help="输入源图片 / source photo")
    p.add_argument("-o", "--out", type=Path, required=True, help="输出目录 / output folder")
    p.add_argument("--mask", type=Path, help="主体蒙版（白色主体、黑色背景）/ subject mask (white subject on black)")
    p.add_argument("--theme", choices=("dark", "white"), default="dark",
                   help="分隔线颜色，和你的 X 显示模式一致 / gap colour matching your X mode (default: dark)")
    p.add_argument("--images", type=int, default=10, choices=range(1, 21), metavar="1-20",
                   help="等分成几份 (1~20，默认 10) / number of slices")
    p.add_argument("--centers", type=str, help="自定义每条缝的位置（占整图宽度的比例），如 0.1,0.2,0.4；优先于 --images")
    p.add_argument("--drop", type=str, help="去掉指定编号的缝（从左到右，1 起），如 2,5")
    args = p.parse_args()

    if not args.image.is_file():
        print(f"找不到图片 / image not found: {args.image}", file=sys.stderr)
        return 1

    img = ImageOps.exif_transpose(Image.open(args.image)).convert("RGB")
    w, h = fit_size(*img.size)
    if img.size != (w, h):
        img = img.resize((w, h), Image.Resampling.LANCZOS)

    if args.mask:
        if not args.mask.is_file():
            print(f"找不到蒙版 / mask not found: {args.mask}", file=sys.stderr)
            return 1
        m_img = Image.open(args.mask).convert("L")
        if m_img.size != (w, h):
            m_img = m_img.resize((w, h), Image.Resampling.LANCZOS)
        subject = np.where(np.asarray(m_img) >= 128, 255, 0).astype(np.uint8)
    else:
        subject = np.zeros((h, w), dtype=np.uint8)   # 没有蒙版：全部是普通切片

    # 主体横向范围（忽略零星噪点）
    cols = (subject == 255).sum(axis=0)
    xs_ = np.nonzero(cols >= 3)[0]
    box = (xs_[0] / w, (xs_[-1] + 1) / w) if len(xs_) else None

    if args.centers:
        centers = sorted(float(c) for c in args.centers.split(",") if c.strip())
    else:
        centers = [i / args.images for i in range(1, args.images)]
    if args.drop:
        drop = {int(x) for x in args.drop.split(",") if x.strip()}
        centers = [c for i, c in enumerate(centers, start=1) if i not in drop]

    cuts = [0.0] + sorted(set(round(c, 4) for c in centers if 0 < c < 1)) + [1.0]
    region = None
    if box is not None:
        lo = max(c for c in cuts if c <= box[0] + 1e-4)
        hi = min(c for c in cuts if c >= box[1] - 1e-4)
        region = (lo, hi) if hi - lo > 1e-6 else None

    pieces = len(cuts) - 1
    merged = sum(1 for c in cuts if region and region[0] - 2e-4 <= c <= region[1] + 2e-4) - 1 if region else 0
    total = pieces - merged + (1 if region else 0)
    if total > 20:
        print("最多 20 张图 / at most 20 images", file=sys.stderr)
        return 1

    inner = [c for c in cuts[1:-1] if region and region[0] + 2e-4 < c < region[1] - 2e-4]
    slot_w = max(4, int(round(w * 0.007)))      # 槽宽 = X 图缝宽（实测约 0.70% 图宽）
    corner = max(2, int(round(w * 0.0062)))   # X 圆角实测 8px / 1282px
    keep = build_lines_mask(w, h, inner, slot_w, corner)
    main_img = render_main_image(img, subject, keep, args.theme)

    args.out.mkdir(parents=True, exist_ok=True)
    px = [int(round(f * w)) for f in cuts]
    L, R = (int(round(region[0] * w)), int(round(region[1] * w))) if region else (-1, -1)
    # X 的格子宽高比上限约 0.64：主图更宽就给所有图上下补边（网页版同一规则）
    pad_top, out_h = 0, h
    if region and (R - L) / h > 0.64:
        out_h = int(np.ceil((R - L) / 0.625))
        pad_top = (out_h - h) // 2
    theme_c = 255.0 if args.theme == "white" else 0.0
    pad_bot = out_h - h - pad_top
    smooth_k = max(2, int(round(w / 250)))

    def edge_fade(rows: np.ndarray, n: int, is_top: bool) -> np.ndarray:
        e = rows.mean(axis=0)                                   # per-column edge colour, (width, 3)
        ker = np.ones(2 * smooth_k + 1) / (2 * smooth_k + 1)
        e = np.stack([np.convolve(np.pad(e[:, c], (smooth_k, smooth_k), mode="edge"), ker, mode="valid") for c in range(3)], axis=1)
        d = (np.arange(n) + 0.5) / n                            # rows listed top to bottom
        if is_top:
            d = 1 - d                                           # 0 at the photo edge, 1 outermost
        t = (d * d * (3 - 2 * d))[:, None, None]
        return e[None] * (1 - t) + theme_c * t

    def put(piece: Image.Image) -> Image.Image:
        """Extend the picture up/down from its edge colours and fade to the theme colour."""
        if out_h == h:
            return piece
        a = np.asarray(piece.convert("RGB")).astype(np.float32)
        top = edge_fade(a[:8], pad_top, True) if pad_top else a[:0]
        bot = edge_fade(a[-8:], pad_bot, False) if pad_bot else a[:0]
        return Image.fromarray(np.concatenate([top, a, bot], 0).clip(0, 255).astype(np.uint8))

    widths, n, done = [], 0, False
    for i in range(pieces):
        x0, x1 = px[i], px[i + 1]
        if region and x0 >= L and x1 <= R:
            if not done:
                n += 1
                put(main_img.crop((L, 0, R, h))).save(args.out / f"{n:02d}.png")     # 主图：所见即所得
                widths.append(R - L)
                done = True
        else:
            n += 1
            put(img.crop((x0, 0, x1, h))).save(args.out / f"{n:02d}.png")            # 普通切片：原图原宽
            widths.append(x1 - x0)

    print(json.dumps({"out": str(args.out), "widths": widths, "images": len(widths)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
