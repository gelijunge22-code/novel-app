/* ============================================================
   e2e-cover.js — 「有没有东西盖住字」（第 19 轮）

   为什么有这东西：
     用户报过「切书的小方块在 AI 对话那里穿模」；夜间体检那次报出来的 3 条"看不清"，
     查下去也是**被别的东西压在下面**（`#preset-save` 那条常驻保存栏压在正文行上）。
     这类毛病靠肉眼挑不干净，所以做成机器判据：**滚到底，看最后一行字有没有被钉在屏上的东西压住**。

   判据（能报红）：
     每个可滚动容器滚到最底 → 取它里面**最后一个带字的叶子** →
     ① 那行字必须在容器可视区里、且在屏幕里（不许滚到底还露不全）；
     ② 那行字跟任何 `position:fixed/sticky` 的元素**相交面积必须为 0**。
        （滚动过程中内容从固定条底下穿过是正常的 —— 所以只量"滚到底"这一刻，
          这时候还压着，就说明容器的下边距没给够，用户根本滚不出来。）

   反证开关（判据必须先能报红）：
     COVER_FORCE=bar    往屏幕底部塞一条 64px 的固定黑条 → 每条判据必须报红
     COVER_FORCE=pad0   把滚动容器的 padding-bottom 清零 → 必须报红（证明"是下边距救的"）

   用法：node tools/e2e-cover.js
   产出：docs/遮挡体检.json（反证：docs/遮挡体检-反证.json + r19cover-* 截图）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');
const { READER_OPEN, CHROME, SCREENS, OVERLAYS, toolSurfaces } = require('./surfaces');

const ROOT = '/home/ubuntu/novel-app';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const FORCE = process.env.COVER_FORCE || '';
/* 反证的产出按开关分开存：pad0 与 bar 是两条独立证据，
   以前都写同一个文件 → 后跑的把那一条覆盖掉，回头看只剩一半证据。 */
