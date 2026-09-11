#!/usr/bin/env python3
"""生成 Android 启动图标与启动画面。

一次性工具（不参与构建），放在仓库里是为了"图标怎么来的"可复现：
改颜色或形状时改这里的常量重跑，而不是拿一张图去反推。

设计与验收口径：
- 图形是「一叠卡片 + 上面一张写了两行字」，48dp 下仍能认出是卡片类应用。
- 前景图只占中间 66% 的安全区：自适应图标会被系统裁成圆形/方形/圆角方形，
  图形贴边就会被削掉。
- 背景用品牌蓝的竖向渐变（深→浅），纯色在深色主题下会显得发闷。

用法：
    python3 scripts/gen_icons.py
输出直接覆盖 android/app/src/main/res 下的对应文件。
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.normpath(os.path.join(HERE, '..', 'android', 'app', 'src', 'main', 'res'))

# 品牌色（与 src/ui/styles.css 的 --accent 同源）
BRAND_TOP = (37, 99, 235)  # #2563eb
BRAND_BOTTOM = (29, 78, 216)  # #1d4ed8
WHITE = (255, 255, 255, 255)

# 各密度下的图标边长（px）：mdpi=48dp 起，按 1.5/2/3/4 倍递增
DENSITIES = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
# 自适应图标前景画布是 108dp
FOREGROUND_DENSITIES = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}


def gradient(size: int) -> Image.Image:
    """竖向渐变底：逐行插值，够用且不引入依赖"""
    img = Image.new('RGB', (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        d.line(
            [(0, y), (size, y)],
            fill=tuple(round(BRAND_TOP[i] + (BRAND_BOTTOM[i] - BRAND_TOP[i]) * t) for i in range(3)),
        )
    return img


def draw_mark(size: int, scale: float = 1.0) -> Image.Image:
    """画前景图形：两张叠在一起的卡片，前面那张带两行"文字"。

    scale 控制图形在画布中的占比（自适应图标要留安全区，所以小于 1）。
    """
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    s = size * scale
    off = (size - s) / 2
    w = s * 0.66  # 卡片宽
    h = s * 0.48  # 卡片高
    r = s * 0.07  # 圆角

    # 后面那张（露一角，半透明）
    back_x = off + (s - w) / 2 + s * 0.06
    back_y = off + (s - h) / 2 - s * 0.07
    d.rounded_rectangle([back_x, back_y, back_x + w, back_y + h], radius=r, fill=(255, 255, 255, 130))

    # 前面那张
    fx = off + (s - w) / 2 - s * 0.06
    fy = off + (s - h) / 2 + s * 0.05
    d.rounded_rectangle([fx, fy, fx + w, fy + h], radius=r, fill=WHITE)

    # 卡面上的两行字：第一行深蓝（问题），第二行浅蓝（答案）
    lx = fx + w * 0.14
    lw = w * 0.72
    lh = h * 0.11
    d.rounded_rectangle([lx, fy + h * 0.24, lx + lw, fy + h * 0.24 + lh], radius=lh / 2, fill=BRAND_BOTTOM)
    d.rounded_rectangle(
        [lx, fy + h * 0.52, lx + lw * 0.6, fy + h * 0.52 + lh], radius=lh / 2, fill=(147, 197, 253)
    )
    return img


def rounded_mask(size: int, radius_ratio: float) -> Image.Image:
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=size * radius_ratio, fill=255)
    return m


def circle_mask(size: int) -> Image.Image:
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).ellipse([0, 0, size - 1, size - 1], fill=255)
    return m


def write(path: str, img: Image.Image) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)
    print('写入', os.path.relpath(path, RES))


def main() -> None:
    # 1) 自适应图标前景（只画图形，底由系统的 background 提供）
    for dens, size in FOREGROUND_DENSITIES.items():
        write(os.path.join(RES, f'mipmap-{dens}', 'ic_launcher_foreground.png'), draw_mark(size, scale=0.62))

    # 2) 传统图标（一体化的圆角方形 / 圆形）：老系统与部分启动器只用这两个
    for dens, size in DENSITIES.items():
        base = gradient(size).convert('RGBA')
        merged = Image.alpha_composite(base, draw_mark(size, scale=0.86))
        square = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        square.paste(merged, (0, 0), rounded_mask(size, 0.22))
        write(os.path.join(RES, f'mipmap-{dens}', 'ic_launcher.png'), square)

        round_icon = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        round_icon.paste(merged, (0, 0), circle_mask(size))
        write(os.path.join(RES, f'mipmap-{dens}', 'ic_launcher_round.png'), round_icon)

    # 3) 启动画面用的 logo（透明底，由 splash.xml 居中摆放）
    #
    # 这里的比例比图标小得多是有原因的：Android 12+ 的 SplashScreen API 会把这张图
    # **按圆形遮罩裁剪**。卡片图形是宽扁的，按 0.8 的比例画出来会超出内切圆，
    # 四角被切成直线（真机上很显眼）。0.52 能让整张卡片落在圆内。
    write(os.path.join(RES, 'drawable', 'splash_logo.png'), draw_mark(512, scale=0.52))


if __name__ == '__main__':
    main()
