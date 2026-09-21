#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══════ 1. 昨天下午 4 点之后的提交（你说换模型那个时间点） ═══════"
git log --since="2026-09-19 15:30" --pretty=format:"%ad | %s" --date=format:"%m-%d %H:%M" 2>/dev/null | head -20
echo
echo
echo "═══════ 2. 后端有多少接口（按模块） ═══════"
for f in server/routers/*.py; do
  n=$(grep -cE "@router\.(get|post|put|patch|delete)\(" "$f" 2>/dev/null)
  [ "$n" -gt 0 ] && printf "  %-28s %3s 个\n" "$(basename $f)" "$n"
done | sort -k2 -rn
echo "  ------------------------------"
echo "  合计: $(grep -rhcE '@router\.(get|post|put|patch|delete)\(' server/routers/*.py | paste -sd+ | bc) 个"
echo
echo "═══════ 3. 前端有哪些面板（studio.js 里的 panel 名） ═══════"
grep -oE "id: *'st-[a-z-]+'|'st-[a-z-]+'" frontend/js/studio.js 2>/dev/null | sed "s/.*'\(st-[a-z-]*\)'.*/\1/" | sort -u | tr '\n' ' '
echo
echo
echo "═══════ 4. 前端工具页有多少个 ═══════"
grep -oE "id: '[a-z]+', name: '[^']+'" frontend/js/tools.js | head -20
echo "  工具总数: $(grep -cE "id: '[a-z]+', name:" frontend/js/tools.js)"
