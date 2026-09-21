/* ============================================================
   e2e-corners.js — 弹层「四角 + 夜间白边」自动体检（第 12 轮）

   为什么有这东西：
     用户实机反馈：「点开设置，应该是从底下弹出来、边角是弧形的，结果有些没适配，
     边边还是白的，不是弧形的，夜间最明显。」
     肉眼挑毛病挑不出全部，所以做成可复现的判据。

   怎么判（每个弹层的左上角 / 右上角，放大后逐像素看）：
     ① 角是不是真的被裁圆了：把「角上最外面那一个像素」取样，
        如果它等于弹层自己的底色 → 圆角没生效（直角）→ 失败。
     ② 有没有白边/亮边：沿弹层顶边扫一条线，只要出现比弹层底色亮 30/255 以上的像素
        （内白色 hairline、露出来的白底、没裁干净的白角）→ 失败。
     ③ 日间 + 夜间都要过：夜间最容易露馅。

   用法：node tools/e2e-corners.js
   产出：docs/弹层四角/*.png（放大裁剪）+ docs/弹层四角/meta.json
        → 再跑 tools/corner_check.py 出判定报告
   ============================================================ */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
// 目录可换：反证实验（FORCE_WHITE=1）要写到另一个目录，别把真证据混进去
const DIR = path.join(ROOT, process.env.CORNERS_DIR || 'docs/弹层四角');

const THEMES = ['paper', 'white', 'sepia', 'night'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}

/* 弹层清单：全部走**真实交互路径**打开（不自己拼 DOM，免得测了个假东西） */
const OVERLAYS = [
  {
    id: 'reader-menu-set', sel: '#sheet-panel', title: '阅读器更多 → 设置页签（用户点名的那一个）',
    open: `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const card = document.querySelector('#shelf-list .book-card');
      if (card) { card.click(); await wait(2600); }
      const mb = document.querySelector('[data-act="reader-menu"]');
      if (mb) { mb.click(); await wait(900); }
      const tab = [...document.querySelectorAll('.rd-tab')].find((b) => b.dataset.t === 'set');
      if (tab) { tab.click(); await wait(600); }
      return 1;
    })()`,
    close: `(async () => { App.closeSheet(); await new Promise((r) => setTimeout(r, 420)); return 1; })()`,
  },
  {
    id: 'reader-menu-toc', sel: '#sheet-panel', title: '阅读器更多 → 目录',
    open: `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const mb = document.querySelector('[data-act="reader-menu"]');
      if (mb) { mb.click(); await wait(900); }
      return 1;
    })()`,
    close: `(async () => { App.closeSheet(); await new Promise((r) => setTimeout(r, 420)); return 1; })()`,
  },
  {
    id: 'chapter-menu', sel: '#sheet-panel', title: '目录里每一章的「改章名 / 删除」小抽屉（带抓手条）',
    open: `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const mb = document.querySelector('[data-act="reader-menu"]');
      if (mb) { mb.click(); await wait(900); }
      const more = document.querySelector('#rd-tabbody .chmore') ||
                   document.querySelector('#rd-tabbody .rd-toc-item');
      if (more) { more.click(); await wait(700); }
      return 1;
    })()`,
    close: `(async () => { App.closeSheet(); await new Promise((r) => setTimeout(r, 420)); return 1; })()`,
  },
  {
    id: 'modal-confirm', sel: '#modal-panel', title: '确认弹窗（App.confirm）',
    open: `(async () => {
      App.confirm('这是弹窗四角体检用的一条确认文案。', () => {}, '好');
      await new Promise((r) => setTimeout(r, 420));
      return 1;
    })()`,
    close: `(async () => { App.closeModal(); await new Promise((r) => setTimeout(r, 320)); return 1; })()`,
  },
  {
    id: 'toast', sel: '#toast', title: '提示条（toast）',
    open: `(async () => { App.toast('已保存'); await new Promise((r) => setTimeout(r, 260)); return 1; })()`,
    close: `(async () => { const t = document.getElementById('toast'); if (t) t.classList.add('hidden'); return 1; })()`,
  },
  {
    id: 'login-card', title: '登录页卡片（未登录时才看得见，有就一起拍）',
    skip: true,
  },
];

