#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. studio.js 对外暴露的入口 ═══"
grep -nE "window\.Studio|Studio = \{|^\s+(open|show)[A-Za-z]*(:| \()" frontend/js/studio.js | head -25
echo
echo "═══ 2. 谁调用了 Studio.xxx（哪些地方能点进去） ═══"
grep -rnoE "Studio\.[a-zA-Z]+" frontend/js/*.js frontend/index.html 2>/dev/null | grep -v "^frontend/js/studio.js" | sort -u | head -20
echo
echo "═══ 3. 写作台入口在哪（tools.js 里的写作台/studio） ═══"
grep -nE "studio|写作台|Studio" frontend/js/tools.js frontend/js/app.js | head -12
echo
echo "═══ 4. index.html 里的页签（底部导航） ═══"
grep -oE 'data-tab="[a-z]+"' frontend/index.html | sort -u | tr '\n' ' '
echo
echo "═══ 5. 工具页在移动端的入口结构（tools.js 分组） ═══"
grep -nE "tools-sec|<h2>" frontend/js/tools.js | head -10
grep -oE "'[^']{2,8}'" frontend/js/tools.js | sed "s/'//g" | grep -E "书稿|AI|系统|写作台|世界|剧情|质检|统计" | sort -u | tr '\n' ' '
