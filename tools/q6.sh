#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 状态 ═══"
systemctl --user is-active codex-goal.service
python3 -c "
import json;d=json.load(open('logs/goal-state.json'));g=d.get('goal') or d
print(' 目标:',g.get('status'),'| token:',f\"{g.get('tokensUsed'):,}\",'| 已跑:',round(g.get('timeUsedSeconds',0)/60,1),'分钟')"
echo " 日志最后活动: $(( ( $(date +%s) - $(stat -c %Y logs/codex-goal.log) ) / 60 )) 分钟前"
echo
echo "═══ Gradle/Chaquopy 构建进展 ═══"
ls -la apk/build/outputs/apk/release/*.apk 2>/dev/null | awk '{print "  ",$9,$5"B"}'
find apk -name "*.apk" -newermt '-90 minutes' 2>/dev/null | head -5
du -sh apk/.gradle 2>/dev/null | sed 's/^/  gradle缓存: /'
du -sh apk/libs 2>/dev/null | sed 's/^/  libs: /'
ls apk/libs/*.whl 2>/dev/null | wc -l | sed 's/^/  wheel包数: /'
echo
echo "═══ 它最近说的话 ═══"
grep "它说:" logs/codex-goal.log | tail -5 | cut -c1-320
echo
echo "═══ 最近命令 ═══"
tail -60 logs/codex-goal.log | grep "cmd:" | tail -5 | cut -c1-220
echo
echo "═══ 有没有 python 运行时的痕迹 ═══"
[ -f apk/src/main/python/main.py ] && echo "  ✅ apk/src/main/python/main.py 存在 ($(wc -l < apk/src/main/python/main.py) 行)"
[ -f apk/build.gradle.kts ] && echo "  ✅ apk/build.gradle.kts 存在" || echo "  ⚠️ 没有 build.gradle.kts"
[ -f server/ondevice.py ] && echo "  ✅ server/ondevice.py 存在 ($(wc -l < server/ondevice.py) 行)" || echo "  ⏳ server/ondevice.py 还没写"
echo
echo "═══ 账 ═══"
echo "  GOAL.md: $(grep -c '^- \[x\]' GOAL.md)/28 已勾"
grep "^## 第" docs/进度.md | tail -2 | sed 's/^/  /'
[ -f DONE.md ] && echo "  ✅ DONE.md" || echo "  ⏳ DONE.md 未写"
