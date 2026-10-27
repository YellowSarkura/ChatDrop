"""用 pyzbar 解码 ChatDrop 生成的二维码，验证内容正确（修正编码）"""
import os
import sys
import io

# 强制 UTF-8 输出，避免 Windows GBK 报错
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

try:
    from pyzbar import pyzbar
    from PIL import Image
except ImportError as e:
    print(f"依赖缺失: {e}")
    sys.exit(1)

BASE = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(BASE, "_shots", "qr-test.png")

if not os.path.exists(path):
    print(f"文件不存在: {path}")
    sys.exit(1)

img = Image.open(path)
print(f"图片: {img.size[0]}x{img.size[1]}  {os.path.getsize(path)} bytes")

codes = pyzbar.decode(img)
print(f"识别到 {len(codes)} 个二维码")

if not codes:
    print("[X] 解码失败 —— 这个二维码扫不出来")
    sys.exit(1)

expected = "http://localhost:8787/?pair=aabe521e-8833-4d0b-b44c-7bb5316b6f5c"

ok = True
for i, c in enumerate(codes):
    val = c.data.decode("utf-8")
    print(f"  [{i}] 类型={c.type}")
    print(f"      内容={val}")
    if val == expected:
        print("      结果: 完全匹配 [OK]")
    else:
        print(f"      期望: {expected}")
        print("      结果: 不匹配 [FAIL]")
        ok = False

print()
print("结论: 二维码可被标准解码器正确识别" if ok else "结论: 验证失败")
sys.exit(0 if ok else 1)
