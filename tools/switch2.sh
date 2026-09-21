#!/bin/bash
KEY=$(python3 -c "
import yaml;d=yaml.safe_load(open('/home/ubuntu/.hermes/config.yaml'))
print(d['providers']['custom_渠道']['api_key'])")
echo "═══ comm 上所有 deepseek / 相关模型 ═══"
curl -s -m 25 https://api.渠道.ai/provider/v1/models -H "Authorization: Bearer $KEY" \
 | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d.get('data',[]):
    i=m.get('id','')
    if 'deep' in i.lower() or 'v4' in i.lower() or 'flash' in i.lower():
        print('  %-38s %-34s ctx=%s' % (i, m.get('name'), m.get('context_length')))
print()
print('  全部模型数:', len(d.get('data',[])))
"
echo
echo "═══ 实测这个模型真能用吗（发一发最小请求）═══"
for M in "某模型" "某模型" "某模型"; do
  R=$(curl -s -m 25 https://api.渠道.ai/provider/v1/chat/completions \
    -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
    -d "{\"model\":\"$M\",\"max_tokens\":12,\"messages\":[{\"role\":\"user\",\"content\":\"说两个字：可用\"}]}" 2>&1 | head -c 220)
  printf "  %-34s -> %s\n" "$M" "$R"
done
