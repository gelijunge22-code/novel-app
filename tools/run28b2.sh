#!/bin/bash
# 第 28 轮收口 · **续跑**：run28b.sh 在 ⑧ 的 uicheck 中途被（会话/通道）打断，
# 这里把没跑完的 ⑧⑨⑩⑪ 接着跑完，结果**追加**进同一个 logs/run28b.log。
cd /home/ubuntu/novel-app || exit 1
say(){ echo; echo "=== $* ==="; }
say "⑧（续）三态 / 不遮挡 / UI 硬判据 / 安全区 / 切书小方块 / 夜间"
node tools/e2e-uicheck.js; echo "uicheck exit=$?"
SAFE_ONLY=reader node tools/e2e-safearea.js; echo "safearea exit=$?"
node tools/e2e-bkmini.js; echo "bkmini exit=$?"
node tools/e2e-night.js; echo "night exit=$?"

say "⑨ 阅读器沉浸态（结构 + 逐像素）"
node tools/e2e-rdshell.js; echo "rdshell exit=$?"
server/venv/bin/python tools/check_rdshell.py; echo "rdshell-px exit=$?"

say "⑩ 令牌 / 文案 / 死代码 / 体量"
server/venv/bin/python tools/verify_tokens.py; echo "tokens exit=$?"
python3 tools/copy_check.py; echo "copy exit=$?"
python3 tools/deadcode_audit.py; echo "deadcode exit=$?"
python3 tools/size_report.py; echo "size exit=$?"

say "⑪ 无头浏览器收尾"
ps -eo args | grep -c "[h]eadless"
node tools/sweep_chrome.js
say "全部跑完"
