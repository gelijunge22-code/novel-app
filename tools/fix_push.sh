#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 本地 vs 远程 ═══"
git log --oneline origin/main..HEAD 2>/dev/null | cut -c1-110 | sed 's/^/  未推送: /'
echo
echo "═══ 2. 试推一次（看报什么错）═══"
TOKEN=$(grep -E '^GITHUB_TOKEN=' /home/ubuntu/.hermes/.env | cut -d= -f2)
export https_proxy=http://本地代理 http_proxy=http://本地代理
git push origin main 2>&1 | tail -6 | sed 's/^/  /'
echo
echo "═══ 3. 结果 ═══"
echo "  远程 $(git rev-parse origin/main 2>/dev/null | cut -c1-7) / 本地 $(git rev-parse HEAD 2>/dev/null | cut -c1-7)"
echo
echo "═══ 4. remote 地址（看 token 还在不在）═══"
git remote -v 2>/dev/null | sed 's/:[^@]*@/:***@/' | sed 's/^/  /'
