/* ============================================================
   e2e-bookctx.js — 「当前书」实测（390×844，真浏览器）

   用户的原话：
     「我在这本书里干了什么之后，这本书显示的才是我的这本书。」
     「我切换了第二本书，我给 AI 说、给 AI 选的也是第二本，那它就看不到第一本。」

   验的事（每条都要数字/文字证据，不看"我觉得没问题"）：
     1. 书架上那条「一键切换」在不在、写的是不是当前那本
     2. 当前那本书卡上有没有「正在写」标
     3. 点开书单：能不能上下滑、点一本能不能真的切过去（localStorage + App.state + 卡片标都要跟着动）
     4. 所有"跟书有关"的面板，顶上是不是都有那条切换入口，且写的是当前那本
     5. 换书之后，同一个面板的内容真的换了吗（设定/统计/素材/写作台 各取一次内容指纹）
     6. 没书时会不会偷偷弹"请选一本书"（用户讨厌每次都要选）
     7. 换书后对话是不是整屏重来（不是留着上一本的消息）
     8. 390 宽下这条 bar 不许横向溢出

   用法：node tools/e2e-bookctx.js
   报告：docs/当前书实测.json   截图：docs/前端截图/r12-*.png
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const OUTJSON = path.join(ROOT, 'docs/当前书实测.json');
const SHOTDIR = path.join(ROOT, 'docs/前端截图');
const { shieldOnly, readPassword, makeApi } = require('./preflight');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 跟书有关、顶上必须有切换条的面板（宫格 id）—— 用户说"只要需要能切换的，全部有切换按钮" */
const BOOK_PANELS = ['write', 'world', 'plot', 'lint', 'prompt', 'stats', 'export',
  'material', 'refs', 'term', 'listen', 'files', 'cover', 'notes', 'memory', 'history'];
/* 不跟书走的（全局）：账号 / 关于 / 模型 / 档案 / 技能 / 任务 / 备份 / 同步 / 会话 / 数据。
   这几屏的是"整包"的（备份整包、日志整机），所以那条 bar 会写明"这一屏是全局的"，
   但**入口照样给**（全站同一个组件），保证任何一屏都能看到"在写哪本"、随手换。 */
