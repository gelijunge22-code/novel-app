#!/bin/bash
cd /home/ubuntu/novel-app
echo "════════ 前端代码量基线 ════════"
echo
echo "── 分文件（字节 / 行数）:"
tot_b=0; tot_l=0
for f in frontend/index.html frontend/js/*.js frontend/css/*.css; do
  [ -f "$f" ] || continue
  b=$(stat -c%s "$f"); l=$(wc -l < "$f")
  tot_b=$((tot_b+b)); tot_l=$((tot_l+l))
  printf "  %-32s %8s 字节 %6s 行\n" "${f#frontend/}" "$b" "$l"
done
echo "  ────────────────────────────────────────────"
printf "  %-32s %8s 字节 %6s 行\n" "合计" "$tot_b" "$tot_l"
echo
echo "── 按类型:"
for t in js css html; do
  b=$(cat frontend/*.$t frontend/js/*.$t frontend/css/*.$t 2>/dev/null | wc -c)
  l=$(cat frontend/*.$t frontend/js/*.$t frontend/css/*.$t 2>/dev/null | wc -l)
  [ "$b" -gt 0 ] && printf "  %-6s %8s 字节 %6s 行\n" "$t" "$b" "$l"
done
echo
echo "── 不含空行/注释的"实际代码行":"
for f in frontend/js/*.js frontend/css/*.css; do
  [ -f "$f" ] || continue
  n=$(grep -vcE '^\s*$|^\s*(//|/\*|\*)' "$f")
  printf "  %-32s %6s\n" "${f#frontend/}" "$n"
done | sort -k2 -rn
echo
echo "════════ 目标（翻倍） ════════"
echo "  现在合计: $tot_l 行 / $tot_b 字节"
echo "  翻倍目标: $((tot_l*2)) 行 / $((tot_b*2)) 字节"
echo
echo "════════ 后端规模（对照，不动） ════════"
echo "  后端 py: $(find server -name '*.py' -not -path '*/venv/*' 2>/dev/null | wc -l) 文件 / $(find server -name '*.py' -not -path '*/venv/*' -exec cat {} + 2>/dev/null | wc -l) 行"
