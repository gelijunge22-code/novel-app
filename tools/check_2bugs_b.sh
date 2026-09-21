#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 快捷面板的按钮是哪些（找 data-q 定义处）═══"
grep -nE "data-q|\bqbtn\b|rd-qbtn" frontend/js/reader.js | head -20 | cut -c1-170 | sed 's/^/  /'
echo
echo "  ── openQuick / quickTab 附近 200 行内找按钮列表:"
sed -n '1236,1270p' frontend/js/reader.js | cut -c1-170 | sed 's/^/  /'
echo
echo "═══ 2. 底部快捷栏的 HTML 在哪定义 ═══"
grep -nE "rd-quick-body|rd-qbtn|openQuick" frontend/index.html frontend/js/reader.js | head -12 | cut -c1-160 | sed 's/^/  /'
echo
echo "═══ 3. AI 对话页的结构（看小方块跟什么重叠）═══"
sed -n '118,132p' frontend/index.html | sed 's/^/  /'
echo
echo "  ── 对话页 CSS:"
grep -nE "#chat-book|chat-head|chat-input|chat-body|\.chat" frontend/css/panels.css frontend/css/base.css 2>/dev/null | head -14 | cut -c1-150 | sed 's/^/  /'
echo
echo "═══ 4. bk-bar-host 在对话页的样式 ═══"
grep -rnE "chat-book|#shelf-book|#lore-book" frontend/css/*.css | head -8 | cut -c1-150 | sed 's/^/  /'