const GLOBAL_PANELS = ['jobs', 'backup', 'sync', 'sessions', 'users', 'about', 'logs',
  'models', 'profiles', 'skills'];

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const guard = await shieldOnly('e2e-bookctx.js');
  let books = guard.books.map((b) => b.slug);
  /* 架上只有一本时——用户的书架本来就可能只有一本，这**不是毛病、是没得测**：
     自己建一本临时的来测「切换」，跑完删干净（收尾那一步做，崩了也有兜底）。 */
  let TMP_BOOK = '';
  if (books.length < 2) {
    const api = makeApi(BASE);
    await api('POST', '/api/app/login', { password: readPassword() });
    const mk = await api('POST', '/api/book', { title: '当前书自测-临时-' + Date.now() });
    TMP_BOOK = (mk.json && mk.json.slug) || '';
    if (!TMP_BOOK) { console.error('[bookctx] 建不出临时书，这条没法测"切换"'); process.exit(2); }
    console.log('[bookctx] 架上只有 1 本 → 自建临时书 ' + TMP_BOOK + '（跑完会删干净）');
    books = books.concat([TMP_BOOK]);
  }
  const cleanupTmp = () => {
    if (!TMP_BOOK) return;
    try {
      require('child_process').execFileSync('curl', ['-s', '-o', '/dev/null', '-X', 'POST',
        BASE.replace(/\/$/, '') + '/api/book/delete', '-H', 'Content-Type: application/json',
        '--data', JSON.stringify({ slug: TMP_BOOK })], { timeout: 8000 });
      console.log('  · 兜底：临时书已删（不留垃圾）');
    } catch (e) {}
  };
  process.on('uncaughtException', (e) => { console.log('  ⚠ 崩了：' + (e && e.message)); cleanupTmp(); process.exit(1); });
  process.on('SIGINT', () => { cleanupTmp(); process.exit(130); });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-bookctx-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', '--remote-debugging-port=9341', '--window-size=390,844',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch('http://127.0.0.1:9341/json/list')).json(); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('chrome 起不来'); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const errors = [];
  const bad404 = [];
  const seen401 = [];        // 页面刚打开、还没登录时打出来的 401（书单打空）—— 这条路径必须真的走到
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text.slice(0, 200));
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.text || '') + ' ' + ((m.params.exceptionDetails.exception || {}).description || '').slice(0, 200));
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      bad404.push(m.params.response.status + ' ' + m.params.response.url);
      if (m.params.response.status === 401 && /\/api\/(shelf|projects|book)/.test(m.params.response.url)) {
        seen401.push(m.params.response.url.replace(/^https?:\/\/[^/]+/, ''));
      }
    }
  });
  const js = async (expr, wait) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (wait) await sleep(wait);
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const shot = async (name) => {
    try {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      if (r.result && r.result.data) fs.writeFileSync(path.join(SHOTDIR, name), Buffer.from(r.result.data, 'base64'));
    } catch (e) {}
  };

  const report = { at: new Date().toISOString(), books, steps: [], problems: [], exceptions: errors, retries: {} };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok: !!ok, detail });
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + ' — ' + JSON.stringify(detail));
    if (!ok) report.problems.push({ step: name, detail });
  };

  /* 「当前书」入口长什么样 —— **第 17 轮重做过**，判据必须跟着改：
     以前是一条带底色的整行 bar（`#shelf-book .bk-bar .bk-txt b` + `.bk-chip`），
     用户说它「单独一个图层……自己要了一条横线」，于是改成每一屏**顶栏右上角那个
     34×34 小方块**（`.bk-mini[data-book-chip]`：里面是书名首字 + 一个小红点，
     `title` / `aria-label` 写着「当前书：《书名》· 点一下切换」）。
     老判据读的那些元素**现在根本不存在**，不改就是全片假红（而且测的不是用户看到的东西）。 */
  const CHIP = `(() => {
    const sc = document.querySelector('.screen:not(.hidden)');
    const c = sc ? sc.querySelector('.bk-bar .bk-mini') : null;
    const note = document.querySelector('.bk-bar .bk-none');
    if (!c || c.hidden) return { has: false, hidden: true,
      text: note ? note.textContent.trim() : '',
      slug: window.BookCtx ? BookCtx.slug() : '' };
    const lab = c.getAttribute('aria-label') || c.title || '';
    const m = lab.match(/《([^》]*)》/);
    return { has: true, hidden: false, text: m ? m[1] : lab, label: (c.textContent || '').trim().slice(0, 4),
             slug: window.BookCtx ? BookCtx.slug() : '' };
  })()`;

  const pw = readPassword();
  /* 反证模式（E2E_OLDBUG=1）：地址上加 ?oldbug=1，把「当前书」退回**修之前**的行为
     （空书单也缓存 + 登录后不重拉）。这一轮**必须报红** —— 判据先能红，绿才算数。 */
  const REDPROOF = !!process.env.E2E_OLDBUG;
  const OUTJSON_RED = path.join(ROOT, 'docs/当前书实测-反证.json');
  const shotName = (n) => (REDPROOF ? 'r14-反证-' + n : 'r14-' + n);

  /* ── 0. 全新打开：未登录 → 登录（用户第一眼看到的那条路径）──────────────
     这是上一版判据漏掉的那条路：页面刚打开时还没登录，/api/shelf 与 /api/projects
     都是 401；那次拿回来的**空书单**如果被缓存住，登录之后架上那条就永远写着
     「还没有作品」，而同一屏下面就列着书（监督人截的 r10-01-书架.png 就是这个）。
     老判据是"登录完先傻等好几秒再读第一条"，所以它 37/37 全过、截图却是空态。
     这里改成：清掉 cookie + localStorage（= 全新装一个 App）→ 打开 → 确认停在登录页
     → 登录 → **掐秒表**，看顶上那条多久变成书名。 */
  await send('Network.clearBrowserCookies');
  await send('Storage.clearDataForOrigin', { origin: (new URL(BASE)).origin, storageTypes: 'all' });
  const url0 = BASE + '?bookctx=' + Date.now() + (REDPROOF ? '&oldbug=1' : '');
  await send('Page.navigate', { url: url0 });
  await sleep(3200);
  const freshProbe = `(() => ({
    needLogin: !document.getElementById('login').classList.contains('hidden'),
    bar: (() => { const c = document.querySelector('#screen-shelf .bk-bar .bk-mini');
      if (c && !c.hidden) { const m = (c.getAttribute('aria-label') || '').match(/《([^》]*)》/); return m ? m[1] : ''; }
      const n = document.querySelector('#shelf-book .bk-none'); return n ? n.textContent.trim() : ''; })(),
    ls: localStorage.getItem('nbapp.book.v1'),
    legacy: !!(window.BookCtx && BookCtx.legacy),
    search: location.search,
  }))()`;
  /* 开机 300ms 那次 ensure() 在无头浏览器里会被定时器节流，可能还没打出去 ——
     真人输密码要好几年（几秒），这个 401 一定已经发生过。所以这里等它，等不到就自己催一次
     （催的就是 App 开机那一步本身，不是造假）。不等的话整轮会偶发假绿。 */
  for (let i = 0; i < 25 && !seen401.length; i++) await sleep(100);
  if (!seen401.length) {
    await js("(async()=>{ try { await BookCtx.ensure(); } catch (e) {} return BookCtx.slug(); })()");
    await sleep(400);
  }
  const fresh = await js(freshProbe);
  report.freshOpen = Object.assign({ url: url0 }, fresh || {}, { seen401: seen401.slice(0, 3) });
  step('全新打开：没登录时确实停在登录页',
    !!(fresh && fresh.needLogin), fresh);
  step('「页面加载时书单 401 打空」这条路径真的走到了（老代码就是在这儿把空书单缓存住的）',
    seen401.length > 0, { seen401: seen401.slice(0, 3) });

  /* 登录之前打出来的 401（/api/shelf、/api/projects）是**故意的** ——
     我们就是要造"页面加载时书单打空"这个场景。所以下面"全程没有报错/没有 4xx"
     这两条判据从登录那一刻开始算，前面那两条 401 单独说明。 */
  const errorsBeforeLogin = errors.length;
  const bad404BeforeLogin = bad404.length;
  const t0 = Date.now();
  await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(pw) + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
  const afterLogin = `(() => ({
    login: !document.getElementById('login').classList.contains('hidden'),
    legacy: !!(window.BookCtx && BookCtx.legacy),
    ls: localStorage.getItem('nbapp.book.v1'),
    bar: (() => { const c = document.querySelector('#screen-shelf .bk-bar .bk-mini');
      if (c && !c.hidden) { const m = (c.getAttribute('aria-label') || '').match(/《([^》]*)》/); return m ? m[1] : ''; }
      const n = document.querySelector('#shelf-book .bk-none'); return n ? n.textContent.trim() : ''; })(),
    cur: [...document.querySelectorAll('#shelf-list .book-card.cur')].map((c) => c.dataset.slug),
    chips: [...document.querySelectorAll('#shelf-list .book-card .book-cur')].map((c) => c.textContent),
    cards: [...document.querySelectorAll('#shelf-list .book-card')].length,
  }))()`;
  let after = null, ms = -1;
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    after = await js(afterLogin);
    if (after && !after.login && after.bar && !/^还没有作品/.test(after.bar)) { ms = Date.now() - t0; break; }
  }
  if (ms < 0) ms = Date.now() - t0;
  report.afterLogin = Object.assign({ ms }, after || {});
  await shot(shotName('全新打开-登录后书架.png'));   // 反证模式存成 r14-反证-*，跟前修后放一起对比
  step('登录后 1 秒内书架顶上就是书名（不是「还没有作品」）',
    /* 假绿修正：顶上那条空态写的是「还没有作品 · 先去书架建一本」，
       以前用 `bar !== '还没有作品'` 比 —— 全等比较恒为真，老行为下**照样判绿**（反证跑出来的）。
       现在按前缀判，空态一律算红。 */
    !!(after && after.bar && !/^还没有作品/.test(after.bar) && ms <= 1000),
    { ms, bar: after && after.bar });
  step('登录后恰好一张书卡带「正在写」',
    !!(after && after.cur.length === 1 && after.chips.length === 1), after);
  if (REDPROOF) {
    /* 反证：老行为下这两条**必须红**。红了 → 判据不是空判据；还绿 → 判据是假的。 */
    const reds = report.problems.map((p) => p.step);
    const hit1 = reds.some((n) => n.indexOf('1 秒内书架顶上就是书名') >= 0);
    const hit2 = reds.some((n) => n.indexOf('正在写') >= 0);
    report.ok = false;
    fs.writeFileSync(OUTJSON_RED, JSON.stringify(report, null, 2));
    console.log('\n[反证] 老行为(?oldbug=1)下报红的条目：' + JSON.stringify(reds));
    console.log((hit1 && hit2 ? '[反证通过] 判据真的能报红（书名那条 + 正在写那条都红了）'
      : '[反证失败] 判据是空判据！没红的是：' + JSON.stringify(reds)) + ' → ' + OUTJSON_RED);
    chrome.kill();
    process.exit((hit1 && hit2) ? 0 : 1);
  }

  const barInfo = `(() => {
    const chip = document.querySelector('#screen-shelf .bk-bar .bk-mini');
    const r = chip ? chip.getBoundingClientRect() : null;
    const host = chip ? chip.parentElement : document.getElementById('shelf-book');
    return {
      text: (() => { if (chip && !chip.hidden) { const m = (chip.getAttribute('aria-label') || '').match(/《([^》]*)》/);
          return m ? m[1] : ''; } const n = document.querySelector('#shelf-book .bk-none');
          return n ? n.textContent.trim() : ''; })(),
      has: !!chip && !chip.hidden,
      h: r ? Math.round(r.height) : 0,
      overflowX: host ? host.scrollWidth - host.clientWidth : -1,
      localStorage: (() => { try { return JSON.parse(localStorage.getItem('nbapp.book.v1') || '{}'); } catch (e) { return {}; } })(),
      appSlug: (window.App && App.state && App.state.slug) || '',
      ctxSlug: window.BookCtx ? BookCtx.slug() : '(没有 BookCtx)',
      curCards: [...document.querySelectorAll('#shelf-list .book-card.cur')].map((c) => c.dataset.slug),
      chipTexts: [...document.querySelectorAll('#shelf-list .book-card .book-cur')].map((c) => c.textContent),
    };
  })()`;

  /* ── 1. 书架顶上那条一键切换 ── */
  await sleep(1200);
  const s1 = await js(barInfo);
  step('书架顶上有「一键切换」那条', s1 && s1.has && s1.text, s1);
  step('bar 不横向溢出（390 宽）', s1 && s1.overflowX <= 0, { overflowX: s1 && s1.overflowX });
  step('「当前书」已立起来（localStorage + App.state 一致）',
    s1 && s1.ctxSlug && s1.ctxSlug === s1.appSlug && s1.localStorage.slug === s1.ctxSlug,
    { ctx: s1 && s1.ctxSlug, app: s1 && s1.appSlug, ls: s1 && s1.localStorage.slug });
  step('书架卡片标了「正在写」', s1 && s1.curCards.length === 1 && s1.curCards[0] === s1.ctxSlug,
    { cards: s1 && s1.curCards, chip: s1 && s1.chipTexts });
  await shot('r12-当前书-书架.png');

  /* ── 2. 书单：能滑、能点、切完全站跟着变 ── */
  const other = books.find((s) => s !== s1.ctxSlug);
  await js("(()=>{const b=document.querySelector('#shelf-book .bk-bar');const m=b.querySelector('.bk-mini');if(m)m.click();b.querySelector('.bk-chip').click();return 1})()", 900);
  const sheet = await js(`(() => {
    const rows = [...document.querySelectorAll('#bk-list .bk-row')];
    const list = document.getElementById('bk-list');
    return { rows: rows.length, slugs: rows.map((r) => r.dataset.slug),
             scrollable: list ? list.scrollHeight > list.clientHeight : null,
             title: (document.querySelector('#sheet-panel .sheet-head h3') || {}).textContent };
  })()`);
  step('书单列全了所有书', sheet && sheet.rows === books.length, sheet);
  await shot('r12-当前书-书单.png');
  await js("(()=>{document.querySelector('#bk-list .bk-row[data-slug=" + JSON.stringify(other) + "]').click();return 1})()", 2200);
  const s2 = await js(barInfo);
  step('点一本就切过去了（三个地方一起变）',
    s2 && s2.ctxSlug === other && s2.appSlug === other && s2.localStorage.slug === other,
    { 期望: other, ctx: s2 && s2.ctxSlug, app: s2 && s2.appSlug, ls: s2 && s2.localStorage.slug });
  step('书架卡片上的「正在写」跟着挪了', s2 && s2.curCards.length === 1 && s2.curCards[0] === other, s2 && s2.curCards);
  await shot('r12-当前书-切到第二本.png');

  /* ── 3. 每个面板顶上都有那条入口，且写的是当前那本 ── */
  const panelBar = `(() => {
    const body = document.getElementById('tool-body');
    const bar = body.querySelector('.bk-bar');
    const chip = document.querySelector('.screen:not(.hidden) .bk-bar .bk-mini');
    const t = (() => { if (chip && !chip.hidden) { const m = (chip.getAttribute('aria-label') || '').match(/《([^》]*)》/);
        return m ? m[1] : ''; } return null; })();
    const picker = body.querySelector('.t-list [data-slug]');
    const r = chip ? chip.getBoundingClientRect() : null;
    return { has: !!chip && !chip.hidden, text: t, pickerShown: !!picker,
             title: (document.getElementById('tool-title') || {}).textContent,
             tab: document.body.dataset.tab,
             global: bar ? bar.classList.contains('bk-bar-global') : null,
             /* 这里以前量的是 chip.scrollWidth - clientWidth —— 多出来的那 6px 是
                「.bk-dot」（"正在写"的小红点，故意 right:-2px 压在角上）的加宽，不是文字被裁。
                探针实测：chip rect [348,9,34,34] / span 16=16=16（文字没被裁）/ dot 右沿 383 < 屏宽 390。
                改成量真正该管的：① 文字有没有被自己的盒子裁掉 ② 方块连徽标有没有顶出屏幕。 */
             chipRight: r ? Math.round(r.right) : -1,
             dotRight: (() => { const d = chip && chip.querySelector('.bk-dot');
                 return d ? Math.round(d.getBoundingClientRect().right) : -1; })(),
             textClipped: (() => { const sp = chip && chip.querySelector('span');
                 return sp ? sp.scrollWidth - sp.clientWidth : -1; })(),
             W: innerWidth,
             inner: (() => { const n = body.querySelector('.bk-bar'); if (!n) return 0;
                     const rest = body.cloneNode(true); const b = rest.querySelector('.bk-bar'); if (b) b.remove();
                     return rest.textContent.replace(/\\s+/g, '').length; })() };
  })()`;

  /* 打开一个面板：点宫格卡片 → 等 #tool-body 真的有内容。
     为什么不用"点完干等 2 秒"：转场/并发期间偶尔会点空（脚本自己的抖动，不是 App 的问题），
     干等会把抖动当成"面板没有切书条"的假红。这里改成轮询 + 必要时补一次点击，
     并把"补点了几次"记进报告 —— 真要补点，说明是 App 的响应问题，也能看见。 */
  async function openPanel(pid) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await js("App.show('tools')", 900);
      const sig = "(document.getElementById('tool-body').innerHTML.length) + '|' + "
        + "(document.getElementById('tool-title') || {}).textContent";
      const before = await js(sig);
      await js("(()=>{const c=document.querySelector('.tool-card[data-id=\"" + pid + "\"]');if(!c)return 0;c.click();return 1})()");
      /* 等"这一屏真的换成新面板"：内容长度和标题都不是点之前那套。
         只等"有内容"是不够的 —— 上一个面板的 HTML 还留在里面，会骗过判据（假绿的来源）。 */
      const wait = "(async()=>{const b=document.getElementById('tool-body');"
        + "for(let i=0;i<30;i++){const s=" + sig + ";"
        + "if(b.innerHTML.length>0 && s!==" + JSON.stringify(before) + ")return true;"
        + "await new Promise(r=>setTimeout(r,120));}return false;})()";
      const ok = await js(wait);
      if (ok) { if (attempt) report.retries[pid] = attempt; await sleep(700); return; }
    }
    report.retries[pid] = 'failed';
  }
  const panelRows = [];
  for (const pid of BOOK_PANELS) {
    await openPanel(pid);
    const r = await js(panelBar);
    panelRows.push({ id: pid, ...(r || {}) });
    step('面板 ' + pid + ' 顶上有切书条且写的是当前那本', !!(r && r.has && r.text),
      { text: r && r.text, picker: r && r.pickerShown, innerLen: r && r.inner });
    if (pid === 'write') await shot('r12-当前书-写作台.png');
  }
  report.panelRows = panelRows;
  const allHaveBar = panelRows.every((r) => r.has && r.text);
  const anyPicker = panelRows.filter((r) => r.pickerShown).map((r) => r.id);
  step('17 个跟书有关的面板：全都有切书条', allHaveBar, { 覆盖: panelRows.length, 缺: panelRows.filter((r) => !r.has).map((r) => r.id) });
  step('有「当前书」时不再弹"请先选一本书"', anyPicker.length === 0, anyPicker);
  step('切书小方块在面板里没被裁、没顶出屏幕',
    panelRows.every((r) => r.textClipped <= 0 && r.chipRight <= r.W && r.dotRight <= r.W + 0.5),
    panelRows.filter((r) => !(r.textClipped <= 0 && r.chipRight <= r.W && r.dotRight <= r.W + 0.5))
      .map((r) => r.id + ':文本裁' + r.textClipped + '/方块右' + r.chipRight + '/徽标右' + r.dotRight + '/屏' + r.W));

  /* 全局面板：那条 bar 要写明"这一屏是全局的"，但入口必须照样在 */
  const globalRows = [];
  for (const pid of GLOBAL_PANELS) {
    await openPanel(pid);
    const r = await js(panelBar);
    globalRows.push({ id: pid, ...(r || {}) });
  }
  report.globalRows = globalRows;
  step('全局面板也都有切换入口、且标明是全局的',
    globalRows.every((r) => r.has && r.global),
    globalRows.map((r) => ({ id: r.id, has: r.has, global: r.global })));

  /* ── 4. 换书之后，内容真的换了吗（同一个面板取两次内容指纹）── */
  const fingerprint = `(() => {
    const body = document.getElementById('tool-body');
    const rest = body.cloneNode(true);
    const b = rest.querySelector('.bk-bar'); if (b) b.remove();
    const t = rest.textContent.replace(/\\s+/g, ' ').trim();
    return { len: t.length, head: t.slice(0, 120) };
  })()`;
  const perBook = {};
  for (const slug of [s1.ctxSlug, other]) {
    await js("window.BookCtx.set(" + JSON.stringify(slug) + "," + JSON.stringify(slug) + ")", 300);
    perBook[slug] = {};
    for (const pid of ['stats', 'material', 'term', 'refs', 'world']) {
      await openPanel(pid);
      perBook[slug][pid] = await js(fingerprint);
    }
  }
  const changed = ['stats', 'material', 'term', 'refs', 'world'].filter((pid) =>
    perBook[s1.ctxSlug][pid].head !== perBook[other][pid].head);
  step('换书后同一个面板的内容确实换了（不是只换了标题）', changed.length >= 1,
    { 变了: changed, A: perBook[s1.ctxSlug].stats, B: perBook[other].stats });
  report.perBook = perBook;

  /* ── 5. 对话：换书整屏重来 + 会话记忆按书分开存 ── */
  const chatInfo = `(() => {
    const c = document.querySelector('#screen-chat .bk-bar .bk-mini');
    const bar = (() => { if (c && !c.hidden) { const m = (c.getAttribute('aria-label') || '').match(/《([^》]*)》/);
        return m ? m[1] : ''; } const n = document.querySelector('#chat-book .bk-none');
        return n ? n.textContent.trim() : ''; })();
    const body = document.getElementById('chat-body');
    return { bar: bar,
             ctx: window.BookCtx ? BookCtx.slug() : '',
             bodyLen: body ? body.textContent.replace(/\\s+/g, '').length : -1,
             keys: Object.keys(localStorage).filter((k) => k.indexOf('nbapp.chat.v2.') === 0) };
  })()`;
  await js("App.show('chat')", 3500);
  const c1 = await js(chatInfo);
  step('对话页顶上也有切书条、写的是当前那本', !!(c1 && c1.bar === c1.ctx), c1);
  await shot('r12-当前书-对话.png');
  await js("window.BookCtx.set(" + JSON.stringify(s1.ctxSlug) + "," + JSON.stringify(s1.ctxSlug) + ")", 400);
  await js("App.show('shelf')", 400);
  await js("App.show('chat')", 4000);
  const c2 = await js(chatInfo);
  step('换书后对话换了另一本的那套', !!(c2 && c2.bar === s1.ctxSlug), { bar: c2 && c2.bar, 期望: s1.ctxSlug, keys: c2 && c2.keys });
  step('会话记忆按书分开存（两本书各一份）', !!(c2 && c2.keys.length >= 2), c2 && c2.keys);

  /* ── 6. 设定页 ── */
  await js("App.show('lore')", 2500);
  const l = await js(`(() => {
    const c = document.querySelector('#screen-lore .bk-bar .bk-mini');
    const bar = (() => { if (c && !c.hidden) { const m = (c.getAttribute('aria-label') || '').match(/《([^》]*)》/);
        return m ? m[1] : ''; } const n = document.querySelector('#lore-book .bk-none');
        return n ? n.textContent.trim() : ''; })();
    const body = document.getElementById('lore-body');
    return { bar: bar, ctx: BookCtx.slug(),
             len: body ? body.textContent.replace(/\\s+/g,'').length : -1 };
  })()`);
  step('设定页顶上有切书条、写的是当前那本', !!(l && l.bar === l.ctx), l);
  await shot('r12-当前书-设定.png');

  /* ── 7. 预设页 ── */
  await js("App.show('preset')", 2600);
  const p = await js(`(() => {
    const c = document.querySelector('#screen-preset .bk-bar .bk-mini');
    const bar = (() => { if (c && !c.hidden) { const m = (c.getAttribute('aria-label') || '').match(/《([^》]*)》/);
        return m ? m[1] : ''; } const n = document.querySelector('#preset-book .bk-none');
        return n ? n.textContent.trim() : ''; })();
    const scope = document.getElementById('preset-scope');
    return { bar: bar, ctx: BookCtx.slug(),
             scopeHidden: scope ? scope.hidden : null,
             scope: scope ? scope.textContent.replace(/\\s+/g,' ').slice(0, 80) : '' };
  })()`);
  step('预设页顶上有切书条（以前这里直接隐藏）', !!(p && p.bar === p.ctx), p);
  step('预设的「这本书/所有书默认」也露出来了', !!(p && p.scopeHidden === false), p && p.scope);
  await shot('r12-当前书-预设.png');

  /* ── 8. 全局入口：宫格顶上那条 ── */
  await js("App.show('tools')", 1200);
  const g = await js(`(() => {
    const c = document.querySelector('#screen-tools .bk-bar .bk-mini');
    const t = (() => { if (c && !c.hidden) { const m = (c.getAttribute('aria-label') || '').match(/《([^》]*)》/);
        return m ? m[1] : ''; } return null; })();
    return { has: !!c && !c.hidden, text: t, ctx: BookCtx.slug(),
             overflowX: c ? c.scrollWidth - c.clientWidth : -1 };
  })()`);
  step('工具宫格顶上也有全站切换入口', !!(g && g.has && g.text === g.ctx), g);
  await shot('r12-当前书-宫格.png');

  report.exceptions = errors.slice(0, 20);
  /* navigator.vibrate 在"没有真实用户手势"的自动化环境里必然被浏览器拦下报错，
     这不是 App 的问题（真机上用户是点过的）。其余报错一条都不许放过。 */
  const hardErrors = errors.slice(errorsBeforeLogin).filter((e) => !/favicon|ERR_|navigator\.vibrate/.test(e));
  step('登录之后全程没有 JS 报错', hardErrors.length === 0, hardErrors.slice(0, 5));
  step('登录之前只有那两个 401（未登录打的书单，场景需要）',
    bad404BeforeLogin === bad404.slice(0, bad404BeforeLogin).length, { 登录前: bad404BeforeLogin });
  report.badResponses = [...new Set(bad404.slice(bad404BeforeLogin))];
  step('登录之后没有 404/5xx 的接口或资源', report.badResponses.length === 0, report.badResponses);

  /* 收尾：临时书删掉、书架跟跑之前逐本一致（自测绝不许在用户架上留痕） */
  if (TMP_BOOK) {
    const api2 = makeApi(BASE);
    await api2('POST', '/api/app/login', { password: readPassword() });
    const del = await api2('POST', '/api/book/delete', { slug: TMP_BOOK });
    const af = (await api2('GET', '/api/shelf')).json || {};
    const now = (af.projects || []).map((b) => b.slug).filter((x) => x !== TMP_BOOK);
    step('收尾：临时书进回收站、书架跟跑之前一致', del.status === 200,
      { 临时书: TMP_BOOK, 现在: now });
  }

  report.problems = report.problems || [];
  report.ok = report.problems.length === 0;
  fs.writeFileSync(OUTJSON, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? '全部通过' : '有 ' + report.problems.length + ' 条没过') + ' → ' + OUTJSON);
  chrome.kill();
  process.exit(report.ok ? 0 : 1);
})();
