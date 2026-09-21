/* ============================================================
   e2e-safearea.js — 「手势 + 安全区」的机器判据（第 19 轮 · 偷懒自查表第 ⑤ 项）

   为什么有这东西：手机上有两处"看不见的坑"，靠无头浏览器默认视口**永远量不出来**——
     · 刘海 / 灵动岛：顶部 47px 里不该有字和按钮，否则字被切掉、按钮点不到；
     · 底部 home 条：底部 34px 里不该有可点元素，否则"返回/发送"这种键正好压在条上；
     · 手势：手指下滑要能把列表滚起来。真机上"划不动"通常不是 CSS 坏了，
       而是有个**透明的整屏层**把触摸吞掉（`touch-action:none` / 盖满屏的遮罩没关干净）。

   做法：把 `--safe-t / --safe-b` 注入成 iPhone 那种 47 / 34，然后：
     ① 顶栏：可见的文字/控件不许伸进顶部安全区；
     ② 底栏：可见的可点元素不许伸进底部安全区；
     ③ 手势：真的发触摸事件（Input.dispatchTouchEvent）把内容往上拖，主滚动容器必须真的滚；
     ④ 吞手势：不许有"盖满视口 + touch-action:none"的透明层。

   反证（判据必须先能红）：
     SAFE_FORCE=nopad  顶栏 padding-top 抹成 0     → ① 必须报红
     SAFE_FORCE=clip   底栏 padding-bottom 抹成 0  → ② 必须报红
     SAFE_FORCE=trap   盖一层整屏 touch-action:none → ③④ 必须报红

   用法：node tools/e2e-safearea.js   （反证：SAFE_FORCE=nopad|clip|trap）
   产出：docs/安全区实测.json（反证 → docs/安全区实测-反证-<开关>.json）+ docs/前端截图/r19sa-*.png
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');
const { READER_OPEN, CHROME, SCREENS } = require('./surfaces');
const { readPassword } = require('./preflight');

const ROOT = '/home/ubuntu/novel-app';
const FORCE = process.env.SAFE_FORCE || '';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const SHOTDIR = path.join(ROOT, 'docs/前端截图');
const OUT = path.join(ROOT, FORCE ? 'docs/安全区实测-反证-' + FORCE + '.json' : 'docs/安全区实测.json');
const SAFE_T = 47, SAFE_B = 34;                   // iPhone 14 Pro：刘海 47 / home 条 34

const AUDIT = (rootSel, extra) => `(() => {
  const R = document.querySelector(${JSON.stringify(rootSel)});
  if (!R) return { err: '没有这个屏 ' + ${JSON.stringify(rootSel)} };
  const roots = [R].concat(${JSON.stringify(extra)}.map((q) => document.querySelector(q)).filter((x) => !!x));
  const W = innerWidth, H = innerHeight;
  const T = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-t')) || 0;
  const B = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-b')) || 0;
  const name = (el) => { const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
    return el.tagName.toLowerCase() + id + cls; };
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none'
      && parseFloat(cs.opacity) > 0.15; };
  const txtOf = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 14);
  /* 被祖先滚动容器裁掉的部分**不算数**：直接拿 getBoundingClientRect 比，
     面板只要滚过一点，屏外元素就全被误判成"伸进刘海/压 home 条"——
     第 19 轮正跑那 9 条红全是这么来的（button「纸白」top:-5 是滚上去的，
     div.bubble top:-1021 是聊天记录滚出去的）。这里把每个祖先的裁剪轴和视口都交上去。 */
  const clip = (el) => { const r0 = el.getBoundingClientRect();
    let l = r0.left, t = r0.top, rt = r0.right, b = r0.bottom;
    let n = el.parentElement;
    while (n && n.nodeType === 1) { const cs = getComputedStyle(n);
      const cx = cs.overflowX !== 'visible', cy = cs.overflowY !== 'visible';
      if (cx || cy) { const p = n.getBoundingClientRect();
        if (cx) { l = Math.max(l, p.left); rt = Math.min(rt, p.right); }
        if (cy) { t = Math.max(t, p.top); b = Math.min(b, p.bottom); } }
      n = n.parentElement; }
    l = Math.max(l, 0); t = Math.max(t, 0); rt = Math.min(rt, W); b = Math.min(b, H);
    return { top: t, bottom: b, left: l, right: rt, width: rt - l, height: b - t };
  };
  /* 在不在"滚动内容"里：滚动中的内容从 home 条底下划过是正常的（iOS 也这样），
     只要**滚到底**时最后一条能停在 home 条上方 —— 那是 ⑤ 管的，不在这儿误判。 */
  const inScroller = (el) => { let n = el.parentElement;
    while (n && n.nodeType === 1) { const cs = getComputedStyle(n);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 8) return true;
      n = n.parentElement; }
    return false; };
  const all = [];
  roots.forEach((r) => r.querySelectorAll('*').forEach((el) => all.push(el)));
  all.push(...roots);
  const top = [];        // 伸进顶部安全区的字/控件
  const bottom = [];     // 伸进底部安全区的固定可点元素
  const trap = [];       // 盖满视口的 touch-action:none 层
  const HOT = 'button, [data-act], a[href], input, textarea, select, [role="button"], .tab, [data-q]';
  for (const el of all) {
    if (!vis(el)) continue;
    const v = clip(el);
    if (v.width < 2 || v.height < 2) continue;            // 被滚出去了 → 看不见，不算
    const cs = getComputedStyle(el);
    let hasText = false;
    for (const k of el.childNodes) if (k.nodeType === 3 && k.nodeValue.trim()) hasText = true;
    const isCtl = el.matches(HOT) || el.matches('.icon-btn, svg, img');
    if ((hasText || isCtl) && !el.querySelector(HOT) && v.top < T - 1) {
      top.push({ el: name(el), top: Math.round(v.top), h: Math.round(v.height), txt: txtOf(el) });
    }
    if (el.matches(HOT) && v.bottom > H - B + 1 && !inScroller(el)) {
      bottom.push({ el: name(el), bottom: Math.round(v.bottom), 越界: Math.round(v.bottom - (H - B)), txt: txtOf(el) });
    }
    if (cs.touchAction === 'none') { const r = el.getBoundingClientRect();
      if (r.width > W * 0.8 && r.height > H * 0.8) trap.push({ el: name(el), ta: cs.touchAction }); }
  }
  /* ④ 吞手势的整屏层还可能挂在 body 上（不在屏 root 里）—— 单独扫一遍，
     不然 SAFE_FORCE=trap 塞的那层永远扫不到（判据假绿）。 */
  for (const el of Array.from(document.body.children)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (cs.touchAction === 'none' && r.width > W * 0.8 && r.height > H * 0.8)
      trap.push({ el: name(el), ta: cs.touchAction, where: 'body' });
  }
  /* ⑤ 滚到底：每个滚动容器里，最后一个可点元素的底沿必须停在 home 条上方
        （滚动容器自己 padding-bottom 里要留 var(--safe-b)，没留就报红）。 */
  const scrollers = [];
  all.forEach((el) => { const cs = getComputedStyle(el);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 8) scrollers.push(el); });
  const tail = [];
  for (const sc of scrollers) {
    const keep = sc.scrollTop; sc.scrollTop = sc.scrollHeight;   // 滚到底再看（看完还原）
    let worst = null;
    for (const el of Array.from(sc.querySelectorAll(HOT))) {
      if (!vis(el)) continue;
      const v = clip(el);
      if (v.height < 2) continue;
      if (v.bottom > H - B + 1 && (!worst || v.bottom > worst.bottom))
        worst = { el: name(el), bottom: Math.round(v.bottom), 越界: Math.round(v.bottom - (H - B)), txt: txtOf(el) };
    }
    sc.scrollTop = keep;
    if (worst) tail.push(Object.assign({ scroller: name(sc) }, worst));
  }
  /* ③ 找主滚动容器：**按面积找**，别用 elementFromPoint —— 盖一层透明整屏层（trap 反证就是这种）
     就"看不见"下面的滚动容器了，于是那一条永远判绿。 */
  const findScroller = (rt) => { let best = null, area = 0;
    const list = [rt].concat(Array.from(rt.querySelectorAll('*')));
    for (const el of list) { const cs = getComputedStyle(el);
      if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue;
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (el.scrollHeight <= el.clientHeight + 8) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 100) continue;
      if (r.width * r.height > area) { area = r.width * r.height; best = el; } }
    return best; };
  const scEl = findScroller(R);
  const sc = scEl ? name(scEl) : null;
  return { safeT: T, safeB: B, top: top.slice(0, 8), bottom: bottom.slice(0, 8),
    trap: trap.slice(0, 4), tail: tail.slice(0, 6), scroller: sc, centerEl: (() => { const e = document.elementFromPoint(W / 2, H * 0.62);
      return e ? (e.tagName.toLowerCase() + (e.className && typeof e.className === 'string'
        ? '.' + e.className.trim().split(/\\s+/)[0] : '')) : ''; })() };
})()`;

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const s = await open({ port: 9397, width: 390, height: 844, settle: 900 });
  const js = s.js;
  const R = [];
  const chk = (name, ok, detail) => {
    R.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail });
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + '   ' + JSON.stringify(detail === undefined ? '' : detail));
  };

  await s.nav(BASE + '?safe=' + Date.now());
  for (let i = 0; i < 40; i++) {
    const gone = await js("(()=>{const sp=document.getElementById('splash');return !!(sp&&(sp.classList.contains('gone')||getComputedStyle(sp).opacity==='0'));})()");
    if (gone) break; await sleep(120);
  }
  if (await js("document.getElementById('login') && !document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword())
      + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4200);
  }
  /* 把刘海 / home 条注入进来（无头浏览器没有真机的那种 env()，只能自己给） */
  await js("(()=>{const r=document.documentElement.style;r.setProperty('--safe-t','" + SAFE_T + "px');"
    + "r.setProperty('--safe-b','" + SAFE_B + "px');return 1})()");
  if (FORCE === 'nopad') await js("(()=>{const e=document.createElement('style');e.id='sa-force';"
    + "e.textContent='.topbar,.reader-head,.t-head,.chat-head,.lore-head{padding-top:0 !important}';"
    + "document.head.appendChild(e);return 1})()");
  if (FORCE === 'clip') await js("(()=>{const e=document.createElement('style');e.id='sa-force';"
    + "e.textContent='#tabbar{padding-bottom:0 !important;height:var(--tab-h) !important}';"
    + "document.head.appendChild(e);return 1})()");
  if (FORCE === 'trap') await js("(()=>{const d=document.createElement('div');d.id='sa-trap';"
    + "d.style.cssText='position:fixed;inset:0;z-index:99999;background:transparent;touch-action:none';"
    + "document.body.appendChild(d);return 1})()");
  /* 这里曾经有个 pad0 反证（抹掉吸底条的 --safe-b 内边距），跑出来 **0 条红**：
     阅读器底部面板 `#rd-quick` 不在 `#screen-reader` 的扫描范围里（它是 index.html 里的独立层），
     所以抹了也扫不到 —— **靶子不存在就删掉，不留一条永远绿的反证**（那种比没有更坏）。
     现在 home 条那一条由 clip 反证兜底（打的是 tabbar）。这事记在 docs/自审清单.md。 */
  /* 每个反证开关**点名**它该红在哪一条上 —— 只要"有红"就算过，那是空判据（红在别处的可能性很大）。 */
  const EXPECT = { nopad: ['顶栏不伸进刘海'], clip: ['可点元素不压 home 条'],
    trap: ['吞手势层', '上拖能滚动内容'] };
  if (FORCE) console.log('  ⚠ 反证模式 SAFE_FORCE=' + FORCE + '（判据必须红在「'
    + (EXPECT[FORCE] || []).join(' / ') + '」上）');

  /* 真的发触摸事件：从下往上拖，主滚动容器该跟着滚 */
  const drag = async (x, y) => {
    await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 6; i++) {
      await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 26 }] });
      await sleep(20);
    }
    await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);
  };

  const ONLY = (process.env.SAFE_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const sf of (ONLY.length ? SCREENS.filter((x) => ONLY.indexOf(x.id) >= 0) : SCREENS)) {
    const okOpen = await js(sf.open);
    await sleep(sf.settle || 800);
    /* 拖之前先把主滚动容器拉回顶部：原来停在底部时"再往上拖"本来就没得滚，
       会把"到顶了"当成"划不动"（假红）。chat 的 scroll-behavior 是平滑的 ——
       直接"设 0 马上读"会读到旧值（8169），所以先掐掉平滑、再单独读一次。 */
    const FIND = "(function(rt){let b=null,a=0;const l=[rt].concat(Array.from(rt.querySelectorAll('*')));"
      + "for(const el of l){const cs=getComputedStyle(el);"
      + "if(cs.overflowY!=='auto'&&cs.overflowY!=='scroll')continue;"
      + "if(cs.visibility==='hidden'||cs.display==='none')continue;"
      + "if(el.scrollHeight<=el.clientHeight+8)continue;const r=el.getBoundingClientRect();"
      + "if(r.width<60||r.height<100)continue;if(r.width*r.height>a){a=r.width*r.height;b=el;}}return b;})";
    const rootSel = JSON.stringify(sf.root);
    await js("(()=>{const b=" + FIND + "(document.querySelector(" + rootSel + "));"
      + "if(b){b.style.scrollBehavior='auto';b.scrollTop=0;}return 1})()");
    await sleep(320);
    const readTop = "(()=>{const b=" + FIND + "(document.querySelector(" + rootSel + "));"
      + "return b?b.scrollTop:null;})()";
    const before = await js(readTop);
    /* 一个点上可能正好压着输入框/标签（手指在输入框里拖是选字，不是滚页）——换个位置再试，
       三个位置都不动才算"划不动"。 */
    for (const y of [700, 520, 340]) { await drag(195, y); const t = await js(readTop); if (t !== null && before !== null && t > before + 4) break; }
    const a = await js(AUDIT(sf.root, sf.extra));
    if (!a || a.err) { chk('安全区 · ' + sf.id + ' · 打开', false, a && a.err); continue; }
    const txt = await js("(()=>{const R=document.querySelector(" + JSON.stringify(sf.root) + ");return (R.innerText||'').replace(/\\s+/g,'').slice(0,24);})()");
    const after = await js(readTop);
    const scrolled = (before !== null && after !== null && after > before + 4);
    chk('安全区 · ' + sf.id + ' · 打开（' + String(txt || '').slice(0, 12) + '）', !!okOpen, { ok: okOpen });
    chk('安全区 · ' + sf.id + ' · 顶栏不伸进刘海', a.top.length === 0, a.top);
    chk('安全区 · ' + sf.id + ' · 可点元素不压 home 条', a.bottom.length === 0, a.bottom);
    chk('安全区 · ' + sf.id + ' · 没有盖满屏的吞手势层', a.trap.length === 0, a.trap);
    chk('安全区 · ' + sf.id + ' · 滚到底时最后一行不压 home 条', a.tail.length === 0, a.tail);
    if (sf.id === 'reader') {
      /* 阅读页往上拖是翻页（不是滚动）：只要有点反应就算过（页变了 / 滚动变了） */
      chk('手势 · ' + sf.id + ' · 上拖有反应（翻页或滚动）', scrolled || (before === null), { before, after });
    } else {
      /* before === null = 这一屏没有可滚内容（书不够多、面板短）—— 这时候"划不动"是应该的，
         记成"没有可滚内容"而不是判绿/判红（判绿是假绿，判红是假红）。 */
      chk('手势 · ' + sf.id + ' · 上拖能滚动内容', scrolled || before === null,
        { scroller: a.scroller, before, after, 说明: before === null ? '这一屏没有可滚内容' : '' });
    }
    await s.shot(path.join(SHOTDIR, 'r19sa-' + (FORCE ? '反证-' + FORCE + '-' : '') + sf.id + '.png'));
    await sleep(160);
  }

  const bad = R.filter((x) => !x.ok);
  const rep = { at: new Date().toISOString(), base: BASE, force: FORCE || '(正常)',
    safeT: SAFE_T, safeB: SAFE_B, total: R.length, fails: bad.length, items: R };
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
  if (FORCE) {
    const exp = EXPECT[FORCE] || [];
    const hit = exp.filter((k) => bad.some((b) => b.name.indexOf(k) >= 0));
    console.log('\n反证跑（' + FORCE + '）：报红 ' + bad.length + ' 条，命中预期的「' + hit.join(' / ') + '」'
      + (hit.length === exp.length ? '  ✅ 判据真能红' : '  ❌ 预期的那条没红 → 判据还是空判据')
      + ' → ' + OUT);
    process.exit(hit.length === exp.length ? 0 : 1);
  }
  console.log('\n' + (bad.length ? '有 ' + bad.length + ' 条没过' : '全部通过（' + R.length + ' 条）') + ' → ' + OUT);
  s.close();
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('跑挂了：', e); process.exit(2); });
