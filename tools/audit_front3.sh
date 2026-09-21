#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. index.html 加载了哪些 js（studio.js 有没有被加载） ═══"
grep -oE '<script[^>]*src="[^"]+"' frontend/index.html | sed 's/.*src="//;s/"//' | sed 's/^/  /'
echo
echo "═══ 2. studio.js 有没有被引入 ═══"
grep -c "studio.js" frontend/index.html | sed 's/^/  index.html 里提到次数: /'
echo
echo "═══ 3. 前端一共调了多少个不同接口 ═══"
echo "  前端调用路径数: $(grep -rhoE '/api/[a-z_/-]+' frontend/js/*.js 2>/dev/null | sort -u | wc -l)"
echo "  后端提供接口数: 287"
echo
echo "═══ 4. 后端有、但前端完全没提过的模块（粗查） ═══"
for m in world plot lint stats prompts workflows voice pacing refs material term logs export batch modelset sync peer notes rag write agent files backup lore presets config_models misc core; do
  n=$(grep -rhoE "/api/[a-z_/-]*" frontend/js/*.js 2>/dev/null | grep -ciE "/api/$m|/$m/" || true)
  [ "$n" -eq 0 ] && echo "  ❌ $m （前端没提）"
done
echo
echo "═══ 5. studio.js 什么时候加的、多大 ═══"
ls -la frontend/js/studio.js | awk '{print "  ",$5"B",$6,$7,$8}'
git log --oneline -1 -- frontend/js/studio.js 2>/dev/null | sed 's/^/  最后改动: /'
