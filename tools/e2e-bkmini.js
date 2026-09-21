/* ============================================================
   e2e-bkmini.js — 「当前书」那一个入口（第 41 轮：形态**回到旧版**）

   ⚠ 第 41 轮用户改口（原话，一字不改）：「我想让那个就是**现在切换书不是一个小方块嘛，然后改回原来的
   样子**，**只要别穿模就行**」。所以这一轮把**旧版那一套形态**搬回来了（内容流里一行：
   收起 = 34×34 小方块 ⇄ 展开 = 「在写：xxx ▸ 切换」），顶栏那个方块删掉（只留一份实现）。
   —— 旧判据（"方块必须长在顶栏里"）是上一版的规格，用户改口后它**反了**，所以整条重写。

   但第 17 / 20 轮修掉的**两个毛病一条都不许带回来**（这三条是这一版的核心判据）：
     · 不许 sticky/fixed —— 用户原话「单独弄了一个图层……固定在那儿动不了」；
     · 不许自带底色 —— 「它是自己要了一条横线」；
     · 不许假占位（盒高 0 却溢出）—— 那会压到下面的字上（用户报的"穿模"）。

   要证的（全部量像素/量类名，不靠看图）：
     ① 内容流里那一行 `.bk-bar` 默认是**收起态**：正好一个 34×34 的小方块（`.bk-mini`）
     ② 那一行 **不 sticky / 不 fixed / 底透明 / 有真高度**（不是假占位）
     ③ 滚 400px 之后 ② 依然成立（治"固定在那儿动不了"）
     ④ 点小方块 → **展开**成「在写：书名 ▸ 切换」那一行（`.bk-chip`）
     ⑤ 点那一行 → 出切书面板，行数 = 架上本数，**恰好一行**标「正在写」
     ⑥ 在面板里点另一本 → 当前书真的换了 + 面板自动收回 + 那一行又收回小方块
     ⑦ 全站每一屏（书架/预设/设定/对话/工具宫格/设置/工具子面板）**重叠面积 = 0**
     ⑧ 收尾：当前书切回原来那本、书架跟跑之前逐本一致（自测不留痕）
     ⑨ 切回来之后那一行列的是**书名**（不是一串 slug 字母）

   跑法：
     node tools/e2e-bkmini.js                  # 正常（以上全绿）
     E2E_STICKY=1 node tools/e2e-bkmini.js     # 反证：把旧版的"钉住 + 自带底色 + 高一整行"打回去
                                              #       → ②③ **必须报红**（报绿 = 判据是空的）
     E2E_SLUGCHIP=1 node tools/e2e-bkmini.js   # 反证：切回来只塞 slug（那行就写一串英文）
                                              #       → ⑨ **必须报红**
     E2E_OVERLAP=1 node tools/e2e-bkmini.js    # 反证：把那一行硬拽出内容流、压在正文上
                                              #       → ⑦ **必须报红**
   报告：docs/切书小方块实测.json（反证：同名 -反证*.json）
   截图：docs/前端截图/r17-切书-*.png
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');
const { readPassword } = require('./preflight');

const ROOT = '/home/ubuntu/novel-app';
const SERVER = process.env.E2E_SERVER || 'http://127.0.0.1:8899/';
const OLD = process.env.E2E_OLDBAR === '1' || process.env.E2E_STICKY === '1';  // 反证：旧版的"钉住 + 横线"
const SLUGCHIP = process.env.E2E_SLUGCHIP === '1';   // 反证：切回来时只塞 slug、不塞书名
/* 反证：把这一行拽出内容流（absolute + 大块 + 高 z-index）硬压在正文上 → 「重叠面积 = 0」必须报红 */
const OVERLAP = process.env.E2E_OVERLAP === '1';
const OUT = path.join(ROOT, OLD ? 'docs/切书小方块实测-反证.json'
  : (SLUGCHIP ? 'docs/切书小方块实测-反证2.json'
    : (OVERLAP ? 'docs/切书小方块实测-反证3.json' : 'docs/切书小方块实测.json')));
const SHOTDIR = path.join(ROOT, (OLD || SLUGCHIP || OVERLAP) ? 'docs/截图判据反证' : 'docs/前端截图');
const tag = (n) => (OLD ? 'r17-切书-反证-' : (SLUGCHIP ? 'r17-切书-反证2-'
  : (OVERLAP ? 'r17-切书-反证3-' : 'r17-切书-'))) + n;
