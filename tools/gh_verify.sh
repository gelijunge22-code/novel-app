#!/bin/bash
cd /home/ubuntu/novel-app
TOKEN=$(grep -E '^GITHUB_TOKEN=' /home/ubuntu/.hermes/.env | cut -d= -f2)
export https_proxy=http://本地代理 http_proxy=http://本地代理
echo "=== 仓库里的文件（顶层） ==="
curl -s -m 30 -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/gelijunge22-code/novel-app/contents/" -o /tmp/c.json
python3 -c "
import json
d=json.load(open('/tmp/c.json'))
if isinstance(d,list):
    for x in d: print('  %-14s %s' % (x['type'], x['name']))
else: print(str(d)[:200])
"
echo
echo "=== docs 目录（有多少文档） ==="
curl -s -m 30 -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/gelijunge22-code/novel-app/contents/docs" -o /tmp/c2.json
python3 -c "
import json
d=json.load(open('/tmp/c2.json'))
print('  docs 下条目数:', len(d) if isinstance(d,list) else str(d)[:120])
if isinstance(d,list):
    for x in d[:12]: print('    ',x['name'])
"
echo
echo "=== 最新提交 ==="
curl -s -m 30 -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/gelijunge22-code/novel-app/commits?per_page=3" -o /tmp/c3.json
python3 -c "
import json
d=json.load(open('/tmp/c3.json'))
for c in d if isinstance(d,list) else []:
    print('  ',c['sha'][:7], c['commit']['message'].split(chr(10))[0][:60])
"
echo
echo "=== 本地 vs 远程是否一致 ==="
git rev-parse main | cut -c1-7 | sed 's/^/  本地 main: /'
git rev-parse origin/main | cut -c1-7 | sed 's/^/  远程 main: /'
