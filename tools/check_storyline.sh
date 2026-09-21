#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 前端里"故事线"/"剧情线"/"大纲"分别在哪 ═══"
grep -rn "故事线" frontend/js/*.js frontend/index.html 2>/dev/null | head -12 | cut -c1-150
echo "  ---"
grep -rn "剧情线" frontend/js/*.js frontend/index.html 2>/dev/null | head -8 | cut -c1-150
echo "  ---"
grep -rn "大纲" frontend/js/*.js frontend/index.html 2>/dev/null | head -12 | cut -c1-150
echo
echo "═══ 2. 后端里对应接口 ═══"
grep -rn "storyline\|outline" server/*.py 2>/dev/null | grep -E "route|@app|def " | head -16 | cut -c1-150
echo
echo "═══ 3. 工具宫格里这些工具的名字 ═══"
grep -rn "storyline\|outline" frontend/js/tools.js 2>/dev/null | head -10 | cut -c1-150
echo
echo "═══ 4. 预设页现在的结构（"主创""助手""派活"）═══"
grep -rn "主创\|助手\|派活" frontend/js/*.js 2>/dev/null | head -14 | cut -c1-150
