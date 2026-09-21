#!/bin/bash
echo "═══ 1. 本机有没有现成的 git 凭据 ═══"
ls -la /home/ubuntu/.git-credentials 2>/dev/null && sed 's/:[^@]*@/:***@/' /home/ubuntu/.git-credentials | head -3
cat /home/ubuntu/.gitconfig 2>/dev/null | head -10
echo
echo "═══ 2. .env 里有没有别的 GitHub token / PAT ═══"
grep -iE "GITHUB_TOKEN|GH_TOKEN|PAT|GITHUB_PAT" /home/ubuntu/.hermes/.env 2>/dev/null | sed 's/=.*/=***/' | head -5 || echo "  没有"
echo
echo "═══ 3. 有没有 gh CLI 可装 ═══"
apt-cache policy gh 2>/dev/null | head -3 || echo "  (不查了)"
echo
echo "═══ 4. 能不能装 gh（走国内源） ═══"
which curl git || true
