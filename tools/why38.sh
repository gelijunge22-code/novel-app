#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 待办清单最后一次改动是什么时候 ═══"
stat -c "  待办清单: %y" docs/待办清单.md
stat -c "  进度.md:   %y" docs/进度.md
stat -c "  自审清单: %y" docs/自审清单.md
echo "  现在:      $(date '+%Y-%m-%d %H:%M:%S')"
echo
echo "═══ 2. 进度.md 最新记到哪一轮 ═══"
grep -nE "^#{2,3} .*(第 ?[0-9]+ ?轮|轮)" docs/进度.md 2>/dev/null | tail -6 | cut -c1-110 | sed 's/^/  /'
echo
echo "═══ 3. 最近 1 小时它实际产出的东西（新文件/报告）═══"
find docs -newermt '-60 minutes' -type f 2>/dev/null | grep -vE "前端截图|/作废" | head -12 | while read f; do
  printf "  %-40s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 4. 最近 1 小时改的代码 ═══"
find . -newermt '-60 minutes' -type f \( -name '*.js' -o -name '*.css' -o -name '*.py' \) -not -path './.git/*' -not -path './apk/build/*' -not -path './apk/assets/www/*' -not -path './data/*' -not -path './docs/*' 2>/dev/null | head -14 | sed 's/^/  /'
echo
echo "═══ 5. 最近 1 小时的提交 ═══"
git log --since="-60 minutes" --pretty=format:"  %ad %s" --date=format:"%H:%M" 2>/dev/null | cut -c1-110
echo
echo
echo "═══ 6. 它现在敲的 3 条命令 ═══"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-130 | sed 's/^/  /'
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)"
echo
echo "═══ 7. 截图产出（最近 30 分钟有几张新的）═══"
find docs/前端截图 -newermt '-30 minutes' -name '*.png' 2>/dev/null | wc -l | sed 's/^/  新截图: /'
find docs/前端截图 -newermt '-30 minutes' -name '*.png' 2>/dev/null | head -6 | while read f; do echo "    $(basename "$f")"; done
