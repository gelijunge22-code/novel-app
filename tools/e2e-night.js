/* ============================================================
   e2e-night.js — 夜间/日间全站体检（第 19 轮）

   为什么有这东西：
     用户报过两次「夜间环境下最明显」的毛病（弹层白边、看不清的小字）。
     之前只做了**弹层四角**（20 组）和**静态变量矩阵**（tools/verify_contrast.py）——
     静态工具只看 CSS 变量，看不到"真画到屏上的每个面板、每个弹层、每个状态"长什么样。
     这个脚本补的就是那一段：**真打开、真渲染、真截图、真量对比度**。

   怎么判（两边各算一遍，互相盯着）：
     A. 页面里用 getComputedStyle 读出**每个可见文字叶节点**的前景色 + 它真正压着的底色
        （往上找第一个不透明底），按 WCAG 2.1 算对比度。门槛见 tools/night_check.py。
     B. Python 侧从**截图的真实像素**里再算一遍（裁剪该节点的矩形 → 最常见色 = 底、
        最偏离底的色 = 字），跟 A 比：A 说达标、B 说画出来看不清 → 报红。
        （只信 CSS 会骗自己：渐变/蒙层/半透明底都会让"算出来的底色"跟真画的不一样。）

   覆盖面：7 个屏 + 4 个弹层 + 全部工具子面板 × {日间 paper, 夜间 night}。
   反证（判据必须先能报红，绿才算数）：
     NIGHT_FORCE=dim    把夜间主题的 --ink-3/--ink-2 强改成看不清的灰 → 必须报红
     NIGHT_FORCE=stuck  故意不切主题（说是夜间、实际还是日间）→ 每组必须被标"不算数"并报红

   用法：node tools/e2e-night.js
   产出：docs/前端截图/r19-*.png + docs/夜间体检实测.json（→ tools/night_check.py 出判定）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');

const ROOT = '/home/ubuntu/novel-app';
/* 截图存哪儿。⚠ 反证跑**必须**换一个目录（NIGHT_SHOTS）：
   第 19 轮踩过 —— 反证只换了 JSON 的输出路径，截图还写进 docs/前端截图/r19-*，
   把正跑的图**整批盖掉**（正跑 9 条红 → 复查时突然 44 条红，因为它量的是被反证弄坏的图）。
   跟 e2e-cover / e2e-uicheck 的"反证产出分开存"是同一条规矩：证据不许互相覆盖。 */
const SHOTDIR = path.join(ROOT, process.env.NIGHT_SHOTS || 'docs/前端截图');
const ROUND = process.env.NIGHT_ROUND || 'r19';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const FORCE = process.env.NIGHT_FORCE || '';
const ONLY = process.env.NIGHT_ONLY || '';            // 只跑某个 surface（调试用）
const FROM = Number(process.env.NIGHT_FROM || 0);     // 从第几个 surface 开始（断点续跑用）
const TO = Number(process.env.NIGHT_TO || 1e9);       // 跑到第几个为止（不含）
const SKIP_DONE = !!process.env.NIGHT_SKIP_DONE;  // 已经量过（有图）的 surface 直接跳过 = 自己续跑
const SKIP_TOOLS = !!process.env.NIGHT_SKIP_TOOLS;
const THEMES = (process.env.NIGHT_THEMES || 'paper,night').split(',');
const CN = { paper: '日间', night: '夜间', white: '纸白', sepia: '暖褐', slate: '青灰', green: '护眼' };

function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}

/* ── 屏 / 弹层 / 工具面板清单：全部走**真实交互路径**打开（不自己拼 DOM）── */
/* 屏 / 弹层 / 面板清单在 tools/surfaces.js —— 跟 UI 体检脚本共用同一份，别另抄 */
const { READER_OPEN, CHROME, SCREENS, OVERLAYS, toolSurfaces } = require('./surfaces');

/* 等页面上的动画都停下来再拍。
   为什么要等：上一版直接拍，抓到了正在滑入的面板 —— 截图里那行字在 A 位置，
   量取时元素已经滑到 B 位置，于是裁出来的是背景色，报出"1.1:1 看不清"的**假红**
   （真查下去会发现那几个字其实是 11.55:1，清清楚楚）。 */
