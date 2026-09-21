/* ============================================================
   e2e-offline.js — 「浏览器/PWA 场景下断网」走查。

   ⚠ 定位说明（第 11 轮改过）：这个脚本模拟的是「**服务器连不上**」——
     页面从本地目录给、api/… 全部断掉。那是"后端在服务器上"那个时代对"断网"的假设。
     **App 里不是这样**：App 把整份后端装在手机里，真断网时接口照常（只有模型够不着）。
     所以"飞行模式全功能"那条现在由 `tools/e2e-flightmode.js` 负责，不要再拿这个脚本当证据。

   这一条留着仍然有用：它管的是**网页版/PWA**——服务器挂了或手机在没网的野外打开网页版时，
   界面还能出来、读过的章节还能接着看（走 IndexedDB 缓存）。

   用法：node tools/e2e-offline.js
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const FRONTEND = path.join(ROOT, 'frontend');
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const OUTJSON = path.join(ROOT, 'docs/前端走查-离线.json');
const SHOTDIR = path.join(ROOT, 'docs/前端截图');
const { shelfShield, pickCardExpr, shieldOnly } = require('./preflight');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

function readPassword() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8'));
    return cfg.app_password || cfg.password || '';
  } catch (e) { return ''; }
}

/* 和 MainActivity.isEmbeddedAsset 保持一致 */
function isEmbedded(p) {
  if (!p) return false;
  if (['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/favicon.ico'].indexOf(p) >= 0) return true;
  return p.indexOf('/js/') === 0 || p.indexOf('/css/') === 0;
}

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-off-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=9336', '--window-size=390,844', '--user-data-dir=' + profile, 'about:blank'],
    { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch('http://127.0.0.1:9336/json/list')).json(); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('chrome 起不来'); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  const consoleErrors = []; const exceptions = [];
  let offline = false;          // 一开，静态走本地、接口全断
  let served = 0, blocked = 0;
  const servedUrls = []; const blockedUrls = []; const pausedLog = [];

  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 300));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      exceptions.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 300));
    } else if (m.method === 'Fetch.requestPaused') {
      const p = m.params;
      pausedLog.push(p.request.url.replace(BASE.replace(/\/$/, ''), '') + ' [' + p.resourceType + ']');
      let path = '/';                      // 注意别把 node 的 path 模块盖掉（踩过一次）
      try { path = new URL(p.request.url).pathname; } catch (e) {}
      if (!offline) { send('Fetch.continueRequest', { requestId: p.requestId }); return; }
      if (isEmbedded(path)) {                       // 界面文件：从包里给
        const name = path === '/' ? 'index.html' : path.slice(1);
        try {
          const buf = fs.readFileSync(require('path').join(FRONTEND, name));
          served++; servedUrls.push(path);
          send('Fetch.fulfillRequest', {
            requestId: p.requestId, responseCode: 200,
            responseHeaders: [
              /* 注意：按**文件名**猜类型，别按路径 —— 路径是 '/' 的时候会猜成
                 application/octet-stream，Chrome 就把这次导航当成「下载」直接掐掉
                 （报 net::ERR_ABORTED + isDownload:true），页面根本不会重载。 */
              { name: 'content-type', value: (MIME[name.slice(name.lastIndexOf('.'))] || 'text/plain') + '; charset=utf-8' },
              { name: 'cache-control', value: 'no-cache' },
            ],
            body: buf.toString('base64'),
          });
          return;
        } catch (e) { /* 包里没有 → 当没有网 */ }
      }
      blocked++; blockedUrls.push(p.request.url.replace(BASE.replace(/\/$/, ''), ''));   // 其余（接口 / 图片）全断
      send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionFailed' });
    }
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const js = async (expr, wait) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (wait) await sleep(wait);
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const kit = require('./shotkit')({ send, dir: SHOTDIR, round: 'r10' });
  const shot = (n, opts) => kit.shoot(n, opts);

  /* ── 第一步：联网，正常用一遍，把书和章节缓存下来 ── */
  await send('Page.navigate', { url: BASE + '?off=' + Date.now() });
  await sleep(5000);
  if (await js("!document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
      ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4500);
  }
  await js("localStorage.removeItem('nbapp.offline.v1'); window.__loadId='warmup';1");
  const opened = await js("(async()=>{const d=await API.shelf();const p=(d.projects||[])[0];if(!p)return 'no-book';" +
    "const b=await API.book(p.slug);window.__cacheBook=b;return p.slug})()", 2500);
  console.log('  课本:', opened);
  // 真的读两章（走阅读器那条路，正文才会进缓存）
  const read = await js("(async()=>{const b=window.__cacheBook;const out=[];" +
    "for(const c of (b.chapters||[]).slice(0,3)){await Shelf.openBook(b.slug,{slug:b.slug,path:c.path});" +
    "await new Promise(r=>setTimeout(r,900));out.push(c.path);await App.show('shelf');await new Promise(r=>setTimeout(r,300));}" +
    "return {read:out, stats: Offline.stats()}})()", 1500);
  console.log('  读了:', JSON.stringify(read && read.read));
  console.log('  缓存:', JSON.stringify(read && read.stats));

  /* ── 第二步：断网（静态仍从本地包给），重开 App ── */
  offline = true;
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  consoleErrors.length = 0; exceptions.length = 0;
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  const nav = await send('Page.navigate', { url: BASE + '?off=' + Date.now() });
  console.log('  断网导航:', JSON.stringify((nav && nav.result) || {}));
  await sleep(4500);
  const step1 = {
    href: await js("location.href"),
    loadId: await js("String(window.__loadId)"),
    navigations: await js("performance.getEntriesByType('navigation').length"),
    tab: await js("document.body.dataset.tab"),
    splashGone: await js("!document.getElementById('splash') || document.getElementById('splash').classList.contains('gone')"),
    loginVisible: await js("!document.getElementById('login').classList.contains('hidden')"),
    cards: await js("document.querySelectorAll('#shelf-list .book-card').length"),
  };
  // 断网到底断没断干净：当场打一个接口试试（探针，写进报告）
  const probe = await js("(async()=>{try{const r=await fetch('api/app/status',{credentials:'include'});" +
    "return 'HTTP '+r.status}catch(e){return 'rejected: '+e.message}})()", 800);
  console.log('  探针 api/app/status →', probe);
  await shot('off-01-断网书架');
  console.log('  断网后: loadId=' + step1.loadId + ' href=' + step1.href + ' tab=' + step1.tab + ' 登录页=' + step1.loginVisible + ' 书架卡片=' + step1.cards);

  /* ── 第三步：点开书，读缓存里的正文 ── */
  await js(pickCardExpr('#shelf-list .book-card, #shelf-list [data-slug]'), 3500);
  const step2 = {
    tab: await js("document.body.dataset.tab"),
    title: await js("(document.querySelector('.reader-page')||{}).textContent ? document.querySelector('.reader-page').textContent.slice(0,40) : ''"),
    chars: await js("(document.querySelector('.reader-page')||{}).innerHTML ? document.querySelector('.reader-page').innerHTML.replace(/<[^>]+>/g,'').length : 0"),
    toast: await js("document.getElementById('toast').textContent"),
  };
  await shot('off-02-断网读缓存', { expect: 'same', as: '阅读器' });
  console.log('  断网开书: tab=' + step2.tab + ' 正文长度=' + step2.chars + ' 提示=' + JSON.stringify(step2.toast));

  const report = {
    at: new Date().toISOString(), url: BASE,
    note: '断网模拟规则与 MainActivity.isEmbeddedAsset 一致：静态文件从本地 frontend/ 给，接口请求全部失败',
    warmup: { book: opened, read: read && read.read, cache: read && read.stats },
    offline: { probeApiStatus: probe, staticServed: served, blockedRequests: blocked,
               servedUrls: servedUrls, blockedUrls: blockedUrls, paused: pausedLog,
               shelf: step1, reader: step2 },
    consoleErrors, exceptions,
    verdict: { shellOpensOffline: !step1.loginVisible && step1.cards > 0,
               cachedChapterReadable: step2.chars > 100,
               noConsoleErrors: consoleErrors.length === 0 && exceptions.length === 0 },
  };
  fs.writeFileSync(OUTJSON, JSON.stringify(report, null, 2));
  console.log('\n断网时：界面文件从本地给了', served, '个；接口请求断掉', blocked, '个');
  console.log('  拦到的请求（前 25 条）:');
  pausedLog.slice(0, 25).forEach((u) => console.log('    ', u));
  servedUrls.slice(0, 20).forEach((u) => console.log('   [本地]', u));
  blockedUrls.slice(0, 20).forEach((u) => console.log('   [断掉]', u));
  console.log('控制台报错', consoleErrors.length, '条；页面异常', exceptions.length, '条');
  console.log('判定：', JSON.stringify(report.verdict));
  console.log('报告：', OUTJSON);
  ws.close(); chrome.kill(); process.exit(0);
})();
