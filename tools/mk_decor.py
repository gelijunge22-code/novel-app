#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 frontend/css/decor.css 里那几条**内联 SVG 装饰**（纸纹 / 竹影 / 水波）。

为什么用脚本生成而不是手写一堆百分号编码：
  ① 手写编码最容易错一个 `%23` 就整条背景失效，而且没人看得出来（CSS 里报错是静默的）；
  ② 透明度要反复调（装饰的亮度差必须压在"机器判据的墨迹阈值"以下），
     调一次手改 4 个 data URI 太容易改漏 —— 这里统一从 ALPHA 表读，改一处全动；
  ③ SVG 的"画法"（路径）写在脚本里可读，生成的 CSS 里只放成品。

用法：python3 tools/mk_decor.py            # 打印生成的 CSS 片段到 stdout
      python3 tools/mk_decor.py --write    # 直接写进 frontend/css/decor.css 的标记区之间
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "frontend/css/decor.css"
BEGIN = "/* >>> 机器生成（tools/mk_decor.py --write）：手别改这一段 <<< */"
END = "/* >>> 生成结束 <<< */"

INK_L = "#7a6a52"      # 浅底上的墨色（暖褐灰，跟纸同族）
INK_D = "#e6d9c0"      # 深底上的墨色（暗纸上的淡米）


def enc(svg: str) -> str:
    """把 SVG 塞进 url("data:image/svg+xml,...")：只编码真正会出事的那几个字符。

    ⚠ 第 43 轮实测修掉的真 bug：这里**漏了 `data:image/svg+xml,` 前缀**。
    少了它，`url("%3Csvg …")` 在浏览器眼里是**相对地址** —— 它会去请求
    `/css/%3Csvg…`，服务器回 404，于是 CSS 变量解析成一个取不到的 URL，
    **背景就是空的**（一次网络请求都没有、截图上也看不出毛病，只有看网络面板/日志才发现）。
    后果：第 35 轮加的那四层质感（纸纹/竹影/水波/自然光）**从来没显示过** ——
    用户说"大背景还是单调、有点丑"就有这条的份。
    现在由 tools/verify_layout.py 的 check_url() 盯着：css 里 url() 只许 data:/#/var(。
    """
    return ("data:image/svg+xml," + svg.replace("\n", " ").replace("  ", " ")
               .replace("%", "%25").replace("#", "%23")
               .replace("<", "%3C").replace(">", "%3E").replace('"', "%22")
               .replace("'", "%27"))


def grain(a: float) -> str:
    """纸纹：feTurbulence 分形噪声（tile 96×96 平铺），灰度化后按 a 透明"""
    return enc(
        "<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'>"
        "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' "
        "stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter>"
        f"<rect width='96' height='96' filter='url(#n)' opacity='{a}'/></svg>")


def bamboo(ink: str, a: float) -> str:
    """竹影：三竿竹（竿 / 竹节 / 竹叶），viewBox 220×640，底色透明"""
    stalk = ("M52 648C48 520 54 400 48 280C44 200 50 120 46 44"
             "M104 648C100 540 106 430 100 320C96 240 102 160 98 92"
             "M156 648C152 560 158 470 152 372C148 300 154 230 150 178")
    node = ("M40 172h22M40 292h22M42 404h20M42 512h18"
            "M92 214h22M90 330h22M92 424h20M94 530h18"
            "M142 246h20M142 356h20M144 452h18M144 556h16")
    leaf = ("M46 44C34 26 18 16 0 12C14 32 30 46 48 56Z"
            "M96 92C110 74 128 64 146 62C132 82 116 96 98 104Z"
            "M150 178C136 162 120 154 102 152C116 170 132 182 150 190Z"
            "M48 280C64 264 82 256 100 256C84 274 66 286 50 292Z"
            "M156 372C172 358 190 352 208 352C192 368 174 378 158 384Z")
    return enc(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 220 640' fill='none'>"
        f"<g stroke='{ink}' stroke-linecap='round' stroke-width='7' opacity='{a}'><path d='{stalk}'/></g>"
        f"<g stroke='{ink}' stroke-linecap='round' stroke-width='2.2' opacity='{a}'><path d='{node}'/></g>"
        f"<g fill='{ink}' opacity='{a}'><path d='{leaf}'/></g></svg>")


