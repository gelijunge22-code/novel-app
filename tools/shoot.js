// 直连 Chrome DevTools Protocol 截图：零依赖（Node 内置 WebSocket）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const PORT = 9222;
const BASE = process.env.NB_URL || 'http://127.0.0.1:8890/';
const OUT = '/home/ubuntu/novel-app/docs/前端截图';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--window-size=390,844',
    '--user-data-dir=/tmp/nb-shot-profile',
    'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      targets = await r.json();
      if (targets && targets.length) break;
    } catch (e) {}
  }
  if (!targets) { console.error('chrome 没起来'); chrome.kill(); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    else if (m.method) events.push(m);
  };
  const send = (method, params) => new Promise((res) => {
    const i = ++id; waiting.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });

  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r.result || !r.result.data) { console.log('  截图失败', name); return; }
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
    console.log('  ✅', name + '.png');
  };

  await send('Page.navigate', { url: BASE + '?v=shot' });
  await sleep(6000);
  console.log('tab =', await js('document.body.dataset.tab'));

  const steps = JSON.parse(fs.readFileSync('/home/ubuntu/novel-app/tools/shots.json', 'utf8'));
  for (const s of steps) {
    if (s.js) { try { await js(s.js); } catch (e) { console.log('  脚本失败', s.name, e.message); } }
    await sleep(s.wait || 1800);
    await shot(s.name);
  }
  ws.close(); chrome.kill();
  console.log('完成，输出到', OUT);
  process.exit(0);
})();
