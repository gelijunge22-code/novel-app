/* ============================================================
   e2e-back.js — 返回键逐层退（GOAL C6）真浏览器走查。

   App 里返回键的实现是：Java 侧 onBackPressed() → 调网页的 window.AndroidBack()，
   返回 true 表示「网页自己消化了」，false 才轮到 App 退出。
   所以这里在真浏览器里**直接调 window.AndroidBack()**，一层一层验：

     文件浏览器子目录 → 工具详情 → 工具宫格 → 书架 → （最后才 false 放行退出）
     阅读器里的抽屉 / 任何弹窗：先关它，页面本身不动

   用法：node tools/e2e-back.js
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const OUTJSON = path.join(ROOT, 'docs/前端走查-返回键.json');
const { shelfShield, pickCardExpr, shieldOnly } = require('./preflight');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPassword() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8'));
    return cfg.app_password || cfg.password || '';
  } catch (e) { return ''; }
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-back-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', '--remote-debugging-port=9336', '--window-size=390,844',
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
  const consoleErrors = []; const exceptions = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 200));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      exceptions.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 300));
    }
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const js = async (expr, wait) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (wait) await sleep(wait);
    return r.result && r.result.result ? r.result.result.value : null;
  };
  // 返回键这一类**本来就该回到同一屏**：用 expect:'same' 标出来，
  // 于是不会再往目录里塞第二份一模一样的图（上一轮 27 张 returns 图全是一个 md5）。
  const kit = require('./shotkit')({ send, dir: path.join(ROOT, 'docs/前端截图'), round: 'r10' });
  const shot = (name, opts) => kit.shoot(name, opts);

  /* 当前状态：在哪个屏、栈里有几层、抽屉/弹窗开着没、文件浏览器在哪一层 */
  const STATE = "(()=>{const t=document.body.dataset.tab;" +
    "const sh=document.getElementById('sheet'),md=document.getElementById('modal');" +
    "return {tab:t,sheet:!!(sh&&!sh.classList.contains('hidden')),modal:!!(md&&!md.classList.contains('hidden'))," +
    "crumb:(document.querySelector('#tool-body .fb-crumb')||{}).textContent||''," +
    "crumbLevel:document.querySelectorAll('#tool-body .fb-crumb button').length," +
    "toolTitle:(document.getElementById('tool-title')||{}).textContent||''};})()";
  const press = async (name, wait) => {
    const before = await js(STATE);
    const ret = await js('window.AndroidBack()', wait === undefined ? 700 : wait);
    const after = await js(STATE);
    const row = { 按返回前: before, AndroidBack返回值: ret, 按返回后: after };
    console.log('  ·', name, '→', JSON.stringify(after), 'ret=' + ret);
    return row;
  };

  const steps = {};
  await send('Page.navigate', { url: BASE + '?back=' + Date.now() });
  await sleep(5500);
  if (await js("!document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4500);
  }
  await js("document.querySelector('#tabbar [data-tab=\"tools\"]').click()", 1600);

  /* ① 工具详情 → 文件浏览器子目录 */
  await js("(()=>{const e=document.querySelector('#tools-body [data-id=\"files\"]');if(e)e.click();return 1})()", 2200);
  /* 书架上不止一本时会先弹选书页：不处理的话，后面所有"返回"都在选书页上按，整轮假红。
     （实测抓到的：书架上有自测垃圾书时，这套返回键用例整轮失败。） */
  await js("(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));" +
    "for(let k=0;k<3;k++){const p=document.querySelector('#tool-body [data-slug]');" +
    "if(!p)break;p.click();await wait(1500);}return 1})()", 1800);
  const enterDir = await js("(()=>{const rows=Array.from(document.querySelectorAll('#tool-body .t-row'));" +
    "const d=rows.find(r=>{const s=r.querySelector('.tr-sub');return s&&s.textContent.indexOf('文件夹')>=0});" +
    "if(!d)return 'no-dir';d.click();return (d.querySelector('.tr-title')||{}).textContent||'dir'})()", 1500);
  console.log('  · 进入子目录:', enterDir);
  await shot('back-01-文件子目录');
  steps['①文件浏览器子目录'] = await press('子目录 → 上一层目录');

  /* ② 退到根目录后再按，才回宫格 */
  steps['②文件根目录'] = await press('根目录 → 工具宫格');
  await shot('back-02-回到宫格');

  /* ③ 宫格 → 书架 */
  steps['③工具宫格'] = await press('宫格 → 书架');
  await shot('back-03-回到书架');

  /* ④ 书架在最底下 → 返回 false，让 App 走「再按一次退出」 */
  steps['④书架'] = await press('书架（最底层）');

  /* ⑤ 阅读器：抽屉先关、再退回书架 */
  await js(pickCardExpr('#shelf-list .shelf-card, #shelf-list [data-slug], #shelf-list .book'), 3200);
  await shot('back-04-阅读器');
  await js("(()=>{const b=document.querySelector('[data-act=\"open-toc\"]');if(b)b.click();return 1})()", 1400);
  await shot('back-05-阅读器抽屉');
  steps['⑤阅读器里的抽屉'] = await press('抽屉 → 关抽屉（人还在阅读器）');
  steps['⑥阅读器本身'] = await press('阅读器 → 书架');

  /* ⑦ 弹窗：任何一层上有弹窗，先关弹窗，底下那层不动 */
  await js("document.querySelector('#tabbar [data-tab=\"tools\"]').click()", 1400);
  await js("(()=>{const e=document.querySelector('#tools-body [data-id=\"about\"]');if(e)e.click();return 1})()", 2600);
  await js("App.modal('<div class=\"t-dialog\"><h3>测试弹窗</h3><div class=\"t-hint\">只用来验返回键</div></div>')", 900);
  await shot('back-06-弹窗');
  steps['⑦弹窗'] = await press('弹窗 → 关弹窗（人还在工具页）');

  const checks = {
    '子目录退一层目录': steps['①文件浏览器子目录'].按返回后.tab === 'tool' &&
      steps['①文件浏览器子目录'].按返回前.crumbLevel === 2 &&
      steps['①文件浏览器子目录'].按返回后.crumbLevel === 1,
    '根目录退到宫格': steps['②文件根目录'].按返回后.tab === 'tools',
    '宫格退到书架': steps['③工具宫格'].按返回后.tab === 'shelf',
    '书架放行退出': steps['④书架'].AndroidBack返回值 === false,
    '抽屉先关不跳页': steps['⑤阅读器里的抽屉'].按返回前.sheet === true &&
      steps['⑤阅读器里的抽屉'].按返回后.sheet === false &&
      steps['⑤阅读器里的抽屉'].按返回后.tab === 'reader',
    '阅读器退到书架': steps['⑥阅读器本身'].按返回后.tab === 'shelf',
    '弹窗先关不跳页': steps['⑦弹窗'].按返回前.modal === true &&
      steps['⑦弹窗'].按返回后.modal === false &&
      steps['⑦弹窗'].按返回后.tab === 'tool',
  };
  const allOk = Object.values(checks).every(Boolean);
  fs.writeFileSync(OUTJSON, JSON.stringify({
    url: BASE, at: new Date().toISOString(), enterDir, steps, checks,
    consoleErrors, exceptions, verdict: allOk ? '通过：一层一层退' : '有问题',
  }, null, 2));
  console.log('\n判定：', JSON.stringify(checks, null, 1));
  console.log('控制台报错', consoleErrors.length, '条；页面异常', exceptions.length, '条');
  console.log(allOk ? '✅ 返回键逐层退：通过' : '❌ 返回键逐层退：有问题');
  console.log('报告：', OUTJSON);
  chrome.kill();
  process.exit(allOk ? 0 : 1);
})();
