#!/bin/bash
# 第 21 轮（前端大改 · 第 2 屏「阅读器底部面板 + 独立目录」）收口：
# ① 本屏主判据 e2e-readerquick（含两种反证）
# ② 第 1 屏五关回归（surfaces.js 改过：rdquick-toc 面删、新增 rdtoc 面，必须复跑确认没打破）
# 顺序跑、不并行（3.6G 内存，一个无头 Chrome 约 180MB）。
cd /home/ubuntu/novel-app || exit 1
say(){ echo; echo "=== $* ==="; }
say "① 本屏主判据：底部面板 + 独立目录"
node tools/e2e-readerquick.js; echo "readerquick exit=$?"
say "①b 反证 noq（抹掉 data-act）"
RDQ_FORCE=noq node tools/e2e-readerquick.js; echo "noq exit=$?"
say "①c 反证 flat（固定底不占位）"
RDQ_FORCE=flat node tools/e2e-readerquick.js; echo "flat exit=$?"
say "② 回归 · 三态"
node tools/e2e-states.js; echo "states exit=$?"
say "③ 回归 · 不遮挡"
node tools/e2e-cover.js; echo "cover exit=$?"
say "④ 回归 · UI 硬判据"
node tools/e2e-uicheck.js; echo "uicheck exit=$?"
say "⑤ 回归 · 安全区 + 手势"
node tools/e2e-safearea.js; echo "safearea exit=$?"
say "⑥ 回归 · 切书小方块"
node tools/e2e-bkmini.js; echo "bkmini exit=$?"
say "⑦ 回归 · 夜间模式"
node tools/e2e-night.js; echo "night exit=$?"
say "⑧ 设计令牌 + 色卡"
server/venv/bin/python tools/verify_tokens.py; echo "tokens exit=$?"
SWATCH_FORCE=mismatch server/venv/bin/python tools/verify_tokens.py; echo "swatch-rev exit=$?"
say "⑨ 死代码"
python3 tools/deadcode_audit.py; echo "deadcode exit=$?"
say "⑩ 无头浏览器收尾"
ps -eo args | grep -c "[h]eadless"
node tools/sweep_chrome.js
say "全部跑完"
