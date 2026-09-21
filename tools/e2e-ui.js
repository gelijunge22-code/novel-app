/* ============================================================
   e2e-ui.js — UI 修复的**实测**（不靠"看代码觉得没问题"）。
   在真浏览器里量几何：标题到底居不居中、7 个主题是不是整齐网格、
   设置页最后一行会不会被底部导航压住。
   用法：node tools/e2e-ui.js
   产出：docs/UI实测.json + docs/前端截图/ui-*.png
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
// 踩过的坑：写成 process.argv[indexOf('--url')+1] 时，没传 --url 会取到 argv[0]（node 的路径），
// 结果页面一直停在 about:blank，还以为是自己改坏了。
const BASE = arg('url', 'http://127.0.0.1:8899/');
const OUT = path.join(ROOT, 'docs/UI实测.json');
const SHOT = path.join(ROOT, 'docs/前端截图');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, why) => {
  results.push({ name, ok: !!ok, why: String(why == null ? '' : why) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '   —— ' + why));
};

function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eui-'));
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=9335', '--window-size=390,844',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch('http://127.0.0.1:9335/json/list')).json(); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('chrome 起不来'); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const js = async (expr, wait) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (wait) await sleep(wait);
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) fs.writeFileSync(path.join(SHOT, n + '.png'), Buffer.from(r.result.data, 'base64'));
  };

  await send('Page.navigate', { url: BASE + '?ui=' + Date.now() });
  await sleep(5000);
  if (await js("!document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
      ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4000);
  }

  /* ① 标题居中：所有屏幕的 .topbar-title 中心 vs 视口中心 */
  const titles = await js(`(() => {
    const out = [];
    document.querySelectorAll('.screen').forEach((s) => {
      const t = s.querySelector('.topbar-title');
      if (!t) return;
      const vis = !s.classList.contains('hidden');
      const was = s.classList.contains('hidden');
      if (was) { s.classList.remove('hidden'); }
      const r = t.getBoundingClientRect();
      if (was) { s.classList.add('hidden'); }
      out.push({ screen: s.id, vis: vis, text: t.textContent.trim(),
                 center: Math.round(r.left + r.width / 2), vw: window.innerWidth });
    });
    return out;
  })()`);
  const off = (titles || []).filter((t) => Math.abs(t.center - t.vw / 2) > 2);
  check('① 所有页面标题正居中（偏差 ≤2px）', (titles || []).length >= 4 && off.length === 0,
    JSON.stringify(titles) + ' 偏的：' + JSON.stringify(off));

  /* ② 主题 7 项：一行 4 个、第二行 3 个，宽度一致、不出界 */
  await js("App.show('settings'); 1", 1200);
  const seg = await js(`(() => {
    const b = [...document.querySelectorAll('#settings-body .seg.grid button')];
    if (!b.length) return { n: 0 };
    const rows = {};
    b.forEach((x) => { const r = x.getBoundingClientRect(); const k = Math.round(r.top);
      rows[k] = rows[k] || []; rows[k].push({ w: Math.round(r.width), right: Math.round(r.right), t: x.textContent }); });
    return { n: b.length, rows: Object.values(rows), vw: window.innerWidth };
  })()`, 400);
  const rows = (seg && seg.rows) || [];
  const evenRow = (arr) => Math.max(...arr.map((x) => x.w)) - Math.min(...arr.map((x) => x.w)) <= 2;
  const lastRight = rows.length ? Math.max(...rows[rows.length - 1].map((x) => x.right)) : 0;
  const fillsRight = seg && lastRight >= seg.vw - 34 && lastRight <= seg.vw;   // 末行补满，右边不留大空
  check('② 主题 7 个排成整齐两行（4+3）、每行等宽、右边缘不留空',
    seg && seg.n === 7 && rows.length === 2 && rows[0].length === 4 && rows[1].length === 3 &&
    rows.every(evenRow) && fillsRight,
    JSON.stringify(seg));
  await shot('ui-01-设置-主题网格');

  /* ③ 设置页最后一行不被底部导航压住 */
  const overlap = await js(`(() => {
    const body = document.getElementById('settings-body');
    body.scrollTop = body.scrollHeight;
    const rowsAll = body.querySelectorAll('.settings-row');
    const last = rowsAll[rowsAll.length - 1].getBoundingClientRect();
    const tb = document.getElementById('tabbar').getBoundingClientRect();
    return { lastBottom: Math.round(last.bottom), tabTop: Math.round(tb.top),
             gap: Math.round(tb.top - last.bottom) };
  })()`, 600);
  check('③ 设置页最后一行在底栏之上（没被压住）', overlap && overlap.gap >= 4, JSON.stringify(overlap));
  await shot('ui-02-设置-底部');

  /* ④ 390×844 下没有任何横向溢出（几个主要页面） */
  const overflow = await js(`(async () => {
    const bad = [];
    for (const s of ['shelf', 'settings', 'tools']) {
      App.show(s); await new Promise((r) => setTimeout(r, 700));
      const el = document.querySelector('.screen:not(.hidden)');
      if (el && el.scrollWidth > window.innerWidth + 1) bad.push({ screen: s, w: el.scrollWidth });
    }
    return bad;
  })()`);
  check('④ 390×844 主要页面没有横向溢出', Array.isArray(overflow) && overflow.length === 0, JSON.stringify(overflow));

  /* ⑤ 素材列表**不能再有一列红「删」**（用户原话：右边一列红字太抢眼、易误触、还没二次确认）。
     老判据是查 `button.t-btn.sm.dim` —— 素材面板根本没进去，n=0，"没查到"就当"通过"，是空转。
     现在真进面板量：① 列表行里一个删除按钮都不许有；② 点进一条，"删"要点两下才真的删。 */
  const mat = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const clickText = (t) => {
      const el = [...document.querySelectorAll('#tools-body .tool-card, button, .t-row')]
        .find((e) => (e.textContent || '').trim().startsWith(t));
      if (el) { el.click(); return true; } return false;
    };
    App.show('tools'); await wait(900);
    clickText('素材'); await wait(1500);
    for (let k = 0; k < 3; k++) {
      if (document.querySelector('#tool-body [data-open], #tool-body .t-empty')) break;
      const pick = document.querySelector('#tool-body [data-slug]') || document.querySelector('.t-row[data-i]');
      if (!pick) break;
      pick.click(); await wait(1500);
    }
    const rows = [...document.querySelectorAll('#tool-body .t-row')];
    const delInList = rows.reduce((n, r) => n + [...r.querySelectorAll('button')]
      .filter((b) => /删|删除/.test(b.textContent)).length, 0);
    const open = document.querySelector('#tool-body [data-open]');
    if (!open) return { rows: rows.length, delInList, opened: false };
    open.click(); await wait(1600);
    const delBtn = [...document.querySelectorAll('#tool-body [data-del]')][0];
    if (!delBtn) return { rows: rows.length, delInList, opened: true, delBtn: false };
    /* 弹框就是 .t-dialog（tools.js 的 confirmBox 实现），挂在 #tool-body 里 */
    const before = document.querySelectorAll('.t-dialog').length;
    delBtn.click(); await wait(800);
    const after = document.querySelectorAll('.t-dialog').length;
    const asking = document.querySelector('.t-dialog');
    const boxText = asking ? (asking.innerText || '').replace(/\s+/g, ' ').slice(0, 60) : '';
    // 点"取消"，确认它没有真删
    const cancel = asking && (asking.querySelector('[data-no]') || [...asking.querySelectorAll('button')]
      .find((b) => /取消|算了|不要/.test(b.textContent)));
    if (cancel) { cancel.click(); await wait(600); }
    const stillThere = !!(document.querySelector('#tool-body [data-del]'));
    return { rows: rows.length, delInList, opened: true, delBtn: true,
             askedBeforeDelete: after > before || !!boxText, boxText, stillThere };
  })()`);
  check('⑤ 素材：列表里没有删除按钮，删除在详情页且必须二次确认',
    mat && mat.delInList === 0 && mat.opened && mat.delBtn && mat.askedBeforeDelete && mat.stillThere,
    JSON.stringify(mat));

  /* ⑥ 质检章节列表：默认按**章号**升序。判据用"章号前缀非递减"，
     不要用整串的拼音比较 —— 上一版就是这么比的：两章都叫「第001章-…」时，
     pinyin 排序把"测试"排到"未命名"前面，于是 script 自己判"乱序"，
     查了半天才发现乱的是**判据**，不是应用。（同一分数段/同一章号，tie 怎么破都合法。） */
  const lintOrder = await js(`(async () => {
    const ws = await API.shelf();
    const isTest = (t) => /E2E|实测|测试|临时|走查|自动|zz-/.test(t || '');
    const book = (ws.projects || []).find((p) => !isTest(p.title)) || (ws.projects || [])[0];
    if (!book) return { none: true };
    const ov = await API.book(book.slug);
    const names = (ov.chapters || []).map((c) => c.name || c.path);
    /* 注意：这段是塞在模板串里 eval 的，反斜杠 d 会被模板串吃掉只剩一个 d
       （第 11 轮踩过：章号全变 NaN、判据假红、还以为应用乱序）。用 [0-9] 没有转义歧义。 */
    const num = (s) => { const m = String(s).match(/[0-9]+/); return m ? Number(m[0]) : NaN; };
    const nums = names.map(num);
    let bad = -1;
    for (let i = 1; i < nums.length; i++) {
      if (Number.isFinite(nums[i]) && Number.isFinite(nums[i - 1]) && nums[i] < nums[i - 1]) { bad = i; break; }
    }
    return { book: book.title, n: names.length, head: names.slice(0, 3), nums: nums.slice(0, 8), badIndex: bad, allNumbered: nums.every(Number.isFinite) };
  })()`);
  check('⑥ 质检章节列表默认按章号升序（同一个章号内部怎么排都合法）',
    lintOrder && !lintOrder.none && lintOrder.n && lintOrder.badIndex === -1 && lintOrder.allNumbered,
    JSON.stringify(lintOrder));

  /* ⑦ 评分配色：阈值按 90/75 切（≥90 绿 / 75–89 黄 / <75 红），而且**量真实颜色**。
     上一版只比类名字符串，还写着"88 黄"、其实类名是 gray（灰）——名字在骗人。
     现在：先把三个分数段的 pill 真渲染出来，量 color 的 RGB，确认绿/黄/红是三支不同的色相。 */
  const colors = await js(`(() => {
    const mk = (s) => { const d = document.createElement('span');
      d.className = 't-pill ' + LintScoreClass(s); d.textContent = s + ' 分';
      document.body.appendChild(d); return d; };
    const rgb = (el) => { const m = getComputedStyle(el).color.match(/\\d+/g).map(Number); return m.slice(0, 3); };
    const out = {};
    [92, 90, 88, 75, 74].forEach((s) => { const e = mk(s); out[s] = { cls: LintScoreClass(s), rgb: rgb(e), hex: getComputedStyle(e).color }; });
    // 判"是黄"：红绿都高、蓝明显低（琥珀）；"是绿"：绿最大且红蓝都低；"是红"：红最大
    /* 靠**色相**判色，不靠"哪个通道大"拍脑袋：
       琥珀(154,107,18) 红绿都高、蓝很低，单看"红最大"会被误判成红 —— 上一版就这么误判了。 */
    const kind = ([r, g, b]) => {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d < 25) return 'gray';
      let h; if (mx === r) h = 60 * (((g - b) / d) % 6); else if (mx === g) h = 60 * ((b - r) / d + 2); else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
      if (h < 20 || h >= 340) return 'red';
      if (h < 70) return 'amber';
      if (h < 170) return 'green';
      return 'other';
    };
    Object.keys(out).forEach((k) => { out[k].kind = kind(out[k].rgb); });
    document.querySelectorAll('.t-pill').forEach((e, i) => { if (i >= 0 && e.dataset.__t) e.remove(); });
    [...document.body.querySelectorAll('.t-pill')].slice(-5).forEach((e) => e.remove());
    return out;
  })()`);
  const c = colors || {};
  check('⑦ 评分配色 ≥90 绿 / 75–89 黄 / <75 红（类名 + 真实颜色都对）',
    c[92] && c[92].cls === 'ok' && c[92].kind === 'green' &&
    c[90] && c[90].cls === 'ok' && c[90].kind === 'green' &&
    c[88] && c[88].cls === 'mid' && c[88].kind === 'amber' &&
    c[75] && c[75].cls === 'mid' && c[75].kind === 'amber' &&
    c[74] && c[74].cls === 'warn' && c[74].kind === 'red',
    JSON.stringify(c));
  await shot('ui-04-评分三段色');

  /* ⑧ 进工具子面板时，底部「工具」要高亮 */
  const hi = await js(`(() => {
    App.show('tools');
    const t1 = document.querySelector('.tab[data-tab=tools]').classList.contains('active');
    App.show('tool');            // 工具里的子面板
    const t2 = document.querySelector('.tab[data-tab=tools]').classList.contains('active');
    App.show('shelf');
    const t3 = document.querySelector('.tab[data-tab=shelf]').classList.contains('active');
    return { toolsTab: t1, toolPanel: t2, backToShelf: t3 };
  })()`, 600);
  check('⑧ 底部导航选中态：工具 / 工具子面板 / 回书架 都对得上',
    hi && hi.toolsTab && hi.toolPanel && hi.backToShelf, JSON.stringify(hi));

  /* ⑨ 剧情面板有「新建章节」入口（每个列表页都要有新增的落点） */
  const newEntry = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const clickText = (t) => {
      const el = [...document.querySelectorAll('button, .t-row, .tool-card')]
        .find((e) => (e.textContent || '').trim().startsWith(t));
      if (el) { el.click(); return true; } return false;
    };
    App.show('tools'); await wait(800);
    clickText('剧情'); await wait(1500);
    // 需要先选书就选一本；已经在剧情里就直接进。
    // （踩过的坑：书架上只要多过一本，就会先弹选书页，早先这里只找 .t-row[data-i]，
    //   选书页的行走的是 [data-slug]，于是"没进面板"被当成"没有新建按钮"，假红。）
    for (let k = 0; k < 3 && !document.querySelector('#tool-body [data-tabs]'); k++) {
      const pick = document.querySelector('#tool-body [data-slug]') ||
                   document.querySelector('.t-row[data-i]');
      if (!pick) break;
      pick.click(); await wait(1500);
    }
    // 回到「承载树」那个页签
    const tab = [...document.querySelectorAll('[data-tabs] button')].find((b) => b.dataset.tab === 'tree');
    if (tab) { tab.click(); await wait(900); }
    const add = document.querySelector('[data-newch]');
    const scr = document.querySelector('.screen:not(.hidden)');
    return { found: !!add, text: add ? add.textContent.trim() : '', screen: scr ? scr.id : '',
             body: ((scr && scr.innerText) || '').replace(/\s+/g, ' ').slice(0, 160) };
  })()`);
  check('⑨ 剧情 → 承载树里有「新建章节」按钮', newEntry && newEntry.found,
    JSON.stringify(newEntry));
  await shot('ui-03-剧情-新建章节');

  const ok = results.filter((r) => r.ok).length;
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), total: results.length, ok,
    fail: results.length - ok, items: results }, null, 1));
  console.log(`\n=== UI 实测 ${results.length} 条：通过 ${ok}，失败 ${results.length - ok} ===`);
  console.log('报告：docs/UI实测.json');
  process.exit(ok === results.length ? 0 : 1);
})();
