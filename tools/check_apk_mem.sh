#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 包打好了吗 ═══"
ls -la apk/*.apk 2>/dev/null | awk '{printf "  %-32s %6.1fMB  %s %s %s\n",$9,$5/1048576,$6,$7,$8}'
echo
echo "  包内版本号："
for f in apk/手机写作台.apk apk/app-release.apk; do
  [ -f "$f" ] || continue
  v=$(unzip -p "$f" AndroidManifest.xml 2>/dev/null | strings | grep -oE "2\.[0-9]+\.[0-9]+" | head -1)
  echo "    $(basename $f): ${v:-?}"
done
echo
echo "═══ 2. 版本声明文件 ═══"
cat apk/apk-version.json 2>/dev/null | head -8 | sed 's/^/  /'
echo
echo "═══ 3. 它有没有回答内存那几个问题 ═══"
stat -c "  进度.md 改动: %y  (%s字节)" docs/进度.md
grep -nE "内存|gradle|Gradle|OOM|省内存|看门狗" docs/进度.md 2>/dev/null | tail -8
echo
echo "═══ 4. 最近注入记录 ═══"
grep -a "注入监督人指令" logs/codex-goal.log | tail -3
echo
echo "═══ 5. 它现在在干什么 ═══"
tail -3 logs/codex-goal.log | cut -c1-140
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)  现在 $(date '+%H:%M:%S')"
echo
echo "═══ 6. 内存现状 ═══"
free -h | head -2 | sed 's/^/  /'
