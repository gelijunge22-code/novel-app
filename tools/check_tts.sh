#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. TTS 依赖装了吗 ═══"
python3 -c "
import importlib
for m in ('edge_tts','aiohttp','requests'):
    try:
        importlib.import_module(m); print('  ✅',m)
    except Exception as e: print('  ❌',m,'->',str(e)[:60])
"
echo
echo "═══ 2. 服务器上有网能连微软 TTS 吗 ═══"
curl -s -m 12 -o /dev/null -w "  speech.platform.bing.com  http=%{http_code}\n" https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list 2>/dev/null || echo "  连不上"
curl -s -m 12 -o /dev/null -w "  (走代理) http=%{http_code}\n" -x http://本地代理 https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list 2>/dev/null
echo
echo "═══ 3. TTS 路由代码里的引擎 ═══"
ls server/tts/ 2>/dev/null | sed 's/^/  /'
grep -nE "edge|cosyvoice|azure" server/tts/__init__.py 2>/dev/null | head -8
echo
echo "═══ 4. 切书条样式（太显眼的问题） ═══"
sed -n '481,520p' frontend/css/base.css | sed 's/^/  /'
echo
echo "═══ 5. 工具栈的返回逻辑（退出bug） ═══"
sed -n '86,110p' frontend/js/tools.js | sed 's/^/  /'