def ripple(ink: str, a: float) -> str:
    """水波纹：以右上角为圆心的一圈圈涟漪，向外渐隐（径向渐变当描边色）"""
    rings = "".join(f"<circle cx='420' cy='0' r='{r}'/>" for r in (88, 132, 180, 232, 288, 348))
    return enc(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 420 420' fill='none'>"
        "<defs><radialGradient id='g' cx='420' cy='0' r='420' gradientUnits='userSpaceOnUse'>"
        f"<stop offset='0' stop-color='{ink}' stop-opacity='{a}'/>"
        f"<stop offset='.5' stop-color='{ink}' stop-opacity='{a * 0.7:.4f}'/>"
        f"<stop offset='1' stop-color='{ink}' stop-opacity='0'/></radialGradient></defs>"
        f"<g stroke='url(%23g)' stroke-width='1.7'>{rings}</g></svg>")


# 透明度（为什么要压这么低：tools/imgstat.py 判定"这一屏有没有货"用的是
# 跟底色的差 —— 浅底 30 / 深底 12（三通道绝对值之和）。装饰必须**低于这个阈**，
# 否则一张空白屏也会被量出满屏墨迹，那条判据就废了。所以这里按阈值倒推上限：
#   浅底：#7a6a52 与纸 #f3ead9 的三通道差和 ≈ 384 → a ≤ 26/384 ≈ .067（实测 0 墨迹后取 .072）
#   深底：#e6d9c0 与夜底 #14120f 的差和 ≈ 594 → a ≤ 11/594 ≈ .018
ALPHA = {"bamboo_l": .072, "bamboo_d": .017,
         "ripple_l": .072, "ripple_d": .018,
         "grain_l": .055, "grain_d": .026}


def build() -> str:
    A = ALPHA
    return f"""{BEGIN}
:root{{
  /* 大背景的四层装饰（浅色主题那一套）—— 从下往上：光 · 竹影 · 水波 · 纸纹 */
  --decor-grain:url("{grain(A['grain_l'])}");
  --decor-bamboo:url("{bamboo(INK_L, A['bamboo_l'])}");
  --decor-ripple:url("{ripple(INK_L, A['ripple_l'])}");
  --decor-wash:linear-gradient(180deg, rgba(255,255,255,.30) 0, rgba(255,255,255,.10) 96px, rgba(255,255,255,0) 220px);
  --decor-floor:linear-gradient(0deg, rgba(58,48,32,.05) 0, rgba(58,48,32,.018) 88px, rgba(58,48,32,0) 176px);
}}
html[data-theme="night"]{{
  /* 夜间：装饰改成"暗纸上的淡墨"，并且再压一档 —— 夜里屏幕大、一点亮斑都刺眼 */
  --decor-grain:url("{grain(A['grain_d'])}");
  --decor-bamboo:url("{bamboo(INK_D, A['bamboo_d'])}");
  --decor-ripple:url("{ripple(INK_D, A['ripple_d'])}");
  /* 夜间顶部那道"环境光"。第 42 轮实测：.05 时整屏 p99 差 = 10/255，**超过判据上限 9**（装饰发白）。
     深底 #14120f 与 #ffecce 的差 ≈ 235 → a=.035 时 ≈ 8.2/255，压回阈值以内。
     注意：真正刺眼的不是那几层纹样（它们更淡），是这道 wash —— 所以先调它。 */
  --decor-wash:linear-gradient(180deg, rgba(255,236,206,.035) 0, rgba(255,236,206,.014) 96px, rgba(255,236,206,0) 220px);
  --decor-floor:linear-gradient(0deg, rgba(0,0,0,.22) 0, rgba(0,0,0,.08) 88px, rgba(0,0,0,0) 176px);
}}
{END}"""


def main() -> int:
    css = build()
    if "--write" in sys.argv:
        s = TARGET.read_text(encoding="utf-8")
        i, j = s.find(BEGIN), s.find(END)
        if i < 0 or j < 0:
            print("decor.css 里找不到标记区", file=sys.stderr)
            return 2
        TARGET.write_text(s[:i] + css + s[j + len(END):], encoding="utf-8")
        print("写好了：" + str(TARGET))
        return 0
    print(css)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
