"""
用角色立绘生成 ChatDrop 的 PWA 图标。

处理流程：
  1. 载入原图，按非白像素自动裁掉多余留白
  2. 圆角方形白底（贴合原画风格，不破坏角色轮廓）
  3. 按各尺寸等比缩放并居中
  4. maskable 版本额外内缩到安全区（80%），避免被系统裁切
"""

from PIL import Image, ImageDraw
import os

SRC = r"C:\Users\EDY\Pictures\e2d07432c895d1431cbe792035f082025baf0766.jpg"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
os.makedirs(OUT, exist_ok=True)
os.makedirs(ASSETS, exist_ok=True)


def trim_white(img, threshold=245):
    """裁掉四周的白色留白，返回内容包围盒裁剪后的图。"""
    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()

    # 找非白像素的边界（每隔几像素采样，加快速度）
    step = max(1, min(w, h) // 400)
    left, top, right, bottom = w, h, 0, 0

    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b = px[x, y]
            if r < threshold or g < threshold or b < threshold:
                if x < left:
                    left = x
                if x > right:
                    right = x
                if y < top:
                    top = y
                if y > bottom:
                    bottom = y

    if right <= left or bottom <= top:
        return img  # 全是白色，原样返回

    # 留一点边距，避免贴边
    pad_x = int((right - left) * 0.03)
    pad_y = int((bottom - top) * 0.03)
    left = max(0, left - pad_x)
    top = max(0, top - pad_y)
    right = min(w - 1, right + pad_x)
    bottom = min(h - 1, bottom + pad_y)

    return img.crop((left, top, right + 1, bottom + 1))


def rounded_mask(size, radius_ratio=0.225):
    """生成圆角方形蒙版。"""
    ss = 4
    S = size * ss
    mask = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(mask)
    r = int(S * radius_ratio)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def make_icon(src, size, *, rounded=True, inner=0.90, bg=(255, 255, 255)):
    """把角色放到 size×size 的方形画布上。

    inner: 角色占据画布的比例（maskable 要更小以留出安全区）
    """
    ss = 4
    S = size * ss

    canvas = Image.new("RGBA", (S, S), bg + (255,))

    # 等比缩放到 inner 比例以内
    cw, ch = src.size
    box = int(S * inner)
    scale = min(box / cw, box / ch)
    nw, nh = max(1, int(cw * scale)), max(1, int(ch * scale))
    char = src.convert("RGBA").resize((nw, nh), Image.LANCZOS)

    # 居中粘贴
    ox = (S - nw) // 2
    oy = (S - nh) // 2
    canvas.paste(char, (ox, oy), char)

    if rounded:
        mask = rounded_mask(size, 0.225).resize((S, S), Image.LANCZOS)
        out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        out.paste(canvas, (0, 0), mask)
        canvas = out

    return canvas.resize((size, size), Image.LANCZOS)


def main():
    src_raw = Image.open(SRC)
    print(f"原图: {src_raw.size[0]}x{src_raw.size[1]}  {os.path.getsize(SRC)//1024} KB")

    # 备份原图到项目里，便于以后重生成
    backup = os.path.join(ASSETS, "mascot.jpg")
    if not os.path.exists(backup):
        src_raw.convert("RGB").save(backup, "JPEG", quality=95)
        print(f"原图已备份: {backup}")

    src = trim_white(src_raw)
    print(f"裁白后: {src.size[0]}x{src.size[1]}")

    specs = [
        ("icon-192.png", 192, dict(rounded=True, inner=0.92)),
        ("icon-512.png", 512, dict(rounded=True, inner=0.92)),
        ("icon-maskable-512.png", 512, dict(rounded=False, inner=0.78)),
        ("apple-touch-icon.png", 180, dict(rounded=False, inner=0.88)),
        ("favicon.png", 64, dict(rounded=True, inner=0.94)),
    ]

    for name, size, kw in specs:
        icon = make_icon(src, size, **kw)
        path = os.path.join(OUT, name)
        icon.save(path, "PNG", optimize=True)
        print(f"{name:26s} {size}x{size}  {os.path.getsize(path)//1024} KB")

    # 顶栏小头像用（圆角方形，尺寸小一点）
    avatar = make_icon(src, 96, rounded=True, inner=0.96)
    ap = os.path.join(OUT, "mascot-96.png")
    avatar.save(ap, "PNG", optimize=True)
    print(f"{'mascot-96.png':26s} 96x96  {os.path.getsize(ap)//1024} KB")

    print("\n完成 ->", OUT)


if __name__ == "__main__":
    main()
