#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 前端工具页完整清单 ═══"
grep -oE "name: '[^']+'" frontend/js/tools.js | sed "s/name: //" | tr '\n' ' '
echo; echo
echo "═══ studio.js 里的面板名（换个抓法） ═══"
grep -oE "\"[a-zA-Z-]+\"|'[a-zA-Z-]+'" frontend/js/studio.js 2>/dev/null | grep -E "world|plot|lint|stat|prompt|pipeline|voice|pacing|ref|material|conflict|sync|export|term|logs|batch|modelset|job" | sort -u | tr '\n' ' '
echo; echo
echo "═══ studio.js 里的 tab/面板标题（中文） ═══"
grep -oE "'[一-鿿]{2,6}'" frontend/js/studio.js 2>/dev/null | sed "s/'//g" | sort -u | head -60 | tr '\n' ' '
echo; echo
echo "═══ 前端里出现的 /api/ 路径（说明前端真在调哪些） ═══"
grep -rhoE "/api/[a-z_/-]+" frontend/js/*.js 2>/dev/null | sort -u | head -60
echo
echo "  前端调用路径总数: $(grep -rhoE '/api/[a-z_/-]+' frontend/js/*.js 2>/dev/null | sort -u | wc -l)"
