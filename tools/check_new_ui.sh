#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 对话页的「编排/绘画」是什么元素（被小方块挡住的）═══"
grep -rnE "编排|绘画" frontend/js/chat.js frontend/index.html 2>/dev/null | head -8 | cut -c1-150 | sed 's/^/  /'
echo
echo "  ── 对话页里 chat-book 的位置和它的样式:"
grep -nE "^\.bk-bar\{" frontend/css/base.css | sed 's/^/     /'
grep -nE "chat-book|chat-body|chat-compose" -A 4 frontend/css/panels.css 2>/dev/null | head -24 | sed 's/^/     /'
echo
echo "═══ 2. 目录现在怎么呈现的（是不是塞在设置面板里）═══"
grep -nE "'toc'|tocHtml" frontend/js/reader.js | head -8 | cut -c1-140 | sed 's/^/  /'
echo "  ── 目录面板的宽度/高度限制:"
grep -nE "rd-quick|rd-tabbody|rd-quick-body" -A 5 frontend/css/reader.css | grep -E "max-height|height|width|overflow" | head -10 | sed 's/^/     /'
echo
echo "═══ 3. 文案口语化问题（找口语表达）═══"
grep -rnoE "'[^']*(呀|哈|啦|哦|嘛|吧|咯|诶|哟)[^']*'" frontend/js/app.js frontend/js/reader.js frontend/js/studio.js frontend/js/tools.js 2>/dev/null | head -14 | cut -c1-150 | sed 's/^/  /'
echo
echo "═══ 4. 设置页主题/颜色那块 ═══"
grep -nE "主题|theme" frontend/js/app.js | head -6 | cut -c1-150 | sed 's/^/  /'
