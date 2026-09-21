#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══════ 1. 那些 error 是真报错吗 ═══════"
grep -E 'error|Error|ERROR' logs/codex-goal.log | grep -vE 'textDelta|reasoning' | tail -12
echo
echo "═══════ 2. 后端代码写到哪了 ═══════"
find server deploy -type f 2>/dev/null | sort | head -40
echo
echo "═══════ 3. 代码量 ═══════"
find server -name '*.py' 2>/dev/null | wc -l
find server -name '*.py' -exec cat {} + 2>/dev/null | wc -l
echo
echo "═══════ 4. 数据库表 ═══════"
python3 -c "
import sqlite3
c=sqlite3.connect('data/app.db')
r=[x[0] for x in c.execute(\"select name from sqlite_master where type='table' order by name\")]
print(' 表数:',len(r)); print(' ',', '.join(r))
" 2>&1 | head -8
echo
echo "═══════ 5. 进度.md 写了没 ═══════"
if [ -f docs/进度.md ]; then wc -l docs/进度.md; tail -18 docs/进度.md; else echo " 还没写 docs/进度.md"; fi
