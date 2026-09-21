#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 服务器上 server 里 TTS 相关代码怎么调的 ═══"
grep -rn "edge\|tts\|TTS\|speech" server/*.py 2>/dev/null | grep -iE "edge|url|http|proxy|host" | head -14 | cut -c1-160
echo
echo "═══ 2. edge-tts 装了吗 ═══"
ls server/venv/bin/ 2>/dev/null | grep -i edge | sed 's/^/  /'
server/venv/bin/python -c "import edge_tts; print('  edge_tts 版本:', edge_tts.__version__)" 2>&1 | head -3
echo
echo "═══ 3. edge-tts 默认连的地址能不能通（直连）═══"
timeout 12 curl -s -o /dev/null -w "  speech.platform.bing.com → HTTP %{http_code}  耗时 %{time_total}s\n" https://speech.platform.bing.com/ 2>&1
timeout 12 curl -s -o /dev/null -w "  speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list → HTTP %{http_code}\n" "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4" 2>&1
echo
echo "═══ 4. 走代理能不能通 ═══"
timeout 12 curl -s -o /dev/null -w "  经 PORT 代理 → HTTP %{http_code}  耗时 %{time_total}s\n" --proxy http://本地代理 "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4" 2>&1
echo
echo "═══ 5. 真的合成一句试试（直连）═══"
cd /tmp && timeout 40 /home/ubuntu/novel-app/server/venv/bin/python -c "
import asyncio, edge_tts
async def m():
    try:
        c = edge_tts.Communicate('测试一下', 'zh-CN-YunxiNeural')
        n = 0
        async for ch in c.stream():
            if ch['type'] == 'audio':
                n += len(ch['data'])
        print('  ✅ 成功，音频字节数:', n)
    except Exception as e:
        print('  ❌ 失败:', type(e).__name__, str(e)[:200])
asyncio.run(m())
" 2>&1 | tail -5
echo
echo "═══ 6. 服务器当前 TTS 配置（config.json）═══"
python3 -c "
import json,os
for p in ['/home/ubuntu/novel-app/data/config.json','/home/ubuntu/novel-app/config.json']:
    if os.path.exists(p):
        d=json.load(open(p))
        t=d.get('tts') or d.get('TTS')
        print(' ',p,'→',json.dumps(t,ensure_ascii=False)[:300] if t else '(无 tts 段)')
" 2>&1 | head -6
