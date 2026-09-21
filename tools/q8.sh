#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ GOAL.md 总数与勾选 ═══"
echo "  总条数: $(grep -c '^- \[' GOAL.md)  已勾: $(grep -c '^- \[x\]' GOAL.md)  未勾: $(grep -c '^- \[ \]' GOAL.md)"
echo
echo "  未勾的那些（原文）："
grep '^- \[ \]' GOAL.md | cut -c1-120 | sed 's/^/    /'
echo
echo "═══ 它自己列的 11 个半截模块，现在什么状态 ═══"
echo
echo "① 语义检索：embedding 字段有人写了吗"
grep -rn "embedding_json\|embedding" server/ --include='*.py' 2>/dev/null | grep -v venv | head -4
echo
echo "② 自定义历法：有定义/换算了吗"
grep -rn "def .*calendar\|历法\|纪元\|leap" server/ --include='*.py' 2>/dev/null | grep -v venv | head -4
echo
echo "③ 整包导出：有对应的导入了吗"
grep -rn "export/bundle\|import_bundle\|/import" server/routers/export.py 2>/dev/null | head -4
echo
echo "④ 章节挂角色/事件：有人消费它了吗"
grep -rn "cast\b" server/routers/stats.py server/engine/*.py 2>/dev/null | head -3
echo
echo "⑤ 记忆：写作链路注入了吗"
grep -rn "memory" server/routers/write.py 2>/dev/null | head -4
echo
echo "⑥ 多 Agent：有角色分工了吗"
grep -rn "researcher\|critic\|retriever" server/ --include='*.py' 2>/dev/null | grep -v venv | head -4
echo
echo "⑦ 截图清理"
echo "  截图总数: $(ls docs/前端截图/ | wc -l)"
ls docs/前端截图/ | sed 's/-[0-9]*\.png$//' | sort | uniq -c | sort -rn | head -4
