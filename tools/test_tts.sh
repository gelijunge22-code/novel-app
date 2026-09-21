#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 实测：微软 edge-tts 到底能不能出声 ═══"
python3 - <<'PY' 2>&1 | tail -20
import asyncio, os
try:
    import edge_tts
except Exception as e:
    print("  导入失败:", e); raise SystemExit
async def main():
    try:
        vs = await edge_tts.list_voices()
        print("  可用音色数:", len(vs))
        zh = [v['ShortName'] for v in vs if v['Locale'].startswith('zh')]
        print("  中文音色:", zh[:6])
    except Exception as e:
        print("  ❌ 取音色失败:", type(e).__name__, str(e)[:150]); return
    out = "/tmp/tts_test.mp3"
    try:
        c = edge_tts.Communicate("这是一段听书测试。", "zh-CN-YunxiNeural")
        await c.save(out)
        print("  ✅ 合成成功:", out, os.path.getsize(out), "字节")
    except Exception as e:
        print("  ❌ 合成失败:", type(e).__name__, str(e)[:200])
asyncio.run(main())
PY
echo
echo "═══ 走代理再试一次（如果直连失败） ═══"
HTTPS_PROXY=http://本地代理 python3 - <<'PY' 2>&1 | tail -8
import asyncio, os
import edge_tts
async def main():
    try:
        c = edge_tts.Communicate("代理测试。", "zh-CN-YunxiNeural")
        await c.save("/tmp/tts_test2.mp3")
        print("  ✅ 走代理合成成功:", os.path.getsize("/tmp/tts_test2.mp3"), "字节")
    except Exception as e:
        print("  ❌ 走代理也失败:", type(e).__name__, str(e)[:150])
asyncio.run(main())
PY
