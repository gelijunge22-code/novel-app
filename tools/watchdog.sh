#!/bin/bash
# 盯 Codex 的巡检器：不只看"活着没"，还要看出"有没有偷懒/卡住/跑偏"
cd /home/ubuntu/novel-app || exit 1
LOG=logs/codex-goal.log
NOW=$(date +%s)

echo "═══ 1. 活着吗 ═══"
SVC=$(systemctl --user is-active codex-goal.service 2>/dev/null)
echo "  服务: $SVC"
python3 - <<'PY'
import json, time, os
p='logs/goal-state.json'
if os.path.exists(p):
    d=json.load(open(p)); g=d.get('goal') or d
    print("  目标:", g.get('status'), "| token:", f"{g.get('tokensUsed'):,}",
          "| 已跑:", round(g.get('timeUsedSeconds',0)/60,1), "分钟")
else:
    print("  ⚠️ 读不到 goal-state.json")
PY

echo
echo "═══ 2. 还在动吗（最近 20 分钟有没有新事件） ═══"
LASTLINE=$(tail -1 $LOG 2>/dev/null)
echo "  最后一行: ${LASTLINE:0:100}"
LASTMOD=$(stat -c %Y $LOG 2>/dev/null)
if [ -n "$LASTMOD" ]; then
  GAP=$(( (NOW - LASTMOD) / 60 ))
  echo "  距最后一次活动: ${GAP} 分钟"
  [ "$GAP" -gt 20 ] && echo "  ⚠️⚠️ 20 分钟没动静了，可能卡住"
fi

echo
echo "═══ 3. 进度记录到第几轮 ═══"
grep -c "^## 第" docs/进度.md 2>/dev/null | sed 's/^/  轮数: /'
grep "^## 第" docs/进度.md 2>/dev/null | tail -3 | sed 's/^/  /'

echo
echo "═══ 4. 最近 25 分钟改了什么 ═══"
find . -newermt '-25 minutes' -type f ! -path './.git/*' ! -path './logs/*' \
  ! -path '*__pycache__*' ! -path '*/venv/*' ! -name '*.pyc' 2>/dev/null | head -18

echo
echo "═══ 5. 异常信号 ═══"
echo -n "  近 25 分钟断流重连次数: "
grep -c "Reconnecting" $LOG 2>/dev/null
echo -n "  真错误行数(非 delta): "
grep -E "ERROR" $LOG 2>/dev/null | grep -vE 'textDelta' | wc -l
echo "  最近的错误:"
grep -E "ERROR" $LOG 2>/dev/null | grep -vE 'textDelta' | tail -3 | cut -c1-150 | sed 's/^/    /'

echo
echo "═══ 6. 偷懒信号扫描 ═══"
echo -n "  新增 TODO/占位: "
grep -rn "TODO\|FIXME\|待实现\|占位\|not implemented" --include='*.py' --include='*.js' \
  server/ frontend/ 2>/dev/null | grep -v venv | wc -l
echo -n "  后端接口数: "
grep -rhoE "@router\.(get|post|put|patch|delete)\(" --include='*.py' server/routers/ 2>/dev/null | wc -l
echo -n "  后端真实代码行数: "
find server -name '*.py' ! -path '*venv*' ! -path '*__pycache__*' -exec cat {} + 2>/dev/null | wc -l
echo -n "  前端真实代码行数: "
find frontend -name '*.js' -o -name '*.css' | xargs cat 2>/dev/null | wc -l

echo
echo "═══ 7. 交付物 ═══"
ls -la apk/*.apk 2>/dev/null | awk '{print "  APK:",$9,$5"B"}'
cat apk/apk-version.json 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print('  版本:',d.get('versionName'),'code',d.get('versionCode'),'|',d.get('builtAt'))" 2>/dev/null
echo "  截图数: $(ls docs/前端截图/ 2>/dev/null | wc -l)"
[ -f DONE.md ] && echo "  ✅ DONE.md 已写（任务完成）" || echo "  ⏳ DONE.md 还没写（还在做）"
