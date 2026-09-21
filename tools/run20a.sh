#!/bin/bash
# 第 20 轮（前端大改 · 第 1 屏「书架」）收口：把这一屏该过的判据按顺序重跑一遍。
# 顺序跑、不并行（3.6G 内存，一个无头 Chrome 约 180MB）。
cd /home/ubuntu/novel-app || exit 1
say(){ echo; echo "=== $* ==="; }
say "① 三态（空/载/错）"
node tools/e2e-states.js; echo "states exit=$?"
say "② 不遮挡（滚到底最后一行不许被钉住的东西压住）"
node tools/e2e-cover.js; echo "cover exit=$?"
say "③ UI 硬判据（断词/热区/横向溢出/动效）"
node tools/e2e-uicheck.js; echo "uicheck exit=$?"
say "④ 安全区 + 手势"
node tools/e2e-safearea.js; echo "safearea exit=$?"
say "⑤ 切书小方块不穿模"
node tools/e2e-bkmini.js; echo "bkmini exit=$?"
say "⑥ 无头浏览器收尾"
ps -eo args | grep -c "[h]eadless"
node tools/sweep_chrome.js
say "全部跑完"
