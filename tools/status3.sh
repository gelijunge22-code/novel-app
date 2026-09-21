#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══════ 1. 那 1044 个 py 文件是什么 ═══════"
find server -name '*.py' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -12
echo
echo " 总 .py 文件: $(find server -name '*.py' | wc -l)"
echo " 其中 venv/site-packages: $(find server -path '*site-packages*' -name '*.py' 2>/dev/null | wc -l)"
echo " 真实业务代码行数: $(find server -name '*.py' ! -path '*site-packages*' ! -path '*__pycache__*' -exec cat {} + 2>/dev/null | wc -l)"
echo
echo "═══════ 2. 真实业务文件 ═══════"
find server -name '*.py' ! -path '*site-packages*' ! -path '*__pycache__*' | sort | while read f; do printf "   %-46s %5s行\n" "$f" "$(wc -l < "$f")"; done
echo
echo "═══════ 3. 服务能起来吗 ═══════"
ls -la deploy/novelapp.service 2>/dev/null
grep -E "ExecStart|WorkingDirectory" deploy/novelapp.service 2>/dev/null
python3 -c "import ast,sys
import pathlib
bad=[]
for p in pathlib.Path('server').rglob('*.py'):
    if 'site-packages' in str(p) or '__pycache__' in str(p): continue
    try: ast.parse(p.read_text(encoding='utf-8','ignore'))
    except Exception as e: bad.append((str(p),str(e)[:60]))
print('语法检查: ', '全部通过' if not bad else bad[:5])"
