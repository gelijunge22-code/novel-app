#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══════ 1. 它说 200/200 通过，报告长什么样 ═══════"
python3 - <<'PY'
import json,os
p='docs/接口实测.json'
if os.path.exists(p):
    d=json.load(open(p))
    if isinstance(d,dict):
        print(" 顶层键:", list(d.keys())[:10])
        for k in ('total','passed','failed','skipped','summary'):
            if k in d: print("  %s = %s" % (k, d[k]))
        items=d.get('items') or d.get('results') or []
        if items:
            bad=[x for x in items if not (x.get('ok') or x.get('passed'))]
            print("  条目数:", len(items), "| 失败:", len(bad))
            for b in bad[:5]: print("   ❌", json.dumps(b,ensure_ascii=False)[:200])
    else:
        print(" 类型:", type(d), "长度", len(d))
        print(" 前两条:", json.dumps(d[:2],ensure_ascii=False)[:300])
else:
    print(" ❌ 没有 docs/接口实测.json")
PY
echo
echo "═══════ 2. 它抓的"线上真实返回"基准在不在 ═══════"
ls -la ref/golden/ 2>/dev/null | awk '{print "  ",$9,$5"B"}'
python3 -c "
import json
try:
    d=json.load(open('ref/golden/legacy-shapes.json'))
    print('  条数:', len(d) if not isinstance(d,dict) else len(d.get('endpoints',d)))
except Exception as e: print('  ',e)"
echo
echo "═══════ 3. 它的自测脚本 ═══════"
ls -la tools/verify_api.py tools/e2e.js 2>/dev/null | awk '{print "  ",$9,$5"B"}'
echo
echo "═══════ 4. 服务还活着吗（这是用户的） ═══════"
curl -s -m 5 -o /dev/null -w "  /api/app/info -> %{http_code}\n" http://127.0.0.1:8899/api/app/info
curl -s -m 5 http://127.0.0.1:8899/api/shelf 2>&1 | head -c 200; echo
echo
echo "═══════ 5. 目标进度 ═══════"
python3 -c "
import json;d=json.load(open('logs/goal-state.json'));g=d.get('goal') or d
print('  状态',g.get('status'),'| token',f\"{g.get('tokensUsed'):,}\",'| 秒',g.get('timeUsedSeconds'))"
