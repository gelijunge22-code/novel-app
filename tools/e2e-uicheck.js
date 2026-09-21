/* ============================================================
   e2e-uicheck.js — 全站 UI 硬判据（第 19 轮）

   为什么有这东西：用户点名的两类毛病，靠肉眼永远挑不干净 ——
     「跟随系统被挤成两行」「点击热区太小按不准」「内容顶出屏幕」「弹层生硬跳变」。
   所以做成**机器判据**（能报红的那种），跟 e2e-night.js 共用同一份屏/面板清单（tools/surfaces.js）。

   判 5 件事（每条都能报红）：
     ① 文字断行：**控件里**的字被折成两行（按钮/分段/步进器/页签里出现多行文字）。
        —— 用户原话："『跟随系统』被挤成两行，断成『跟随系/统』，最刺眼。"
     ② 点击热区：所有按钮 / [data-act] / 页签 / [data-q] 的可点区域必须 ≥44×44
        （移动端硬标准；::after 撑出来的隐形热区也算数）。
     ③ 横向溢出：任何可见元素不许顶出屏幕（±1px 容差），
        且 document.scrollWidth 不许超过视口宽（页面能左右晃就是溢出）。
     ④ 居中件：`.rd-quick-grab` 这类"抓手"必须在容器正中（偏差 >2px 判红）。
     ⑤ 动效：弹层/面板必须有过渡（transition/animation），不许生硬跳变。

   反证开关（判据必须先能报红）：
     UICHK_FORCE=wrap   把分段控件的宽度掐到 40px → ① 必须报红
     UICHK_FORCE=small  把步进器按钮掐成 18px 并去掉 ::after → ② 必须报红
     UICHK_FORCE=wide   强塞一个 600px 宽的元素 → ③ 必须报红

   用法：node tools/e2e-uicheck.js
   产出：docs/UI体检实测.json（+ r19ui-* 截图）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');
const { READER_OPEN, CHROME, SCREENS, OVERLAYS, toolSurfaces } = require('./surfaces');

const ROOT = '/home/ubuntu/novel-app';
const SHOTDIR = path.join(ROOT, 'docs/前端截图');
const ROUND = process.env.UICHK_ROUND || 'r19ui';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const FORCE = process.env.UICHK_FORCE || '';
let password = '';
try { password = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
catch (e) { /* 没配置就登不进去，跑不了 */ }

