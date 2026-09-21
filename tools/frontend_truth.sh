#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 前端体积：大改开始前 vs 现在 ═══"
BASE_B=726571; BASE_L=12915
NOW_B=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -c)
NOW_L=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -l)
echo "  大改前:   $BASE_B 字节 / $BASE_L 行"
echo "  现在:     $NOW_B 字节 / $NOW_L 行"
echo "  增加:     +$((NOW_B-BASE_B)) 字节 (+$(( (NOW_B-BASE_B)*100/BASE_B ))%) / +$((NOW_L-BASE_L)) 行"
echo
echo "═══ 2. 前端文件数：大改前 vs 现在 ═══"
echo "  现在 frontend/ 下有 $(find frontend -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' \) | wc -l) 个代码文件"
echo
echo "═══ 3. 大改开始之后【新增】的前端文件（git diff 查的）═══"
git diff --name-status 99466eb~1 HEAD -- frontend/ 2>/dev/null | grep '^A' | sed 's/^A\t/  ✅ 新增 /' | head -20
echo
echo "═══ 4. 大改开始之后【改动过】的前端文件（前 20 个）═══"
git diff --stat 99466eb~1 HEAD -- frontend/ 2>/dev/null | tail -22 | sed 's/^/  /'
echo
echo "═══ 5. 前端相关提交（按时间）═══"
git log --since="2026-09-20 16:00" --pretty=format:'  %ad %s' --date=format:'%m-%d %H:%M' -- frontend/ | cut -c1-115 | head -20
