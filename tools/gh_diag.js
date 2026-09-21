// 诊断：Chrome 走代理能不能加载页面
const { spawn } = require('child_process');
const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + PORT,
    '--proxy-server=http://本地代理',
    '--user-data-dir=/tmp/gh-diag',
    'about:blank',
  ], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 30; i++) { await sleep(500); try { t = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); if (t.length) break; } catch (e) {} }
  const page = t.find((x) => x.type === 'page') || t[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const w = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } };
  const send = (me, p) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: p || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : null; };
  for (const url of ['https://example.com', 'https://github.com/login', 'https://accounts.google.com']) {
    await send('Page.navigate', { url });
    await sleep(6000);
    const title = await js('document.title');
    const len = await js('document.body ? document.body.innerText.length : -1');
    console.log(url, '-> title=', JSON.stringify(title), 'textLen=', len);
  }
  chrome.kill();
})();
