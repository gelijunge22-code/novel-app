#!/bin/bash
echo "═══ 1. 新后端服务活着吗 ═══"
systemctl --user is-active novelapp.service 2>/dev/null
curl -s -m 8 -o /dev/null -w "  本地 127.0.0.1:8899/api/health  http=%{http_code}\n" http://127.0.0.1:8899/api/health
echo
echo "═══ 2. Caddy 里有哪些路由 ═══"
sudo grep -nE "handle|reverse_proxy|redir|:80|listen" /etc/caddy/Caddyfile 2>/dev/null | head -30 || cat /etc/caddy/Caddyfile 2>/dev/null | head -40
echo
echo "═══ 3. 公网能访问到哪些路径 ═══"
for p in / /nbapp/ /app/ /novel/ /novelapp/; do
  code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://<你的服务器地址>$p")
  printf "  %-14s http=%s\n" "$p" "$code"
done
echo
echo "═══ 4. 新后端的静态前端目录指向哪 ═══"
python3 -c "
import json
d=json.load(open('/home/ubuntu/novel-app/server/config.json'))
print('  frontend_dir:', d.get('frontend_dir'))
print('  port:', d.get('port'), '| host:', d.get('host'))
" 2>/dev/null
ls -la /home/ubuntu/novel-app/frontend/index.html | awk '{print "  新前端 index.html:",$6,$7,$8}'
