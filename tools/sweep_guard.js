/* ============================================================
   sweep_guard.js —— 走查判据的**单一出处**。
   为什么单独抽出来：e2e-sweep.js 报"0 问题"时，必须先能证明
   "这套判据在坏界面上真的会报问题"。反证脚本（tools/verify_sweep_guard.js）
   故意把设置页主题组打回旧写法（flex-wrap 自由换行 → 第 7 个孤零零一行），
   再跑**同一段** MEASURE 与**同一个** judgeGroup，看它有没有报出来。
   判据只此一份，反证与正式走查共用 —— 否则等于自己另写一套判据替自己说话。
   ============================================================ */

/* 量页面（在页面里 eval）。原样取自 e2e-sweep.js，语义只有这一份：
   要改就改这里，正式走查与反证脚本自动同步。 */
const MEASURE = `(function () {
  const vis = (el) => el && el.offsetParent !== null;
  const screen = document.querySelector('.screen:not(.hidden)');
  const out = { screen: screen ? screen.id : '', overflowX: 0, clipped: [], invisible: [], groups: [], closeBtn: false, len: 0 };
  const vw = window.innerWidth;
  document.querySelectorAll('body *').forEach((el) => {
    if (!vis(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width > vw + 1 || r.right > vw + 1) {
      if (out.overflowX === 0) out.overflowX = Math.round(Math.max(r.width, r.right));
    }
    const cs = getComputedStyle(el);
    const txt = (el.childElementCount === 0 && el.textContent) ? el.textContent.trim() : '';
    if (txt.length > 1) {
      if (el.scrollWidth > el.clientWidth + 2 && cs.overflow !== 'visible' && el.clientWidth > 0) {
        /* 区分"设计好的省略/多行截断"和"真的被切断"（上一轮把 28 条设计好的单行省略全报成 bug，等于自己骗自己） */
        const ell = cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none');
        if (!ell) out.clipped.push({ cls: el.className || el.tagName, text: txt.slice(0, 24),
                                     sw: el.scrollWidth, cw: el.clientWidth });
      }
      const fg = cs.color, bg = cs.backgroundColor;
      if (fg === bg && cs.opacity !== '0') out.invisible.push({ cls: el.className || el.tagName, text: txt.slice(0, 20) });
    }
  });
  out.clipped = out.clipped.slice(0, 4);
  out.invisible = out.invisible.slice(0, 4);

  /* ── 选项组：一行里全是按钮/胶囊的容器（主题、切页动画、语速…）量行数与每行宽度 ── */
  const isPill = (e) => e.matches('button, .chip, .pill, .seg-item, .opt');
  document.querySelectorAll('.seg, .quick, [data-pref]').forEach((g) => {
    if (!vis(g)) return;
    const kids = [...g.children].filter((k) => k.offsetParent !== null && isPill(k));
    if (kids.length < 3) return;
    const rows = [];
    kids.forEach((k) => {
      const t = Math.round(k.getBoundingClientRect().top);
      const w = Math.round(k.getBoundingClientRect().width);
      const row = rows.find((r) => Math.abs(r.top - t) <= 3);
      if (row) { row.w = Math.max(row.w, w); row.n++; } else rows.push({ top: t, w, n: 1 });
    });
    const widths = rows.map((r) => r.w);
    out.groups.push({ key: g.getAttribute('data-pref') || g.className, items: kids.length,
                      rows: rows.length, perRow: rows.map((r) => r.n), widths,
                      spread: Math.max.apply(null, widths) - Math.min.apply(null, widths),
                      alone: rows.some((r) => r.n === 1) });
  });
  out.groups = out.groups.slice(0, 8);

  /* 返回入口：整个面板页里找「右上 ×」或「左上返回箭头」，**而且必须真的看得见**。
     反证时抓到过：把返回键 display:none 掉，老判据照样算"有入口"（只查了存在性）
     —— 用户点不到的东西不算入口。另外把"是 × 还是 ←"记下来，
     免得报告里含混地说"有 ×"（其实只有 ←）。 */
  const shown = (el) => {
    if (!el) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const scr = document.getElementById('screen-tool');
  const cands = scr ? [...scr.querySelectorAll('[data-act="close"], [data-act="tool-back"], .topbar-back')].filter(shown) : [];
  const tb = cands.find((e) => e.getAttribute('data-act') === 'close') || cands[0] || null;
  out.closeBtn = !!tb;
  out.closeKind = tb ? (tb.getAttribute('data-act') === 'close' ? '×' : '←') : '';
  out.closeLabel = tb ? (tb.textContent || tb.getAttribute('aria-label') || '').trim() : '';
  const body = document.getElementById('tool-body');
  out.len = body ? body.innerText.replace(/\\s+/g, ' ').trim().length : 0;
  out.picker = !!(body && body.querySelector('[data-slug]'));
  return JSON.stringify(out);
})()`;

/* 一组选项按钮（主题 / 切页动画 / 语速…）算不算换行失衡：
   · 某一行只有 1 个（"夜间"孤零零靠右）      → 一眼失衡
   · 排到 3 行及以上                          → 挤
   · 各行的最宽按钮差 ≥30px                    → 没对齐 */
function judgeGroup(g) {
  return !!(g && (g.alone || g.rows > 2 || g.spread >= 30));
}
function groupDetail(g) {
  return (g.key || '') + ' ' + g.items + ' 项排成 ' + g.rows + ' 行 ' + JSON.stringify(g.perRow) +
         ' 行宽' + JSON.stringify(g.widths);
}
/* 逐面板判据（**唯一出处**）：正式走查与反证脚本共用。
   返回问题数组，空数组 = 这一屏没问题。 */
function judgePanel(name, m) {
  const out = [];
  const main = name.indexOf('主界面') === 0;          /* 主界面不是工具面板，判据不同 */
  if (!m || m.__err) return [{ kind: '测量失败', detail: m && m.__err }];
  if (!main && m.screen !== 'screen-tool') out.push({ kind: '没进面板', detail: m.screen + (m.picker ? '(还在选书页)' : '') });
  if (!main && m.screen === 'screen-tool' && !m.closeBtn) out.push({ kind: '面板没有返回入口（←/×，且要看得见）', detail: '' });
  if (!main && m.screen === 'screen-tool' && m.len < 20) out.push({ kind: '面板进去了但是空的', detail: m.len + ' 字' });
  if (m.overflowX > 391) out.push({ kind: '横向溢出', detail: m.overflowX + 'px' });
  (m.clipped || []).forEach((c) => out.push({ kind: '文字被硬切（没有省略号）', detail: c.cls + ' ' + c.text + ' (' + c.cw + '<' + c.sw + ')' }));
  (m.invisible || []).forEach((c) => out.push({ kind: '字与底同色', detail: c.cls + ' ' + c.text }));
  (m.groups || []).forEach((g) => { if (judgeGroup(g)) out.push({ kind: '选项组换行失衡', detail: groupDetail(g) }); });
  return out;
}

module.exports = { MEASURE, judgeGroup, groupDetail, judgePanel };
