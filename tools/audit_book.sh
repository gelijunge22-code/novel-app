#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 全站的圆角用法统计（找不统一） ═══"
echo "  --radius 定义:"; grep -nE "^\s*--radius" frontend/css/base.css | sed 's/^/    /'
echo "  999px（完全圆角胶囊）出现次数:"; grep -c "border-radius:999px" frontend/css/*.css | sed 's/^/    /'
echo "  50%（正圆）出现次数:"; grep -c "border-radius:50%" frontend/css/*.css | sed 's/^/    /'
echo
echo "═══ 2. 「当前是哪本书」怎么定的 ═══"
grep -nE "currentSlug|curSlug|activeSlug|state.slug|R.slug|book.slug" frontend/js/store.js frontend/js/app.js 2>/dev/null | head -12
echo
echo "═══ 3. 预设是按书隔离的吗 ═══"
grep -nE "scope|global|project|slug" frontend/js/preset.js | head -12
echo
echo "═══ 4. 工具/面板怎么拿书（是不是都写死一本） ═══"
grep -nE "slug" frontend/js/tools.js | head -14
echo
echo "═══ 5. 后端有没有按书隔离（book_slug 字段） ═══"
grep -cE "slug" server/db.py | sed 's/^/  db.py 里 slug 出现: /'
for t in preset prompt chat_session model_set setting; do
  n=$(grep -cE "$t.*slug|slug.*$t" server/migrations/*.sql 2>/dev/null | head -1)
  printf "  表 %-14s 有 slug 关联: %s\n" "$t" "${n:-0}"
done
