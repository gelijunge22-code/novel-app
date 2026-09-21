#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. blocked 的原因（日志里的 error） ═══"
grep -E "<-- error|ERROR" logs/codex-goal.log | tail -5 | cut -c1-400
echo
echo "═══ 2. 会话里最后那段错误 ═══"
python3 - <<'PY'
import json,os
p='/home/ubuntu/.codex/sessions/2026/09/19/rollout-2026-09-19T13-45-19-01a0b832-9d5e-7362-8328-53a3ac726e69.jsonl'
lines=open(p,encoding='utf-8',errors='ignore').readlines()
for line in lines[-40:]:
    if 'error' in line.lower() and ('message' in line or 'detail' in line):
        print(' ', line[:400])
PY
echo
echo "═══ 3. Codex 现在用哪个 provider/模型 ═══"
grep -nE "^model|model_provider|CODEX_PROVIDER|CODEX_MODEL" /home/ubuntu/.codex/config.toml | head -4
grep -nE "CODEX_MODEL|CODEX_PROVIDER" /home/ubuntu/.config/systemd/user/codex-goal.service
echo
echo "═══ 4. comm 通道上 v4.1-flash 还活着吗（再测一次） ═══"
KEY=$(python3 -c "
import yaml;d=yaml.safe_load(open('/home/ubuntu/.hermes/config.yaml'))
print(d['providers']['custom_渠道']['api_key'])")
curl -s -m 20 -o /dev/null -w "  chat/completions http=%{http_code}\n" \
  https://api.渠道.ai/provider/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"某模型","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
echo
echo "═══ 5. 我自己的模型 ═══"
python3 -c "
import yaml;d=yaml.safe_load(open('/home/ubuntu/.hermes/config.yaml'))
print('  ',d['model'].get('provider'),'/',d['providers']['custom_渠道'].get('model'))"
