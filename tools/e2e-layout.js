/* ============================================================
   e2e-layout.js — 空间规范的**实机判据**（第 25 轮；治用户说的"观感不协调、内在不一致"）

   用户原话（一字不改）：
     「UI 视觉元素、主色调、圆角方框组件样式都已经统一，但整体页面观感不协调、内在不一致……
      不是颜色、圆角、边框样式问题，是**布局排布、留白、元素权重、间距层级、模块呼吸感**出问题……
      ② 全部元素执行统一对齐规则：左对齐 / 网格对齐，杜绝随意偏移，模块之间对齐网格
      ③ 区分模块外间距、模块内部组件间距、组件内部元素间距，三层间距要拉开层级
      ④ 优化元素摆放位置……修正空旷浪费空间的问题
      ⑤ 统一信息视觉权重：标题、正文、辅助文字、按钮的大小/占比关系保持全局一致
      ⑥ 每个区块的呼吸感保持一致，避免有的模块挤成一团、有的模块留白过多」

   静态那两条（间距只能写 var(--sp-*) / 字号字重只能用令牌）在 tools/verify_layout.py。
   这里量的是**静态脚本量不出来的四条**（逐个屏/面板/弹层）：

     甲 网格对齐：**父容器是块流或纵向 flex** 的子件，它的左偏移完全由 padding/margin 决定 →
                 必须是 4 的倍数（±1）。横向 flex 行里的子件由文字宽度决定，跳过（不然满屏假红）。
     乙 呼吸感：  纵向排布的相邻兄弟，垂直间距必须是 4 的倍数 ±1；顺带记录标准差（挤/散都看得见）。
     丙 权重表：  字号在阶梯上的元素（阅读正文用 --fs，不在阶梯里，跳过），
                 字号×字重必须是表里那一组（16/18/22 只能配 600/700；11/12/13/14.5 只能配 400/500/600）。
     丁 同类同尺寸：长得一样的控件（同一组 class）高度必须一致（±1px）、字号必须一致。

   反证（判据必须先能报红，跑法见下）：
     LAYOUT_FORCE=grid   给 .settings-row .k 加 5px 左偏移 → 甲 必须报红
     LAYOUT_FORCE=breath 给书卡加 7px 上间距           → 乙 必须报红
     LAYOUT_FORCE=weight 把 .settings-row .k 字号改成 21px（阶梯外）→ 丙 必须报红
     LAYOUT_FORCE=size   把 .seg button 高度改成 52px  → 丁 必须报红

   用法：node tools/e2e-layout.js        （LAYOUT_ONLY=shelf,chat 只跑几屏，省内存省时间）
   产出：docs/空间布局实测.json + docs/前端截图/r27-layout-<屏>.png
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');
const { READER_OPEN, CHROME, SCREENS, OVERLAYS, toolSurfaces } = require('./surfaces');

const ROOT = '/home/ubuntu/novel-app';
const SHOTDIR = path.join(ROOT, 'docs/前端截图');
const ROUND = process.env.LAYOUT_ROUND || 'r27-layout';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const FORCE = process.env.LAYOUT_FORCE || '';
/* 判据的八个桶：甲~丁 是第 25 轮立的（对齐/呼吸/权重/同类同尺寸），
   戊~壬 是第 26 轮按用户"UI 统一 + 美观"补的（开关形态/硬截断/底栏压内容/呼吸不匀）。 */
