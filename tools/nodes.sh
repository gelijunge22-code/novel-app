#!/bin/bash
echo "=== 本地代理 控制接口 ==="
grep -E "^external-controller|^secret" /home/ubuntu/.config/本地代理/config.yaml | sed 's/^/  /'
echo
echo "=== 节点列表 ==="
CTRL=$(grep -E "^external-controller" /home/ubuntu/.config/本地代理/config.yaml | awk '{print $2}' | tr -d "'\"")
SEC=$(grep -E "^secret" /home/ubuntu/.config/本地代理/config.yaml | awk '{print $2}' | tr -d "'\"")
echo "  控制口: $CTRL"
curl -s -m 10 -H "Authorization: Bearer $SEC" "http://$CTRL/proxies" 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)['proxies']
    for k,v in d.items():
        if v.get('type') in ('Selector','URLTest','Fallback'):
            print('  组:',k,'| 现在:',v.get('now'),'| 可选',len(v.get('all') or []))
    n=[k for k,v in d.items() if v.get('type') not in ('Selector','URLTest','Fallback','Direct','Reject','Compatible','Pass')]
    print('  节点总数:',len(n))
    for x in n[:8]: print('    -',x)
except Exception as e:
    print('  读取失败:',e)
"
