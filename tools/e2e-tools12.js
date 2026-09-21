/* ============================================================
   e2e-tools12.js — 12 个"老工具"逐个点开、逐个截图、逐个断言。
   为什么要单独一个脚本：以前那批截图（tool-记忆AI 记得啥.png 等 24 张）
   **md5 完全一样**，拍到的只是工具宫格 —— 等于点击没进面板就截了，证据是废的。
   这个脚本的硬要求：
     * 每张图必须能看见 面板标题(#tool-title) + 右上/左上的返回键 + 真内容
     * 截图之间 md5 不许相同（相同就说明根本没进面板 / 拍了同一屏）
   用法：node tools/e2e-tools12.js
   产出：docs/工具12个实测.json + docs/前端截图/tool12-<id>.png
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:8899/');
const OUT = path.join(ROOT, 'docs/工具12个实测.json');
const SHOT = path.join(ROOT, 'docs/前端截图');
const IDS = (arg('ids', '') || 'files,models,profiles,history,backup,sessions,cover,skills,memory,users,about,jobs').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e12-'));
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=9336', '--window-size=390,844',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch('http://127.0.0.1:9336/json/list')).json(); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('chrome 起不来'); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (m, p) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const shotBuf = async () => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    return r.result && r.result.data ? Buffer.from(r.result.data, 'base64') : null;
  };

  await send('Page.navigate', { url: BASE + '?t12=' + Date.now() });
  await sleep(5000);
  if (await js("!document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
      ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4500);
  }
  await js("App.show('tools'); 1"); await sleep(1200);

  const seen = new Map();
  for (const tid of IDS) {
    const info = await js(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const grid = document.getElementById('tools-body');
      App.show('tools'); await wait(500);
      const card = document.querySelector('#tools-body [data-id="' + ${JSON.stringify(tid)} + '"]');
      if (!card) return { err: '宫格里找不到 ' + ${JSON.stringify(tid)} };
      card.click(); await wait(2200);
      // 有的工具先让你选一本书：选第一本再等
      for (let k = 0; k < 3; k++) {
        const scr = document.getElementById('screen-tool');
        if (scr && !scr.classList.contains('hidden')) break;
        const pick = document.querySelector('#tools-body .t-row[data-i], .screen:not(.hidden) .t-row[data-i]');
        if (!pick) break;
        pick.click(); await wait(2200);
      }
      const scr = document.getElementById('screen-tool');
      const visible = !!scr && !scr.classList.contains('hidden');
      const titleEl = document.getElementById('tool-title');
      const bodyEl = document.getElementById('tool-body');
      const body = bodyEl ? bodyEl.innerText.replace(/\\s+/g, ' ').trim() : '';
      const closeBtn = !!document.querySelector('#screen-tool .topbar [data-act="tool-back"]');
      return { visible, title: titleEl ? titleEl.textContent.trim() : '',
               closeBtn, len: body.length, head: body.slice(0, 60),
               gridStillVisible: !!grid && grid.offsetParent !== null && document.getElementById('screen-tools').offsetParent !== null };
    })()`);
    const buf = await shotBuf();
    let md5 = '';
    if (buf) { fs.writeFileSync(path.join(SHOT, 'tool12-' + tid + '.png'), buf); md5 = crypto.createHash('md5').update(buf).digest('hex'); }
    const dup = seen.get(md5);
    seen.set(md5, tid);
    // 内容非空的标准：面板不在宫格上、有标题、有返回键、正文 ≥12 字。
    // 12 字是留给"没有待处理的改动"这类**空态文案**的 —— 空态也是内容，不是没打开。
    const ok = info && !info.err && info.visible && info.title && info.title !== '—' &&
      info.closeBtn && info.len >= 12 && !info.gridStillVisible && !dup;
    results.push({ id: tid, ok: !!ok, md5, shot: 'tool12-' + tid + '.png',
      why: info && info.err ? info.err : (dup ? '截图与 ' + dup + ' 完全相同（没进面板？）' : JSON.stringify(info)),
      title: info && info.title, contentLen: info && info.len });
    console.log((ok ? '  ✓ ' : '  ✗ ') + tid + '  ' + (info && info.title ? '「' + info.title + '」' : '') +
      ' 正文 ' + (info && info.len) + ' 字' + (ok ? '' : '   —— ' + results[results.length - 1].why));
    await js("(()=>{const b=document.querySelector('#screen-tool [data-act=\"tool-back\"]');if(b)b.click();return 1})()");
    await sleep(500);
  }

  const ok = results.filter((r) => r.ok).length;
  fs.writeFileSync(OUT, JSON.stringify({
    at: new Date().toISOString(), total: results.length, ok, fail: results.length - ok,
    uniqueShots: new Set(results.map((r) => r.md5)).size, items: results }, null, 1));
  console.log(`\n=== 12 个老工具：通过 ${ok}/${results.length}；截图去重后 ${new Set(results.map((r) => r.md5)).size} 张不同 ===`);
  console.log('报告：docs/工具12个实测.json');
  process.exit(ok === results.length ? 0 : 1);
})();
