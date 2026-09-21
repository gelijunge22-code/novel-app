/* ============================================================
   e2e-settings.js — **大设置页（搬回旧版之后）的回归判据**

   为什么有这一版（要看清楚，别再改错方向）：
     第 22 轮把大设置页从头重做成"分区标签 + 实时预览卡 + 色卡网格"。
     用户看完说：「**整体的那个设置**……**它没有原来的全屏好看**，
     **直接把原来的搬回来就行**，**现在的这个设置太丑了** ——
     我本来让他改的设置，**只是书里的设置，跟外面的设置没关系**。」
     所以第 23 轮做了两件事：① 大设置页 **git 回退到旧版**；② 书里的设置（阅读器底部面板）重做。
     这个脚本就是「①搬回来了、而且没搬坏」的**机器判据**（每一条都能报红）。

   十七条（对应监督人列的 A1 / A3 / 旧版功能完整性 / 第 26 轮「排布与控件形态」那几条）：
     ① 六个分组都在：外观 / 动效 / 翻页 / 听书 / 账号 / 关于
     ② 主题是 7 个选项、**恰有一个选中**（选中态唯一，不是一片亮/都不亮）
     ③ 主题点了**真的换**（--paper 变了）→ 改回原样
     ④ 字号步进器：点 + → Prefs 与正文 --fs 一起变 → 改回原样
     ⑤ 音色 / 朗读引擎两个下拉**真有选项**（不是空的、也不是"正在读取…"）
     ⑥ 「改密码」点得开（弹出对话框，里面有输入框）——点了有反应
     ⑦ 「退出登录」按钮在（不点它）
     ⑧ 关于区：服务地址 / 版本 / 安卓安装包 三行都在
     ⑨ **A1 复核**：旧版结构里**没有**分区标签条（`#settings-nav` / `.set-chip`）——
        所以"顶部选着『数据』、内容却是『外观』"这种毛病在旧版结构上不存在
     ⑩ **A3 复核**：底部导航**恰有一个**高亮项（不是"全都不亮"，也不是亮到不存在的页），
        并且点它**真的能换屏**（导航没坏）
     ⑪ 没有横向溢出；全程 JS 报错 0 条

   跑法：node tools/e2e-settings.js                     # 正常
         SETR_FORCE=nopref  node tools/e2e-settings.js   # 反证：抹掉 [data-pref] → ③④ 必须红
         SETR_FORCE=nopass  node tools/e2e-settings.js   # 反证：抹掉「改密码」的 id → ⑥ 必须红
         SETR_FORCE=notab   node tools/e2e-settings.js   # 反证：把底部导航的 active 抹掉 → ⑩ 必须红
         SETR_FORCE=nogroup node tools/e2e-settings.js   # 反证：删掉一个分组 → ① 必须红
         SETR_FORCE=olds    node tools/e2e-settings.js   # 反证：开/关换回两个方块 → ②d 必须红
         SETR_FORCE=flatsw  node tools/e2e-settings.js   # 反证：色块全涂成同一个颜色 → ②b 必须红
   报告：docs/设置页回归实测.json（反证写 -反证-<FORCE>.json）
   截图：docs/前端截图/r23-设置-搬回-01-总览.png / -02-下半.png
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open, sleep } = require('./cdp');
const { readPassword } = require('./preflight');

const ROOT = '/home/ubuntu/novel-app';
const FORCE = process.env.SETR_FORCE || '';
const REV = !!FORCE;
const OUT = path.join(ROOT, 'docs', REV ? ('设置页回归实测-反证-' + FORCE + '.json') : '设置页回归实测.json');
const SHOTDIR = path.join(ROOT, REV ? 'docs/截图判据反证' : 'docs/前端截图');
const GROUPS = ['外观', '动效', '翻页', '听书', '账号', '关于'];

(async () => {
  const s = await open({ port: 9373 });
  const rep = { at: new Date().toISOString(), force: FORCE || '（正常）', steps: [], problems: [] };
  const step = (n, ok, d) => {
    rep.steps.push({ name: n, ok: !!ok, detail: d });
    console.log((ok ? '  ✓ ' : '  ✗ ') + n + ' — ' + JSON.stringify(d));
    if (!ok) rep.problems.push(n);
  };

  await s.nav('file://' + ROOT + '/apk/assets/www/index.html');
  await sleep(1600);
  await s.js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
    ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
  await sleep(1800);

  /* 截图 / 判据之前：**启动页必须真退场**（否则拍到的是一片黄底启动页 = 假证据） */
  const splash = await s.js(`(async () => {
    for (let i = 0; i < 90; i++) {
      const sp = document.getElementById('splash');
      const gone = !sp || sp.classList.contains('gone') || sp.offsetParent === null
        || getComputedStyle(sp).display === 'none';
      if (gone) return { gone: true, waited: i * 100 };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { gone: false, waited: 9000 };
  })()`, 45000);
  rep.splash = splash;
  step('进设置页之前：启动页（黄底那个）**真的退场了**', splash && splash.gone, splash);

  await s.js(`(async () => {
    App.show('settings');
    await new Promise((r) => setTimeout(r, 1200));
    const b = document.getElementById('settings-body');
    if (b) b.scrollTop = 0;
    return 1;
  })()`);
  await sleep(600);

  /* ── 反证注入（只在设置页渲染完之后动 UI，等于"故意弄坏一处"）── */
  if (FORCE) {
    const inj = {
      nopref: "(()=>{document.querySelectorAll('.seg[data-pref]').forEach(s=>s.removeAttribute('data-pref'));return 1})()",
      nopass: "(()=>{const b=document.getElementById('do-pass');if(b)b.removeAttribute('id');return 1})()",
      notab: "(()=>{const t=document.getElementById('tabbar');if(t)t.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));return 1})()",
      nogroup: "(()=>{const b=document.getElementById('settings-body');const h=[...b.querySelectorAll('h3')].find(x=>x.textContent.trim()==='动效');if(h)h.remove();return 1})()",
      /* 第 26 轮新加的两条反证：
         olds   —— 把二元开关换回"两个方块（开 / 关）"→ ②d 必须红
         flatsw —— 把所有色块涂成同一个颜色 → ②b 必须红 */
      olds: "(()=>{document.querySelectorAll('#settings-body .settings-row .switch').forEach(b=>{const d=document.createElement('div');d.className='seg';d.innerHTML='<button class=\"on\">开</button><button>关</button>';b.replaceWith(d)});return 1})()",
      flatsw: "(()=>{document.querySelectorAll('#settings-body .seg.themes .sw').forEach(x=>{x.style.background='#cccccc'});return 1})()",
    }[FORCE];
    if (inj) await s.js(inj);
    await sleep(200);
  }

  /* ① 分组 */
  const g = await s.js(`(()=>{const b=document.getElementById('settings-body');
    return {heads:[...b.querySelectorAll('h3')].map(h=>h.textContent.trim()),
            groups:b.querySelectorAll('.settings-group').length,
            rows:b.querySelectorAll('.settings-row').length}})()`);
  rep.groups = g;
  const missing = GROUPS.filter((x) => !g.heads.includes(x));
  step('① 六个分组都在（外观 / 动效 / 翻页 / 听书 / 账号 / 关于）', missing.length === 0,
    { heads: g.heads, missing: missing, rows: g.rows });

  /* ② 主题：**跟随系统 / 夜间 两个开关 + 6 个颜色色块（3×2 规整网格）**
        用户点名的：① 7 个排成 4+3、右下空一块 ② 色块看不出颜色 ③ 选中「米黄」显示深褐 ④ 系统/夜间跟颜色混排 */
  const th = await s.js(`(async () => {
    const s = document.querySelector('.seg.grid.themes[data-pref="theme"]');
    if (!s) return { err: '没有颜色主题选择器' };
    const bs = [...s.querySelectorAll('button[data-v]')];
    const cols = getComputedStyle(s).gridTemplateColumns.split(' ').length;
    /* 每个色块的**渲染底色**必须等于那一套主题的 --paper（不是"看着像"）：
       临时把 dataset.theme 挨个切过去，读 --paper，再跟色块自己算出来的背景色比。 */
    const norm = (c) => String(c).replace(/\s/g, '').toLowerCase();
    const toRgb = (c) => { const d = document.createElement('div'); d.style.color = c;
      document.body.appendChild(d); const v = getComputedStyle(d).color; d.remove(); return v; };
    const cur = document.documentElement.dataset.theme;
    const swatch = [];
    for (const b of bs) {
      document.documentElement.dataset.theme = b.dataset.v;
      await new Promise((r) => requestAnimationFrame(r));
      const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
      const sw = b.querySelector('.sw');
      swatch.push({ v: b.dataset.v, paper: paper, bg: sw ? getComputedStyle(sw).backgroundColor : '',
        ok: !!(sw && norm(getComputedStyle(sw).backgroundColor) === norm(toRgb(paper))) });
    }
    document.documentElement.dataset.theme = cur;
    const on = bs.filter((b) => b.classList.contains('on'));
    const onBtn = on[0];
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return { n: bs.length, cols: cols, on: on.map((b) => b.dataset.v),
      offBorder: bs.filter((b) => !b.classList.contains('on')).map((b) => getComputedStyle(b).borderColor)[0],
      onBorder: onBtn ? getComputedStyle(onBtn).borderColor : '',
      onBg: onBtn ? getComputedStyle(onBtn).backgroundColor : '',
      accentRgb: toRgb(accent),
      switches: document.querySelectorAll('#settings-body .settings-row .switch').length,
      segOnOff: [...document.querySelectorAll('#settings-body .seg button')]
        .filter((b) => ['开', '关'].indexOf(b.textContent.trim()) >= 0).length,
      swatch: swatch };
  })()`);
  rep.theme = th;
  step('② 颜色主题：**6 个色块、3 列规整网格**、恰有一个选中',
    !th.err && th.n === 6 && th.cols === 3 && th.on.length === 1, th && { n: th.n, cols: th.cols, on: th.on });
  step('②b 每个色块画的就是那套主题的底色（--paper 逐个核对，6/6）',
    !!(th && th.swatch && th.swatch.length === 6 && th.swatch.every((x) => x.ok)),
    th && th.swatch);
  step('②c 选中的色块**不被主题色盖住**（按钮底 ≠ accent、色块自己的颜色还在）',
    !!(th && th.onBg && th.accentRgb && th.onBg !== th.accentRgb), th && { onBg: th.onBg, accent: th.accentRgb });
  step('②d 二元开关**只有一种形态**：本屏开/关都是 .switch，`.seg` 里再也没有「开 / 关」两个方块',
    !!(th && th.switches >= 3 && th.segOnOff === 0), th && { switch: th.switches, seg开关键: th.segOnOff });

  /* ③ 点主题真的换（量 --paper），然后改回来 */
  const t2 = await s.js(`(async () => {
    const rd = ()=>getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
    const before = rd();
    const s = document.querySelector('.seg.grid[data-pref="theme"]');
    const btn = s && [...s.querySelectorAll('button')].find(b=>b.textContent.trim()==='夜间');
    if (!btn) return { err: '没有「夜间」这一格' };
    btn.click();
    await new Promise(r=>setTimeout(r,300));
    const after = rd();
    const on = [...s.querySelectorAll('button')].filter(b=>b.classList.contains('on')).map(b=>b.textContent.trim());
    return { before: before, after: after, changed: before !== after, onNow: on };
  })()`);
  rep.theme_click = t2;
  step('③ 点「夜间」→ 主题**真的换了**（--paper 变了）、选中态跟着走',
    !!(t2 && !t2.err && t2.changed && t2.onNow && t2.onNow.length === 1), t2);
  await s.js(`(()=>{const s=document.querySelector('.seg.grid[data-pref="theme"]');
    const b=s&&[...s.querySelectorAll('button')].find(x=>x.textContent.trim()==='米黄');if(b)b.click();return 1})()`);
  await sleep(300);

  /* ④ 字号步进器 */
  const fz = await s.js(`(async () => {
    const st = document.querySelector('.stepper[data-step="fontSize"]');
    if (!st) return { err: '没有字号步进器' };
    const read = () => ({ pref: window.Prefs ? Prefs.get('fontSize') : null,
                          css: getComputedStyle(document.documentElement).getPropertyValue('--fs').trim() });
    const b0 = read();
    st.querySelector('button[data-d="1"]').click();
    await new Promise(r=>setTimeout(r,250));
    const b1 = read();
    return { before: b0, after: b1, changed: b0.pref !== b1.pref && b0.css !== b1.css };
  })()`);
  rep.fontSize = fz;
  step('④ 字号步进器点 + → Prefs 与正文 --fs **一起变**', !!(fz && !fz.err && fz.changed), fz);
  await s.js(`(async()=>{const st=document.querySelector('.stepper[data-step="fontSize"]');
    st.querySelector('button[data-d="-1"]').click();await new Promise(r=>setTimeout(r,250));return 1})()`);
  await sleep(300);

  /* ⑤ 音色 / 引擎下拉真有选项 */
  const vo = await s.js(`(async () => {
    const sel = document.querySelector('[data-select="voice"]');
    const eng = document.querySelector('[data-select="ttsEngine"]');
    for (let i = 0; i < 40 && sel && sel.options.length === 0; i++) await new Promise(r=>setTimeout(r,150));
    return { voice: sel ? sel.options.length : -1, engine: eng ? eng.options.length : -1,
             first: sel && sel.options[0] ? sel.options[0].textContent : '' };
  })()`, 45000);
  rep.voices = vo;
  step('⑤ 音色 / 朗读引擎两个下拉**真有选项**', !!(vo.voice > 0 && vo.engine > 0), vo);

  /* ⑥ 改密码点得开 */
  const pw = await s.js(`(async () => {
    const b = document.getElementById('do-pass');
    if (!b) return { err: '没有「改密码」按钮' };
    b.click();
    await new Promise(r=>setTimeout(r,600));
    const m = document.getElementById('modal');
    const open = !!(m && !m.classList.contains('hidden'));
    const has = !!(m && m.querySelector('#pw-old') && m.querySelector('#pw-new'));
    return { opened: open, hasInputs: has };
  })()`);
  rep.pass = pw;
  step('⑥ 「改密码」点得开（弹出对话框 + 有输入框）', !!(pw && pw.opened && pw.hasInputs), pw);
  await s.js("(()=>{try{App.closeModal()}catch(e){}return 1})()");
  await sleep(300);

  /* ⑦ 退出登录按钮在 */
  const lg = await s.js("(()=>({has:!!document.getElementById('do-logout')}))()");
  rep.logout = lg;
  step('⑦ 「退出登录」按钮在', !!(lg && lg.has), lg);

  /* ⑧ 关于区 */
  const ab = await s.js(`(()=>{const b=document.getElementById('settings-body');
    const hs=[...b.querySelectorAll('h3')];const ah=hs.find(h=>h.textContent.trim()==='关于');
    const grp=ah&&ah.nextElementSibling;
    return { rows: grp?[...grp.querySelectorAll('.settings-row .k')].map(x=>x.textContent.trim()):[],
             hasApk: !!(grp&&grp.querySelector('#do-apk')) }})()`);
  rep.about = ab;
  const need = ['服务地址', '版本'];
  /* 「安卓安装包」那一行的标题**会被更新检查改成「有新版本」**（服务器上的包比网页版新时）——
     所以这里认"安卓安装包 或 有新版本"，只要求那一行真的在、按钮真的在。 */
  const apkRow = ab.rows.includes('安卓安装包') || ab.rows.includes('有新版本');
  step('⑧ 关于区：服务地址 / 版本 / 安装包那一行 都在',
    need.every((k) => ab.rows.includes(k)) && apkRow && ab.hasApk, ab);

  /* ⑨ A1 复核：旧版没有分区标签条（"顶部选中态与内容不符"这种毛病的地基不存在） */
  const nav = await s.js("(()=>({nav:!!document.getElementById('settings-nav'),chips:document.querySelectorAll('.set-chip').length}))()");
  rep.nav = nav;
  step('⑨ A1 复核：旧版结构里没有分区标签条（不会再出现"选着『数据』却显示『外观』"）',
    !nav.nav && nav.chips === 0, nav);

  /* ⑩ A3 复核：底部导航恰有一个高亮项，且点它真能换屏 */
  const tb = await s.js(`(async () => {
    const t = document.getElementById('tabbar');
    const acts = [...t.querySelectorAll('.tab')].filter(x=>x.classList.contains('active'));
    const names = [...t.querySelectorAll('.tab')].map(x=>x.dataset.tab);
    const bad = acts.filter(x=>names.indexOf(x.dataset.tab) < 0).length;
    const first = t.querySelector('.tab[data-tab="shelf"]');
    first.click();
    await new Promise(r=>setTimeout(r,700));
    return { active: acts.map(x=>x.dataset.tab), bad: bad,
             wentShelf: document.body.dataset.tab === 'shelf', hidden: t.classList.contains('hidden') };
  })()`);
  rep.tabbar = tb;
  step('⑩ A3 复核：底部导航**恰有一个**高亮项，且点了真的换屏', !!(tb && tb.active.length === 1 && tb.bad === 0 && tb.wentShelf), tb);

  /* ⑪ 溢出 + JS 报错 */
  const ov = await s.js(`(()=>{const d=document.documentElement;
    return { over: Math.max(0, d.scrollWidth - d.clientWidth), innerW: window.innerWidth }})()`);
  rep.overflow = ov;
  step('⑪ 设置页没有横向溢出', !!(ov && ov.over === 0), ov);
  const errs = await s.js("(()=>window.__errs||[])()").catch(() => []);
  rep.errors = errs;
  step('⑪b 全程没有 JS 报错', !errs || errs.length === 0, { n: errs ? errs.length : 0, first: (errs || [])[0] || '' });

  /* ⚠ ⑩ 那一步点过底部导航去书架了 —— ⑫ 起必须**先回设置页**再量，
     不然量到的是隐藏元素（clientWidth=0 / 矩形全 0），判据会假红或**假绿**
     （第 26 轮真踩到：⑬ 因为"宽度全是 0"反而通过了）。 */
  await s.js(`(async () => { App.show('settings'); await new Promise((r) => setTimeout(r, 1100));
    const b = document.getElementById('settings-body'); if (b) b.scrollTop = 0; return 1; })()`);
  await sleep(500);
  const vis0 = await s.js("(()=>{const b=document.getElementById('settings-body');return {w:b?b.clientWidth:0,h:b?b.clientHeight:0}})()");
  step('⑫ 量之前先确认**设置页真的在屏幕上**（隐藏元素量出来是 0，判据会假绿）',
    !!(vis0 && vis0.w > 200 && vis0.h > 200), vis0);

  /* ⑫ 控制列右对齐：同一组里每一行的控件右边缘必须落在**同一条基准线**上 */
  const colr = await s.js(`(() => {
    const rows = [...document.querySelectorAll('#settings-body .settings-group .settings-row')]
      .filter((r) => !r.classList.contains('stack'));
    const rowsEl = [];
    for (const r of rows) {
      const cs = getComputedStyle(r);
      const ctl = [...r.children].find((c) => !c.classList.contains('k'));
      if (!ctl) continue;
      const contentRight = r.getBoundingClientRect().right
        - parseFloat(cs.paddingRight || 0) - parseFloat(cs.borderRightWidth || 0);
      rowsEl.push({ k: (r.querySelector('.k') || {}).textContent.trim().slice(0, 8),
        ctl: ctl.tagName.toLowerCase() + '.' + (ctl.className || '').toString().trim().split(/\s+/)[0],
        off: Math.round((contentRight - ctl.getBoundingClientRect().right) * 10) / 10 });
    }
    const worst = rowsEl.slice().sort((a, b) => Math.abs(b.off) - Math.abs(a.off))[0];
    return { n: rowsEl.length, worst: worst || null, all: rowsEl };
  })()`);
  rep.ctlcol = colr;
  step('⑫ 每一行的控件都**右贴同一条基准线**（乱偏移就是用户说的"每一行排布都不一样"）',
    !!(colr && colr.n > 4 && colr.all.every((x) => Math.abs(x.off) <= 1)), colr && { n: colr.n, worst: colr.worst });

  /* ⑬ 步进器数值：**带单位 + 固定列宽 + 居中**（以前是光秃秃的 14 / 1.9 / 26，宽度乱跳） */
  const stp = await s.js(`(() => {
    const ss = [...document.querySelectorAll('#settings-body .stepper')];
    const out = ss.map((s) => { const v = s.querySelector('.v'); const cs = v ? getComputedStyle(v) : {};
      return { k: s.dataset.step, txt: v ? v.textContent.trim() : '', unit: s.dataset.unit || '',
        w: v ? Math.round(v.getBoundingClientRect().width) : 0, align: cs.textAlign || '' }; });
    return { n: out.length, noUnit: out.filter((x) => !/[^\d.]/.test(x.txt)).map((x) => x.k),
      widths: Array.from(new Set(out.map((x) => x.w))), badAlign: out.filter((x) => x.align !== 'center').length, all: out };
  })()`);
  rep.stepvals = stp;
  step('⑬ 步进器数值带单位、列宽一致、居中（14px / 1.9倍 / 26px）',
    !!(stp && stp.n >= 3 && stp.noUnit.length === 0 && stp.widths.length === 1 && stp.widths[0] > 20
       && stp.badAlign === 0), stp);

  /* ⑭ 下拉里的文字**不许被硬截断**（用户截图里「edge-tts（微软在:」） */
  const tr = await s.js(`(() => {
    const cv = document.createElement('canvas').getContext('2d');
    return [...document.querySelectorAll('#settings-body select.input')].map((sel) => {
      const o = sel.options[sel.selectedIndex];
      if (!o) return { ok: true, why: '还没选项' };
      const cs = getComputedStyle(sel);
      cv.font = cs.fontSize + ' ' + cs.fontFamily;
      const w = cv.measureText(o.textContent).width;
      const room = sel.clientWidth - 24;      /* 右侧箭头 + 内边距 */
      return { txt: o.textContent, w: Math.round(w), room: Math.round(room),
        ok: room > 24 && w <= room };   /* room ≤24 = 控件根本没渲染（隐藏 / 宽度 0）→ 也算红 */
    });
  })()`);
  rep.trunc = tr;
  step('⑭ 下拉里的文字放得下（不是"硬截断成 edge-tts（微软在:"那种）',
    !!(tr && tr.length && tr.every((x) => x.ok)), tr);

  /* ⑮ 底部留白：最后一行跟固定底栏之间**必须留出间距**（不许贴底、不许被压） */
  const tail = await s.js(`(() => {
    const rows = [...document.querySelectorAll('#settings-body .settings-row')];
    const last = rows[rows.length - 1];
    const bar = document.getElementById('tabbar');
    const b = last.getBoundingClientRect();
    const body = document.getElementById('settings-body');
    body.scrollTop = body.scrollHeight;                 /* 滚到底再量 */
    const b2 = last.getBoundingClientRect();
    const barTop = bar && !bar.classList.contains('hidden') ? bar.getBoundingClientRect().top : innerHeight;
    return { gap: Math.round(barTop - b2.bottom), barVisible: !!(bar && !bar.classList.contains('hidden')) };
  })()`);
  rep.tail = tail;
  step('⑮ 滚到底时最后一行离固定底栏还有余量（≥16px，不被压住）',
    !!(tail && tail.barVisible && tail.gap >= 16), tail);

  /* ── 截图（回设置页，拍两张：总览 + 下半；两张 md5 必须不同）── */
  await s.js(`(async () => { App.show('settings'); await new Promise(r=>setTimeout(r,900));
    const b=document.getElementById('settings-body'); if(b) b.scrollTop=0; return 1 })()`);
  await sleep(500);
  const f1 = path.join(SHOTDIR, 'r23-设置-搬回-01-总览.png');
  await s.shot(f1);
  await s.js(`(async () => { const b=document.getElementById('settings-body');
    b.scrollTop = b.scrollHeight * 0.55; await new Promise(r=>setTimeout(r,500)); return 1 })()`);
  await sleep(400);
  const f2 = path.join(SHOTDIR, 'r23-设置-搬回-02-下半.png');
  await s.shot(f2);
  const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
  const m1 = md5(f1), m2 = md5(f2);
  rep.shots = { a: m1.slice(0, 12), b: m2.slice(0, 12) };
  step('截图两张**互不相同**（同一轮里两张一样 = 那一步根本没生效）', m1 !== m2, rep.shots);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
  const bad = rep.problems.length;
  console.log('\n' + (bad ? ('有 ' + bad + ' 条没过') : '全过') + ' → ' + OUT);
  s.close();
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
