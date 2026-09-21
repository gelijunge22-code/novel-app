/* ============================================================
   e2e-sweep.js — 全站 390×844 扫一遍，专门挑"能用但难受"的毛病：
     * 每个工具面板有没有返回入口（×/←）
     * 有没有横向溢出（390 宽下最容易被忽略）
     * 有没有**文字被挤扁**（scrollWidth > clientWidth 且没有省略号 → 断在半句上）
     * 深浅两套主题下有没有"看不见的字"（前景色 = 背景色）
     * 选项组换行是否失衡（7 个主题挤成 3 行、第三行孤零零一个 = 用户最反感的"拥挤/失衡"）
     * 面板进去之后是不是空的（进了但没内容 = 等于没进）
   用法：node tools/e2e-sweep.js
   产出：docs/全站走查-390.json

   第 11 轮修的两个坑（都曾让报告自欺欺人）：
   ① 要选书的 30 个面板全被记成"没进面板" —— 现在照 e2e-new.js 的写法处理**选书页哨兵**
      （选书列表是异步渲染的，早一步点就落空；用书名当哨兵，确认离了选书页再量）。
   ② 只量了"横向溢出"，量不出"7 个胶囊挤成 3 行、最后一个孤零零靠右"这类失衡。
      现在把每一组选项按钮的行数、每行宽度都量出来，行数 > 2 或行宽差 ≥ 30px 就算问题。
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:8899/');
const OUT = path.join(ROOT, 'docs/全站走查-390.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}

const { MEASURE, judgePanel } = require('./sweep_guard.js');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=9337', '--window-size=390,844',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch('http://127.0.0.1:9337/json/list')).json(); if (targets && targets.length) break; } catch (e) {}
  }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map(); const pageErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = (m.params || {}).exceptionDetails || {};
      pageErrors.push(String((d.exception && d.exception.description) || d.text || '').slice(0, 140));
    }
  };
  const send = (m, p) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : null;
  };

  await send('Page.navigate', { url: BASE + '?sweep=' + Date.now() });
  await sleep(5000);
  if (await js("!document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
      ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4500);
  }

  /* 挑一本最"像真书"的当靶子：优先非测试书（测试书随时会被脚本删掉，会假红） */
  const books = JSON.parse(await js(`(async () => {
    try { const r = await fetch('api/projects'); const d = await r.json(); return JSON.stringify((d.projects||[]).map(p=>({slug:p.projectRoot,title:p.title})));
    } catch (e) { return '[]'; } })()`) || '[]');
  if (!books.length) { console.error('  书架上没有书 —— 走查要在真书上跑，先建一本再走查'); process.exit(2); }
  const isTest = (t) => /E2E|实测|测试|临时|走查|自动/.test(t || '');
  const TARGET = books.find((b) => !isTest(b.title)) || books[0];
  console.log('  走查用书：' + TARGET.title + '（' + books.length + ' 本可选）');

  const panels = [];
  const problems = [];
  const record = (name, m, theme) => {
    panels.push({ name, theme, ...(m || {}) });
    judgePanel(name, m).forEach((x) => problems.push({ name, theme, ...x }));
  };

  /* 先真的进一次「工具」，宫格是 onShow 时才渲染的 —— 不先 show 就查，拿到 0 个卡片
     还会"报全绿"（踩过的坑：脚本查了个空集合，等于什么都没验）。 */
  await js("App.show('tools'); 1"); await sleep(1200);
  const ids = await js("JSON.stringify(Array.from(document.querySelectorAll('#tools-body .tool-card[data-id]')).map((e)=>e.getAttribute('data-id')))");
  const list = JSON.parse(ids || '[]');
  console.log('  工具数：' + list.length);
  if (!list.length) { console.error('  工具卡片为 0 —— 选择器或渲染坏了，这次走查不算数'); process.exit(2); }

  /* 进面板（要选书的先进选书页，用书名当哨兵确认真的离开了选书页） */
  const openTool = async (tid) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await js("App.show('tools'); 1"); await sleep(700);
      const inPicker = await js("(() => { const b = document.getElementById('tool-body'); return !!(b && b.querySelector('[data-slug]')); })()");
      if (inPicker) {
        await js(`(() => { const r = [...document.querySelectorAll('#tool-body [data-slug]')].find(x => x.dataset.slug === ${JSON.stringify(TARGET.slug)}) || document.querySelector('#tool-body [data-slug]'); if (r) r.click(); return 1; })()`);
        await sleep(2200);
      } else {
        await js(`(() => { const c = document.querySelector('#tools-body .tool-card[data-id=${JSON.stringify(tid)}]'); if (c) c.click(); return 1; })()`);
        await sleep(1600);
        const nowPicker = await js("(() => { const b = document.getElementById('tool-body'); return !!(b && b.querySelector('[data-slug]')); })()");
        if (nowPicker) {
          await js(`(() => { const r = [...document.querySelectorAll('#tool-body [data-slug]')].find(x => x.dataset.slug === ${JSON.stringify(TARGET.slug)}) || document.querySelector('#tool-body [data-slug]'); if (r) r.click(); return 1; })()`);
          await sleep(2200);
        }
      }
      const still = await js("(() => { const b = document.getElementById('tool-body'); return !!(b && b.querySelector('[data-slug]')); })()");
      const scr = await js("(() => { const s = document.querySelector('.screen:not(.hidden)'); return s ? s.id : ''; })()");
      if (!still && scr === 'screen-tool') return true;
    }
    return false;
  };

  for (const theme of ['paper', 'night']) {
    await js("Prefs.set('theme','" + theme + "'); 1"); await sleep(400);
    for (const tid of list) {
      const ok = await openTool(tid);
      const raw = await js(MEASURE);
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = { __err: String(raw).slice(0, 120) }; }
      record(tid, parsed, theme);
      if (theme === 'paper') console.log('  · ' + tid + '  ' + (parsed.screen || '') + ' 溢出 ' + (parsed.overflowX || 0) +
        ' 字 ' + (parsed.len || 0) + (ok ? '' : ' [没进去]'));
    }
    /* 主界面也扫一遍（主题网格就在这里） */
    for (const s of ['shelf', 'settings', 'tools', 'lore', 'preset', 'chat']) {
      await js("App.show('" + s + "'); 1"); await sleep(900);
      const m = await js(MEASURE);
      let parsed = null;
      try { parsed = JSON.parse(m); } catch (e) { parsed = { __err: String(m).slice(0, 120) }; }
      record('主界面:' + s, parsed, theme);
    }
  }
  await js("Prefs.set('theme','paper'); 1");

  /* 报告里要留**逐面板的原始测量**，不然事后没法核（"报告能定位到行"）：
     以前只写 panels: 62 这个数字，谁也没法复查那 62 条到底进没进面板。 */
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), target: TARGET,
    panels: panels.length, rows: panels, pageErrors, problems,
    counts: problems.reduce((a, p) => { a[p.kind] = (a[p.kind] || 0) + 1; return a; }, {}) }, null, 1));
  console.log('\n=== 扫了 ' + panels.length + ' 个面板（深浅两套主题）：问题 ' + problems.length + ' 条，页面异常 ' + pageErrors.length + ' 条 ===');
  const byKind = {};
  problems.forEach((p) => { byKind[p.kind] = (byKind[p.kind] || 0) + 1; });
  Object.keys(byKind).forEach((k) => console.log('  ' + k + ' × ' + byKind[k]));
  problems.slice(0, 15).forEach((p) => console.log('   - [' + p.theme + '] ' + p.name + '：' + p.kind + ' ' + (p.detail || '')));
  console.log('报告：docs/全站走查-390.json');
})();
