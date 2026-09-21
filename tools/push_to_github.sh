#!/bin/bash
# 一键：用令牌建 GitHub 仓库 + 推送
#   bash tools/push_to_github.sh <TOKEN> [仓库名] [public|private]
# 令牌也可放 ~/.hermes/.env 的 GITHUB_TOKEN=...
set -e
TOKEN="${1:-$(grep -E '^GITHUB_TOKEN=' /home/ubuntu/.hermes/.env 2>/dev/null | cut -d= -f2-)}"
REPO_NAME="${2:-novel-app}"
VIS="${3:-private}"
if [ -z "$TOKEN" ]; then
  echo "❌ 没有令牌。用法：bash tools/push_to_github.sh <TOKEN> [仓库名] [private]"
  echo "   或把 GITHUB_TOKEN=xxx 写进 ~/.hermes/.env"
  exit 1
fi

echo "1) 验证令牌"
ME=$(curl -s -m 25 -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" https://api.github.com/user)
LOGIN=$(echo "$ME" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('login') or '')" 2>/dev/null)
if [ -z "$LOGIN" ]; then
  echo "❌ 令牌无效：" ; echo "$ME" | head -c 300; exit 1
fi
echo "   ✅ 登录身份：$LOGIN"

echo "2) 建仓库 $LOGIN/$REPO_NAME（$VIS）"
curl -s -m 30 -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/user/repos \
  -d "{\"name\":\"$REPO_NAME\",\"private\":$([ "$VIS" = "private" ] && echo true || echo false),\"description\":\"自研小说写作 App：自研后端 + 定制前端 + 安卓壳\",\"auto_init\":false}" \
  -o /tmp/mkrepo.json
python3 -c "
import json;d=json.load(open('/tmp/mkrepo.json'))
print('   ✅', d.get('full_name') or d.get('message'))"

echo "3) 推送"
cd /home/ubuntu/novel-app
git remote remove origin 2>/dev/null || true
git remote add origin "https://$LOGIN:$TOKEN@github.com/$LOGIN/$REPO_NAME.git"
git push -u origin master --force 2>&1 | tail -5

echo
echo "4) 结果"
git remote set-url origin "https://github.com/$LOGIN/$REPO_NAME.git"
echo "   仓库地址：https://github.com/$LOGIN/$REPO_NAME"
echo "   （remote 已改回不含令牌的地址）"
