#!/bin/bash
echo "═══ 1. 线上网页版（/nbapp/）用的是哪套前端 ═══"
W=/home/ubuntu/nbapp/web
echo "  文件列表:"; ls $W/js/ 2>/dev/null | sed 's/^/    /'
echo "  有没有 studio.js（新面板都在里面）: $([ -f $W/js/studio.js ] && echo '有' || echo '❌ 没有')"
echo "  index.html 加载的 js:"; grep -oE 'src="js/[^"]+"' $W/index.html 2>/dev/null | sed 's/^/    /'
echo "  最后修改: $(stat -c %y $W/index.html 2>/dev/null | cut -d. -f1)"
echo
echo "═══ 2. 新前端（仓库里）什么时候改的 ═══"
cd /home/ubuntu/novel-app
echo "  frontend/js/studio.js: $(stat -c %y frontend/js/studio.js | cut -d. -f1)"
echo "  文件数: $(ls frontend/js/ frontend/css/ | wc -l)"
echo
echo "═══ 3. App 里带的是新前端吗 ═══"
A=apk/手机写作台.apk
echo "  包内 js: $(unzip -l $A 2>/dev/null | grep -c 'assets/www/js/')"
unzip -l $A 2>/dev/null | grep -oE 'assets/www/js/[a-z]+\.js' | sed 's/^/    /'
echo
echo "═══ 4. 新面板在前端注册了哪些（工具宫格里的写作区） ═══"
grep -A 14 "Tools.add(\[" frontend/js/studio.js | grep -oE "name: '[^']+'" | sed 's/^/  /'
