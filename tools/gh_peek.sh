#!/bin/bash
echo "=== 浏览器开了哪些标签页 ==="
curl -s -m 10 http://127.0.0.1:9334/json/list 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    for t in d:
        print('  [%s] %s' % (t.get('type'), (t.get('url') or '')[:110]))
        print('       标题:', (t.get('title') or '')[:80])
except Exception as e:
    print('  读取失败', e)
"
echo
echo "=== 脚本进程还在吗 ==="
pgrep -af gh_google.js | head -2 || echo "  已退出"
echo
echo "=== 完整日志 ==="
tail -20 /tmp/ghg.log 2>/dev/null
