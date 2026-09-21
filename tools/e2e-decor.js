/* e2e-decor.js — 大背景质感（纸纹 / 竹影 / 水波 / 自然光）的判据
   ============================================================
   用户点名的第 ④ 件（原话）：「现在的大背景，说实话还是有点单调，总感觉有点丑丑的，
   可以增加一些那种就是波纹啊，或者就是比较好看的那种花纹，那种竹子啊」。

   判据（甲~戊，每条都能红）：
     甲 该有装饰的屏真的有，而且是**五层**（纸纹/竹影/水波/光/收边）；
        启动页那一屏在本机是"闪一下就没"（boot 太快），所以它是**把 index.html 里的
        那一段原样克隆出来量**（真实标记 + 真实规则），不是另写一份假的。
     乙 阅读器**一层都没有**（正文要干净，且那边有"像素色 == --paper"的判据）
     丙 **最要紧的一条**：装饰的墨迹必须压在阈以下 —— 把一屏的内容清空后，
        imgstat 量的**主体墨迹仍 < 1%**。要是装饰把"空白屏"喂出墨迹，
        e2e-nav 那条「屏上必须有货」判据就废了（反证再也红不了）。
     丁 日/夜两套都在；夜间那一版**不发白**（亮像素占比 < 2%，暖米墨色 + ≤.018 透明度）
     戊 装饰不吃布局：没有横向溢出

   反证（都会被量到，报绿=判据是空的）：
     DECOR_FORCE=off    关掉装饰            → **甲 必须红**
     DECOR_FORCE=loud   透明度放大 10 倍     → **丙 必须红**
     DECOR_FORCE=reader 给阅读器也铺上       → **乙 必须红**

   跑法：node tools/e2e-decor.js            （反证：DECOR_FORCE=off|loud|reader）
   产出：docs/装饰实测.json（反证写 -反证-<force>.json）+ docs/装饰截图/*.png
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { open, sleep } = require('./cdp');

const ROOT = '/home/ubuntu/novel-app';
const FORCE = process.env.DECOR_FORCE || '';
const OUT = path.join(ROOT, 'docs', FORCE ? ('装饰实测-反证-' + FORCE + '.json') : '装饰实测.json');
const SHOTS = path.join(ROOT, 'docs/装饰截图');
const pw = (() => { try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; } catch (e) { return ''; } })();

const fails = [], steps = [];
function step(name, ok, info) {
  steps.push({ name, ok: !!ok, info });
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (info === undefined ? '' : '  ' + JSON.stringify(info)));
  if (!ok) fails.push(name);
}
function diff(a, b, rect) {
  try {
    const args = [path.join(ROOT, 'tools/imgdiff.py'), a, b];
    if (rect) args.push('--rect=' + rect.join(','));
    return JSON.parse(execFileSync(path.join(ROOT, 'server/venv/bin/python'), args, { encoding: 'utf8' }));
  } catch (e) { return { ok: false, why: String(e && e.message) }; }
}
function imgstat(file) {
  try {
    return JSON.parse(execFileSync(path.join(ROOT, 'server/venv/bin/python'),
      [path.join(ROOT, 'tools/imgstat.py'), file], { encoding: 'utf8' }));
  } catch (e) { return { ink: -1, core: -1 }; }
}
const shot = (n) => path.join(SHOTS, (FORCE ? '反证-' + FORCE + '-' : '') + n + '.png');

/* 页面里共用的小工具：数"层数"（url(...) 一个 + 每个 *-gradient( 一个）
   注意别用"按逗号切"——`rgba(0,0,0,.05)` 里的逗号会把一层切成好几段（第一版就这么错的）。 */
const HELPERS = `
  window.__decCnt = (bi) => { const s = (bi || '').trim();
    if (!s || s === 'none') return 0;
    return (s.match(/url\\(/g) || []).length + (s.match(/-gradient\\(/g) || []).length; };
  window.__decHas = (bi) => { const raw = decodeURIComponent(bi || '');
    return { 纸纹: /feTurbulence/.test(raw), 竹影: /220 640/.test(raw), 水波: /420 420/.test(raw) }; };
`;

