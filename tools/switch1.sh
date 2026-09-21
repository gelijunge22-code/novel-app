#!/bin/bash
echo "═══ 1. comm 通道有哪些模型 ═══"
KEY=$(python3 -c "
import yaml;d=yaml.safe_load(open('/home/ubuntu/.hermes/config.yaml'))
print(d['providers']['custom_渠道']['api_key'])")
curl -s -m 20 https://api.渠道.ai/provider/v1/models -H "Authorization: Bearer $KEY" | head -c 900
echo
echo
echo "═══ 2. 当前 Hermes 用哪个 ═══"
python3 -c "
import yaml;d=yaml.safe_load(open('/home/ubuntu/.hermes/config.yaml'))
print('  model.provider =', d['model'].get('provider'))
for k,v in d['providers'].items():
    if '渠道' in k or '渠道' in k:
        print('  ', k, '->', v.get('base_url'), '| model:', v.get('model'))"
echo
echo "═══ 3. Codex 卡了吗 ═══"
systemctl --user is-active codex-goal.service
echo "  日志最后活动: $(( ( $(date +%s) - $(stat -c %Y /home/ubuntu/novel-app/logs/codex-goal.log) ) / 60 )) 分钟前"
tail -4 /home/ubuntu/novel-app/logs/codex-goal.log | cut -c1-220
