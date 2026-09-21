/* ============================================================
   e2e-topzone.js — 「顶上那一块」判据（第 45 轮加）

   用户原话（这一轮，一字不改）：
     ①「顶上这一块有一大块空白，看着很难受」
     ③「现在的那个理论上切换书的那个小方框，现在点一下不是会变成长条的那个吗？让它永久变成长条的，
        然后放在最上面，这样的话就不会穿模了，而且看上去好看一点，以及把它就是相当于是那一片区域，
        连带着他不要给他专门一个独特的区域，不然的话容易出现很奇怪的穿模」

   判据（每条都要能报红）：
     甲 **顶上不许有"一大块空白"**：每一屏量
        ① 顶栏内容（标题/按钮/切书长条）的**上留白** = 内容顶 − 顶栏内容盒顶；
        ② 顶栏内容盒 **下留白** = 顶栏内容盒底 − 内容底；
        ③ 顶栏底 → 正文第一个元素顶 的缝。
        三者都不得超过规范里那一档（顶栏本身的 padding，`--sp-2`=8 与 `--sp-1`=4 量级）。
     乙 **切书长条是"永久长条"**：`.bk-chip` 必须**一直可见**（不许再有"小方块⇄长条"两态），
        而且必须在**顶栏里面**（`closest('.topbar')`），不是内容流里另起一块。
     丙 **不许穿模**：长条跟同屏其它可见元素的重叠面积 = 0；左右边缘跟顶栏内容盒的误差 = 0。
     丁 **标题必须落在第一行**（第 47 轮加，用户报「怎么把字儿给弄下来了……还穿模了」）：
        标题是绝对定位（`.topbar-title`），顶栏现在是**两行**（第一行 图标+标题，第二行 切书长条）。
        绝对定位**不给 top** 时，落点按"整条顶栏"算 → 顶栏一变成两行，标题就掉到第二行压住长条/卡片。
        判据：① 标题竖直中心 ≈ 第一行（图标那一行）的竖直中心，误差 ≤ 2px；
              ② 标题整块必须落在第一行内（±2px）；③ 标题跟长条、跟正文第一个元素的重叠面积 = 0。
     戊 每一屏都拍一张图（改前/改后能对着看）。

   跑法：node tools/e2e-topzone.js           # 全屏
         TOPZONE_ONLY=shelf,settings node tools/e2e-topzone.js
         TOPZONE_FORCE=float|gap|overlap|notop node tools/e2e-topzone.js  # 反证，各自必须能红
   产出：docs/顶区实测.json（反证写 -反证-<FORCE>.json）+ docs/前端截图/r45-topzone-<面>.png
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');
const { readPassword, shieldOnly } = require('./preflight');
const SURF = require('./surfaces');

const ROOT = '/home/ubuntu/novel-app';
const FORCE = process.env.TOPZONE_FORCE || '';
const ONLY = (process.env.TOPZONE_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
const OUT = path.join(ROOT, 'docs', FORCE ? ('顶区实测-反证-' + FORCE + '.json') : '顶区实测.json');
const SHOT = path.join(ROOT, 'docs/前端截图');
const PW = readPassword();
const GAP_MAX = 12;        // 规范里顶栏那一档留白的上限（--sp-2=8 / --sp-3=12 量级）
const EDGE_TOL = 1;        // 边缘对齐允许的误差（边框 1px 级别）
const TITLE_TOL = 2;       // 标题落点允许的误差（第 47 轮：标题必须钉在第一行）

/* 顶栏里"看得见的内容"的包围盒（标题、按钮、长条……排除 topbar-right 这种透明容器本身） */
const SCAN = (rootSel) => `(() => {
  const root = document.querySelector(${JSON.stringify(rootSel)});
  if (!root) return { err: '没有这个屏' };
  const bar = root.querySelector('.topbar');
  if (!bar) return { err: '这一屏没有顶栏' };
  const vis = (e) => { const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = e.getBoundingClientRect(); return r.width > 0.5 && r.height > 0.5; };
  const R = (e) => { const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             r: Math.round(r.right), b: Math.round(r.bottom) }; };
  const br = bar.getBoundingClientRect();
  const cs = getComputedStyle(bar);
  const padT = parseFloat(cs.paddingTop) || 0;
  const box = { x: br.x, y: br.y + padT, w: br.width, h: br.height - padT,
                r: br.right, b: br.bottom, 高: Math.round(br.height) };
  /* 长条（顶栏第二行）—— 先拿到，下面 kids 要用它判断"谁在第一行" */
  const chipEl = bar.querySelector('.bk-bar');
  const chip = bar.querySelector('.bk-chip');
  /* 顶栏里所有"真内容"（自己不是透明容器、且有尺寸） */
  const kids = Array.from(bar.querySelectorAll('*')).filter((e) => vis(e) &&
    !(typeof e.className === 'string' && /topbar-right/.test(e.className)) &&
    e.getBoundingClientRect().height > 0.5);
  const kb = kids.map((e) => { const r = R(e);
    return { x: r.x, y: r.y, w: r.w, h: r.h, r: r.r, b: r.b, 在长条里: !!(chipEl && chipEl.contains(e)) }; });
  const 内容顶 = kb.length ? Math.min.apply(null, kb.map((k) => k.y)) : null;
  const 内容底 = kb.length ? Math.max.apply(null, kb.map((k) => k.b)) : null;
  const mini = root.querySelector('.topbar .bk-mini');
  const chipBox = chip && vis(chip) ? R(chip) : null;
  /* 正文第一个元素（顶栏之外、看得见、不在顶栏里） */
  let first = null;
  Array.from(root.children).forEach((n) => {
    if (n === bar || first) return;
    if (!vis(n)) return;
    if (n.hasAttribute('hidden') || n.classList.contains('hidden')) return;
    const r = n.getBoundingClientRect();
    if (r.height < 2) return;
    first = { 选择器: n.id ? ('#' + n.id) : (n.className ? ('.' + String(n.className).split(' ')[0]) : n.tagName),
              ...R(n) };
  });
  /* 第 47 轮：标题必须落在**第一行**（图标那一行），不许掉到第二行压住长条 */
  const title = bar.querySelector('.topbar-title');
  const titleBox = title && vis(title) ? R(title) : null;
  const 第一行 = kb.filter((k) => !k.在长条里);
  const row1Top = 第一行.length ? Math.min.apply(null, 第一行.map((k) => k.y)) : null;
  const row1Bot = 第一行.length ? Math.max.apply(null, 第一行.map((k) => k.b)) : null;
  const titleCenterY = titleBox ? Math.round((titleBox.y + titleBox.h / 2) * 10) / 10 : null;
  const 期望中心 = (row1Top === null) ? null : Math.round((row1Top + row1Bot) / 2 * 10) / 10;
  const titleOnRow1 = (titleBox && row1Top !== null)
    ? (titleBox.y >= row1Top - ${TITLE_TOL} && titleBox.b <= row1Bot + ${TITLE_TOL}) : null;
  const 面积0 = (a, b) => { if (!a || !b) return 0; const w = Math.min(a.r, b.r) - Math.max(a.x, b.x);
    const h = Math.min(a.b, b.b) - Math.max(a.y, b.y); return (w > 0 && h > 0) ? Math.round(w * h) : 0; };
  /* 穿模：长条跟顶栏之外的可见元素的重叠面积（顶栏自己不算） */
  const overlaps = [];
  const 面积 = (a, b) => { const w = Math.min(a.r, b.r) - Math.max(a.x, b.x);
    const h = Math.min(a.b, b.b) - Math.max(a.y, b.y); return (w > 0 && h > 0) ? Math.round(w * h) : 0; };
  if (chipBox) {
    Array.from(root.querySelectorAll('*')).forEach((e) => {
      if (!vis(e) || bar.contains(e) || e.contains(chip)) return;
      const cs2 = getComputedStyle(e);
      const 有底 = !/rgba?\\(0, 0, 0, 0\\)|transparent/.test(cs2.backgroundColor);
      const 有字 = (e.textContent || '').trim().length > 0 && e.children.length === 0;
      if (!有底 && !有字) return;
      const a = 面积(chipBox, R(e));
      if (a > 0) overlaps.push({ 选择器: e.id ? ('#' + e.id) : (String(e.className || e.tagName).split(' ')[0]),
                                 面积: a });
    });
  }
  return { bar: R(bar), box: box, padTop: padT,
           内容顶: 内容顶, 内容底: 内容底,
           上留白: 内容顶 === null ? null : Math.round(内容顶 - (br.y + padT)),
           下留白: 内容底 === null ? null : Math.round((br.bottom) - 内容底),
           topbar高: Math.round(br.height),
           缝到正文: (first && 内容底 !== null) ? Math.round(first.y - br.bottom) : null,
           first: first, chip: chipBox, mini: !!mini, chip在顶栏: !!chip,
           边缘误差左: chipBox ? Math.round(chipBox.x - (br.x + (parseFloat(cs.paddingLeft) || 0))) : null,
           边缘误差右: chipBox ? Math.round((br.right - (parseFloat(cs.paddingRight) || 0)) - chipBox.r) : null,
           overlaps: overlaps, kids: kb.length,
           title: titleBox, titleCenterY: titleCenterY, 期望中心: 期望中心,
           第一行: (row1Top === null) ? null : { y: row1Top, b: row1Bot },
           titleOnRow1: titleOnRow1,
           title到长条顶: (titleBox && chipBox) ? Math.round(chipBox.y - titleBox.b) : null,
           ovTitleChip: 面积0(titleBox, chipBox), ovTitleFirst: 面积0(titleBox, first) };
})()`;