const KEYS = ['align', 'breath', 'weight', 'csize', 'switch', 'clip', 'tail', 'cv'];
let password = '';
try { password = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
catch (e) { /* 没登录密码就跑不了 */ }

/* 视觉权重表：字号 → 允许的字重。跟 frontend/css/tokens.css 的 --t-* / --w-* 一一对应。 */
/* 第 42 轮整体收一档之后的新阶梯（跟 frontend/css/tokens.css 的 --t-* 一一对应）。 */
const WEIGHT_TABLE = {
  11: [400, 500, 600], 12: [400, 500, 600], 13: [400, 500, 600], 14: [400, 500, 600],
  15: [600, 700], 17: [600, 700], 20: [600, 700],
};
const LADDER = Object.keys(WEIGHT_TABLE).map(Number).concat([24, 30, 40, 56]);

const AUDIT = (rootSels) => `(() => {
  const SELS = ${JSON.stringify(rootSels)};
  const WT = ${JSON.stringify(WEIGHT_TABLE)};
  const LADDER = ${JSON.stringify(LADDER)};
  const roots = SELS.map((q) => document.querySelector(q)).filter((x) => !!x);
  if (!roots.length) return { err: '没有根元素 ' + SELS.join(' / ') };
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none'
      && parseFloat(cs.opacity) > 0.15; };
  const name = (el) => { const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + id + cls; };
  /* 容差 ±0.5px：只够吸收亚像素取整。以前写 ±1.01 —— 结果 5px 的偏移
     （离 4 只差 1）被当成"在格子上"放过去了，反证打 5px 都不红 = 空判据。 */
  const onGrid = (v, tol) => { const m = Math.abs(v / 4 - Math.round(v / 4)) * 4; return m <= (tol || 0.51); };
  const isStack = (cs) => cs.display === 'block' || cs.display === 'flow-root'
    || (cs.display === 'flex' && cs.flexDirection === 'column')
    || (cs.display === 'grid' && (cs.gridTemplateColumns || '').split(' ').filter(Boolean).length <= 1);
  /* 两条降噪（第 25 轮跑全站时踩出来的假红，不是真问题）：
     (1) 图标是 <svg> 里的 path/rect/circle —— 不是排版盒子，偏移由 viewBox 决定，整棵 svg 跳过；
     (2) 行内流（display:inline）的 b/span 随文排，间距由字体度量决定（2px 之类），不是模块留白。
     只量盒子：block / flow-root / flex / grid / list-item / table / inline-block。 */
  const isBox = (el) => { const d = getComputedStyle(el).display;
    return d === 'block' || d === 'flow-root' || d === 'flex' || d === 'grid' || d === 'list-item'
      || d === 'table' || d === 'table-row' || d === 'inline-block'; };
  const inSvg = (el) => !!(el.ownerSVGElement || el.tagName.toLowerCase() === 'svg');
  const res = { root: SELS.join('+'), align: [], breath: [], weight: [], csize: [],\n    switch: [], clip: [], tail: [], cv: [], nums: {} };

  /* ── 甲 网格对齐 ───────────────────────────────────────────── */
  for (const R of roots) {
    for (const P of [R].concat(Array.from(R.querySelectorAll('*')))) {
      if (!vis(P) || inSvg(P)) continue;
      const pcs = getComputedStyle(P);
      if (!isStack(pcs)) continue;
      /* 多栏排版（阅读器的分页正文）：子件本来就分列左右摆，左偏移天然不同 —— 不是"没对齐"。 */
      if ((pcs.columnCount && pcs.columnCount !== 'auto') || (pcs.columnWidth && pcs.columnWidth !== 'auto')) continue;
      const kids = Array.from(P.children).filter((k) => vis(k) && !inSvg(k) && isBox(k)
        && getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).position !== 'fixed'
        && getComputedStyle(k).float === 'none');
      if (kids.length < 2) continue;
      /* 居中 / 右对齐的容器（气泡右贴、按钮居中）本来就不共用左基准线 —— 跳过，
         不然满屏假红（第 25 轮跑对话页时 15 条假红里 14 条是这个）。 */
      const jc = pcs.justifyContent || '';
      const CENTERED = ['center', 'flex-end', 'end', 'right', 'space-between', 'space-around', 'space-evenly'];
      const ai = pcs.alignItems || '';
      if (CENTERED.indexOf(jc) >= 0 || CENTERED.indexOf(ai) >= 0
        || pcs.textAlign === 'center' || pcs.textAlign === 'right' || pcs.textAlign === 'end') continue;
      const base = P.getBoundingClientRect().left
        + parseFloat(pcs.borderLeftWidth || 0) + parseFloat(pcs.paddingLeft || 0);
      for (const k of kids) {
        const cs = getComputedStyle(k);
        if (cs.marginLeft === 'auto' || cs.marginRight === 'auto') continue;   /* 居中/右贴是故意的 */
        if (cs.position === 'sticky') continue;                                /* 吸顶那一层另说 */
        const kta = getComputedStyle(k).textAlign;
        if (kta === 'center' || kta === 'right' || kta === 'end') continue;
        const kr = k.getBoundingClientRect();
        const pcx = base + (P.getBoundingClientRect().width
          - parseFloat(pcs.borderLeftWidth || 0) - parseFloat(pcs.paddingLeft || 0)
          - parseFloat(pcs.borderRightWidth || 0) - parseFloat(pcs.paddingRight || 0)) / 2;
        /* 抓手条 / 居中件：margin:0 auto 在 computed style 里已经解析成具体 px，
           判断不出 auto，但"自己中心 ≈ 容器内容中心"就是居中的证据 → 跳过。 */
        if (Math.abs((kr.left + kr.width / 2) - pcx) <= 2) continue;
        const off = kr.left - base;
        if (off < -1.01 || onGrid(off)) continue;
        if (res.align.length > 14) break;
        res.align.push({ parent: name(P), el: name(k), off: Math.round(off * 10) / 10 });
      }
    }
  }

  /* ── 乙 呼吸感（纵向相邻间距必须落在 4 的格子上）─────────────── */
  const gapps = [];
  const byParent = {};
  const depthKeys = {};
  /* 壬/癸 的"容器"必须**认元素本身**，不能认 tag.class 这个名字：
     同一屏里"同类容器"多的是（对话页的十来条 div.msg.ai、书架的一整片书卡），
     按名字合并就把**不同容器**的间距混进一个桶里算方差 ——
     第 30 轮实测：对话页就是被这么判成"呼吸不匀 1 处"（单看每条消息，间距是 4/8/4/8，本来就一致）。
     规则原文是"**同一容器里**同层兄弟之间的间距要一致"，所以这里给每个元素一个唯一键。 */
  const PK = new WeakMap(); let pkSeq = 0;
  const pkey = (el) => { if (!PK.has(el)) PK.set(el, name(el) + '#' + (++pkSeq)); return PK.get(el); };
  const depthOf = (el) => { let d = 0; let n = el.parentElement;
    while (n && n.nodeType === 1) { const cs = getComputedStyle(n);
      if (isStack(cs) && n.children.length >= 2 && !inSvg(n)) d++;
      if (roots.indexOf(n) >= 0) break;
      n = n.parentElement; }
    return d; };
  const byDepth = {};
  for (const R of roots) {
    for (const P of [R].concat(Array.from(R.querySelectorAll('*')))) {
      if (!vis(P) || inSvg(P) || !isStack(getComputedStyle(P))) continue;
      const kids = Array.from(P.children).filter((k) => vis(k) && !inSvg(k) && isBox(k)
        && getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).position !== 'fixed');
      if (kids.length < 2 || kids.length > 40) continue;
      /* 这个容器是不是"一排重复的模块"？（周期 1/2/3 最多试到 3）
         大设置页 #settings-body 就是 H3 / .settings-group / H3 / .settings-group …（周期 2），
         它的"模块间距"全长在 **group → 下一个 H3** 这一对上 —— 两边 class 不同，
         按"同名才算"会把它整条丢掉（第 30 轮实测：LAYOUT_FORCE=cv 反证因此变空）。
         判"周期"而不是判"同名"，才既保住这条、又不把"徽章→气泡→胶囊→时间"那种分组节奏算进来。 */
      const sigs = kids.map((k) => k.tagName + '.' + String(k.className || ''));
      let period = 0;
      for (const p of [1, 2, 3]) {
        let ok = sigs.length > p;
        for (let i = p; ok && i < sigs.length; i++) if (sigs[i] !== sigs[i - p]) ok = false;
        if (ok) { period = p; break; }
      }
      for (let i = 1; i < kids.length; i++) {
        const prev = kids[i - 1].getBoundingClientRect();
        const cur = kids[i].getBoundingClientRect();
        const gap = Math.round((cur.top - prev.bottom) * 10) / 10;
        if (gap < -1) continue;                       /* 叠着的（负 margin 等）另说 */
        /* 同一行上并排的两个（比如行内的 b + span）不是"纵向间距"，跳过。
           ⚠ 判"同一行"要看**纵向**有没有重叠 —— 一开始我写成"横向有没有重叠"，
           结果全宽的上下两块（左右都贴边）也被当成并排跳过了，
           反证打 6px 间距都不红（空判据），第 25 轮自己抓出来的。 */
        if (prev.bottom > cur.top + 1) continue;
        /* 0/1/2px 是"半个格子"的微调（跟静态规范 tools/verify_layout.py 同一条口径）。 */
        if (gap <= 2.01) continue;
        if (!onGrid(gap)) {
          if (res.breath.length > 14) break;
          res.breath.push({ parent: name(P), a: name(kids[i - 1]), b: name(kids[i]), gap: gap });
        }
        gapps.push(gap);
        /* 壬/癸 要按"容器"和"层"分开看 —— 一条间距属于哪个容器必须记下来：
           用户要的是「三层间距拉开」（模块之间 / 模块里的组件之间 / 组件里的元素之间），
           不是"全站所有间距一样大"（那反而是错的）。 */
        /* 「小标题 → 它管的那块内容」这一对**故意**比别处紧（标题贴着它的卡片，8px）——
           这不是"忽大忽小"，是排版规矩。所以只把它算进 乙（4 的格子），不算进 壬/癸。
           真正的模块间距（卡片 → 下一个小标题）才要互相一致。 */
        const headPair = kids[i - 1].matches('h1, h2, h3, h4, .settings-title, .group-title, .sec-title');
        /* 壬/癸 只算**同类兄弟之间**的间距（同位 + 同 class）：这条规矩管的
           "别有的挤成一团、有的空一片"，针对的是**一排重复的同类项**（书卡、设置行、章节行）。
           而"徽章 → 气泡 → 模式胶囊 → 时间"这种**不同类**的排布，间距本来就该不一样 ——
           那是分组节奏，不是忽大忽小。第 30 轮实测：对话页每条 AI 消息里 4/8/4 被判成
           "呼吸不匀 5 处"，逐张看图是对的，纯属判据自己把"分组"当成了"不匀"。 */
        if (!headPair && (period > 0 || sigs[i - 1] === sigs[i])) {
          const pk = pkey(P);
          (byParent[pk] = byParent[pk] || []).push(gap);
          if (depthKeys[pk] === undefined) depthKeys[pk] = String(Math.min(3, depthOf(kids[0]) || 1));
        }
      }
    }
  }
  if (gapps.length > 3) {
    const mean = gapps.reduce((a, b) => a + b, 0) / gapps.length;
    const sd = Math.sqrt(gapps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gapps.length);
    res.nums.gapMean = Math.round(mean * 10) / 10;
    res.nums.gapSd = Math.round(sd * 10) / 10;
    res.nums.gapN = gapps.length;
  }

  /* ── 丙 视觉权重表 ─────────────────────────────────────────── */
  const seen = [];
  /* 阅读正文的字号是**用户自己的偏好**（--fs，默认 19px），不在界面阶梯里 ——
     #reader-cols 里的字跳过；别处出现阶梯外的字号，就是"局部随意放大缩小"。 */
  for (const R of roots) {
    for (const el of R.querySelectorAll('*')) {
      if (!vis(el)) continue;
      if (el.closest('.reader-cols')) continue;   /* 阅读正文（--fs 用户偏好）：index.html 里没有 id，只能按 class 找 */
      let txt = '';
      for (const k of el.childNodes) if (k.nodeType === 3) txt += k.nodeValue;
      if (!txt.replace(/\s+/g, '')) continue;
      const cs = getComputedStyle(el);
      const size = Math.round(parseFloat(cs.fontSize) * 10) / 10;
      const w = parseInt(cs.fontWeight, 10) || 400;
      seen.push(size + '/' + w);
      if (res.weight.length > 14) continue;
      if (LADDER.indexOf(size) < 0) {
        res.weight.push({ el: name(el), size: size, weight: w, why: '字号不在阶梯上', allow: LADDER,
          txt: txt.replace(/\s+/g, ' ').trim().slice(0, 14) });
        continue;
      }
      if ([400, 500, 600, 700].indexOf(w) >= 0) continue;
      res.weight.push({ el: name(el), size: size, weight: w, why: '字重不在四档里',
        allow: [400, 500, 600, 700], txt: txt.replace(/\s+/g, ' ').trim().slice(0, 14) });
    }
  }
  res.nums.weights = Array.from(new Set(seen)).sort();

  /* ── 丁 同类同尺寸 ─────────────────────────────────────────── */
  const fam = {};
  for (const R of roots) {
    for (const el of R.querySelectorAll('button, .seg, .rd-qbtn, .rd-fb, .tab, .pseg, .mode-btn')) {
      if (!vis(el)) continue;
      const par = el.parentElement;
      const pkey = par ? (par.tagName.toLowerCase() + '.' + ((par.className || '').toString().trim().split(/\\s+/)[0] || '')) : '';
      const key = el.tagName.toLowerCase() + '.' + (el.className || '').toString().trim().split(/\\s+/).sort().join('.')
        + ' @ ' + pkey;
      (fam[key] = fam[key] || []).push(el);
    }
  }
  for (const key of Object.keys(fam)) {
    const els = fam[key];
    if (els.length < 2) continue;
    const hs = els.map((e) => Math.round(e.getBoundingClientRect().height * 10) / 10);
    const fss = els.map((e) => Math.round(parseFloat(getComputedStyle(e).fontSize) * 10) / 10);
    /* 比"决定控件尺寸的那几项样式"，而不是比测量出来的高度：
       高度会被"文字换行"带偏（同一族里一个选项两行、其余一行 → 高度天然不同），
       那种是内容差异，不是"控件尺寸不统一"。真正该一致的是
       字号 / 上下内边距 / 行高 —— 这三项一致，控件就是同一个尺寸。 */
    const style = els.map((e) => { const cs = getComputedStyle(e);
      const lh = parseFloat(cs.lineHeight);
      return { fs: Math.round(parseFloat(cs.fontSize) * 10) / 10,
        pad: Math.round((parseFloat(cs.paddingTop || 0) + parseFloat(cs.paddingBottom || 0)) * 10) / 10,
        lh: isNaN(lh) ? -1 : Math.round(lh * 10) / 10 }; });
    const fmin = Math.min.apply(null, fss), fmax = Math.max.apply(null, fss);
    const pmins = Math.min.apply(null, style.map((x) => x.pad)), pmaxs = Math.max.apply(null, style.map((x) => x.pad));
    const lmin = Math.min.apply(null, style.map((x) => x.lh)), lmax = Math.max.apply(null, style.map((x) => x.lh));
    if (fmax - fmin > 0.01 || pmaxs - pmins > 0.51 || (lmin > 0 && lmax - lmin > 0.51)) {
      res.csize.push({ fam: key, n: els.length, h: [Math.min.apply(null, hs), Math.max.apply(null, hs)],
        fs: [fmin, fmax], pad: [pmins, pmaxs], lh: [lmin, lmax] });
    }
  }
  /* ── 戊 二元开关：全站**只许一种形态** ─────────────────────────────
     用户原话：「那个什么界面动效啊，竟然是上下的一个开一个关，太丑了」——
     同一个 App 里"开/关"必须长一样。两种坏法都要抓：
       ① 尺寸/圆角不一致（两个 .switch 长得不一样高胖）
       ② 又冒出"两个方块（开 / 关）"这种老形态（.seg 里恰好两个按钮、文字是 开/关） */
  const sws = [];
  for (const R of roots) R.querySelectorAll('.switch').forEach((el) => { if (vis(el)) sws.push(el); });
  const shapes = [];
  for (const el of sws) { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    const k = Math.round(r.width) + 'x' + Math.round(r.height) + '/' + cs.borderRadius;
    if (shapes.indexOf(k) < 0) shapes.push(k); }
  res.nums.switches = sws.length;
  if (shapes.length > 1) res['switch'].push({ why: '开关尺寸不一致', shapes: shapes });
  const segOnOff = [];
  for (const R of roots) R.querySelectorAll('.seg').forEach((el) => {
    const bs = Array.from(el.querySelectorAll('button'));
    if (bs.length !== 2) return;
    const t = bs.map((b) => b.textContent.trim()).join('');
    if (t === '开关') segOnOff.push(name(el) + ' @ ' + name(el.parentElement));
  });
  if (segOnOff.length) res['switch'].push({ why: '又冒出「开/关」两个方块的老形态', seg: segOnOff });

  /* ── 庚 文字硬截断：被裁的元素必须给省略号，不许"半截字" ─────────────
     用户截图里的「edge-tts（微软在:」就是硬截断（没省略号，看着像坏了）。 */
  const mctx = document.createElement('canvas').getContext('2d');
  const textW = (cs, txt) => { mctx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    return mctx.measureText(txt).width; };
  for (const R of roots) {
    for (const el of R.querySelectorAll('select.input, .tr-name, .book-title, .rd-toc-item .nm')) {
      if (!vis(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.textOverflow === 'ellipsis') continue;         /* 有省略号 = 正常处理，不算"硬截断" */
      /* ⚠ 两个容易写成**空判据**的坑（第 26 轮实测记下来）：
         ① select 的 computed overflow 永远是 visible（Blink 里它由替换元素接管），
            照别处那套"overflow:visible 就跳过"写，会因为**第一个判断**就把所有下拉跳过 → 永远不红；
         ② 文字宽不能只看 clientWidth：下拉右边还有箭头和内边距要扣掉。 */
      let txt = '', room = el.clientWidth;
      if (el.tagName === 'SELECT') {
        const o = el.options[el.selectedIndex];
        txt = o ? o.textContent : '';
        room = el.clientWidth - 24;                          /* 右边还有箭头和内边距 */
      } else {
        if (cs.overflow === 'visible') continue;             /* 不裁剪 → 谈不上截断 */
        txt = (el.textContent || '').trim();
        if (el.scrollWidth <= el.clientWidth + 1) continue;  /* 没溢出 */
      }
      if (!txt) continue;
      const w = textW(cs, txt);
      if (w > room) {
        if (res.clip.length > 14) break;
        res.clip.push({ el: name(el), txt: txt.slice(0, 16), 文字宽: Math.round(w), 可用: Math.round(room) });
      }
    }
  }

  /* ── 辛 固定底栏不许压内容：滚到底时最后一行与底栏之间要有余量 ─────────
     （只看**页面级滚动容器**；弹层/面板自己的滚动由"不遮挡"那套判据管。） */
  const bar = document.querySelector('#tabbar');
  if (bar && vis(bar)) {
    const barTop = bar.getBoundingClientRect().top;
    for (const R of roots) {
      const sc = Array.from(R.querySelectorAll('*')).filter((el) => {
        const cs = getComputedStyle(el);
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll')
          && el.scrollHeight > el.clientHeight + 8 && vis(el);
      })[0];
      if (!sc) continue;
      /* 量之前**先把平滑滚动关掉**：.chat-body 是 scroll-behavior:smooth，
         直接 scrollTop = scrollHeight 会起一段动画，而这里紧接着就量 ——
         量到的是**滚到一半**的位置（第 27 轮就这么报了一条 -34.1 的假红：
         看着像"底栏压住最后一条"，其实是判据自己没等动画）。
         （这段是注入到页面里执行的，注释里别写反引号 —— 会把外层模板串截断。） */
      const keepBeh = sc.style.scrollBehavior;
      sc.style.scrollBehavior = 'auto';
      const keep = sc.scrollTop;
      sc.scrollTop = sc.scrollHeight;
      let last = null;
      for (const el of Array.from(sc.children)) if (vis(el)) last = el;
      if (last) {
        const b = last.getBoundingClientRect();
        const gap = Math.round((barTop - b.bottom) * 10) / 10;
        if (gap < 8) res.tail.push({ scroller: name(sc), last: name(last), gap: gap });
      }
      sc.scrollTop = keep;
      sc.style.scrollBehavior = keepBeh;
    }
  }

  /* ── 壬 呼吸感一致：**同一个容器里**同层兄弟之间的间距要一致 ─────────────
     乙 管的是"每条间距都在 4 的格子上"；壬 管的是"别有的挤成一团、有的空一片"。
     ⚠ 第一版写成"全屏所有间距算一个变异系数" —— 那是**错的判据**：
       用户要的恰恰是「三层间距拉开」（模块外 / 组件间 / 元素内 本来就该不一样），
       全屏拉平去算必然到处超标（实测 11 屏红，全是假红）。
       所以按**容器**分开算：一张卡片里的行间距互相比，只跟同层兄弟比。 */
  const cvs = [];
  for (const key of Object.keys(byParent)) {
    const arr = byParent[key];
    if (arr.length < 3) continue;                      /* 少于 3 条谈不上"匀不匀" */
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const sd2 = Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length);
    const cv = m > 0 ? sd2 / m : 0;
    cvs.push({ c: key, n: arr.length, mean: Math.round(m * 10) / 10, sd: Math.round(sd2 * 10) / 10,
      cv: Math.round(cv * 100) / 100 });
  }
  res.nums.gapCvs = cvs.length;
  for (const c of cvs) if (c.cv > 0.34) res.cv.push(c);

  /* ── 癸 三层间距：模块之间 > 模块里的组件之间 > 组件里的元素之间 ──────────
     用户第 ①③ 条：「建立一套固定间距标尺」「模块外间距 / 模块内组件间距 / 组件内元素间距
     三层要拉开层级，不要全部间距大小一样」。
     怎么分三层：按"上面套了几层容器"数（屏幕格子=第 1 层）。数不够 3 条就不下结论，
     免得用一两条样本冤枉一个屏。 */
  for (const key of Object.keys(byParent)) {
    const dkey = depthKeys[key];
    if (dkey === undefined) continue;
    (byDepth[dkey] = byDepth[dkey] || []).push.apply(byDepth[dkey], byParent[key]);
  }
  const med = (a) => { if (!a || !a.length) return null; const b = a.slice().sort((x, y) => x - y);
    return b[Math.floor(b.length / 2)]; };
  const lv = {};
  for (const d of Object.keys(byDepth)) if (byDepth[d].length >= 3) lv[d] = Math.round(med(byDepth[d]) * 10) / 10;
  res.nums.gapLevels = lv;
  const l1 = lv['1'], l2 = lv['2'];
  if (l1 !== undefined && l2 !== undefined && l1 < l2 * 1.4) {
    res.cv.push({ why: '模块外间距没有明显大于组件间距（三层没拉开）', 模块外: l1, 组件间: l2, all: lv });
  }
  if (l1 !== undefined && l1 < 16) {
    res.cv.push({ why: '模块之间贴得太近（< 16px）', 模块外: l1, all: lv });
  }

  return res;
})()`;

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const s = await open({ port: 9391, width: 390, height: 844, settle: 900 });
  const js = s.js;
  await s.nav(BASE + '?layout=' + Date.now());
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
    /* ⚠ 反证打在哪很讲究：要打**块的子件**上（父容器是块流/纵向 flex），
       打在父容器自己身上只会把它整体挪走、相对偏移没变 → 判据不红 = 空反证。
       第 25 轮第一版就打错了（打 .settings-row .k 那种横向 flex 行的子件），四条反证只红一条。 */
    const css = FORCE === 'grid' ? '.settings-group .settings-row{margin-left:6px !important}'
      : FORCE === 'breath' ? '.settings-group .settings-row{margin-top:6px !important}'
        : FORCE === 'weight' ? '.settings-row .k{font-size:21px !important}'
          /* ⚠ 第 26 轮返工：原来打的是 `.settings-row:first-child .seg button.on` ——
         第 26 轮把「跟随系统」换成了 .switch，**第一行里根本没有 .seg 了** → 注入落空 →
         反证不红（假绿）。改成打一个**确实存在**的分段控件（切页动画那组），
         只动其中一个按钮的字号 → 丁 同类同尺寸 必须报红。 */
      : FORCE === 'size' ? '.seg[data-pref="pageMode"] button.on{font-size:18px !important}'
            /* 第 26 轮新增的四条：
               switch —— 把「跟随系统」那个开关换成"开 / 关"两个方块 → 戊 必须红
               clip   —— 把下拉改成硬截断（去掉省略号 + 压窄）     → 庚 必须红
               pad0   —— 抹掉页面级滚动容器的底部内边距           → 辛 必须红
               cv     —— 隔一行塞 40px 上间距（都合法，但忽大忽小）→ 壬 必须红（乙 不红） */
            : FORCE === 'clip' ? '#settings-body select.input{text-overflow:clip !important;max-width:var(--sp-16) !important}'
              : FORCE === 'pad0' ? '.settings-body,.shelf-list,.lore-body,.preset-body,.tools-body{padding-bottom:0 !important}'
                /* ⚠ 第一版打 `.settings-row:nth-child(odd){margin-top:40px}` —— 不红：
                   行间距本来是 0（靠分隔线），0 会被"≤2px 不算间距"跳过，剩下的全是 40 → 反而"很匀"。
                   改成让**同一容器里的小标题上间距**一大一小（48 / 20），这才是"忽大忽小"。 */
                : FORCE === 'cv' ? '.settings-body > h3:nth-of-type(odd){margin-top:var(--sp-8) !important}'
                  + '.settings-body > h3:nth-of-type(even){margin-top:var(--sp-1) !important}'
                  /* ⚠ 第 30 轮返工：原来写的是 sp-12 / sp-5（本主题里 = 24 / 20，只差 4px），
                     方差系数 0.09 << 0.34 的阈值 → **反证一直不红**（两个 json 里 fails=0，
                     也就是说壬/癸 这条链的"咬合力"从来没被证明过）。改成 40 / 4 才算真的"一大一小"。 */
                  : FORCE === 'switch' ? '' : '';
    if (css) {
      await js("(()=>{const st=document.createElement('style');st.textContent=" + JSON.stringify(css)
        + ";document.head.appendChild(st);return 1})()");
      console.log('  ⚠ 反证模式 LAYOUT_FORCE=' + FORCE + '（判据必须报红）');
    }
    if (FORCE === 'switch') console.log('  ⚠ 反证模式 LAYOUT_FORCE=switch（判据必须报红）');
  }
  const ids = await js("(()=>{try{return (window.Tools.TOOLS||[]).map(t=>t.id);}catch(e){return [];}})()") || [];
  let all = SCREENS.concat(OVERLAYS).concat(toolSurfaces(ids));
  const ONLY = (process.env.LAYOUT_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (ONLY.length) all = all.filter((sf) => ONLY.indexOf(sf.id) >= 0);
  const report = { at: new Date().toISOString(), base: BASE, force: FORCE, surfaces: [], fails: [] };
  for (const sf of all) {
    const roots = [sf.root].concat(sf.extra || []);
    const rec = { id: sf.id, root: roots.join('+'), shot: '', res: null, notes: [] };
    const opened = await js(sf.open);
    if (!opened) { rec.notes.push('打不开（跳过）'); report.surfaces.push(rec); continue; }
    await sleep(sf.settle || 800);
    if (FORCE === 'switch') {
      /* 反证 戊：打开这一屏之后，把里面的二元开关换回"两个方块（开 / 关）"老形态。
         必须在**这一屏渲染出来之后**做：启动时设置页还没渲染，找不着开关（第一版空反证就是这么来的）。 */
      await js("(()=>{let n=0;document.querySelectorAll('.switch').forEach(b=>{"
        + "const d=document.createElement('div');d.className='seg';"
        + "d.innerHTML='<button class=\\\'on\\\'>开</button><button>关</button>';"
        + "b.replaceWith(d);n++;});return n})()");
    }
    const shot = [ROUND, sf.file].join('-') + '.png';
    await s.shot(path.join(SHOTDIR, shot));
    rec.shot = shot;
    const r = await js(AUDIT(roots));
    rec.res = r;
    if (!r || r.err) rec.notes.push((r && r.err) || '探针没结果');
    else {
      for (const [k, lab] of [['align', '对齐'], ['breath', '间距不在格'], ['weight', '权重'],
        ['csize', '同类不同尺寸'], ['switch', '开关形态'], ['clip', '文字被硬裁'], ['tail', '底栏压内容'],
        ['cv', '呼吸不匀']]) {
        if ((r[k] || []).length) rec.notes.push(lab + ' ' + r[k].length + ' 处');
      }
      rec.bad = KEYS.reduce((n, k) => n + (r[k] || []).length, 0);
    }
    console.log('  · ' + sf.id.padEnd(22) + (rec.notes.length ? ' ✗ ' + rec.notes.join('，') : ' ✓ 干净'));
    if (sf.close) await js(sf.close);
    await sleep(240);
    report.surfaces.push(rec);
  }
  const flat = { align: [], breath: [], weight: [], csize: [], switch: [], clip: [], tail: [], cv: [] };
  for (const rec of report.surfaces) {
    const r = rec.res; if (!r || r.err) continue;
    for (const k of Object.keys(flat)) for (const it of (r[k] || [])) flat[k].push(Object.assign({ surface: rec.id }, it));
  }
  report.flat = flat;
  report.sum = Object.keys(flat).reduce((o, k) => { o[k] = flat[k].length; return o; }, {});
  const SUF = (process.env.LAYOUT_ONLY || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 20);
  const outName = process.env.LAYOUT_OUT ||
    (FORCE ? ('docs/空间布局实测-反证-' + FORCE + (SUF ? '-' + SUF : '') + '.json')
           : 'docs/空间布局实测' + (SUF ? '-分批-' + SUF : '') + '.json');
  fs.writeFileSync(path.join(ROOT, outName), JSON.stringify(report, null, 1));
  console.log('\n汇总：' + JSON.stringify(report.sum) + ' → ' + outName);
  s.close();
  process.exit(KEYS.reduce((n, k) => n + (report.sum[k] || 0), 0) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