const THEME_OF = { paper: '米黄', white: '纸白', sepia: '暖褐', slate: '青灰', green: '护眼', night: '夜间' };

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'corners-'));
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=9341', '--window-size=390,844',
    '--disable-features=HttpsFirstMode,HttpsUpgrades',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch('http://127.0.0.1:9341/json/list')).json(); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('chrome 起不来'); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable').catch(() => {});
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  const js = async (expr, wait) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (wait) await sleep(wait);
    const ex = r.result && r.result.exceptionDetails;
    if (ex) {                       /* 页面里的 JS 报错，必须看得见（第一版静默返回 null，白跑了一轮） */
      console.log('  ! 页面 JS 报错：' + String(ex.text || '') + ' :: ' + String((ex.exception && ex.exception.description) || '').split('\n')[0]);
      return null;
    }
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const snap = async (name, clip) => {
    const params = { format: 'png' };
    if (clip) params.clip = Object.assign({ scale: 1 }, clip);
    const r = await send('Page.captureScreenshot', params);
    if (!(r.result && r.result.data)) return null;
    fs.writeFileSync(path.join(DIR, name + '.png'), Buffer.from(r.result.data, 'base64'));
    return name + '.png';
  };

  await send('Page.navigate', { url: BASE + '?corners=' + Date.now() });
  await sleep(5500);
  if (await js("document.getElementById('login') && !document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
      ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4500);
  }

  /* ── 反证模式（第 12 轮加）────────────────────────────────────────
     判据必须**先能报红**，绿才算数。所以给两个"故意做坏"的开关：
       FORCE=pre-fix   把弹层的圆角/裁剪关掉（= 修之前那种直角）
       FORCE=white-bg  把弹层背后那层改成纯白、蒙层关掉（= 用户看到的"边边是白的"）
     跑这两个，报告必须报失败；再跑正常态，必须全绿。两组数据一起留档。 */
  const FORCE = process.env.FORCE || '';
  if (FORCE === 'pre-fix' || FORCE === 'white-bg') {
    const css = FORCE === 'pre-fix'
      ? 'html,body{--radius-sheet:0px !important} .sheet-panel,.modal-panel{border-radius:0 !important;'
        + '-webkit-clip-path:none !important;clip-path:none !important}'
      : 'html,body{background:#ffffff !important} .sheet{background:#ffffff !important}'
        + ' .sheet-mask{opacity:0 !important} .modal{background:#ffffff !important}'
        + ' .modal-mask{opacity:0 !important}';
    await js("(()=>{const st=document.createElement('style');st.textContent=" + JSON.stringify(css) + ";"
      + "document.head.appendChild(st);return 1})()");
    console.log('  ⚠ 反证模式 FORCE=' + FORCE + '（判据必须报红；报绿就说明判据是空判据）');
  }
  const meta = { at: new Date().toISOString(), base: BASE, dpr: 3, force: process.env.FORCE || '', items: [], notes: [] };
  for (const ov of OVERLAYS) {
    if (ov.skip) continue;
    for (const theme of THEMES) {
      /* 主题**要验一遍真的应用上了再拍**。
         这条是被一次假红逼出来的：`reader-menu-set @ white` 那一组，量到的 `themeApplied` 是
         `paper`（上一组的主题还留着），于是"弹层背后不是主题色"报了两条红 —— 看着像界面的毛病，
         其实是脚本自己没把主题切过去。切完**读回来核对**，不对就再切一次。 */
      const wantTheme = async () => {
        for (let i = 0; i < 3; i++) {
          await js("(async()=>{ Prefs.set('theme','" + theme + "'); await new Promise(r=>setTimeout(r,260)); return 1; })()");
          await sleep(220);
          if ((await js("document.documentElement.dataset.theme")) === theme) return true;
        }
        return (await js("document.documentElement.dataset.theme")) === theme;
      };
      const themeOk = await wantTheme();
      const opened = await js(ov.open);
      if (!opened) { meta.notes.push(ov.id + '/' + theme + '：打不开（跳过）'); continue; }
      await sleep(420);
      /* 打开弹层本身也可能把主题顶回去（阅读器会按这本书的阅读底色重画）→ 开完再核一次。 */
      const themeOk2 = themeOk ? true : await wantTheme();
      if (!themeOk2) meta.notes.push(ov.id + '/' + theme + '：主题没切过去（脚本问题，这一组不算数）');
      // 量：弹层矩形 + 弹层自己的底色 + 弹层外（蒙层/页面）的底色
      const box = await js(`(() => {
        const el = document.querySelector(${JSON.stringify(ov.sel)});
        if (!el) return { err: '没有 ' + ${JSON.stringify(ov.sel)} };
        const r = el.getBoundingClientRect();
        if (!(r.width > 8 && r.height > 4)) return { err: '尺寸是 0：' + JSON.stringify({ w: r.width, h: r.height }) };
        const host = el.closest('.sheet, .modal');
        if (host && host.classList.contains('hidden')) return { err: '宿主还是 hidden（没打开）' };
        const cs = getComputedStyle(el);
        return { x: r.left, y: r.top, w: r.width, h: r.height, bg: cs.backgroundColor, id: el.id,
                 radius: cs.borderTopLeftRadius, overflow: cs.overflow,
                 clip: cs.clipPath || cs.webkitClipPath || 'none',
                 theme: ${JSON.stringify(theme)}, themeApplied: document.documentElement.dataset.theme };
      })()`);
      if (!box || box.err) { meta.notes.push(ov.id + '/' + theme + '：' + ((box && box.err) || '量不到矩形')); console.log('  ! ' + ov.id + ' @ ' + theme + ' → ' + ((box && box.err) || '量不到矩形')); await js(ov.close); continue; }
      const M = 8;                                   // 往上/左留 8px，好把弹层外面的底色拍进来
      // 裁剪边长要**盖住整段圆弧再往外**：第一版固定 26px，遇上胶囊（toast 半径 20）时
      // 平直段整个落在弧里，量到的全是弧外的页面底 → 6 条假红。现在按实测半径算。
      const rawR = parseFloat(String(box.radius || '0')) || 0;
      const R = Math.min(rawR, box.h / 2, box.w / 2, 40);
      const W = Math.ceil(Math.max(26, M + R + 14));
      const tl = await snap(`${ov.id}-${theme}-tl`, { x: Math.max(0, box.x - M), y: Math.max(0, box.y - M), width: W, height: W });
      const tr = await snap(`${ov.id}-${theme}-tr`, { x: Math.max(0, box.x + box.w - (W - M)), y: Math.max(0, box.y - M), width: W, height: W });
      // 四角都要：下边还在屏幕里的（弹窗）连下面两个角一起拍
      const bl = box.y + box.h + M < 844
        ? await snap(`${ov.id}-${theme}-bl`, { x: Math.max(0, box.x - M), y: box.y + box.h - (W - M), width: W, height: W }) : '';
      const br = box.y + box.h + M < 844
        ? await snap(`${ov.id}-${theme}-br`, { x: Math.max(0, box.x + box.w - (W - M)), y: box.y + box.h - (W - M), width: W, height: W }) : '';
      let full = '';
      if (theme === 'night' || theme === 'paper') full = await snap(`${ov.id}-${theme}-full`);
      meta.items.push({ overlay: ov.id, overlayTitle: ov.title, theme, themeName: THEME_OF[theme] || theme,
        box, tl, tr, bl, br, full, margin: M, crop: W, radiusEff: R,
        scrim: ov.sel !== '#toast' });
      console.log(`  · ${ov.id} @ ${theme}  底 ${box.bg}  圆角 ${box.radius}  裁 ${tl} ${tr}`);
      await js(ov.close);
      await sleep(420);
    }
  }
  fs.writeFileSync(path.join(DIR, 'meta.json'), JSON.stringify(meta, null, 1));
  console.log(`\n裁剪 ${meta.items.length} 组 → docs/弹层四角/`);
  const py = spawnSync('python3', [path.join(ROOT, 'tools/corner_check.py')], { encoding: 'utf8' });
  process.stdout.write(py.stdout || '');
  process.stderr.write(py.stderr || '');
  process.exit(py.status || 0);
})();