const INJECT = {
  /* 反证一：把长条塞回"内容流里另起一块"（还原旧形态）→ 乙 必须红 */
  float: `(() => { const bar = document.querySelector('.screen:not(.hidden) .bk-bar');
    if (!bar) return 0; const host = document.querySelector('.screen:not(.hidden)');
    const tb = host.querySelector('.topbar'); tb.parentNode.insertBefore(bar, tb.nextSibling); return 1; })()`,
  /* 反证二：顶栏里人为撑出一大块空白 → 甲 必须红 */
  gap: `(() => { const tb = document.querySelector('.screen:not(.hidden) .topbar');
    if (!tb) return 0; tb.style.paddingTop = '40px'; tb.style.height = '96px'; return 1; })()`,
  /* 反证四（第 47 轮）：把标题刚加的 `top` 去掉 —— **还原用户报的 bug 那一版**
     （绝对定位不给 top，落点跟着"整条顶栏"走 → 顶栏两行时标题掉到第二行）→ 丁 必须红 */
  notop: `(() => { const t = document.querySelector('.screen:not(.hidden) .topbar .topbar-title');
    if (!t) return 0; t.style.top = 'auto'; t.style.transform = 'translateX(-50%)'; return 1; })()`,
  /* 反证三：让长条压到内容上（还原"穿模"）→ 丙 必须红 */
  overlap: `(() => { const c = document.querySelector('.screen:not(.hidden) .topbar .bk-chip');
    if (!c) return 0; c.style.position = 'relative'; c.style.marginTop = '-34px'; c.style.zIndex = '9'; return 1; })()`,
};