const OUT = path.join(ROOT, FORCE ? ('docs/遮挡体检-反证-' + FORCE + '.json') : 'docs/遮挡体检.json');
const SHOTDIR = path.join(ROOT, 'docs/前端截图');
const ROUND = FORCE ? 'r19cover-反证' : 'r19cover';
let password = '';
try { password = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
catch (e) { /* 没配置就跑不了 */ }

const PROBE = (rootSels) => `(() => {
  const SELS = ${JSON.stringify(rootSels)};
  const roots = SELS.map((q) => document.querySelector(q)).filter((x) => !!x);
  if (!roots.length) return { err: '没有根元素 ' + SELS.join(' / ') };
  const H = window.innerHeight, W = window.innerWidth;
  const vis = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.15
      && r.width > 1 && r.height > 1; };
  const name = (el) => { const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + id + cls; };
  const boxOf = (el) => { const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  /* 两个矩形相交多少 px²。**两种形状都收**：DOMRect 是 left/top/right/bottom，
     boxOf() 给的是 l/t/r/b。上一版只认后者，而调用处传的是 DOMRect →
     全是 NaN → 永远返回 0 → "没有东西被压住"**永远为真**（判据是空的）。
     这条是反证（pad0 那一轮该红却没红）抓出来的。 */
  const inter = (a, b) => {
    const A = { l: (a.left !== undefined ? a.left : a.l), t: (a.top !== undefined ? a.top : a.t),
                r: (a.right !== undefined ? a.right : a.r), b: (a.bottom !== undefined ? a.bottom : a.b) };
    const B = { l: (b.left !== undefined ? b.left : b.l), t: (b.top !== undefined ? b.top : b.t),
                r: (b.right !== undefined ? b.right : b.r), b: (b.bottom !== undefined ? b.bottom : b.b) };
    const w = Math.min(A.r, B.r) - Math.max(A.l, B.l);
    const h = Math.min(A.b, B.b) - Math.max(A.t, B.t);
    return (w > 0.5 && h > 0.5) ? Math.round(w * h) : 0; };
  /* 谁压在这行字上面？
     上一版是"跟所有 fixed/sticky 的矩形求交"—— 那会误报：**叠层里的底层**（比如切书书单
     下面那层书架屏、确认弹窗下面那层阅读器）rect 也是满屏的，求交必然相交，
     可它是**在下面**（垫着的），根本没盖住字。所以改成**命中测试**：
     elementsFromPoint 给的是真实的绘制/命中顺序，排在它前面的才是压着它的。 */
  const occluders = (el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > W || cy > H) return [];
    let stack = [];
    try { stack = document.elementsFromPoint(cx, cy) || []; } catch (e) { return []; }
    const i = stack.indexOf(el);
    if (i < 0) return [{ by: '(这行字不可命中)', unknown: true, area: 0 }];
    const out = [];
    for (let k = 0; k < i; k++) {
      const o = stack[k];
      if (!o || el.contains(o) || o.contains(el)) continue;
      out.push({ by: name(o), area: inter(r, o.getBoundingClientRect()),
                 pinned: getComputedStyle(o).position });
    }
    return out;
  };
  const cans = [];
  const pushCan = (el) => { if (el && cans.indexOf(el) < 0) cans.push(el); };
  const scrollable = (el) => { const cs = getComputedStyle(el);
    return (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'hidden')
      && el.scrollHeight > el.clientHeight + 4; };
  roots.forEach((R) => {
    [R].concat([...R.querySelectorAll('*')]).forEach((el) => { if (scrollable(el)) pushCan(el); });
    /* 根自己不滚的时候，真正在滚的是**它的祖先**（比如书架整页滚）——
       上一版只往子孙里找，于是书架/几个工具报"容器 0 个"，等于没量（假绿）。 */
    let n = R.parentElement;
    while (n && n.nodeType === 1) { if (scrollable(n)) pushCan(n); n = n.parentElement; }
    const se = document.scrollingElement;
    if (se && se.scrollHeight > se.clientHeight + 4) pushCan(se);
  });
  const rows = [];
  cans.slice(0, 8).forEach((sc, i) => {
    const keep = sc.scrollTop;
    sc.scrollTop = sc.scrollHeight;                      /* 滚到底 —— 用户"滚到底还看不全"才算毛病 */
    const cr = sc.getBoundingClientRect();
    let line = null, lineEl = null, txt = '';
    [...sc.querySelectorAll('*')].forEach((el) => {
      if (!vis(el)) return;
      let t = ''; for (const k of el.childNodes) if (k.nodeType === 3) t += k.nodeValue;
      t = t.replace(/\\s+/g, ' ').trim(); if (!t) return;
      const r = el.getBoundingClientRect();
      if (r.bottom < cr.top || r.top > cr.bottom) return;
      if (!line || r.bottom > line.bottom) { line = r; lineEl = el; txt = t.slice(0, 24); }
    });
    /* ⚠ occluders() 要的是**元素**（它要读 rect + 命中测试），不是 rect ——
       上一版把 rect 传进去了，探针直接抛 TypeError（"el.getBoundingClientRect is not a function"）。 */
    const cover = lineEl ? occluders(lineEl) : [];
    rows.push({ i: i, sel: name(sc), maxScroll: Math.round(sc.scrollHeight - sc.clientHeight),
      scrollTop: Math.round(sc.scrollTop), visBox: { t: Math.round(cr.top), b: Math.round(cr.bottom) },
      lastText: txt,
      lastBox: line ? { t: Math.round(line.top), b: Math.round(line.bottom) } : null,
      inView: line ? (line.top >= -0.5 && line.bottom <= H + 0.5) : null,
      coveredBy: cover });
    sc.scrollTop = keep;                                 /* 还原，别把后面的判据带偏 */
  });
  /* 没有可滚动的容器（比如整屏正好放下）不代表"没毛病"：
     退一步量**这一屏最下面的那行字**有没有被钉住的东西压住 —— 有内容量才算数，
     一条都没得量会在下面被单独记账，绝不当成"绿了"。 */
  if (!rows.length) {
    let line = null, lineEl = null, txt = '';
    roots.forEach((R) => {
      /* 底部导航 #tabbar 只是"公共外壳"，它自己那排标签本来就在屏幕最下面 ——
         拿它当"最下面那行字"会天天报绿（量的是导航的字，不是内容），所以挑目标时跳过它。 */
      if (R.id === 'tabbar') return;
      [...R.querySelectorAll('*')].forEach((el) => {
        if (!vis(el)) return;
        let t = ''; for (const k of el.childNodes) if (k.nodeType === 3) t += k.nodeValue;
        t = t.replace(/\\s+/g, ' ').trim(); if (!t) return;
        const r = el.getBoundingClientRect();
        if (r.top > H || r.bottom < 0) return;
        if (!line || r.bottom > line.bottom) { line = r; lineEl = el; txt = t.slice(0, 24); }
      });
    });
    if (lineEl) {
      const cover = occluders(lineEl);
      rows.push({ i: 0, sel: '(整屏，无可滚动容器)', maxScroll: 0, scrollTop: 0,
        visBox: { t: 0, b: H }, lastText: txt,
        lastBox: { t: Math.round(line.top), b: Math.round(line.bottom) },
        inView: (line.top >= -0.5 && line.bottom <= H + 0.5), bottomMost: true, coveredBy: cover });
    }
  }
  return { root: SELS.join('+'), scrollables: cans.length, rows: rows };
})`;

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const s = await open({ port: 9392, width: 390, height: 844, settle: 800 });
  const js = s.js;
  const rep = { at: new Date().toISOString(), base: BASE, force: FORCE, surfaces: [], fails: [], problems: [] };
  await s.nav(BASE + '?cover=' + Date.now());
  for (let i = 0; i < 40; i++) {
    const gone = await js("(()=>{const sp=document.getElementById('splash');return !!(sp&&(sp.classList.contains('gone')||getComputedStyle(sp).opacity==='0'));})()");
    if (gone) break; await sleep(120);
  }
  if (await js("document.getElementById('login') && !document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(password)
      + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4200);
  }
  const ids = await js("(()=>{try{return (window.Tools.TOOLS||[]).map(t=>t.id);}catch(e){return [];}})()");
  global.__TOOLIDS__ = (ids || []).map((x) => ({ id: x }));

  if (FORCE === 'bar') {
    await js("(()=>{const d=document.createElement('div');d.id='cover-force-bar';"
      + "d.style.cssText='position:fixed;left:0;right:0;bottom:0;height:240px;background:#222;z-index:99999';"
      + "document.body.appendChild(d);return 1})()");
    rep.notes = ['反证模式 COVER_FORCE=bar：屏幕底部塞了一条 240px 固定黑条'
      + '（比底部导航高得多，故意盖到「滚到底时最后一行字」的位置），判据必须报红'];
    console.log('  ⚠ 反证模式 COVER_FORCE=bar（判据必须报红）');
  }
  if (FORCE === 'pad0') {
    await js("(()=>{const st=document.createElement('style');"
      + "st.textContent='*{padding-bottom:0 !important}';document.head.appendChild(st);return 1})()");
    rep.notes = ['反证模式 COVER_FORCE=pad0：所有下边距清零，判据必须报红'];
    console.log('  ⚠ 反证模式 COVER_FORCE=pad0（判据必须报红）');
  }
  await sleep(400);

  const list = SCREENS.concat(OVERLAYS).concat(toolSurfaces());
  for (const sf of list) {
    const rec = { id: sf.id, root: sf.root, probe: null, fails: [] };
    try {
      const ok = await js("(async()=>{try{return await (" + sf.open + ");}catch(e){return -1;}})()");
      if (!ok) { rec.fails.push('打不开这一屏（open 返回 ' + ok + '）'); rep.problems.push(sf.id + '：打不开'); }
      await sleep(sf.settle || 900);
      const pr = await js('(' + PROBE([sf.root].concat(sf.extra || [])) + ')()');
      rec.probe = pr;
      if (pr && pr.err) rec.fails.push(pr.err);
      else if (!pr || !pr.rows || !pr.rows.length) {
        /* 一条都没量到 = 这一屏**没被验过**：不许当绿，单独记账，跑完打印出来 */
        rec.notes = ['这一屏一条都没量到（没内容 / 没渲染出来）—— 不算通过'];
        rep.unmeasured = (rep.unmeasured || []).concat([sf.id]);
      } else {
        (pr.rows || []).forEach((r2) => {
          if (!r2.lastBox) return;
          if (r2.inView === false) rec.fails.push('滚到底了最后一行还露不全（' + r2.sel + ' 里"'
            + r2.lastText + '" y=' + r2.lastBox.t + '-' + r2.lastBox.b + '，屏高 844）');
          if ((r2.coveredBy || []).length && r2.coveredBy[0].unknown) {
            rec.unmeasurable = (rec.unmeasurable || []).concat([r2.sel + ' 里那行字不可命中，量不了遮挡']);
          } else if ((r2.coveredBy || []).length) {
            rec.fails.push('滚到底了最后一行还被压住（' + r2.sel + ' 里"'
              + r2.lastText + '" 被 ' + r2.coveredBy.map((c) => c.by + '[' + c.pinned + ']').join('、') + ' 压住）');
          }
        });
      }
    } catch (e) { rec.fails.push('探针抛了：' + String(e && e.message || e).slice(0, 90)); }
    if (sf.close) { try { await js("(async()=>{try{return await (" + sf.close + ");}catch(e){return 0;}})()"); await sleep(300); } catch (e) {} }
    if (rec.fails.length) { rep.fails = rep.fails.concat(rec.fails.map((f) => sf.id + '：' + f)); }
    rep.surfaces.push(rec);
    console.log('  ' + (rec.fails.length ? '✗' : '·') + ' ' + sf.id.padEnd(22) + ' '
      + (rec.probe && rec.probe.rows ? ('容器 ' + rec.probe.rows.length + ' 个') : '')
      + (rec.fails.length ? ('  ' + rec.fails.length + ' 条') : ''));
  }
  /* 反证模式下必须**真的报出红**，否则说明判据是空的（这就是"绿灯不算数"的那条规矩） */
  if (FORCE && !rep.fails.length) rep.fails.push('反证模式 ' + FORCE + ' 跑完一条红都没有 —— 判据是空的，不许算过');
  rep.ok = rep.fails.length === 0;
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
  console.log('\n' + (rep.ok ? '全部通过' : '有 ' + rep.fails.length + ' 条没过') + '（测了 '
    + rep.surfaces.length + ' 个屏/面板）→ ' + OUT);
  for (const f of rep.fails.slice(0, 20)) console.log('  ✗ ' + f);
  await s.close();
  process.exit(rep.ok ? 0 : 1);
})();