const SWEEP = '切书自测-临时';

let TOKEN = '';
async function api(method, p, body) {
  const r = await fetch(SERVER.replace(/\/$/, '') + p, {
    method, headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' },
      TOKEN ? { 'X-Token': TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
  if (d && d.token) TOKEN = d.token;
  return { status: r.status, data: d };
}

/* 穿模判据（用户原话：「切换小说的那个小方框，在 AI 对话那里……实实在在的穿模了」）：
   **那一行（含里面那个小方块）与其它可见元素的重叠面积必须为 0**。
   为什么机器判：肉眼得一张张扒着看，"看着像压住了"说不清；换成面积就是 0 或 >0，红绿分明。
   容器（包含它的那些祖先）和它自己的子元素不算。 */
const OVERLAP_PROBE = (sel) => '(function(){'
  + 'var sc=document.querySelector(' + JSON.stringify(sel) + ');if(!sc)return {err:"找不到这个屏"};'
  + 'var target=sc.querySelector(".bk-bar .bk-mini")||sc.querySelector(".bk-bar");'
  + 'if(!target)return {err:"这一屏没有切书那一行"};'
  + 'var c=target.getBoundingClientRect();'
  + 'function inter(a,b){var w=Math.min(a.right,b.right)-Math.max(a.left,b.left);'
  + 'var h=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);return (w>0&&h>0)?Math.round(w*h):0;}'
  + 'var hits=[],all=sc.querySelectorAll("*");'
  + 'for(var i=0;i<all.length;i++){var el=all[i];'
  + 'if(el===target||target.contains(el)||el.contains(target))continue;'
  + 'var cs=getComputedStyle(el);'
  + 'if(cs.display==="none"||cs.visibility==="hidden"||parseFloat(cs.opacity||"1")===0)continue;'
  + 'var bg=cs.backgroundColor,leaf=!el.childElementCount;'
  + 'var paints=leaf||!/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg)||parseFloat(cs.borderTopWidth)>0;'
  + 'if(!paints)continue;'
  + 'var r=el.getBoundingClientRect();if(r.width<2||r.height<2)continue;'
  + 'var a=inter(c,r);'
  + 'if(a>4)hits.push({tag:el.tagName.toLowerCase(),cls:String(el.className||"").slice(0,40),'
  + 'txt:(el.textContent||"").trim().slice(0,18),area:a});}'
  + 'return {chip:{x:Math.round(c.left),y:Math.round(c.top),w:Math.round(c.width),h:Math.round(c.height)},'
  + 'n:hits.length,hits:hits.slice(0,6)};})()';

const rep = { at: new Date().toISOString(), oldBar: OLD, slugChip: SLUGCHIP, overlapForce: OVERLAP, steps: [], problems: [] };
const step = (n, ok, d) => {
  rep.steps.push({ name: n, ok: !!ok, detail: d });
  console.log((ok ? '  ✓ ' : '  ✗ ') + n + ' — ' + JSON.stringify(d));
};

const SHIM = `(() => {
  const BASE = ${JSON.stringify(SERVER)};
  let tok = '';
  const call = (method, p, body) => {
    try {
      const x = new XMLHttpRequest();
      x.open(method || 'GET', BASE + String(p || '').replace(/^\\//, ''), false);
      x.setRequestHeader('Accept', 'application/json');
      if (tok) x.setRequestHeader('X-Token', tok);
      if (body) { x.setRequestHeader('Content-Type', 'application/json'); x.send(body); } else x.send();
      const txt = x.responseText || '';
      try { const j = JSON.parse(txt); if (j && j.token) tok = j.token; } catch (e) {}
      return JSON.stringify({ status: x.status, body: txt, error: '' });
    } catch (e) { return JSON.stringify({ status: 0, body: '', error: '连不上服务器：' + e }); }
  };
  window.NBApp = { request: (m, p, b) => call(m, p, b), base: () => BASE, token: () => tok,
    ready: () => true, localReady: () => false, ping: () => '{"ok":true,"bridge":true}' };
  window.Android = { getPlatform: () => 'android', getVersion: () => '2.0.4', getVersionCode: () => 24,
    localStatus: () => JSON.stringify({ mode: 'server', local: false, server: BASE, why: '' }),
    retry: () => {}, retryLocal: () => {}, downloadApk: () => {}, keepAlive: () => {},
    setThemePaper: () => {}, setStatusBar: () => {}, vibrate: () => {}, keepAwake: () => {},
    openSettings: () => {}, share: () => {}, exitApp: () => {}, serverCheck: () => '{"ok":true}' };
})();`;

/* 量"那一行到底长什么样"。判据全在这几个数上。 */
const PROBE = `(() => {
  const sc = document.querySelector('#screen-shelf');
  const bar = document.getElementById('shelf-book') ? document.getElementById('shelf-book').querySelector('.bk-bar') : null;
  const mini = bar ? bar.querySelector('.bk-mini') : null;
  const chip = bar ? bar.querySelector('.bk-chip') : null;
  const list = document.getElementById('shelf-list');
  const tb = sc ? sc.querySelector('.topbar') : null;
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.left), y: Math.round(b.top),
             bottom: Math.round(b.bottom) }; };
  const cs = bar ? getComputedStyle(bar) : null;
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
  return {
    topbarChips: document.querySelectorAll('.topbar .bk-mini[data-book-chip]').length,
    bars: document.querySelectorAll('#screen-shelf .bk-bar').length,
    miniCount: bar ? bar.querySelectorAll('.bk-mini').length : 0,
    bar: box(bar), barPos: cs ? cs.position : null, barBg: cs ? cs.backgroundColor : null,
    barH: bar ? Math.round(bar.getBoundingClientRect().height) : null,
    mini: box(mini), miniShown: vis(mini), chipShown: vis(chip),
    miniTitle: mini ? mini.title : '', chipTxt: chip ? chip.textContent.trim().slice(0, 40) : '',
    topbar: box(tb), list: box(list),
    listTop: list ? Math.round(list.getBoundingClientRect().top) : null,
    barBottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : null,
  };
})()`;

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const s = await open({ port: OLD ? 9391 : 9392, shims: [SHIM] });
  const js = (e) => s.js(e);
  const shot = (n) => s.shot(path.join(SHOTDIR, n));

  await s.nav('file://' + ROOT + '/apk/assets/www/index.html');
  await sleep(1200);
  await js("(()=>{const i=document.getElementById('login-pass');if(!i)return 0;i.value=" + JSON.stringify(readPassword()) +
    ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
  await sleep(1500);
  /* 反证：把**旧的**那一行 bar 打回去（钉在顶上 + 自带底色 + 撑成一整行）——
     这正是用户说的"单独一个图层、自己要了一条横线"。第 ②③ 条判据必须报红。 */
  if (OLD) {
    await js(`(()=>{const st=document.createElement('style');st.id='oldbar';
      st.textContent='.bk-bar{height:42px !important;background:var(--paper) !important;position:sticky !important;top:0 !important;z-index:6 !important}';
      document.head.appendChild(st);return 1})()`);
    console.log('  ⚠ 反证模式 E2E_STICKY=1：那一行已改回"钉住 + 自带底色 + 42px 高一整行"（②③ 必须报红）');
    await sleep(350);
  }

  const login = await api('POST', '/api/app/login', { password: readPassword() });
  const base0 = (await api('GET', '/api/shelf')).data || {};
  const BASE_SLUGS = (base0.projects || []).map((p) => p.slug);
  const before = await js('(()=>{try{return (window.BookCtx&&BookCtx.slug())||""}catch(e){return ""}})()');
  step('登录了，架上本来就有书（"当前书"有值）', !!before, { current: before, books: BASE_SLUGS.length });

  /* 先扫掉上一次崩掉留下的临时书（自测的书绝不许留在用户架上） */
  const swept = [];
  for (const p of (base0.projects || [])) {
    if (String(p.slug || '').indexOf(SWEEP) === 0) { await api('POST', '/api/book/delete', { slug: p.slug }); swept.push(p.slug); }
  }
  if (swept.length) step('清掉上一次崩掉留下的 ' + swept.length + ' 本临时书', true, swept);

  const mk = await api('POST', '/api/book', { title: SWEEP + '-' + Date.now() });
  const TMP = mk.data && mk.data.slug;
  step('建了一本临时书（用来验"点另一本真的切过去"）', !!TMP, { slug: TMP });
  const wipe = () => {
    if (!TMP) return;
    try {
      const args = ['-s', '-o', '/dev/null', '-X', 'POST', SERVER.replace(/\/$/, '') + '/api/book/delete',
        '-H', 'Content-Type: application/json', '--data', JSON.stringify({ slug: TMP })];
      if (TOKEN) args.push('-H', 'X-Token: ' + TOKEN);
      require('child_process').execFileSync('curl', args, { timeout: 8000 });
      console.log('  · 兜底：临时书已删（不留垃圾）');
    } catch (e) {}
  };
  process.on('SIGINT', () => { wipe(); process.exit(130); });
  process.on('SIGTERM', () => { wipe(); process.exit(143); });
  process.on('uncaughtException', (e) => { console.log('  ⚠ 崩了：' + (e && e.message)); wipe(); process.exit(1); });

  /* ── ① 那一行默认长什么样 ───────────────────────────────────────── */
  const a = await js(PROBE);
  rep.probe1 = a;
  step('那一行**只在内容流里一份**（顶栏那个旧方块一个都不许剩 —— 不许两套实现并存）',
    !!(a && a.topbarChips === 0 && a.bars === 1 && a.miniCount === 1),
    { 顶栏方块: a && a.topbarChips, 内容流里的行: a && a.bars, 行里的方块: a && a.miniCount });
  step('默认是**收起态**：就一个 ≈34×34 的小方块（展开那一行藏着）',
    !!(a && a.miniShown && !a.chipShown && a.mini && a.mini.w >= 28 && a.mini.w <= 40
      && a.mini.h >= 28 && a.mini.h <= 40),
    { mini: a && a.mini, 方块可见: a && a.miniShown, 展开行可见: a && a.chipShown });
  step('小方块上写着"当前书是哪本"（title 里有书名）', !!(a && /在写|当前书/.test(a.miniTitle || '')),
    { title: a && a.miniTitle });
  const barClear = !!(a && a.barBg && /rgba\(0, 0, 0, 0\)|transparent/.test(a.barBg));
  const barFlow = !!(a && a.barPos && a.barPos !== 'sticky' && a.barPos !== 'fixed');
  const barReal = !!(a && a.barH != null && a.barH >= 30);
  step('那一行**不钉住**（不 sticky/fixed）、**不自带底色**（没有那条横线）、**不是假占位**（有真高度）',
    !!(barClear && barFlow && barReal), { 底: a && a.barBg, 定位: a && a.barPos, 高: a && a.barH });
  step('正文在它**下面**（那一行的底 ≤ 列表的顶 + 2 —— 谁也不压谁）',
    !!(a && a.barBottom != null && a.listTop != null && a.barBottom <= a.listTop + 2),
    { 行底: a && a.barBottom, 列表顶: a && a.listTop });
  await shot(tag('01-收起态小方块.png'));

  /* ── ② 滚动之后还成立吗（用户："固定在那儿动不了"）──────────────── */
  const scrolled = await js(`(async () => {
    const sc = document.querySelector('#screen-shelf .screen-body') || document.scrollingElement;
    sc.scrollTop = 400;
    await new Promise((r) => setTimeout(r, 350));
    return true;
  })()`);
  const b = await js(PROBE);
  rep.probe2 = b;
  const stillOk = !!(scrolled && b && b.barPos !== 'sticky' && b.barPos !== 'fixed' && b.barBg &&
                     /rgba\(0, 0, 0, 0\)|transparent/.test(b.barBg) && b.topbarChips === 0);
  step('往下滚 400px 之后，那三条依然成立（不钉住、不划横线）', stillOk,
    { 定位: b && b.barPos, 底: b && b.barBg, 顶栏方块: b && b.topbarChips });
  await js(`(async () => {
    const sc = document.querySelector('#screen-shelf .screen-body') || document.scrollingElement;
    sc.scrollTop = 0; await new Promise((r) => setTimeout(r, 300)); return true;
  })()`);

  /* ── ③ 点小方块 → 展开成「在写：xxx ▸ 切换」那一行 ───────────────── */
  const exp = await js(`(async () => {
    const mini = document.querySelector('#shelf-book .bk-bar .bk-mini');
    if (!mini) return { err: '内容流里没有小方块' };
    mini.click();
    await new Promise((r) => setTimeout(r, 450));
    const bar = document.querySelector('#shelf-book .bk-bar');
    const chip = bar ? bar.querySelector('.bk-chip') : null;
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
    const r = chip ? chip.getBoundingClientRect() : null;
    return {
      chipShown: vis(chip), miniShown: vis(bar && bar.querySelector('.bk-mini')),
      chipTxt: chip ? chip.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) : '',
      hasPick: !!(chip && chip.querySelector('.bk-pick')),
      h: r ? Math.round(r.height) : 0, w: r ? Math.round(r.width) : 0,
      isMini: bar ? bar.classList.contains('is-mini') : null,
    };
  })()`);
  rep.expand = exp;
  step('点小方块 → **展开**成「在写：书名 ▸ 切换」那一行（方块让位）',
    !!(exp && exp.chipShown && !exp.miniShown && exp.hasPick), exp);
  await shot(tag('02-展开那一行.png'));

  /* ── ④ 点展开那一行 → 切书面板 ──────────────────────────────────── */
  const opened = await js(`(async () => {
    const chip = document.querySelector('#shelf-book .bk-bar .bk-chip');
    if (!chip) return { err: '那一行没展开' };
    chip.click();
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 150));
      if (document.querySelector('#bk-list .bk-row')) break; }
    const rows = [...document.querySelectorAll('#bk-list .bk-row')];
    const list = document.getElementById('bk-list');
    const r = list ? list.getBoundingClientRect() : null;
    return { rows: rows.length, on: document.querySelectorAll('#bk-list .bk-row.on').length,
             slugs: rows.map((x) => x.dataset.slug), h: r ? Math.round(r.height) : 0 };
  })()`);
  step('点那一行 → 出**切书面板**（一列书名，能上下滑着找）', !!(opened && opened.rows >= 2), opened);
  step('面板里**恰好一行**标着「正在写」（就是当前这本）', !!(opened && opened.on === 1), opened);
  await shot(tag('03-切书面板.png'));

  /* ── ⑤ 切到另一本 → 真的换 + 收回小方块 ─────────────────────────── */
  const switched = await js(`(async () => {
    const row = [...document.querySelectorAll('#bk-list .bk-row')].find((x) => x.dataset.slug === ${JSON.stringify(TMP)});
    if (!row) return { err: '面板里没有那本临时书' };
    row.click();
    /* "收回"按**用户看到的那回事**判：App.sheetOpen() 变 false（面板滑下去了）。
       别看 #bk-list 在不在 —— App.closeSheet() 只是把 #sheet 藏起来、不清里面的 DOM。 */
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 150));
      if (!(window.App && App.sheetOpen && App.sheetOpen())) break; }
    await new Promise((r) => setTimeout(r, 400));
    const bar = document.querySelector('#shelf-book .bk-bar');
    const mini = bar ? bar.querySelector('.bk-mini') : null;
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
    const sh = document.getElementById('sheet');
    return { now: (window.BookCtx && BookCtx.slug()) || '',
             sheetClosed: !(window.App && App.sheetOpen && App.sheetOpen()),
             sheetHidden: !!(sh && sh.classList.contains('hidden')),
             backToMini: !!(bar && bar.classList.contains('is-mini') && vis(mini)),
             hostBars: document.querySelectorAll('#shelf-book > .bk-bar').length,
             shelfBars: document.querySelectorAll('#screen-shelf .bk-bar').length,
             mini: mini ? mini.textContent.trim() : '', miniTitle: mini ? mini.title : '' };
  })()`);
  step('在面板里点另一本 → **当前书真的换了**（不是只改了标题）',
    !!(switched && switched.now === TMP), switched);
  step('切完**自动收回小方块**（面板滑下去、那一行也收回去）',
    !!(switched && switched.sheetClosed && switched.backToMini), switched);
  /* 第 41 轮实测到并修掉的那个真 bug：重新 mount 一次会在同一个宿主里堆出**两个** bar
     （两个 34×34 小方块叠在同一个位置 —— 看着就是"方块上有个重影"）。这条判据盯死它。 */
  step('切书之后宿主里**只有一个** bar（不堆重复元素）',
    !!(switched && switched.hostBars === 1 && switched.shelfBars === 1),
    { 宿主里的行: switched && switched.hostBars, 整屏的行: switched && switched.shelfBars });
  await shot(tag('04-切完收回.png'));

  /* ── ⑥ 全站每一屏：那一行**不许压住任何东西**（穿模）────────────────
     用户原话：「切换小说的那个小方框，在 AI 对话那里是实实在在的穿模了，需要改一下」。
     这一条就是给"穿模"立的机器判据：**重叠面积 = 0**，一个像素都不许压。 */
  if (OVERLAP) {
    await js("(()=>{const st=document.createElement('style');st.id='overlapforce';"
      + "st.textContent='.bk-bar{position:absolute !important;top:70px !important;left:0 !important;"
      + "right:0 !important;height:130px !important;z-index:60 !important}';"
      + "document.head.appendChild(st);return 1})()");
    console.log('  ⚠ 反证模式 E2E_OVERLAP=1：把那一行拽出内容流、硬压在正文上（重叠判据必须报红）');
    await sleep(300);
  }
  const CHK = [['shelf', '书架'], ['preset', '预设'], ['lore', '设定'], ['chat', '对话'],
    ['tools', '工具宫格'], ['settings', '设置']];
  for (const [id, cn] of CHK) {
    await js("(async()=>{try{App.show(" + JSON.stringify(id) + ");}catch(e){} "
      + "await new Promise(r=>setTimeout(r,900));return 1})()");
    await sleep(420);
    const o = await js(OVERLAP_PROBE('#screen-' + id));
    const ok = !!(o && !o.err && o.n === 0);
    step('切书那一行不穿模（' + cn + '）：与其它元素的重叠面积 = 0', ok, o);
    await shot(tag('06-不穿模-' + id + '.png'));
  }
  /* 工具子面板（用户说的"工具能向下滑"那种场景）也要量一遍 */
  await js("(async()=>{try{App.show('tools');Tools.open('files');}catch(e){} await new Promise(r=>setTimeout(r,1200));return 1})()");
  await sleep(420);
  const oTool = await js(OVERLAP_PROBE('#screen-tool'));
  step('切书那一行不穿模（工具子面板）：与其它元素的重叠面积 = 0', !!(oTool && !oTool.err && oTool.n === 0), oTool);
  await shot(tag('06-不穿模-toolpanel.png'));
  await js("(async()=>{try{Tools.back();}catch(e){} await new Promise(r=>setTimeout(r,600));return 1})()");

  /* ── ⑦ 收尾：切回原来那本 + 删临时书 + 书架对账 ──────────────────── */
  const back = await js(`(async () => {
    /* 切回来的时候要**带着真书名**回来 —— 界面上的路径就是这么走的（书单那一行有 title）。
       反证 E2E_SLUGCHIP=1 故意只塞 slug：那就是"那一行写一串英文字母"的样子，
       下面那条判据必须报红。 */
    const BEFORE = ${JSON.stringify(String(before))};
    const real = await BookCtx.nameOf(BEFORE);      // 后端里这本书的真名（判据拿它当靶子）
    const t = ${SLUGCHIP ? 'BEFORE' : '(real || BEFORE)'};
    BookCtx.set(BEFORE, t);
    await new Promise((r) => setTimeout(r, 700));
    if (window.App && App.show) { try { App.show('shelf'); } catch (e) {} }
    await new Promise((r) => setTimeout(r, 600));
    const mini = document.querySelector('#shelf-book .bk-bar .bk-mini');
    return { now: (window.BookCtx && BookCtx.slug()) || '', real: real, name: t,
             miniTitle: mini ? mini.title : '', mini: mini ? mini.textContent.trim() : '' };
  })()`);
  step('收尾：当前书切回原来那本（不把用户的"在写的"改走）',
    !!(back && back.now === before), back);
  step('收尾：切回来之后那一行的 title 里写的是**书名**，不是一串英文 slug',
    !!(back && back.miniTitle && back.real && (back.real === before
      ? true                       // 后端自己就没给书名（真名兜底=slug），那只能要求非空
      : (back.miniTitle.indexOf(back.real) >= 0 && back.miniTitle.indexOf(before) < 0))), back);
  const del = await api('POST', '/api/book/delete', { slug: TMP });
  const after = (await api('GET', '/api/shelf')).data || {};
  const now = (after.projects || []).map((p) => p.slug);
  step('收尾：临时书进回收站、书架跟跑之前**逐本一致**',
    del.status === 200 && JSON.stringify(now) === JSON.stringify(BASE_SLUGS),
    { 跑之前: BASE_SLUGS, 跑完: now });

  rep.passed = rep.steps.filter((x) => x.ok).length;
  rep.total = rep.steps.length;
  rep.problems = rep.steps.filter((x) => !x.ok);
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
  console.log('\n' + rep.passed + '/' + rep.total + ' 通过 → ' + path.relative(ROOT, OUT));
  s.close();
  process.exit(rep.problems.length ? 1 : 0);
})();
