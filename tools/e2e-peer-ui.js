/* ============================================================
   e2e-peer-ui.js —— 「跟服务器对账」这件事在**界面上真的能做**（GOAL C2）。

   为什么要单开一个：引擎级的 `verify_peer_sync.py` 只证明后端之间说得通；
   用户能不能在「同步」面板里点一下就把手机和服务器对上，得在真界面上点一遍。

   布局：临时起一台"服务器"（8898，自己的数据目录），浏览器里打开本机 8899 的同步面板，
        填地址 + 口令 → 点「双向对一次」→ 断言：界面给了人话、书真的拉到本机、再进去能看到上次同步时间。
   用法：node tools/e2e-peer-ui.js        产出：docs/对端同步界面实测.json + 前端截图/r11-peer-*.png
   ============================================================ */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const BASE = 'http://127.0.0.1:8899/';
const PEER_PORT = 8896;
const OUT = path.join(ROOT, 'docs/对端同步界面实测.json');
const SHOTDIR = path.join(ROOT, 'docs/前端截图');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pw = () => JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password;
const rows = [];
const check = (n, ok, why) => {
  rows.push({ name: n, ok: !!ok, why: String(why == null ? '' : why).slice(0, 400) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + n + (ok ? '' : '   —— ' + String(why).slice(0, 220)));
  return !!ok;
};

(async () => {
  /* ── 起一台"服务器"：和 verify_peer_sync 同一套起法（APK 里那份代码 + 自己的数据目录） ── */
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'peerui-seed-'));
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerui-srv-'));
  fs.mkdirSync(path.join(seed, 'empty'), { recursive: true });
  const code = `import sys, json, time;sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'apk/src/main/python'))});`
    + `import main;print('RESULT=' + main.start(${JSON.stringify(sdir)}, ${JSON.stringify(path.join(sdir, 'www'))},`
    + ` ${JSON.stringify(seed)}, ${PEER_PORT}), flush=True);time.sleep(10**7)`;
  const srv = spawn(path.join(ROOT, 'server/venv/bin/python'), ['-c', code],
    { env: { ...process.env, PYTHONUTF8: '1', NOVELAPP_INIT_PASSWORD: pw() }, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  srv.stdout.on('data', (d) => { srvLog += d.toString(); });
  let srvInfo = null;
  for (let i = 0; i < 120; i++) {
    const m = srvLog.match(/RESULT=(\{.*\})/);
    if (m) { srvInfo = JSON.parse(m[1]); break; }
    await sleep(500);
  }
  if (!srvInfo) { console.error('对端起不来：' + srvLog.slice(-600)); process.exit(1); }
  console.log('  「服务器」起来了：127.0.0.1:' + srvInfo.port);

  /* 服务器上先放一本书（2 章正文） */
  const TITLE = '对端界面自测-' + Date.now().toString().slice(-6);
  const login = async (body) => {
    const r = await fetch(`http://127.0.0.1:${PEER_PORT}/api/app/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  };
  const ck = await login({ password: pw() });
  const api = async (p, method = 'GET', body) => {
    const r = await fetch(`http://127.0.0.1:${PEER_PORT}${p}`, { method, headers: { 'content-type': 'application/json', cookie: ck }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const born = await api('/api/projects', 'POST', { title: TITLE, summary: '对端界面自测', kind: 'novel' });
  const SLUG = born.json.projectRoot || born.json.slug;
  await api('/api/import/text', 'POST', { slug: SLUG, name: '第001章-服务器上的稿子', text: '服务器上的正文。\n'.repeat(40) });
  await api('/api/import/text', 'POST', { slug: SLUG, name: '第002章-服务器上的稿子', text: '第二章。\n'.repeat(30) });
  check('① 准备：服务器上有这本书（2 章正文 + 自带的空白章）', born.status === 200, JSON.stringify(born.json).slice(0, 160));

  /* ── 浏览器：打开同步面板，像用户那样填表、点按钮 ── */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'peerui-'));
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=9351', '--window-size=390,844', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) { await sleep(400); try { targets = await (await fetch('http://127.0.0.1:9351/json/list')).json(); if (targets && targets.length) break; } catch (e) {} }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map(); const pageErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = (m.params || {}).exceptionDetails || {};
      pageErrors.push(String((d.exception && d.exception.description) || d.text || '').slice(0, 160));
    }
  };
  const send = (mm, p) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const js = async (expr, wait) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (wait) await sleep(wait);
    if (r.result && r.result.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 200) };
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const shoot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const b = Buffer.from(r.result.data, 'base64');
    fs.writeFileSync(path.join(SHOTDIR, n + '.png'), b);
    return crypto.createHash('md5').update(b).digest('hex');
  };

  await send('Page.navigate', { url: BASE + '?peer=' + Date.now() });
  await sleep(5000);
  if (await js("!document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(pw()) +
      ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4500);
  }
  const opened = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    App.show('tools'); await wait(1000);
    const c = document.querySelector('#tools-body .tool-card[data-id="sync"]'); if (c) c.click();
    await wait(2500);
    const box = document.querySelector('#tool-body [data-peer]');
    return { hasBox: !!box, hasBase: !!document.querySelector('#tool-body [data-peer-base]'),
             hasPass: !!document.querySelector('#tool-body [data-peer-pass]'),
             hasBook: !!document.querySelector('#tool-body [data-peer-book]'),
             hasBoth: !!document.querySelector('#tool-body [data-peer-both]'),
             books: [...document.querySelectorAll('#tool-body [data-peer-book] option')].map((o) => o.textContent),
             tip: (document.querySelector('#tool-body [data-peer-tip]') || {}).textContent || '' };
  })()`);
  check('② 同步面板上真的有「跟服务器对账」这一块（地址/口令/选书/三个按钮）',
    opened && opened.hasBox && opened.hasBase && opened.hasPass && opened.hasBook && opened.hasBoth,
    JSON.stringify(opened));
  const shotBefore = await shoot('r12-peer-01-同步面板');

  /* 空地址点一下 → 要中文人话 */
  const noAddr = await js(`(async () => {
    /* 地址是被记住的（Prefs），这是要的行为 —— 所以这里先手动清空再点 */
    const b = document.querySelector('#tool-body [data-peer-base]');
    b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#tool-body [data-peer-both]').click();
    await new Promise((r) => setTimeout(r, 700));
    return (document.querySelector('#tool-body [data-peer-tip]') || {}).textContent || '';
  })()`);
  check('③ 没填地址就点 → 提示"先把服务器地址填上"（不是静默）', /地址/.test(noAddr || ''), noAddr);

  /* 真填真点 —— 顺序照用户来：先选书 → 再填地址/口令 → 再点。
     这里专门盯住"换过书之后刚打进去的地址/口令还在不在"，那是本轮修掉的真 bug。 */
  const did = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const Q = (s) => document.querySelector('#tool-body ' + s);
    const b = Q('[data-peer-base]');
    b.value = ${JSON.stringify('127.0.0.1:' + PEER_PORT)};
    b.dispatchEvent(new Event('input', { bubbles: true }));
    const p = Q('[data-peer-pass]');
    p.value = ${JSON.stringify(pw())};
    p.dispatchEvent(new Event('input', { bubbles: true }));
    /* 换一次"书"（触发整块重渲染）→ 刚填的东西必须还在 */
    const sel = Q('[data-peer-book]');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(1800);
    const kept = { base: Q('[data-peer-base]').value, pass: Q('[data-peer-pass]').value };
    Q('[data-peer-both]').click();
    await wait(7000);
    return { kept, tip: (Q('[data-peer-tip]') || {}).textContent || '' };
  })()`);
  check('④a 换过书之后，刚填的地址/口令还在（不是被重渲染抹掉）',
    did && did.kept && did.kept.base === '127.0.0.1:' + PEER_PORT && did.kept.pass === pw(),
    JSON.stringify(did && did.kept));
  /* ④ 拿一本"服务器上没有的书"去对账 → 必须给人话，而且**明说服务器上没这本**，
     不许把失败说成成功（老判据把「同步不了」也算过，等于自己骗自己）。 */
  check('④ 服务器上没有的书 → 人话点明"服务器上没有叫…的书"',
    did && /服务器上没有/.test(did.tip || ''), JSON.stringify(did && did.tip));
  const shotAfter = await shoot('r12-peer-02-对账报错也说人话');

  /* ⑤ 新手机第一次用：本地下拉框里当然没有服务器那本书 → 走「＋ 从服务器拉一本新的…」，
     填**书名**（不是书号），真点一遍，看它能不能把书建到本机。 */
  const pulled = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const Q = (s) => document.querySelector('#tool-body ' + s);
    const sel = Q('[data-peer-book]');
    sel.value = '__new__';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(700);
    const dlg = document.querySelector('#tool-body .t-dialog');
    if (!dlg) return { err: '选「从服务器拉一本新的」没弹出输入框' };
    dlg.querySelector('.t-input').value = ${JSON.stringify(TITLE)};
    dlg.querySelector('[data-yes]').click();
    await wait(9000);
    return { tip: (Q('[data-peer-tip]') || {}).textContent || '',
             cur: (Q('[data-peer-book]') || {}).value || '',
             localSlug: Prefs.get('peerBook') || '' };
  })()`);
  check('⑤ 新手机第一次用：照**书名**把服务器那本拉到本机（记着它 + 面板说清拉了多少）',
    pulled && pulled.localSlug && /上次同步/.test(pulled.tip || '')
    && /(拉下 [0-9]+ 章|没有要换)/.test(pulled.tip || ''),
    JSON.stringify(pulled).slice(0, 300));

  /* 本机真拿到书了（界面说什么不算，看数据） */
  const local = await js(`(async () => {
    const slug = Prefs.get('peerBook');
    const bk = await API.book(slug, true);
    const st = await API.peerState(slug);
    return { slug, chapters: (bk.chapters || []).map((c) => c.title || c.name), lastResult: st.last_result, lastTime: st.last_time };
  })()`);
  const pullStat = await js(`(async () => {
    const slug = Prefs.get('peerBook');
    const st = await API.peerState(slug);
    return { slug, lastResult: st.last_result };
  })()`);
  check('⑤a 拉的结果里"没取到"是 0（老 bug：本机自带的空白章会 422 → 一章没取到）',
    pullStat && !/没取到/.test(pullStat.lastResult || ''),
    JSON.stringify(pullStat));
  check('⑤b 本机真拿到这本书了（3 章落盘 + 记着上次同步到什么时候）',
    local && local.chapters && local.chapters.length >= 3 && local.lastTime > 0,
    JSON.stringify(local).slice(0, 300));

  /* 拉下来之后再进面板 → 提示里应该写着上次同步结果 */
  const again = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-act="tool-back"]').click(); await wait(1200);
    const c = document.querySelector('#tools-body .tool-card[data-id="sync"]'); if (c) c.click(); await wait(2400);
    return (document.querySelector('#tool-body [data-peer-tip]') || {}).textContent || '';
  })()`);
  check('⑥ 再进来能看到「上次同步：… · 拉下 N 章」', /上次同步/.test(again || '') && /拉下/.test(again || ''), again);
  const shotAgain = await shoot('r12-peer-03-再次进入');

  check('⑦ 全程 0 个前端报错', pageErrors.filter((e) => !/favicon/i.test(e)).length === 0,
    JSON.stringify(pageErrors.slice(0, 3)));
  check('⑧ 三张截图内容各不相同', new Set([shotBefore, shotAfter, shotAgain]).size === 3,
    [shotBefore, shotAfter, shotAgain].join(' '));

  /* 收尾：两边的书都清掉（走回收站） */
  const cleaned = await js(`(async () => { try { const s = Prefs.get('peerBook'); const r = await API.raw('api/projects/item?projectRoot=' + encodeURIComponent(s), { method: 'DELETE' }); return r && r.ok; } catch (e) { return String(e.message); } })()`);
  await api('/api/projects/item?projectRoot=' + encodeURIComponent(SLUG), 'DELETE');
  check('⑨ 收尾：两边的自测书都清掉了', cleaned === true, String(cleaned));

  const ok = rows.filter((r) => r.ok).length;
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    peer: 'http://127.0.0.1:' + PEER_PORT, total: rows.length, passed: ok, failed: rows.length - ok,
    截图: ['r12-peer-01-同步面板', 'r12-peer-02-对账报错也说人话', 'r12-peer-03-再次进入'], items: rows }, null, 1));
  console.log(`\n=== 对端同步界面：${ok}/${rows.length} ===`);
  console.log('报告：docs/对端同步界面实测.json');
  try { srv.kill(); } catch (e) {}
  ws.close();
  process.exit(ok === rows.length ? 0 : 1);
})();
