/* ============================================================
   e2e-appboot.js — App 启动两条路都验一遍（真浏览器 390×844）。

   为什么单独有一个：真机"一点就闪退 / 一片黄什么都没有"这两件事，
   根子上都是**启动那一小段**的问题，而它是唯一没法用面板走查覆盖的地方。

   路线丙的两条路：
     ① server 模式：WebView 加载 http://<服务器>/novel/  —— 同源，cookie/SSE/上传天然对
     ② offline 模式：WebView 加载 assets/www/index.html（file://）—— 断网也得能开壳

   检查项：
     · 启动页一定会退场（不许一直盖着 = 黄屏）
     · 界面真的渲染出东西（书架卡 / 登录卡），不是空白
     · 没有 JS 异常、没有 4xx
     · file:// 模式下**所有请求地址都是绝对的**（不许出现 file:///…/api/… 这种打不出去的）

   用法：node tools/e2e-appboot.js
   报告：docs/App启动实测.json
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const OUT = path.join(ROOT, 'docs/App启动实测.json');
const SHOTDIR = path.join(ROOT, 'docs/前端截图');
const SERVER = process.env.APP_SERVER || 'http://<你的服务器地址>/novel/';
const ASSETS = 'file://' + path.join(ROOT, 'apk/assets/www/index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPassword() {
  try {
    const c = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8'));
    return c.app_password || '';
  } catch (e) { return ''; }
}

async function runOne(label, url, { blockExternal = false } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-'));
  const port = 9600 + Math.floor(Math.random() * 80);
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, '--window-size=390,844', '--user-data-dir=' + profile,
    '--allow-file-access-from-files',
    /* 桌面 Chrome 默认开着「HTTPS-First」：http://<你的服务器地址>/… 会被它自动升到 https，
       而服务器只有 http → ERR_BLOCKED_BY_CLIENT，页面变成 chrome-error://。
       这是**测试环境**的毛病，不是 App 的：Android WebView 没有这个特性
       （明文由清单的 usesCleartextTraffic 说了算，我们那条断言已经守着）。
       不关掉它，这一路永远假红（第一次跑就是被它骗的）。 */
    '--disable-features=HttpsFirstMode,HttpsFirstModeV2,HttpsFirstBalancedMode,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
    'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { chrome.kill('SIGKILL'); return { label, error: 'chrome 起不来' }; }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map(); const errs = []; const fails = []; const reqs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      errs.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 300));
    }
    if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url);
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r.status >= 400) fails.push(r.status + ' ' + r.url.slice(0, 140));
    }
  };
  const send = (method, params) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  if (blockExternal) await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });

  const t0 = Date.now();
  await send('Page.navigate', { url });
  await sleep(6500);
  const js = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };
  if (await js("(()=>{const l=document.getElementById('login');return l&&!l.classList.contains('hidden')})()")) {
    await js("(()=>{const i=document.getElementById('login-pass');if(!i)return 0;i.value=" + JSON.stringify(readPassword()) + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4000);
  }
  const shot = path.join(SHOTDIR, 'r14-appboot-' + label + '.png');
  try {
    const cap = await send('Page.captureScreenshot', { format: 'png' });
    if (cap && cap.result && cap.result.data) fs.writeFileSync(shot, Buffer.from(cap.result.data, 'base64'));
  } catch (e) {}

  /* 只抓"接口级"的 file:// 请求。
     第一版写成 /^file:.*\/(api|nb|apk)/ —— 结果把 file:///…/js/api.js 也当成接口，
     8 条全是自己人。坑：静态文件名里也有 api。 */
  const badReqs = reqs.filter((u) => /^file:[^?]*\/(api|nb)\/|^file:[^?]*\/apk(\?|$)/.test(u));
  const out = {
    label, url, ms: Date.now() - t0,
    splashGone: await js('!document.getElementById("splash")'),
    rendered: (await js('document.body.innerText || ""') || '').trim().slice(0, 120),
    shelfCards: await js('document.querySelectorAll("#shelf-list .book-card,#shelf-list .book,#shelf-list > *").length'),
    loginVisible: await js("(()=>{const l=document.getElementById('login');return !!l&&!l.classList.contains('hidden')})()"),
    backend: await js('JSON.stringify((window.API&&API.backend&&API.backend())||null)'),
    exceptions: errs.slice(0, 6),
    http4xx: fails.slice(0, 8),
    fileSchemeApiCalls: badReqs.slice(0, 8),
    requests: reqs.length,
    shot: path.relative(ROOT, shot),
  };
  /* 判据：
       · 启动页一定退场（不退 = 真机上的"一片黄"）
       · 一定渲染出东西（书架或登录卡；**空屏才是事故**）
       · 没有 JS 异常 / 没有 4xx
       · 没有往 file:///…/api/… 上打请求（打出去就是一定失败的幽灵请求）
     注意"登录页可见"**不算失败**：断网 + 一个缓存都没有时，设计上就是给登录页 + 一句
     "连不上服务器"。真正不许发生的是空白。 */
  out.pass = out.splashGone && out.exceptions.length === 0
    && out.http4xx.length === 0 && out.fileSchemeApiCalls.length === 0
    && out.rendered.length > 0;
  try { ws.close(); } catch (e) {}
  chrome.kill('SIGKILL');
  return out;
}

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const results = [];
  results.push(await runOne('server', SERVER));
  results.push(await runOne('offline', ASSETS, { blockExternal: true }));
  const bad = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(`\n【${r.label}】${r.pass ? '通过 ✅' : '不通过 ❌'}  (${r.ms}ms)`);
    console.log('  url      :', r.url);
    console.log('  启动页退场:', r.splashGone, '| 登录页可见:', r.loginVisible, '| 书架条目:', r.shelfCards);
    console.log('  首屏文字 :', JSON.stringify(r.rendered));
    console.log('  后端握手 :', r.backend);
    console.log('  异常/4xx :', JSON.stringify(r.exceptions), JSON.stringify(r.http4xx));
    console.log('  打不出去的请求:', JSON.stringify(r.fileSchemeApiCalls));
    console.log('  截图     :', r.shot);
  }
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length - bad.length}/${results.length} 条路通过；报告 → ${OUT}`);
  process.exit(bad.length ? 1 : 0);
})();
