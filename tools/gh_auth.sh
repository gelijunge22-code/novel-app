#!/bin/bash
# 测试 GitHub 认证（先试密码直连 API，再试 token）
U="gelijunge22@gmail.com"
P='1!2@3#1q2w3e'
echo "═══ 1. 直接用账号密码调 API（GitHub 2021 后多数接口已禁用密码） ═══"
curl -s -m 25 -o /tmp/gh1.json -w "  http=%{http_code}\n" -u "$U:$P" https://api.github.com/user
head -c 200 /tmp/gh1.json; echo
echo
echo "═══ 2. 试试用密码换 token（部分老流程仍在） ═══"
curl -s -m 25 -o /tmp/gh2.json -w "  http=%{http_code}\n" -u "$U:$P" \
  -X POST https://api.github.com/authorizations \
  -H "content-type: application/json" \
  -d '{"scopes":["repo"],"note":"hermes-novelapp","client_id":"00000000000000000000","client_secret":"0000000000000000000000000000000000000000"}'
head -c 250 /tmp/gh2.json; echo
echo
echo "═══ 3. 本机有没有 gh CLI / 现成 token ═══"
which gh 2>/dev/null || echo "  没有 gh"
grep -E "^GITHUB_TOKEN|^GH_TOKEN" /home/ubuntu/.hermes/.env 2>/dev/null | sed 's/=.*/=有/' || echo "  .env 里没有现成 token"
ls /home/ubuntu/.config/gh/hosts.yml 2>/dev/null || echo "  没有 gh 登录态"