const WAIT_ANIM = `(async () => { const t0 = Date.now();
  const busy = () => (document.getAnimations ? document.getAnimations() : []).some((a) =>
    a.playState === 'running' && !(a.effect && a.effect.target && a.effect.target.id === 'toast'));
  while (busy() && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 60));
  await new Promise((r) => setTimeout(r, 80)); return 1; })()`;

/** 两次量取的矩形是不是一致（±1px）—— 一致才说明"截图那一刻的样子就是量到的样子" */
function sameBox(a, b) {
  const A = (a && a.items) || [], B = (b && b.items) || [];
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) {
    if (Math.abs(A[i].x - B[i].x) > 1 || Math.abs(A[i].y - B[i].y) > 1
      || Math.abs(A[i].w - B[i].w) > 1 || Math.abs(A[i].h - B[i].h) > 1) return false;
  }
  return true;
}

/* 一个元素里所有可见文字叶节点的前景/底色（**页面侧**，A 判据） */
const PROBE = (rootSels) => `(() => {
  const SELS = ${JSON.stringify(rootSels)};
  const ROOTS = SELS.map((q) => document.querySelector(q)).filter((x) => !!x);
  const H = window.innerHeight;
  if (!ROOTS.length) return { err: '没有根元素 ' + SELS.join(' / ') };
  const parse = (s) => { const m = String(s||'').match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v));
    return { r: p[0], g: p[1], b: p[2], a: (p.length > 3 ? p[3] : 1) }; };
  /* 只量**整格都在屏幕里**的元素。半截在屏幕外的（滚动区里还没滚到的那部分）裁出来是别的东西 ——
     上一版就是这么量出一堆"假红"：说某个字 1.1:1 看不清，其实那个位置压根不是那行字。 */
  /* 这块矩形**真的露在屏幕上**吗？
     两条都要过：
       ① 在视口里（0..W / 0..H）；
       ② **没有被滚动容器裁掉**：滚动区的可视矩形跟它求交，交集要盖住 ≥85%。
     为什么非加第②条：getBoundingClientRect() 给的是**没被裁过**的框 ——
     面板里滚出去的那些行，坐标还在屏幕外/边缘，上一版照坐标去裁像素，
     裁到的是别的东西，于是报出一堆"文字在屏幕上找不到"的**假红**。 */
  const clipOk = (el, r) => {
    let box = { l: 0, t: 0, rr: 390, bb: H };
    let n = el.parentElement;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'hidden'
        || cs.overflow === 'auto' || cs.overflow === 'scroll' || cs.overflow === 'hidden') {
        const cr = n.getBoundingClientRect();
        box.l = Math.max(box.l, cr.left); box.t = Math.max(box.t, cr.top);
        box.rr = Math.min(box.rr, cr.right); box.bb = Math.min(box.bb, cr.bottom);
      }
      n = n.parentElement;
    }
    const w = Math.max(0, Math.min(r.right, box.rr) - Math.max(r.left, box.l));
    const h = Math.max(0, Math.min(r.bottom, box.bb) - Math.max(r.top, box.t));
    return (w * h) >= r.width * r.height * 0.85;
  };
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none'
      && parseFloat(cs.opacity) > 0.2
      && r.top >= -0.5 && r.left >= -0.5 && r.bottom <= H + 0.5 && r.right <= 390.5
      && clipOk(el, r); };
  /* 底色：往上找第一个不透明 backgroundColor。
     但**底色不一定是 backgroundColor**：封面/书脊走的是 background-image（渐变或图），
     这时候"算出来的底色"跟真画在屏上的完全不是一回事 —— 要标出来（grad），
     交给 Python 侧从截图像素里再量一遍，那个才是真的。 */
  const bgOf = (el) => { let n = el; let grad = false;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') grad = true;
      const c = parse(cs.backgroundColor);
      if (c && c.a >= 0.95) {
        const nm = n.id ? ('#' + n.id) : (n.tagName.toLowerCase()
          + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).join('.') : ''));
        return { c: c, from: nm, grad: grad };
      }
      if (c && c.a > 0.05) grad = true;
      n = n.parentElement;
    }
    return { c: null, from: '(没有不透明底)', grad: grad }; };
  const items = [];
  const all = [];
  ROOTS.forEach((R) => { all.push(R); R.querySelectorAll('*').forEach((el) => all.push(el)); });
  for (let i = 0; i < all.length && items.length < 140; i++) {
    const el = all[i];
    if (!vis(el)) continue;
    let txt = '';
    for (const k of el.childNodes) if (k.nodeType === 3) txt += k.nodeValue;
    txt = txt.replace(/\\s+/g, ' ').trim();
    if (!txt) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const bg = bgOf(el);
    /* 这行字**是不是被别的东西压在下面**？
       压住了就不能拿它当判据：探针按矩形去截图里找"字色像素"，找到的其实是压在上面那层的字
       （第 19 轮那 3 条"看不清"就是这么来的：#preset-save 那条常驻保存栏压在正文行上，
       量出来 1.97:1 是"保存栏里的灰字"跟卡片底的对比度，跟那行正文一点关系都没有）。
       判法：命中测试，看这条元素上面还盖着谁 —— 盖着的既不是它自己、也不是它的祖先/子孙，就算被压。
       （"被压住"这件事本身有没有 bug，由 tools/e2e-cover.js 那条判据管，这里只负责**不瞎量**。） */
    const cover = (() => {
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > 390 || cy > H) return '';
      let stack = [];
      try { stack = document.elementsFromPoint(cx, cy) || []; } catch (e) { return ''; }
      const i = stack.indexOf(el);
      if (i <= 0) return '';
      for (let k = 0; k < i; k++) {
        const o = stack[k];
        if (!o || el.contains(o) || o.contains(el)) continue;
        return o.id ? ('#' + o.id) : (o.tagName.toLowerCase()
          + (typeof o.className === 'string' && o.className.trim() ? '.' + o.className.trim().split(/\\s+/)[0] : ''));
      }
      return '';
    })();
    items.push({ t: txt.slice(0, 30), tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 64),
      fg: cs.color, fs: Math.round(parseFloat(cs.fontSize) * 10) / 10, fw: cs.fontWeight,
      ls: cs.letterSpacing,
      bg: (bg && bg.c) ? ('rgb(' + Math.round(bg.c.r) + ',' + Math.round(bg.c.g) + ',' + Math.round(bg.c.b) + ')') : '',
      bgFrom: bg ? bg.from : '?', grad: !!(bg && bg.grad),
      disabled: !!(el.closest && el.closest('[disabled],[aria-disabled="true"],.off,.is-disabled')),
      cover: cover,
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  }
  const rootCs = getComputedStyle(document.documentElement);
  return { root: SELS.join('+'), theme: document.documentElement.dataset.theme,
    paperVar: rootCs.getPropertyValue('--paper').trim(),
    cardVar: rootCs.getPropertyValue('--card').trim(),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    count: items.length, items: items };
})`;   /* 末尾只到 `})`：调用处拼 '(' + PROBE(sel) + ')()' 才是完整 IIFE */   /* 末尾**不带** `()`：调用处统一拼 '(' + PROBE(sel) + ')()'，两边都带就变成 })())() 直接报错的空探针 */

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const s = await open({ port: 9388, width: 390, height: 844, settle: 900 });
  const js = s.js;
  const report = { at: new Date().toISOString(), base: BASE, force: FORCE, themes: THEMES,
                   surfaces: [], notes: [], fails: [] };
  let tNav = Date.now();
  await s.nav(BASE + '?night=' + Date.now());
  /* 启动页要**真退场**再拍照（第 15 轮监督人抓的"四张截图都是启动页"就是这么来的） */
  let splashMs = -1;
  for (let i = 0; i < 40; i++) {
    const gone = await js("(()=>{const sp=document.getElementById('splash');return !!(sp&&(sp.classList.contains('gone')||getComputedStyle(sp).opacity==='0'));})()");
    if (gone) { splashMs = Date.now() - tNav; break; }
    await sleep(120);
  }
  report.splashMs = splashMs;
  if (await js("document.getElementById('login') && !document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword())
      + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4200);
  }
  const loginShown = await js("!!(document.getElementById('login') && !document.getElementById('login').classList.contains('hidden'))");
  report.loginShown = loginShown;

  /* 工具 id 从页面里现读（不许在脚本里另抄一份清单，抄了就会两套不一致） */
  const ids = await js("(()=>{try{return (window.Tools.TOOLS||[]).map(t=>t.id);}catch(e){return [];}})()");
  report.toolIds = ids || [];
  global.__TOOLIDS__ = (ids || []).map((x) => ({ id: x }));
  const all = SCREENS.concat(OVERLAYS).concat(SKIP_TOOLS ? [] : toolSurfaces());

  /* 反证开关：让判据**先能报红** */
  if (FORCE === 'dim') {
    await js("(()=>{const st=document.createElement('style');st.textContent="
      + JSON.stringify('html[data-theme="night"]{--ink-3:#3b3b3b !important;--ink-2:#4a443c !important;}')
      + ";document.head.appendChild(st);return 1})()");
    report.notes.push('反证模式 NIGHT_FORCE=dim：夜间 --ink-3/--ink-2 被强改成看不清的灰，必须报红');
    console.log('  ⚠ 反证模式 NIGHT_FORCE=dim（判据必须报红）');
  }
  if (FORCE === 'cover') {
    await js("(()=>{const d=document.createElement('div');d.id='night-force-cover';"
      + "d.style.cssText='position:fixed;left:0;top:0;right:0;bottom:0;z-index:99998;"
      + "background:rgba(250,250,250,0.04)';document.body.appendChild(d);return 1})()");
    report.notes.push('反证模式 NIGHT_FORCE=cover：整屏盖了一层（几乎看不见但会挡命中测试）——'
      + '探针必须把它记成"被压住"，于是每条都变成"量不准"，判据必须报红（不许静默放过）');
    console.log('  ⚠ 反证模式 NIGHT_FORCE=cover（判据必须报红）');
  }
  if (FORCE === 'stuck') {
    report.notes.push('反证模式 NIGHT_FORCE=stuck：故意不切主题，每组必须被判"不算数/红"');
    console.log('  ⚠ 反证模式 NIGHT_FORCE=stuck（判据必须报红）');
  }

  const wantTheme = async (theme) => {
    if (FORCE === 'stuck') return (await js('document.documentElement.dataset.theme')) === theme ? 'ok' : 'stuck';
    for (let i = 0; i < 3; i++) {
      await js("(async()=>{ try{Prefs.set('theme','" + theme + "');}catch(e){document.documentElement.dataset.theme='"
        + theme + "';} await new Promise(r=>setTimeout(r,240)); return 1; })()");
      await sleep(180);
      if ((await js('document.documentElement.dataset.theme')) === theme) return 'ok';
    }
    return 'fail';
  };

  /* ── 落盘（每量完一组就写一次）───────────────────────────────
     为什么：这一轮跑到一半被环境杀掉（两次都这样），旧版只在最后写一次文件 →
     52 组数据和 100 多张截图全白跑。现在**增量落盘 + 合并**：
     这轮跑到的覆盖旧记录，没跑到的保留旧的 → 可以 NIGHT_FROM/NIGHT_TO 分段续跑。 */
  const OUT = path.join(ROOT, process.env.NIGHT_OUT || 'docs/夜间体检实测.json');
  function flush(quiet) {
    let old = null;
    try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { old = null; }
    const mine = new Set(report.surfaces.map((r) => r.id));
    const keep = (old && old.surfaces ? old.surfaces : []).filter((r) => !mine.has(r.id));
    const out = Object.assign({}, old || {}, report, { surfaces: keep.concat(report.surfaces) });
    try { fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); } catch (e) {}
    if (!quiet) console.log('  （已落盘：本轮 ' + report.surfaces.length + ' 组 + 留存 '
      + keep.length + ' 组 = ' + (keep.length + report.surfaces.length) + ' 组）');
  }
  process.on('unhandledRejection', (e) => {
    console.log('  ⚠ 未处理的异常（记一笔继续，别整轮死掉）：' + ((e && e.message) || e)); });
  /* 已经量过的不再量：读现有 json（上次被杀之前落盘的那份），有图就跳 → 反复跑会自己收敛。 */
  let doneSet = new Set();
  if (SKIP_DONE) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      const need = {};
      all.forEach((x) => { need[x.id] = THEMES.length; });
      const got = {};
      (prev.surfaces || []).forEach((r) => { if (r.shot) got[r.id] = (got[r.id] || 0) + 1; });
      Object.keys(need).forEach((k) => { if ((got[k] || 0) >= need[k]) doneSet.add(k); });
      console.log('  续跑模式：已有完整数据的 ' + doneSet.size + ' 组直接跳过');
    } catch (e) { console.log('  续跑模式：读不到旧数据（' + e.message + '），全量跑'); }
  }
  let gi = -1, skipped = 0;
  for (const sf of all) {
    gi++;
    if (ONLY && sf.id !== ONLY) continue;
    if (gi < FROM || gi >= TO) continue;
    if (SKIP_DONE && doneSet.has(sf.id)) { skipped++; continue; }
    for (const theme of THEMES) {
      const rec = { id: sf.id, file: sf.file, theme, title: sf.id, shot: '', probe: null, notes: [] };
      const t0 = Date.now();
      const t1 = await wantTheme(theme);
      if (FORCE === 'stuck' && theme !== 'paper') { rec.notes.push('反证：主题没切（stuck）'); }
      const opened = await js(sf.open);
      if (!opened) { rec.notes.push('打不开（跳过）'); report.surfaces.push(rec); flush(true); continue; }
      await sleep(sf.settle || 800);
      /* 打开这个屏本身可能把主题顶回去（阅读器会按书的阅读底色重画）→ 开完再核一次 */
      const applied = await js('document.documentElement.dataset.theme');
      if (applied !== theme) {
        const again = await wantTheme(theme);
        await sleep(300);
        rec.notes.push('开完再切主题：' + again);
        if (FORCE === 'stuck') { /* 反证：就该不一致 */ }
      }
      const name = [ROUND, sf.file, CN[theme] || theme].join('-') + '.png';
      const roots = [sf.root].concat(sf.extra || []);
      /* 量 → 拍 → 再量：两次量到的矩形一样，才说明这张照片就是这组数据的样子。
         不一样就重来（最多三次），三次都没稳住就如实记一笔，不假装量准了。 */
      let pr = null, pre = null, tries = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        await js(WAIT_ANIM);
        pre = await js('(' + PROBE(roots) + ')()');
        await s.shot(path.join(SHOTDIR, name));
        tries++;
        pr = await js('(' + PROBE(roots) + ')()');
        if (sameBox(pre, pr)) break;
        await sleep(360);
      }
      rec.shot = name; rec.tries = tries; rec.probe = pr;
      if (!sameBox(pre, pr)) rec.notes.push('三次都没稳住（拍的跟量的对不上）');
      rec.themeApplied = await js('document.documentElement.dataset.theme');
      const n = pr && pr.count ? pr.count : 0;
      rec.ms = Date.now() - t0;
      console.log('  · ' + sf.id.padEnd(22) + ' @ ' + theme.padEnd(6) + ' 文字节点 ' + String(n).padStart(3)
        + '  theme=' + rec.themeApplied + '  ' + String(rec.ms).padStart(6) + 'ms'
        + (rec.notes.length ? '  [' + rec.notes.join('; ') + ']' : ''));
      if (sf.close) await js(sf.close);
      await sleep(240);
      report.surfaces.push(rec);
      flush(true);
    }
  }
  /* 收尾：别把 webview 停在后台跑动画 */
  await js("(()=>{try{App.closeSheet();}catch(e){} try{App.closeModal();}catch(e){} "
    + "try{App.show('shelf');}catch(e){} return 1;})()");
  s.close();
  flush(true);
  console.log('\n本轮走到 surface 序号 ' + gi + '（共 ' + all.length + ' 个）· 跳过已量过的 ' + skipped + ' 个');
  console.log('\n截图 ' + report.surfaces.filter((x) => x.shot).length + ' 张 → '
    + path.relative(ROOT, SHOTDIR) + '/' + ROUND + '-*');
  console.log('探针 → docs/夜间体检实测.json');
})();
