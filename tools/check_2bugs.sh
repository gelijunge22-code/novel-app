#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 底部快捷面板的按钮定义（目录 vs 设置）═══"
grep -nE "rd-qbtn|data-q=" frontend/js/reader.js | head -20 | cut -c1-160 | sed 's/^/  /'
echo
echo "═══ 2. quickTab 函数：'目录'点了做什么 ═══"
sed -n '1133,1180p' frontend/js/reader.js | cut -c1-160 | sed 's/^/  /'
echo
echo "═══ 3. 有没有 toc 这个 tab 分支 ═══"
grep -nE "t === 'toc'|'toc'|tocHtml" frontend/js/reader.js | head -14 | cut -c1-150 | sed 's/^/  /'
echo
echo "═══ 4. AI 对话页的切书小方块（穿模）═══"
grep -nE "bk-bar|bk-mini|bookBar|bookctx" frontend/js/chat.js frontend/index.html 2>/dev/null | head -12 | cut -c1-150 | sed 's/^/  /'
echo
echo "  ── 对话页的 DOM 结构（看小方块插在哪）:"
grep -nE "id=\"chat|chat-head|chat-body|topbar" frontend/index.html | head -10 | sed 's/^/     /'
echo
echo "═══ 5. bookctx 在哪些地方被插入 ═══"
grep -rnE "BookCtx|bookctx" frontend/js/*.js frontend/index.html 2>/dev/null | grep -vE "^frontend/js/bookctx.js" | head -12 | cut -c1-150 | sed 's/^/  /'