const INJECT = `(() => {
  const force = ${JSON.stringify(FORCE)};
  const SEL = '#screen-shelf,#screen-chat,#screen-lore,#screen-preset,#screen-settings,' +
    '#screen-tools,#screen-tool,#splash,.login';
  const st = document.createElement('style'); st.id = '__decorprobe';
  if (force === 'off') st.textContent = SEL + '{background-image:none !important}';
  if (force === 'loud') st.textContent = SEL + '{background-image:none !important;' +
    'background:repeating-linear-gradient(45deg,rgba(0,0,0,.40) 0 7px,rgba(0,0,0,0) 7px 14px) !important}';
  if (force === 'reader') st.textContent = '#screen-reader{background-image:' +
    'repeating-linear-gradient(45deg,rgba(0,0,0,.34) 0 7px,rgba(0,0,0,0) 7px 14px) !important}';
  document.head.appendChild(st);
  return force || '（正常）';
})()`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const p = await open({ port: 9394, width: 390, height: 844, settle: 1000 });
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(2600);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(pw)}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(3800);
    await p.js(HELPERS);
    await p.js(INJECT);

    console.log('\n=== 甲、该有装饰的屏（七屏 + 启动页 + 登录页）===');
    const got = await p.js(`(async () => {
      const ids = ['screen-shelf','screen-chat','screen-lore','screen-preset','screen-settings','screen-tools','screen-tool'];
      const rows = ids.map((id) => { const el = document.getElementById(id);
        const cs = getComputedStyle(el);
        return Object.assign({ id: id, layers: window.__decCnt(cs.backgroundImage) },
          window.__decHas(cs.backgroundImage)); });
      /* 启动页：本机 boot 太快（<150ms 就 remove 了），所以把 index.html 里那一段
         原样克隆出来挂上 —— 量的是**真实标记 + 真实规则**，不是另写一份。 */
      const tpl = document.createElement('template');
      tpl.innerHTML = await (await fetch('index.html', { cache: 'no-store' })).text();
      const src = tpl.content.querySelector('#splash');
      let splash = null;
      if (src) { const sp = src.cloneNode(true); document.body.appendChild(sp);
        const cs = getComputedStyle(sp);
        splash = Object.assign({ layers: window.__decCnt(cs.backgroundImage) },
          window.__decHas(cs.backgroundImage));
        window.__splashClone = sp; }
      const lg = document.querySelector('.login');
      const lcs = lg ? getComputedStyle(lg) : null;
      const rd = getComputedStyle(document.getElementById('screen-reader'));
      return { rows: rows, splash: splash,
        login: lcs ? Object.assign({ layers: window.__decCnt(lcs.backgroundImage) }, window.__decHas(lcs.backgroundImage)) : null,
        reader: Object.assign({ layers: window.__decCnt(rd.backgroundImage) }, window.__decHas(rd.backgroundImage)) };
    })()`, { timeout: 25000 });

    const bad = got.rows.filter((r) => r.layers < 5 || !r.纸纹 || !r.竹影 || !r.水波).map((r) => r.id);
    step('甲1 七个屏都铺了装饰（纸纹+竹影+水波 三件套都在，且 ≥5 层）', bad.length === 0, { 缺的屏: bad });
    const okSplash = FORCE === 'off' ? (got.splash && got.splash.layers === 0)
      : (got.splash && got.splash.layers >= 5 && got.splash.竹影 && got.splash.水波 && got.splash.纸纹);
    step('甲2 启动页（克隆真标记量的）也有五层', okSplash, got.splash);
    const okLogin = FORCE === 'off' ? (got.login && got.login.layers === 0)
      : (got.login && got.login.layers >= 5 && got.login.竹影);
    step('甲3 登录页也有（那一屏几乎全空，装饰不跟任何正文打架）', okLogin, got.login);

    console.log('\n=== 乙、阅读器一层都不许有 ===');
    step('乙1 阅读器 background-image 里没有任何装饰（正文要干净）',
      got.reader.layers === 0 && !got.reader.纸纹 && !got.reader.竹影 && !got.reader.水波,
      { layers: got.reader.layers });

    /* 启动页/登录页那两张观感图：趁克隆的启动页还挂着，先拍它 */
    if (got.splash && FORCE !== 'off') {
      await p.js(`(() => { const sp = window.__splashClone; if (sp) sp.scrollIntoView(); return 1; })()`);
      await sleep(500);
      await p.shot(shot('启动页-日间'));
      await p.js(`(() => { document.documentElement.dataset.theme = 'night'; return 1; })()`);
      await sleep(500);
      await p.shot(shot('启动页-夜间'));
      await p.js(`(() => { document.documentElement.dataset.theme = 'paper';
        const sp = window.__splashClone; if (sp) sp.remove(); return 1; })()`);
      await sleep(400);
    }

    /* 关掉装饰只改 background-image，不动任何其它属性 —— 这样两张图除了装饰完全一致 */
    const STRIP = (on) => p.js(`(() => {
      const id = '__decorstrip'; const was = document.getElementById(id);
      if (was) was.remove();
      if (!(${on})) {
        const st = document.createElement('style'); st.id = id;
        st.textContent = '#screen-shelf,#screen-chat,#screen-lore,#screen-preset,#screen-settings,' +
          '#screen-tools,#screen-tool,#splash,.login{background-image:none !important}';
        document.head.appendChild(st);
      }
      return 1; })()`);

    console.log('\n=== 丙、装饰不许把"空白屏"喂出墨迹（最要紧的一条）===');
    await p.js(`(() => { document.body.dataset.tab = 'settings';
      ['screen-shelf','screen-reader','screen-chat','screen-lore','screen-preset','screen-tools','screen-tool']
        .forEach((id) => document.getElementById(id).classList.add('hidden'));
      document.getElementById('screen-settings').classList.remove('hidden');
      const b = document.getElementById('settings-body'); if (b) b.innerHTML = '';
      return 1; })()`);
    await sleep(900);
    await p.shot(shot('空白屏-装饰在'));
    await STRIP(false); await sleep(600);
    await p.shot(shot('空白屏-无装饰'));
    await STRIP(true); await sleep(600);
    const st1 = imgstat(shot('空白屏-装饰在'));
    step('丙1 清空内容后主体墨迹 < 1%（装饰没把"空白屏"喂出墨迹）',
      st1.core >= 0 && st1.core < 0.01, { 主体墨迹: st1.core });

    console.log('\n=== 丁、看得见，但不过分（同一屏只差"装饰开 / 关"两张图）===');
    /* 切回书架：丙 把设置屏清空过，装饰的差分要量**有内容的那一屏**（拿真界面说话） */
    await p.js(`(() => { document.getElementById('screen-settings').classList.add('hidden');
      document.getElementById('screen-shelf').classList.remove('hidden');
      document.body.dataset.tab = 'shelf'; return 1; })()`);
    await sleep(700);
    /* 为什么要差分：一张截图里装饰、正文、卡片糊在一起，量"墨迹"量的是内容不是装饰。
       同一屏、同一主题、只把装饰关掉再拍一张 —— 两张的差就是**装饰自己的贡献**。
       太小 = 白做了（看不见）；太大 = 刺眼/发白。 */
    await STRIP(true); await sleep(600);
    await p.shot(shot('书架-日间'));
    await STRIP(false); await sleep(600);
    await p.shot(shot('书架-日间-无装饰'));
    /* **为什么要拿"清空过的屏"来量**：书架一屏大半被书卡盖住，整屏平均会被"盖住的地方"稀释，
       量出来 0.5 左右，那个数说明不了"看不看得见"。空屏整片都是纸面，装饰该看得见就看得见。 */
    const dBlank = diff(shot('空白屏-装饰在'), shot('空白屏-无装饰'));
    const dDay = diff(shot('书架-日间'), shot('书架-日间-无装饰'));
    /* 门槛为什么这么低：装饰是**故意克制**的（亮度差压在墨迹阈以下，见 decor.css 里那段），
       所以整屏平均本来就小。这条判的是"真的上了像素 + 有能看出形状的峰值"：
       mean ≥ 0.8（大片纸面都有一层淡淡的层次）且 p99 ≥ 4（竹影/水波那种形状看得见）。 */
    step('丁1 纸面上装饰**真的看得见**（空屏平均差 ≥ 0.8 且峰值 p99 ≥ 4/255）',
      dBlank.ok && dBlank.mean >= 0.8 && dBlank.p99 >= 4, { 空屏: dBlank, 书架屏: dDay });

    await STRIP(true);                                  /* 量层数前先把"关装饰"撤掉，否则量到的是 0 层 */
    await p.js(`(() => { document.documentElement.dataset.theme = 'night'; return 1; })()`);
    await sleep(700);
    const nightLayers = await p.js(`(() => { const cs = getComputedStyle(document.getElementById('screen-shelf'));
      return Object.assign({ layers: window.__decCnt(cs.backgroundImage) }, window.__decHas(cs.backgroundImage)); })()`);
    await p.shot(shot('书架-夜间'));
    await STRIP(false); await sleep(700);
    await p.shot(shot('书架-夜间-无装饰'));
    const dNight = diff(shot('书架-夜间'), shot('书架-夜间-无装饰'));
    step('丁2 夜间：五层三件套都在（竹影 + 水波 + 纸纹）',
      nightLayers.layers >= 5 && nightLayers.竹影 && nightLayers.水波 && nightLayers.纸纹, nightLayers);
    step('丁3 夜间：装饰**不刺眼、不发白**（整屏平均差 ≤ 4.0/255，且局部 ≤ 9）',
      dNight.ok && dNight.mean <= 4.0 && dNight.p99 <= 9, dNight);
    await STRIP(true);
    await p.js(`(() => { document.documentElement.dataset.theme = 'paper'; return 1; })()`);
    await sleep(400);

    console.log('\n=== 戊、装饰不吃布局 ===');
    const lay = await p.js(`(() => { const s = document.getElementById('screen-shelf');
      return { 页面横向溢出: document.documentElement.scrollWidth - window.innerWidth,
               屏幕横向溢出: s.scrollWidth - s.clientWidth }; })()`, { timeout: 20000 });
    step('戊1 铺上装饰后没有横向溢出（页面 / 屏幕都不许超）',
      lay.页面横向溢出 <= 0 && lay.屏幕横向溢出 <= 0, lay);

    console.log(fails.length ? ('\n红 ' + fails.length + ' 条：' + fails.join(' / ')) : '\n全过 ✅');
    fs.writeFileSync(OUT, JSON.stringify({ force: FORCE || '（正常）', steps, fails }, null, 1), 'utf8');
    console.log('→ ' + path.relative(ROOT, OUT));
    process.exitCode = fails.length ? 1 : 0;
  } finally { await p.close(); }
})().catch((e) => { console.error('崩了：' + (e && e.stack || e)); process.exit(2); });
