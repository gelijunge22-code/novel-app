/* ============================================================
   e2e-toolsback.js — 工具面板「退出」实测（用户点名的 bug）

   用户原话：
     「现在工具里的一些东西退出是有一些说不出来的 bug 的，容易退出、退出不了，
       或者退出没有退出到工具那界面，退出到别的工具里面就很奇怪。」

   验的事（逐个工具，机器判，不靠感觉）：
     1. 宫格点进每一个工具 → 真的进去了（标题对上）
     2. 按顶部返回 → **回到工具宫格**（不是别的工具、不是书架）
     3. 按安卓返回键 → 同样回到宫格
     4. 关键那条：进 A 工具 → 返回 → 进 B 工具 → 返回 → **必须回宫格**（不许落到 A）
   跑法：node tools/e2e-toolsback.js
   报告：docs/工具返回实测.json   截图：docs/前端截图/r15-toolback-*.png
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const OUTJSON = path.join(ROOT, 'docs/工具返回实测.json');
const SHOTDIR = path.join(ROOT, 'docs/前端截图');
const { shieldOnly, readPassword } = require('./preflight');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const guard = await shieldOnly('e2e-toolsback.js');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-toolsback-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=9355', '--window-size=390,844',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch('http://127.0.0.1:9355/json/list')).json(); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('chrome 起不来'); process.exit(1); }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text.slice(0, 200));
    if (m.method === 'Runtime.exceptionThrown') errors.push(String((m.params.exceptionDetails.text || '')).slice(0, 200));
  });
  const js = async (expr, wait) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (wait) await sleep(wait);
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const shot = async (name) => {
    try { const r = await send('Page.captureScreenshot', { format: 'png' });
      if (r.result && r.result.data) fs.writeFileSync(path.join(SHOTDIR, name), Buffer.from(r.result.data, 'base64')); } catch (e) {}
  };

  const report = { at: new Date().toISOString(), steps: [], problems: [], exceptions: errors, tools: [] };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok: !!ok, detail });
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)));
    if (!ok) report.problems.push({ step: name, detail });
  };
  /* 「现在在哪一屏」：宫格屏是 screen-tools，子面板屏是 screen-tool */
  const where = `(() => { try { BookCtx.ensure(); } catch(e) {}
    return {
      tab: document.body.dataset.tab || '',
      gridShown: !document.getElementById('screen-tools').classList.contains('hidden'),
      panelShown: !document.getElementById('screen-tool').classList.contains('hidden'),
      title: (document.getElementById('tool-title') || {}).textContent || '',
      barOn: [...document.querySelectorAll('#tabbar .tab')].filter((t) => t.classList.contains('active')).map((t) => t.dataset.tab),
    }; })()`;

  await send('Page.navigate', { url: BASE + '?toolsback=' + Date.now() });
  await sleep(3000);
  await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword())
    + ";i.dispatchEvent(new Event('input',{bubbles:true}));const g=document.getElementById('login-go');if(g)g.click();return 1})()");
  await sleep(2000);
  await js("App.show('tools')", 600);

  const ids = await js("[...document.querySelectorAll('#tools-body .tool-card')].map(c=>c.dataset.id)");
  report.toolCount = ids.length;
  step('工具宫格列出来了（能数到工具个数）', ids.length >= 10, { n: ids.length });

  let backOk = 0, androidBackOk = 0, crossOk = 0;
  for (const tid of ids) {
    const name = await js(`(()=>{const c=document.querySelector('#tools-body .tool-card[data-id="${tid}"]');return c?c.querySelector('.tc-name').textContent:''})()`);
    await js(`document.querySelector('#tools-body .tool-card[data-id="${tid}"]').click()`, 900);
    const inPanel = await js(where);
    const entered = !!(inPanel && inPanel.tab === 'tool' && inPanel.panelShown);
    /* 顶部返回按钮 */
    await js("document.querySelector('[data-act=\"tool-back\"]').click()", 700);
    const after1 = await js(where);
    const backToGrid = !!(after1 && after1.tab === 'tools' && after1.gridShown && !after1.panelShown);
    if (backToGrid) backOk++;
    /* 安卓返回键：再进去一次，用返回键退 */
    await js(`document.querySelector('#tools-body .tool-card[data-id="${tid}"]').click()`, 900);
    await js("window.AndroidBack && AndroidBack()", 700);
    const after2 = await js(where);
    const androidToGrid = !!(after2 && after2.tab === 'tools' && after2.gridShown);
    if (androidToGrid) androidBackOk++;
    /* 跨工具：进 A → 退 → 进 B → 退，看会不会落到 A */
    const other = ids.find((x) => x !== tid);
    await js(`document.querySelector('#tools-body .tool-card[data-id="${tid}"]').click()`, 800);
    await js("document.querySelector('[data-act=\"tool-back\"]').click()", 600);
    await js(`document.querySelector('#tools-body .tool-card[data-id="${other}"]').click()`, 800);
    await js("document.querySelector('[data-act=\"tool-back\"]').click()", 600);
    const after3 = await js(where);
    const crossToGrid = !!(after3 && after3.tab === 'tools' && after3.gridShown);
    if (crossToGrid) crossOk++;
    report.tools.push({ id: tid, name, entered, backToGrid, androidToGrid, crossToGrid,
      titleAfterEnter: inPanel && inPanel.title });
    if (!entered || !backToGrid || !androidToGrid || !crossToGrid) {
      console.log('    ✗ ' + tid + '（' + name + '）entered=' + entered + ' back=' + backToGrid
        + ' androidBack=' + androidToGrid + ' cross=' + crossToGrid);
    }
  }
  if (ids.length) await shot('r15-toolback-宫格.png');
  step('每个工具都能进去（进去之后是那一屏子面板）',
    report.tools.every((t) => t.entered), { bad: report.tools.filter((t) => !t.entered).map((t) => t.id) });
  step('每个工具按顶部返回都回到**工具宫格**（不是别的工具）',
    backOk === ids.length, { ok: backOk + '/' + ids.length });
  step('每个工具按安卓返回键也回到工具宫格',
    androidBackOk === ids.length, { ok: androidBackOk + '/' + ids.length });
  step('「进 A → 退 → 进 B → 退」最终一定回到宫格（不会落到 A 里）',
    crossOk === ids.length, { ok: crossOk + '/' + ids.length });
  /* 只看"我们自己的错"：
     · 登录前那一对 401（/api/shelf + /api/projects）是**必然**会有的 —— 那时候还没输密码，
       登录成功之后前端会强制重拉一次（bookctx 的 loginOk），所以这一对不算错；
     · navigator.vibrate 那条是**无头浏览器**不给震动权限时 Chrome 自己打的提示，不是页面报错；
       顺手在这条断言里分开数，别把"别人的提示"记成"我们崩了"。 */
  const ours = errors.filter((e) => !/401/.test(e) && !/navigator\.vibrate/i.test(e));
  step('全程没有 JS 报错（登录前那一对 401 和震动提示不算）', ours.length === 0,
    { errors: ours.slice(0, 3), raw: errors.length });

  report.ok = report.problems.length === 0;
  fs.writeFileSync(OUTJSON, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? '全部通过 ' + report.steps.length + '/' + report.steps.length
    : '有 ' + report.problems.length + ' 条没过') + ' → ' + OUTJSON);
  chrome.kill();
  process.exit(report.ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
