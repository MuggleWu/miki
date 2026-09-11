#!/usr/bin/env python3
"""生成 Android 启动图标与启动画面。

图形**不是**这里画出来的：和桌面端共用同一份 `resources/icon.png`（狐狸线稿），
这个脚本只负责把它裁到各种尺寸、按自适应图标的规矩留出安全区。
放在仓库里是为了"图标怎么来的"可复现：改了桌面图标就重跑一次，而不是手动改一堆 PNG。

用法：
    python3 scripts/gen_icons.py     # 需要 Pillow：pip install pillow
输出直接覆盖 android/app/src/main/res 下的对应文件。

三套尺寸口径：
- 自适应图标前景：108dp 画布，**只有中间 72dp 一定可见**（系统会按圆形/圆角方形裁切）。
  狐狸的 bbox 占画布 45%（≈49dp），落在 72dp 内切圆里——圆角方形之外的启动器也削不到耳朵。
- 传统图标（Android 8 以前、以及部分启动器）：直接用桌面那份整图，形状自带。
- 启动图 logo：Android 12+ 会按圆形裁剪，所以比图标再小一点。
"""
from __future__ import annotations

import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.normpath(os.path.join(HERE, '..', 'android', 'app', 'src', 'main', 'res'))
SOURCE = os.path.normpath(os.path.join(HERE, '..', '..', 'resources', 'icon.png'))

# 桌面图标里的实际颜色（见 resources/icon.png）：底 #FBFBFB、笔画 #424242
BACKDROP = (251, 251, 251, 255)
INK = (66, 66, 64)
INK_LUM = 0.299 * INK[0] + 0.587 * INK[1] + 0.114 * INK[2]
BACKDROP_LUM = 0.299 * BACKDROP[0] + 0.587 * BACKDROP[1] + 0.114 * BACKDROP[2]
INK_THRESHOLD = 24  # alpha 低于此值当背景，用来算 bbox

# 各密度下的图标边长（px）：mdpi=48dp 起，按 1.5/2/3/4 倍递增
DENSITIES = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
# 自适应图标（前景/单色层）的画布是 108dp
LAYER_DENSITIES = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}

FOX_IN_FOREGROUND = 0.45  # 狐狸 bbox 占 108dp 画布的比例
FOX_IN_SPLASH = 0.6  # 启动图里占 512px 画布的比例


def extract_fox() -> Image.Image:
    """把狐狸笔画抠成透明底的图层。

    源图是"浅底 + 深色线稿"的合成图，没有现成的 alpha。按亮度线性换算成不透明度：
    亮度等于底色 → 全透明，等于笔画色 → 全不透明，中间就是抗锯齿边缘。
    """
    src = Image.open(SOURCE).convert('RGBA')
    w, h = src.size
    fox = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    sp, fp = src.load(), fox.load()
    span = BACKDROP_LUM - INK_LUM
    for y in range(h):
        for x in range(w):
            r, g, b, a = sp[x, y]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            alpha = max(0.0, min(1.0, (BACKDROP_LUM - lum) / span)) * (a / 255)
            if alpha > 0:
                fp[x, y] = (INK[0], INK[1], INK[2], round(alpha * 255))
    return fox


def fox_bbox(fox: Image.Image) -> tuple[int, int, int, int]:
    mask = fox.split()[3].point(lambda v: 255 if v >= INK_THRESHOLD else 0)
    box = mask.getbbox()
    if box is None:
        raise SystemExit('源图里找不到狐狸笔画——resources/icon.png 换图了？')
    return box


def paste_fox(canvas: Image.Image, fox: Image.Image, box: tuple[int, int, int, int], ratio: float) -> None:
    """把狐狸按"bbox 占画布 ratio"缩放并居中贴进画布。"""
    size = canvas.size[0]
    crop = fox.crop(box)
    target = max(1, round(size * ratio))
    scale = target / max(crop.size)
    resized = crop.resize((max(1, round(crop.size[0] * scale)), max(1, round(crop.size[1] * scale))), Image.LANCZOS)
    canvas.alpha_composite(resized, ((size - resized.size[0]) // 2, (size - resized.size[1]) // 2))


def circle_mask(size: int) -> Image.Image:
    mask = Image.new('L', (size, size), 0)
    from PIL import ImageDraw

    ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
    return mask


def write(path: str, img: Image.Image) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)
    print('写入', os.path.relpath(path, RES))


def main() -> None:
    fox = extract_fox()
    box = fox_bbox(fox)
    desktop = Image.open(SOURCE).convert('RGBA')

    # 1) 自适应图标前景与单色层（Android 13+ 主题图标）：只放图形，底色由 background 提供
    for dens, size in LAYER_DENSITIES.items():
        fg = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        paste_fox(fg, fox, box, FOX_IN_FOREGROUND)
        write(os.path.join(RES, f'mipmap-{dens}', 'ic_launcher_foreground.png'), fg)

        mono = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        paste_fox(mono, fox, box, FOX_IN_FOREGROUND)
        # 单色层只看 alpha，系统会自己上色；这里统一填白以符合惯例
        mono_white = Image.new('RGBA', (size, size), (255, 255, 255, 0))
        mono_white.putalpha(mono.split()[3])
        write(os.path.join(RES, f'mipmap-{dens}', 'ic_launcher_monochrome.png'), mono_white)

    # 2) 传统图标：桌面那份整图（自带圆角方形），按各密度缩放
    for dens, size in DENSITIES.items():
        write(os.path.join(RES, f'mipmap-{dens}', 'ic_launcher.png'), desktop.resize((size, size), Image.LANCZOS))

        # 圆形版：底色铺满圆 + 狐狸居中（传统图标没有系统遮罩，形状得自己给）
        rnd = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        disc = Image.new('RGBA', (size, size), BACKDROP)
        rnd.paste(disc, (0, 0), circle_mask(size))
        paste_fox(rnd, fox, box, FOX_IN_FOREGROUND)
        rnd.putalpha(Image.composite(rnd.split()[3], Image.new('L', (size, size), 0), circle_mask(size)))
        write(os.path.join(RES, f'mipmap-{dens}', 'ic_launcher_round.png'), rnd)

    # 3) 启动画面 logo（透明底，由启动主题居中摆放；Android 12+ 会按圆形裁剪）
    splash = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
    paste_fox(splash, fox, box, FOX_IN_SPLASH)
    write(os.path.join(RES, 'drawable', 'splash_logo.png'), splash)


if __name__ == '__main__':
    main()
