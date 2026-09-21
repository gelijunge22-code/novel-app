/* ============================================================
   e2e-uiscale.js — 「全站整体收一档 + 哪两排不许缩」判据（第 46 轮加）

   用户原话（第 46 轮第 ② 条，一字不改）：
     「所有的前端整体的稍微缩小一下，不用缩小的是点开书之后下面的那一排小前端，
       但是下面那一排就是书里的设置，是需要稍微缩小一下的，
       然后整个大前端的，下面的那一排小前端也是不用的，也是很好看的，
       整个大设置，那个大设置里面的前端需要稍微调小一点」

   判据（每条都能报红）：
     甲 **要缩的确实缩了**：正文那一档字号（--t-base）、设置页分组标题、工具宫格间距
        （第 49 轮：缩放不再是"乘 0.92"，而是把要缩的那一档**烤进整数阶梯** ——
          间距 12→8、字号 14→13 / 13→12、顶栏 48→44、页边距 16→12；
          反证 UISCALE_FORCE=noscale = 把老值写回去）
        都必须**小于**改前（改前实测值钉在下面常量 BEFORE 里，来自 logs/r46-probe-before.json）。
     乙 **不许缩的两排，分毫不差**：
        `#tabbar` 高 = 50px、`.tab` 字号 = 11px、`.tab` padding-top = 8px（底部导航）
        `.rd-fb` 高 = 48px、`.rd-fb span` 字号 = 11px（阅读器底部动作栏）
        （"书里的设置" #rd-quick 不在 .reader-foot 里 —— 它是兄弟，照旧跟着缩，这正是用户要的）
     丙 **顶上那块 42px 的空白带没了**：内容流里的 .bk-bar-host 高度必须 < 2px
        （改前实测 42px：顶栏底下白白一条，里面只有一枚 34×34 的小方块 —— 用户说"看着很难受"）

   跑法：node tools/e2e-uiscale.js
         UISCALE_FORCE=nopin|noscale  node tools/e2e-uiscale.js   # 反证，各自必须报红
   产出：docs/前端尺寸实测.json（反证写 -反证-<FORCE>.json）+ docs/前端截图/r46-scale-<屏>.png
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');
const { readPassword, shieldOnly } = require('./preflight');

const ROOT = '/home/ubuntu/novel-app';
const FORCE = process.env.UISCALE_FORCE || '';
const OUT = path.join(ROOT, 'docs', FORCE ? ('前端尺寸实测-反证-' + FORCE + '.json') : '前端尺寸实测.json');
const SHOT = path.join(ROOT, 'docs/前端截图');
const PW = readPassword();
/* 改前实测（logs/r46-probe-before.json，2026-09-21 第 46 轮开跑时量的） */
const BEFORE = { tabbarH: 50, tabFont: 11, tabPadTop: 8, rdFbH: 48, rdFbFont: 11,
                 tBase: 15, settingsH3: 13, toolGap: 12, hostBand: 42 };

const SCAN = `(() => {
  const g = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; };
  const h = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().height * 100) / 100 : null; };
  const hosts = ['#shelf-book', '#preset-book', '#lore-book', '#tools-book']
    .map((s) => ({ sel: s, h: h(s) }));
  return {
    tabbarH: h('#tabbar'), tabFont: g('.tab', 'fontSize'), tabPadTop: g('.tab', 'paddingTop'),
    tBase: g('#settings-body', 'fontSize'), settingsH3: g('.settings-body h3', 'fontSize'),
    toolGap: g('.tools-grid', 'gap'), rdFbH: h('.rd-fb'), rdFbFont: g('.rd-fb span', 'fontSize'),
    rdQuickH3: g('.rd-quick-body h3', 'fontSize'),
    hosts: hosts, topbars: [].map.call(document.querySelectorAll('.screen:not(.hidden) .topbar'), (e) =>
      ({ id: e.parentNode.id, h: Math.round(e.getBoundingClientRect().height) }))
  };
})()`;