(async () => {
  await shieldOnly('e2e-topzone.js');
  const s = await open({ port: 9395, width: 390, height: 844, settle: 1200 });
  const fails = [];
  const rows = [];
  const bad = (m) => { fails.push(m); console.log('  ✗ ' + m); };

  await s.nav('http://127.0.0.1:8899/'); await sleep(2600);
  await s.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({password:${JSON.stringify(PW)}})}).then(r=>r.text())`);
  await s.nav('http://127.0.0.1:8899/'); await sleep(3800);
  const sp = await s.js(`(async () => { for (let i = 0; i < 90; i++) {
      const e = document.getElementById('splash');
      if (!e || e.classList.contains('gone') || getComputedStyle(e).display === 'none') return true;
      await new Promise((r) => setTimeout(r, 120)); } return false; })()`, 45000);
  if (!sp) { console.error('启动页没退场 —— 停'); process.exit(1); }

  const list = SURF.SCREENS.filter((x) => !ONLY.length || ONLY.indexOf(x.id) >= 0);
  for (const suf of list) {
    const ok = await s.js(suf.open, { timeout: 60000 }).catch(() => 0);
    await sleep(suf.settle || 900);
    if (FORCE && INJECT[FORCE]) { await s.js(INJECT[FORCE]); await sleep(350); }
    const r = await s.js(SCAN(suf.root), { timeout: 40000 }).catch((e) => ({ err: String(e && e.message) }));
    rows.push({ id: suf.id, ...r });
    const shot = path.join(SHOT, 'r45-topzone-' + suf.id + (FORCE ? ('-' + FORCE) : '') + '.png');
    try { await s.shot(shot); } catch (e) {}
    /* 没有顶栏的那几面（对话抽屉 / 阅读器 / 阅读器设置）**豁免甲/乙/丙** ——
       它们本来就没有顶栏、也没有切书长条（第 46 轮：切书长条活在顶栏里）。 */
    if (r.err && /没有顶栏/.test(r.err)) {
      console.log('  ' + suf.id.padEnd(12) + ' 没有顶栏 —— 甲/乙/丙 豁免（' + r.err + '）');
      continue;
    }
    if (r.err) { bad(suf.id + '：' + r.err); continue; }
    console.log('  ' + suf.id.padEnd(12) + ' 标题中心y=' + r.titleCenterY + '(期望 ' + r.期望中心 +
      ', 第一行 ' + JSON.stringify(r.第一行) + ', 在第一行=' + r.titleOnRow1 + ' 压长条=' + r.ovTitleChip +
      'px² 压正文=' + r.ovTitleFirst + 'px²)');
    console.log('  ' + suf.id.padEnd(12) + ' 顶栏高=' + r.topbar高 + ' 上留白=' + r.上留白 +
      ' 下留白=' + r.下留白 + ' 缝到正文=' + r.缝到正文 + ' 长条=' + (r.chip ? '有' : '无') +
      ' 在顶栏=' + r.chip在顶栏 + ' 小方块=' + r.mini + ' 重叠=' + r.overlaps.length +
      ' 左右边缘误差=' + r.边缘误差左 + '/' + r.边缘误差右);
    /* 甲：顶上不许有一大块空白 */
    [['上留白', r.上留白], ['下留白', r.下留白], ['缝到正文', r.缝到正文]].forEach(([k, v]) => {
      if (v !== null && v > GAP_MAX) bad(suf.id + ' 顶区 ' + k + '=' + v + 'px（上限 ' + GAP_MAX + '）—— 这一块就是用户说的"一大块空白"');
    });
    /* 乙：切书长条必须是"永久长条 + 在顶栏里" */
    if (!r.chip) bad(suf.id + ' 顶栏里没有切书长条（.bk-chip 不可见）—— 不是"永久长条"');
    if (r.mini) bad(suf.id + ' 还留着"小方块"那一态（.bk-mini）—— 用户要求永久长条');
    /* 丙：不许穿模 + 边缘对齐 */
    if (r.overlaps.length) bad(suf.id + ' 切书长条跟 ' + r.overlaps.length + ' 个元素重叠（' +
      r.overlaps.slice(0, 2).map((o) => o.选择器 + ' ' + o.面积 + 'px²').join('；') + '）—— 穿模');
    if (r.边缘误差左 !== null && Math.abs(r.边缘误差左) > EDGE_TOL) bad(suf.id + ' 长条左边缘跟顶栏内容差 ' + r.边缘误差左 + 'px');
    if (r.边缘误差右 !== null && Math.abs(r.边缘误差右) > EDGE_TOL) bad(suf.id + ' 长条右边缘跟顶栏内容差 ' + r.边缘误差右 + 'px');
    /* 丁：标题必须钉在第一行（第 47 轮，用户报"字儿给弄下来了"） */
    if (r.titleCenterY === null) bad(suf.id + ' 顶栏里量不到标题（.topbar-title 不可见）');
    else {
      if (r.期望中心 !== null && Math.abs(r.titleCenterY - r.期望中心) > TITLE_TOL) bad(suf.id +
        ' 标题竖直中心 y=' + r.titleCenterY + '，第一行中心 y=' + r.期望中心 + '（差 ' +
        Math.round((r.titleCenterY - r.期望中心) * 10) / 10 + 'px > ' + TITLE_TOL + '）—— 标题没落在第一行');
      if (r.titleOnRow1 === false) bad(suf.id + ' 标题整块跑到第一行外（标题 ' +
        JSON.stringify(r.title) + '；第一行 ' + JSON.stringify(r.第一行) + '）—— 用户说的"把字儿给弄下来了"');
      if (r.ovTitleChip > 0) bad(suf.id + ' 标题跟切书长条重叠 ' + r.ovTitleChip + 'px² —— 穿模');
      if (r.ovTitleFirst > 0) bad(suf.id + ' 标题跟正文第一个元素重叠 ' + r.ovTitleFirst + 'px² —— 标题压在卡片上');
    }
  }

  const rep = { at: new Date().toISOString().replace('T', ' ').slice(0, 19), force: FORCE || null,
                gapMax: GAP_MAX, titleTol: TITLE_TOL, rows: rows, bad: fails };
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
  console.log('\n' + (fails.length ? ('有红 ❌ ' + fails.length + ' 条') : '全过 ✅') + ' → ' + path.relative(ROOT, OUT));
  s.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
