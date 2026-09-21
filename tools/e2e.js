/* ============================================================
   e2e.js — 端到端走查：真浏览器打开前端，逐个页签/工具点一遍，
   抓控制台报错、页面异常、失败的网络请求，并截图。
   用法：node tools/e2e.js [--url http://127.0.0.1:8899/] [--out docs/前端走查.json]
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:8899/');
const OUTJSON = path.join(ROOT, arg('out', 'docs/前端走查.json'));
const SHOTDIR = path.join(ROOT, 'docs/前端截图');
const { shelfShield, pickCardExpr, shieldOnly } = require('./preflight');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPassword() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8'));
    return cfg.app_password || cfg.password || '';
  } catch (e) { return ''; }
}

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', '--remote-debugging-port=9333', '--window-size=390,844',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch('http://127.0.0.1:9333/json/list')).json(); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('chrome 起不来'); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  const consoleErrors = []; const exceptions = []; const netFails = []; const apiCalls = {};
  /* 预期的失败：封面工具会给「没有封面的书」探一次 404，界面自己会画成「还没有封面」。
     它不是故障（真故障是控制台报错/页面异常），但也不能装作没看见 —— 单独记一份。 */
  const expectedFails = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      consoleErrors.push({ level: m.params.type, text: (m.params.args || []).map((a) => a.value || a.description || a.type).join(' ').slice(0, 400) });
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      exceptions.push({ text: (d.exception && (d.exception.description || d.exception.value)) || d.text, url: d.url, line: d.lineNumber });
    } else if (m.method === 'Network.responseReceived') {
      const r = m.params.response; const u = r.url.replace(BASE.replace(/\/$/, ''), '');
      if (u.startsWith('/api') || u.startsWith('/nb/api')) {
        const key = r.url.replace(BASE.replace(/\/$/, ''), '').split('?')[0] + ' [' + m.params.type + ']';
        apiCalls[key] = (apiCalls[key] || 0) + 1;
        const u = r.url.replace(BASE.replace(/\/$/, ''), '').slice(0, 220);
        if (r.status >= 400) {
          const row = { status: r.status, url: u };
          if (r.status === 404 && u.indexOf('/projects/cover') >= 0) expectedFails.push(row);
          else netFails.push(row);
        }
      }
    } else if (m.method === 'Network.loadingFailed' && !m.params.canceled) {
      if (String(m.params.errorText).indexOf('ERR_ABORTED') < 0) netFails.push({ status: 0, url: (m.params.requestId || '') + ' :: ' + m.params.errorText });
    }
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const js = async (expr, wait) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    if (wait) await sleep(wait);
    return r.result && r.result.result ? r.result.result.value : null;
  };
  /* 截图统一走 shotkit：md5 去重（该换屏却一模一样 = 这一步没点动）、文件名带轮次前缀。
     老前端这轮叫 r9-，历史图留在目录里也能被认出来（跨轮次重复同样判问题）。 */
  const kit = require('./shotkit')({ send, dir: SHOTDIR, round: 'r10' });
  const shot = async (name) => {
    const r = await kit.shoot(name);
    return !!r.md5;
  };
  const log = [];
  const step = async (name, expr, wait) => {
    const before = netFails.length;
    const r = expr ? await js(expr, wait === undefined ? 1200 : wait) : null;
    const shotOk = await shot(name);
    log.push({ step: name, js: expr || '', result: r, newFails: netFails.slice(before), shot: shotOk });
    console.log('  ·', name, r && r.__err ? ('JS错误: ' + r.__err) : '', netFails.length > before ? ('网络失败 x' + (netFails.length - before)) : '');
    return r;
  };

  await send('Page.navigate', { url: BASE + '?e2e=' + Date.now() });
  await sleep(5000);

  // 登录（如果页面停在登录页）
  const needLogin = await js("!document.getElementById('login').classList.contains('hidden')");
  if (needLogin) {
    const pw = readPassword();
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(pw) + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4000);
    log.push({ step: '登录', result: await js("document.getElementById('login').classList.contains('hidden') ? 'ok' : 'failed'") });
    console.log('  · 登录', log[log.length - 1].result);
  }
  await shot('01-书架');

  // 开跑前先看书架（第 9 遍打磨）：并发跑别的脚本会往架上塞自测书，
  // 走查取"第一张卡"就会点到那本去 —— 那之后所有红都是假红。
  await shieldOnly('e2e.js', BASE);

  // 五个页签
  for (const [tab, nm] of [['shelf', '书架'], ['preset', '预设'], ['lore', '设定'], ['chat', '对话'], ['tools', '工具']]) {
    await step('tab-' + nm, "document.querySelector('#tabbar [data-tab=\"" + tab + "\"]').click(); 1", 1600);
  }

  // 12 件工具
  const tools = await js("Array.from(document.querySelectorAll('#tools-body [data-id]')).map(e=>e.getAttribute('data-id'))");
  console.log('  工具卡片：', JSON.stringify(tools));
  for (const t of (tools || [])) {
    await step('tool-' + t, "(()=>{const e=document.querySelector('#tools-body [data-id=\"" + t + "\"]');if(!e)return 'missing';e.click();return 1})()", 2600);
    await step('tool-' + t + '-back', "(()=>{const b=document.querySelector('#screen-tool [data-act=\"tool-back\"]');if(b){b.click();return 1}const t2=document.querySelector('#tabbar [data-tab=\"tools\"]');t2&&t2.click();return 2})()", 900);
  }

  // 阅读器：点第一本书
  await js("document.querySelector('#tabbar [data-tab=\"shelf\"]').click()", 800);
  await step('reader-open', pickCardExpr('#shelf-list .shelf-card, #shelf-list [data-slug], #shelf-list .book'), 3000);
  for (const [act, nm] of [['open-toc', '目录'], ['reader-menu', '菜单']]) {
    await step('reader-' + nm, "(()=>{const b=document.querySelector('[data-act=\"" + act + "\"]');if(!b)return 'no-btn';b.click();return 1})()", 1500);
    await step('reader-' + nm + '-close', "(()=>{const x=document.querySelector('#sheet-panel [data-close], #modal-panel [data-close], #sheet .sheet-mask');if(x){x.click();return 'x'}App.closeSheet&&App.closeSheet();return 'closed'})()", 700);
  }

  const report = { url: BASE, at: new Date().toISOString(), consoleErrors, exceptions, netFails,
    expectedFails, apiCalls, steps: log };
  fs.writeFileSync(OUTJSON, JSON.stringify(report, null, 2));
  console.log('\n控制台报错', consoleErrors.length, '条；页面异常', exceptions.length, '条；失败请求', netFails.length, '条');
  if (expectedFails.length) console.log('（另有 ' + expectedFails.length + ' 条预期的 404：书还没有封面，界面会画成「还没有封面」）');
  consoleErrors.slice(0, 20).forEach((e) => console.log('  [console]', e.text.slice(0, 200)));
  exceptions.slice(0, 20).forEach((e) => console.log('  [exception]', String(e.text).slice(0, 200)));
  netFails.slice(0, 30).forEach((e) => console.log('  [net]', e.status, e.url));
  console.log('API 命中：', Object.keys(apiCalls).length, '个端点');
  console.log('报告：', OUTJSON);
  ws.close(); chrome.kill(); process.exit(0);
})();