(async () => {
  await shieldOnly('e2e-uiscale.js');
  const s = await open({ port: 9398, width: 390, height: 844, settle: 1200 });
  const fails = [];
  const bad = (m) => { fails.push(m); console.log('  ✗ ' + m); };
  await s.nav('http://127.0.0.1:8899/'); await sleep(2600);
  await s.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({password:${JSON.stringify(PW)}})}).then(r=>r.text())`);
  await s.nav('http://127.0.0.1:8899/'); await sleep(3800);
  const sp = await s.js(`(async () => { for (let i = 0; i < 90; i++) { const e = document.getElementById('splash');
      if (!e || e.classList.contains('gone') || getComputedStyle(e).display === 'none') return true;
      await new Promise((r) => setTimeout(r, 120)); } return false; })()`, 45000);
  if (!sp) { console.error('启动页没退场 —— 停'); process.exit(1); }

  if (FORCE === 'nopin') {
    await s.js(`(() => { const st = document.createElement('style');
      st.textContent = '.tabbar,.reader-foot{--sp-2:7.36px !important;--t-sm:11.04px !important}';
      document.head.appendChild(st); return 1; })()`);
  } else if (FORCE === 'noscale') {
    /* 反证：把**没缩之前**的阶梯值写回去（第 46 轮那版的做法是乘 --ui:0.92，
       第 49 轮改成"把缩的那一档烤进整数阶梯"，所以反证也要跟着改成"写回老值"） */
    await s.js(`(() => { const st = document.createElement('style');
      st.textContent = ':root{--t-base:15px !important;--t-md:13px !important;--sp-3:12px !important}';
      document.head.appendChild(st); return 1; })()`);
  }
  await sleep(400);

  /* 阅读器那一排只有把阅读屏显示出来才量得到（它是 display:none 时 rect 全 0） */
  const RD = `(() => { const g = (sel, prop) => { const e = document.querySelector(sel);
      return e ? getComputedStyle(e)[prop] : null; };
    const h = (sel) => { const e = document.querySelector(sel);
      return e ? Math.round(e.getBoundingClientRect().height * 100) / 100 : null; };
    /* .rd-fb 是阅读器那一排的按钮：没开书时它是 display:none（rect 全 0），
       所以量**CSS 高度**（那才是它的定值），另外量 #reader-foot 的 rect 做交叉验证。 */
    return { rdFbH: parseFloat(g('.rd-fb', 'height')), rdFbFont: g('.rd-fb span', 'fontSize'),
             rdQuickH3: g('.rd-quick-body h3', 'fontSize'),
             rdFootH: h('#reader-foot') }; })()`;
  await s.js(`App.show('reader')`).catch(() => 0); await sleep(1000);
  const rd = await s.js(RD, { timeout: 30000 }).catch(() => ({}));
  await s.js(`App.show('settings')`).catch(() => 0); await sleep(1000);
  const m = await s.js(SCAN, { timeout: 40000 });
  m.rdFbH = rd.rdFbH; m.rdFbFont = rd.rdFbFont; m.rdQuickH3 = rd.rdQuickH3;
  m.rdFootH = rd.rdFootH;
  /* 令牌的**渲染值**（探针元素量，不靠哪一屏渲染到什么程度） */
  const tok = await s.js(`(() => { const d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:-9999px;font-size:var(--t-md);gap:var(--sp-3);display:flex';
    document.body.appendChild(d); const cs = getComputedStyle(d);
    const out = { tmd: parseFloat(cs.fontSize), sp3: parseFloat(cs.rowGap) }; d.remove(); return out; })()`);
  m.tmd = tok.tmd; m.sp3 = tok.sp3;
  console.log(JSON.stringify(m, null, 1));

  /* 甲：要缩的缩了 */
  const f = (v) => parseFloat(v) || 0;
  if (!(f(m.tBase) < BEFORE.tBase)) bad('正文那一档字号没缩：' + m.tBase + '（改前 ' + BEFORE.tBase + 'px）');
  if (!(m.tmd < BEFORE.settingsH3)) bad('字号阶梯中档没缩：--t-md = ' + m.tmd + 'px（改前 ' + BEFORE.settingsH3 + 'px）');
  if (!(m.sp3 < BEFORE.toolGap)) bad('间距令牌没缩：--sp-3 = ' + m.sp3 + 'px（改前 ' + BEFORE.toolGap + 'px）');
  /* 乙：两排分毫不差 */
  if (m.tabbarH !== BEFORE.tabbarH) bad('底部导航高度变了：' + m.tabbarH + ' ≠ ' + BEFORE.tabbarH + 'px（用户点名这一排"很好看"）');
  if (f(m.tabFont) !== BEFORE.tabFont) bad('底部导航字号变了：' + m.tabFont + ' ≠ ' + BEFORE.tabFont + 'px');
  if (f(m.tabPadTop) !== BEFORE.tabPadTop) bad('底部导航里的文字位置变了：padding-top ' + m.tabPadTop + ' ≠ ' + BEFORE.tabPadTop + 'px');
  if (m.rdFbH !== BEFORE.rdFbH) bad('阅读器底部动作栏高度变了：' + m.rdFbH + ' ≠ ' + BEFORE.rdFbH + 'px');
  if (f(m.rdFbFont) !== BEFORE.rdFbFont) bad('阅读器底部动作栏字号变了：' + m.rdFbFont + ' ≠ ' + BEFORE.rdFbFont + 'px');
  /* 丙：顶上那块空白带没了 */
  m.hosts.forEach((x) => { if (!(x.h < 2)) bad(x.sel + ' 顶上还留着 ' + x.h + 'px 的空白带（改前 ' + BEFORE.hostBand + 'px）'); });

  for (const id of ['shelf', 'preset', 'settings', 'tools', 'reader', 'lore', 'chat']) {
    await s.js(`App.show(${JSON.stringify(id)})`).catch(() => 0);
    await sleep(900);
    try { await s.shot(path.join(SHOT, 'r46-scale-' + id + (FORCE ? ('-' + FORCE) : '') + '.png')); } catch (e) {}
  }

  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    force: FORCE || null, before: BEFORE, after: m, bad: fails }, null, 1));
  console.log('\n' + (fails.length ? ('有红 ❌ ' + fails.length + ' 条') : '全过 ✅') + ' → ' + path.relative(ROOT, OUT));
  s.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
