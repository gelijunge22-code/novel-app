#!/bin/bash
cd /home/ubuntu/novel-app
TOKEN=$(grep -E '^GITHUB_TOKEN=' /home/ubuntu/.hermes/.env | cut -d= -f2)
export https_proxy=http://本地代理 http_proxy=http://本地代理

echo "=== 1. 仓库在不在（API） ==="
curl -s -m 30 -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/gelijunge22-code/novel-app -o /tmp/repo.json -w "  http=%{http_code}\n"
python3 -c "
import json
d=json.load(open('/tmp/repo.json'))
if 'full_name' in d:
    print('  ✅',d['full_name'],'| 大小',d.get('size'),'KB | 默认分支',d.get('default_branch'))
    print('  地址:',d['html_url'])
else:
    print('  ',str(d)[:200])
"

echo
echo "=== 2. 远程分支有没有内容 ==="
curl -s -m 30 -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/gelijunge22-code/novel-app/branches -o /tmp/br.json -w "  http=%{http_code}\n"
python3 -c "
import json
d=json.load(open('/tmp/br.json'))
print('  分支:',[b.get('name') for b in d] if isinstance(d,list) else str(d)[:150])
"

echo
echo "=== 3. 本地推送（补推） ==="
git push -u origin main --force 2>&1 | tail -8

echo
echo "=== 4. 再查一次 ==="
curl -s -m 30 -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/gelijunge22-code/novel-app/branches -o /tmp/br2.json
python3 -c "
import json
d=json.load(open('/tmp/br2.json'))
print('  分支:',[b.get('name') for b in d] if isinstance(d,list) else str(d)[:150])
"
