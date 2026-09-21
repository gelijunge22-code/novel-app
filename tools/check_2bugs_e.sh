#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ reader-quick 的主处理逻辑在哪（哪个文件读 data-q）═══"
grep -rnE "reader-quick" frontend/js/*.js | grep -v "quick-close" | cut -c1-180 | sed 's/^/  /'
echo
echo "═══ 所有 rd-fb 底栏按钮（对照 data-q）═══"
sed -n '88,96p' frontend/index.html | sed 's/^/  /'
echo
echo "═══ 搜索处理 data-q 的代码 ═══"
grep -rnE "dataset\.q|data-q|\.q\b" frontend/js/app.js frontend/js/tools.js frontend/js/reader.js 2>/dev/null | grep -iE "quick|reader" | head -12 | cut -c1-180 | sed 's/^/  /'