/* 每个屏/面板/弹层上要跑的那套判据（一个探针搞定，少来回） */
const AUDIT = (rootSels) => `(() => {
  const SELS = ${JSON.stringify(rootSels)};
  const roots = SELS.map((q) => document.querySelector(q)).filter((x) => !!x);
  if (!roots.length) return { err: '没有根元素 ' + SELS.join(' / ') };
  const W = window.innerWidth, H = window.innerHeight;
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0.5 && r.height > 0.5 && cs.visibility !== 'hidden' && cs.display !== 'none'
      && parseFloat(cs.opacity) > 0.15; };
  const name = (el) => { const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
    return el.tagName.toLowerCase() + id + cls; };
  /* 「横滑容器里的东西本来就该溢出」—— 但**不能拿 overflow-x:auto 当证据**：
     纵向滚动的面板（overflow-y:auto）按规范会把 overflow-x 也算成 auto，
     于是"面板里塞了个 600px 的宽元素"这种真溢出会被当成"横滑容器"放过去 ——
     第 19 轮实测：UICHK_FORCE=wide 反证跑**报绿**，整条判据是空判据（跟监督人抓 H4 一个套路）。
     改成**显式声明**：只有祖先挂了 [data-hscroll] 才放行（真做横滑条的自己声明一下）。 */
  const hscrollIntent = (el) => { let n = el.parentElement;
    while (n && n.nodeType === 1) { if (n.hasAttribute && n.hasAttribute('data-hscroll')) return true;
      n = n.parentElement; }
    return false; };
  /* 反证用：真塞一个 600px 宽的元素（伪元素扫不到，见上面 e2e-uicheck 里的注释） */
  let inj = null;
  if (window.__uichkWide && roots.length) {
    document.querySelectorAll('#__uichk-wide').forEach((e) => e.remove());   // 上一屏塞的那个先撤掉
    inj = document.createElement('div');
    inj.id = '__uichk-wide';
    inj.setAttribute('style', 'width:600px;height:40px;background:rgba(255,0,0,.2)');
    roots[0].appendChild(inj);
  }
  const all = [];
  roots.forEach((R) => R.querySelectorAll('*').forEach((el) => all.push(el)));
  const res = { root: SELS.join('+'), checked: all.length,
    overflow: [], wrap: [], hot: [], center: [], anim: [], radius: [] };

  /* ① 文字断行 —— 只看**控件里**的字 */
  const CTL = 'button, .seg, .stepper, .rd-qbtn, .tab, .t-btn, .pseg, .mode-seg, .settings-row .k, .stepper .v';
  for (const el of all) {
    if (!vis(el)) continue;
    const ctl = el.closest(CTL);
    if (!ctl) continue;
    /* 说明性的小字（<small>、.hint、副标题那种）不是"控件标签"：
       控件标签被折成两行是毛病（用户点名的「跟随系统」），
       而"只写视角人物知道的事"这种一句说明本来就该换行 —— 不在这条判据的范围里。 */
    if (el.matches('small, em, .hint, .sub, .desc, .meta, .tr-sub, .al-meta, .pseg-hint, .tx, .pc')) continue;
    let txt = '';
    for (const k of el.childNodes) if (k.nodeType === 3) txt += k.nodeValue;
    txt = txt.replace(/\\s+/g, ' ').trim();
    if (!txt) continue;
    let inner = false;                      /* 只看最里层：父元素身上的字跟子元素的字颜色/行数可能不是一回事，
                                               量父的就会报出"父的颜色对不上子的像素"这种假红 */
    for (const c of el.children) {
      for (const k of c.childNodes) if (k.nodeType === 3 && k.nodeValue.trim()) { inner = true; break; }
      if (inner) break;
    }
    if (inner) continue;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.4);
    const r = el.getBoundingClientRect();
    /* 只量**文字自己**折没折行：以前 selectNodeContents(el) 会把里面的 <svg> 图标也算一段，
       于是"图标一行 + 文字一行"天生两段 → 页签 / 图标按钮被整片冤枉成断行
       （实测 41 条里绝大多数是这种）。用户说的「跟随系统被挤成两行」是**文字自己**被折。
       所以：逐个文字节点量它自己的 rect 数，取最大那个才是真行数。 */
    let lines = 1;
    try {
      const tn = [];
      el.childNodes.forEach((k) => { if (k.nodeType === 3 && k.nodeValue.trim()) tn.push(k); });
      if (!tn.length) { const rg = document.createRange(); rg.selectNodeContents(el); lines = Math.max(1, rg.getClientRects().length); }
      else {
        let mx = 1;
        tn.forEach((t) => { const rg = document.createRange(); rg.selectNodeContents(t); mx = Math.max(mx, rg.getClientRects().length); });
        lines = mx;
      }
    } catch (e) { lines = Math.max(1, Math.round(r.height / lh)); }
    if (lines > 1 && r.height > lh * 1.6) {
      res.wrap.push({ t: txt.slice(0, 24), el: name(el), ctl: name(ctl), lines: lines,
        w: Math.round(r.width), h: Math.round(r.height), fs: cs.fontSize });
    }
  }

  /* ② 点击热区 ≥44×44（::after 撑出来的隐形热区也算） */
  const HOT = 'button, [data-act], .tab, [data-q], [role="button"], a[href]';
  for (const el of all) {
    if (!vis(el)) continue;
    if (!el.matches(HOT)) continue;
    const r = el.getBoundingClientRect();
    let w = r.width, h = r.height;
    try {
      const ps = getComputedStyle(el, '::after');
      if (ps && ps.position === 'absolute' && ps.content && ps.content !== 'none') {
        const px = (v) => (v && v.endsWith('px') ? parseFloat(v) : 0);
        const l = px(ps.left), rr = px(ps.right), t = px(ps.top), b = px(ps.bottom);
        if (l < 0) w += -l; if (rr < 0) w += -rr;
        if (t < 0) h += -t; if (b < 0) h += -b;
        if (ps.width && ps.width.endsWith('px') && parseFloat(ps.width) > w) w = parseFloat(ps.width);
        if (ps.height && ps.height.endsWith('px') && parseFloat(ps.height) > h) h = parseFloat(ps.height);
      }
    } catch (e) { /* 伪元素读不到就算视觉尺寸 */ }
    if (w < 44 || h < 44) {
      res.hot.push({ el: name(el), w: Math.round(w), h: Math.round(h),
        txt: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 16) });
    }
  }

  /* ③ 横向溢出 */
  const docOver = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (docOver > 1) res.overflow.push({ el: '(整页)', why: '页面能左右晃 ' + docOver + 'px' });
  for (const el of all) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= W - 1 && r.height >= H - 1) continue;            // 整屏容器不看
    if (r.right > W + 1 || r.left < -1) {
      if (hscrollIntent(el)) continue;                              // 只有显式声明 [data-hscroll] 的横滑容器才放行
      if (res.overflow.length > 12) break;
      res.overflow.push({ el: name(el), left: Math.round(r.left), right: Math.round(r.right), W: W,
        txt: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 16) });
    }
  }

  /* ④ 居中件（抓手条这类） */
  for (const el of all) {
    if (!/\b(grab|center-line|handle)\b/.test(el.className || '')) continue;
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    const host = el.parentElement.getBoundingClientRect();
    const off = Math.abs((r.left + r.width / 2) - (host.left + host.width / 2));
    if (off > 2) res.center.push({ el: name(el), off: Math.round(off * 10) / 10 });
  }

  /* ⑤ 动效：弹层/面板必须有过渡（不许生硬跳变） */
  for (const sel of ['.sheet-panel', '.modal-panel', '.rd-quick', '.tools-grid', '.shelf-list']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const cs = getComputedStyle(el);
    const dur = (cs.transitionDuration || '0s').split(',').map((x) => parseFloat(x) || 0);
    const ldur = (cs.animationName && cs.animationName !== 'none')
      ? (parseFloat(cs.animationDuration) || 0) : 0;
    if (Math.max.apply(null, dur.concat([ldur])) <= 0) res.anim.push({ el: sel, why: '没有任何过渡/动画' });
  }
  return res;
})()`;

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const s = await open({ port: 9389, width: 390, height: 844, settle: 900 });
  const js = s.js;
  let tNav = Date.now();
  await s.nav(BASE + '?uichk=' + Date.now());
  for (let i = 0; i < 40; i++) {
    const gone = await js("(()=>{const sp=document.getElementById('splash');return !!(sp&&(sp.classList.contains('gone')||getComputedStyle(sp).opacity==='0'));})()");
    if (gone) break;
    await sleep(120);
  }
  if (await js("document.getElementById('login') && !document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(password)
      + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4200);
  }
  if (FORCE) {
    const css = FORCE === 'wrap'
      ? '.seg button{width:40px !important;max-width:40px !important;overflow-wrap:anywhere !important}'
      : FORCE === 'small'
        ? '.stepper button{width:18px !important;height:18px !important} .stepper button::after{display:none !important}'
        : '';
    if (css) {
      await js("(()=>{const st=document.createElement('style');st.textContent=" + JSON.stringify(css)
        + ";document.head.appendChild(st);return 1})()");
    }
    if (FORCE === 'wide') {
      /* ⚠ 这里以前是 `body::after{width:600px…}` —— **伪元素不在 DOM 里**，
         而判据是 `root.querySelectorAll('*')` 一路扫下来的，永远扫不到它 → 反证跑报绿、
         整条「横向溢出」判据**是空判据**（第 19 轮自己抓出来的，跟监督人抓 H4 同一个套路：
         判据先得能红）。现在改成每个面板里真塞一个 600px 宽的 div，量完再撤掉。 */
      await js("window.__uichkWide=1");
      console.log('  ⚠ 反证模式 UICHK_FORCE=wide：每个面板里真塞一个 600px 宽的元素（判据必须报红）');
    } else if (FORCE) {
      console.log('  ⚠ 反证模式 UICHK_FORCE=' + FORCE + '（判据必须报红）');
    }
  }
  const ids = await js("(()=>{try{return (window.Tools.TOOLS||[]).map(t=>t.id);}catch(e){return [];}})()") || [];
  let all = SCREENS.concat(OVERLAYS).concat(toolSurfaces(ids));
  /* UICHK_ONLY=reader,chat 只跑这几屏 —— 全站 44 屏一次要三四分钟，
     分批跑省内存也省时间（3.6G 的机器上别把 chrome 挂太久）。 */
  const ONLY = (process.env.UICHK_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (ONLY.length) all = all.filter((sf) => ONLY.indexOf(sf.id) >= 0);
  const report = { at: new Date().toISOString(), base: BASE, force: FORCE, surfaces: [], fails: [] };
  for (const sf of all) {
    const roots = [sf.root].concat(sf.extra || []);
    const rec = { id: sf.id, root: roots.join('+'), shot: '', res: null, notes: [] };
    const opened = await js(sf.open);
    if (!opened) { rec.notes.push('打不开（跳过）'); report.surfaces.push(rec); continue; }
    await sleep(sf.settle || 800);
    const name = [ROUND, sf.file].join('-') + '.png';
    await s.shot(path.join(SHOTDIR, name));
    rec.shot = name;
    /* AUDIT() 返回的已经是一个自执行表达式（`(() => {…})()`）——
       以前在这里又套了一层 `(...)()` → 变成「把返回的对象当函数调」，每个面板都抛
       `TypeError: (intermediate value)(…) is not a function`，探针全废。 */
    const r = await js(AUDIT(roots));
    rec.res = r;
    if (!r || r.err) rec.notes.push((r && r.err) || '探针没结果');
    else {
      const bad = r.wrap.length + r.hot.length + r.overflow.length + r.center.length + r.anim.length;
      if (r.wrap.length) rec.notes.push('断行 ' + r.wrap.length + ' 处');
      if (r.hot.length) rec.notes.push('热区不够 ' + r.hot.length + ' 处');
      if (r.overflow.length) rec.notes.push('溢出 ' + r.overflow.length + ' 处');
      if (r.center.length) rec.notes.push('没居中 ' + r.center.length + ' 处');
      if (r.anim.length) rec.notes.push('没动效 ' + r.anim.length + ' 处');
      rec.bad = bad;
    }
    console.log('  · ' + sf.id.padEnd(22) + (rec.notes.length ? ' ✗ ' + rec.notes.join('，') : ' ✓ 干净'));
    if (sf.close) await js(sf.close);
    await sleep(240);
    report.surfaces.push(rec);
  }
  /* 汇总：把"每个问题是什么"摊平，方便一条条修 */
  const flat = { wrap: [], hot: [], overflow: [], center: [], anim: [] };
  for (const rec of report.surfaces) {
    const r = rec.res; if (!r || r.err) continue;
    for (const k of Object.keys(flat)) for (const it of (r[k] || [])) flat[k].push(Object.assign({ surface: rec.id }, it));
  }
  report.flat = flat;
  report.sum = Object.keys(flat).reduce((o, k) => { o[k] = flat[k].length; return o; }, {});
  report.ok = Object.keys(flat).every((k) => flat[k].length === 0);
  s.close();
  /* 反证的产出单独存：不然后跑的会把前一条反证的证据盖掉（e2e-cover 踩过同一个坑）。 */
  /* 分批跑（UICHK_ONLY）时给每批一个自己的文件名，别互相盖掉 —— 第 19 轮吃过这个亏：
     反证的产出把正跑的图/报告整批覆盖，回头谁都说不清哪张是哪次。 */
  const SUF = (process.env.UICHK_ONLY || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 20);
  const outName = process.env.UICHK_OUT ||
    (FORCE ? ('docs/UI体检实测-反证-' + FORCE + (SUF ? '-' + SUF : '') + '.json')
           : 'docs/UI体检实测' + (SUF ? '-分批-' + SUF : '') + '.json');
  fs.writeFileSync(path.join(ROOT, outName), JSON.stringify(report, null, 1));
  console.log('\n汇总：' + JSON.stringify(report.sum) + ' → ' + outName);
  process.exit(report.ok ? 0 : 1);
})();
