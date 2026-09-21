#!/bin/bash
echo "═══ 1. 把我自己换成 comm 的 v4.1-flash ═══"
hermes config set providers.custom_渠道.model "某模型" 2>&1 | tail -1
hermes config set model.provider "custom_渠道" 2>&1 | tail -1
echo
echo "═══ 2. 确认 ═══"
python3 -c "
import yaml;d=yaml.safe_load(open('/home/ubuntu/.hermes/config.yaml'))
print('  model.provider =', d['model'].get('provider'))
print('  渠道.model =', d['providers']['custom_渠道'].get('model'))"
echo
echo "═══ 3. Codex 要用的 responses 接口通不通 ═══"
KEY=$(python3 -c "
import yaml;d=yaml.safe_load(open('/home/ubuntu/.hermes/config.yaml'))
print(d['providers']['custom_渠道']['api_key'])")
curl -s -m 25 -o /tmp/r.json -w "  responses 接口 http=%{http_code}\n" \
  https://api.渠道.ai/provider/v1/responses \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"某模型","input":"说两个字","max_output_tokens":20}'
head -c 300 /tmp/r.json; echo
