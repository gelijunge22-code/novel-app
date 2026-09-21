/* ============================================================
   shots-30.js — 「主要屏幕」逐屏截图（第 30 轮加，给监督人/用户逐张核用）

   为什么要单独一个：以前每轮各自写一段截图代码（抄了两三遍），而且**踩过两次假绿**——
   ① `e2e-refsimg.js` 那批图没等启动页退场，拍出来是"连不上服务器"的启动页却挂成"书架空态"；
   ② 第 30 轮头一次跑，`r30-书架.png` / `r30-大设置.png` 是**两张纯底色**（墨迹 0.000），
      名字却写着"书架 / 大设置"。

   ②那一查查出**两个真问题**，都修在这里 / 前端里了：
     · **前端真 bug**：转场收尾是异步的（等动画 finished），旧的那次收尾会晚到，
       它照着**旧 outEl** 去 `hidden` —— 而那元素可能正是**现在该显示的那一屏**
       → 切屏切出一整片空白。已修（`app.js` 的 `finish()` 里加"是当前屏就别藏" + `App.revealCurrent()` 兜底）。
     · **脚本真问题**：拍完不检查，空白也照收。现在拍完**当场量像素**（`tools/imgstat.py`），
       是空白就**重拍**（最多 3 次）；重拍还是空白 → 判红、不进"证据"。

   所以这一版立三条规矩（每条都能报红）：
     ① 拍之前等 `#splash` 真退场；
     ② 每张图拍之前先跑一道 **gate**：名字写的是什么屏，DOM 上那屏就得真是当前屏
        （`screen-<名>` 露着、别的屏藏着、该有的行数够）—— 名字和图对不上当场判红；
     ③ 同一轮里 md5 不许重复（重复 = 拍错屏/拍重了），且**像素必须有货**。

   用法：node tools/shots-30.js            # 拍全部
         SHOTS30_ONLY=chat,reader node tools/shots-30.js
   产出：docs/前端截图/r30-<名>.png + docs/每屏截图-第30轮.json
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { open, sleep } = require('./cdp');

const ROOT = '/home/ubuntu/novel-app';
const SHOT = path.join(ROOT, 'docs/前端截图');
const OUT = path.join(ROOT, 'docs/每屏截图-第30轮.json');
const PY = path.join(ROOT, 'server/venv/bin/python');
const ROUND = 'r30';
const ONLY = (process.env.SHOTS30_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const pw = (() => { try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; } catch (e) { return ''; } })();

/* 量一张图"有没有货"（墨迹占比 / 是不是空白）—— 拍完当场用，不是事后审计 */
function imgstat(file) {
  try { return JSON.parse(execFileSync(PY, [path.join(ROOT, 'tools/imgstat.py'), file], { encoding: 'utf8' })); }
  catch (e) { return { ink: -1, blank: false, err: String(e.message || e).slice(0, 80) }; }
}

/* 每一屏拍之前要过的那道 gate：写的是哪屏，屏幕上就得是哪屏。
   返回 {ok, seen} —— seen 会被写进报告，出了问题一眼看得出"当时屏幕上是谁"。 */
const GATE = (screen, extra) => `(() => {
  const cur = document.body.dataset.tab;
  const el = document.getElementById('screen-' + ${JSON.stringify(screen)});
  const vis = !!el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none';
  const others = ${JSON.stringify(['shelf', 'reader', 'chat', 'lore', 'preset', 'settings', 'tools', 'tool'])}
    .filter((s) => s !== ${JSON.stringify(screen)})
    .filter((s) => { const e = document.getElementById('screen-' + s);
      return e && !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none'; });
  const seen = others.length ? ('别的屏还露着：' + others.join(',')) : ('当前屏=' + cur);
  const extra = (${extra || 'true'});
  return { ok: vis && cur === ${JSON.stringify(screen)} && others.length === 0 && !!extra,
           seen: seen + (extra ? '' : ' ⚠ 屏里没东西'), cur: cur, vis: vis, others: others };
})()`;

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  const s = await open({ port: 9375, width: 390, height: 844 });
  const shots = [], dupes = [], bad = [];
  const seen = new Map();          // md5 → 名（本轮内）

  /* 拍一张：先过 gate → 拍 → 量像素（空白就重拍）→ 查重 */
  const shot = async (name, why, gateJs) => {
    const file = path.join(SHOT, ROUND + '-' + name + '.png');
    const gate = gateJs ? await s.js(gateJs) : { ok: true, seen: '' };
    let st = null, tries = 0;
    for (; tries < 3; tries++) {
      /* 拍之前推一帧：无头 Chrome 偶尔会交出"上一帧还是空白"的合成结果
         （第 30 轮实测：DOM 有内容、像素全空）。双 rAF + 一点余量之后再拍。 */
      await s.js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame('
        + '() => setTimeout(r, 60))))', 8000);
      await s.shot(file);
      st = imgstat(file);
      if (!st.blank) break;
      await sleep(500);
    }
    const buf = fs.readFileSync(file);
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    if (seen.has(md5)) {
      dupes.push(name + ' == ' + seen.get(md5));
      bad.push('「' + name + '」和「' + seen.get(md5) + '」一模一样（拍错屏？）');
    } else seen.set(md5, name);
    if (!gate || !gate.ok) {
      bad.push('「' + name + '」拍的时候屏幕上不是它：' + ((gate && gate.seen) || '(没探到)'));
    }
    if (st.blank) bad.push('「' + name + '」重拍 ' + tries + ' 次仍是空白页（只有底色、没有内容）');
    shots.push({ name, why: why || '', gate: (gate && gate.seen) || '', gate_ok: !!(gate && gate.ok),
      md5: md5.slice(0, 8), bytes: buf.length, ink: st.ink, blank: !!st.blank, retries: tries });
    console.log('  ' + (gate && gate.ok && !st.blank ? '✓' : '✗') + ' ' + name.padEnd(20)
      + ' 墨迹=' + String((st.ink * 100).toFixed(1) + '%').padEnd(7)
      + ' ' + String(Math.round(buf.length / 1024) + 'KB').padEnd(6)
      + (tries ? ('重拍' + tries + '次 ') : '') + ((gate && gate.seen) || ''));
  };

  await s.nav('http://127.0.0.1:8899/?shots30=' + Date.now());
  await sleep(2500);
  /* 登录（密码从 nbapp/config.json 读，不写死在脚本里） */
  await s.js(`(() => { const l = document.getElementById('login');
    if (l && !l.classList.contains('hidden')) {
      const i = document.getElementById('login-pass'); i.value = ${JSON.stringify(pw)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login-go').click();
    } return 1; })()`);
  await sleep(3000);
  /* ① 等启动页真退场（以前就是这儿没等，拍出"连不上服务器"的启动页当书架空态） */
  const sp = await s.js(`(async () => { for (let i = 0; i < 90; i++) {
      const e = document.getElementById('splash');
      if (!e || e.classList.contains('gone') || getComputedStyle(e).display === 'none') return true;
      await new Promise((r) => setTimeout(r, 120)); } return false; })()`, 45000);
  if (!sp) { console.error('启动页没退场 —— 停（拍了也是假图）'); s.close(); process.exit(1); }
  /* ② 打开用户的真书（不点自测书） */
  const bk = await s.js(`(async () => {
    const bad = /^(zz-|zzperf|界面实测|走查|e2e|性能自测|tmp-|test-)/i;
    const cards = [...document.querySelectorAll('#shelf-list .book-card')];
    const c = cards.find((x) => !bad.test(x.dataset.slug || '')) || cards[0];
    if (!c) return null; c.click();
    for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 150));
      if (window.Reader && Reader.isOpen()) break; }
    return (c.dataset.slug || 'book'); })()`, 45000);
  if (!bk) { console.error('书架上没有书 —— 停'); s.close(); process.exit(1); }
  console.log('  用书：' + bk);

  const want = (k) => !ONLY.length || ONLY.indexOf(k) >= 0;
  const show = (name, ms) => s.js("(() => { App.show(" + JSON.stringify(name) + "); return 1; })()")
    .then(() => sleep(ms || 1500));

  /* 书架：要把"动画没演完又切一次"这种真实场景也走一遍（那次晚到的收尾正是空白屏的元凶） */
  if (want('shelf')) {
    await show('shelf', 300);
    await s.js("(() => { App.show('shelf'); App.show('chat'); App.show('shelf'); return 1; })()");
    await sleep(1800);
    await shot('书架', '书架首页：顶栏 + 书卡 + 底栏',
      GATE('shelf', "document.querySelectorAll('#shelf-list .book-card').length > 0"));
  }
  if (want('reader')) {
    await s.js("(() => { const c = document.querySelector('#shelf-list .book-card'); if (c) c.click(); return 1; })()");
    await sleep(2500);
    await shot('阅读器-正文', '阅读器：顶栏 + 正文 + 底栏',
      GATE('reader', "(document.getElementById('reader-stage') || {textContent:''}).textContent.trim().length > 60"
        + " && !document.getElementById('screen-reader').classList.contains('chrome-off')"));
  }
  /* 沉浸态：走**用户那条路**——点正文中间一下，顶栏/底栏收起（不直接摸内部函数） */
  if (want('immersive')) {
    const off = await s.js("(() => { const st = document.getElementById('reader-stage')"
      + " || document.querySelector('#screen-reader .stage');"
      + " const r = st.getBoundingClientRect();"
      + " st.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2,"
      + " clientY: r.top + r.height / 2 })); return 1; })()");
    await sleep(1400);
    await shot('阅读器-沉浸态', '顶栏/底栏收起后：正文要撑满，上下不许露白带',
      GATE('reader', "document.getElementById('screen-reader').classList.contains('chrome-off')"));
  }
  /* 目录：**独立成块**（不是设置里的一个页签）。拍的时候目录得亮着，设置面板必须关着。 */
  if (want('toc')) {
    await s.js("(() => { if (Reader.quickClose) Reader.quickClose(true);"
      + " if (Reader.tocClose) Reader.tocClose(true); return 1; })()");
    await sleep(400);
    await s.js("(() => { Reader.toc(); return 1; })()");
    await sleep(1000);
    await shot('目录', '目录：一行一章 + 固定头/固定底（不跟"排版"挤一个页签）',
      GATE('reader', "(document.getElementById('rd-toc').classList.contains('on')"
        + " && document.querySelectorAll('#rd-toc-body .rd-toc-item').length > 1"
        + " && document.getElementById('rd-quick').classList.contains('hidden'))"));
  }
  if (want('quick')) {
    await s.js("(() => { if (Reader.tocClose) Reader.tocClose(true); return 1; })()");
    await sleep(400);
    await s.js("(() => { Reader.quickToggle('type'); return 1; })()");
    await sleep(1000);
    await shot('书里的设置', '阅读器底部面板「排版」页（不是目录！）',
      GATE('reader', "(document.getElementById('rd-quick').classList.contains('on')"
        + " && (document.querySelector('#rd-quick .rd-qbtn.on')||{}).dataset &&"
        + " document.querySelector('#rd-quick .rd-qbtn.on').dataset.q === 'type'"
        + " && document.querySelectorAll('#rd-quick-body .stepper').length > 0)"));
  }
  if (want('quicktts')) {
    await s.js("(() => { Reader.quickToggle('tts'); return 1; })()");
    await sleep(1000);
    await shot('书里的设置-听书', '底部面板的听书页（动作按钮在最上面）',
      GATE('reader', "(document.querySelector('#rd-quick .rd-qbtn.on')||{}).dataset &&"
        + " document.querySelector('#rd-quick .rd-qbtn.on').dataset.q === 'tts'"
        + " && document.querySelectorAll('#rd-quick-body .rd-act').length >= 3"));
  }
  if (want('settings')) {
    await show('settings', 1800);
    await shot('大设置', '全站设置页（外观 / 动效 / 翻页 / 听书）',
      GATE('settings', "document.querySelectorAll('#settings-body .settings-group').length > 0"
        + " || document.querySelectorAll('#settings-body .settings-row').length > 3"));
  }
  if (want('chat')) {
    await show('chat', 2000);
    await shot('对话', 'AI 对话：模式行 + 消息 + 输入框',
      GATE('chat', "document.querySelectorAll('#chat-body .msg, #chat-body .row').length > 0"
        + " || !!document.querySelector('#chat-body')"));
  }
  if (want('tools')) {
    await show('tools', 1600);
    await shot('工具宫格', '工具宫格', GATE('tools',
      "document.querySelectorAll('.tc-name').length >= 4"));
  }
  if (want('preset')) {
    await show('preset', 1600);
    await shot('预设', '预设页', GATE('preset',
      "document.querySelectorAll('#preset-body .pfield, #preset-body .settings-row').length > 0"));
  }
  if (want('lore')) {
    await show('lore', 1800);
    await shot('设定', '设定（世界引擎）页', GATE('lore',
      "document.querySelectorAll('#lore-body .lore-item, #lore-body .settings-row').length > 0"));
  }
  if (want('night')) {
    await s.js("(() => { if (window.Prefs) Prefs.set('theme', 'night'); App.show('shelf'); return 1; })()");
    await sleep(1800);
    await shot('夜间-书架', '夜间主题下的书架',
      GATE('shelf', "document.documentElement.dataset.theme === 'night'"));
    await s.js("(() => { if (window.Prefs) Prefs.set('theme', 'paper'); return 1; })()");
    await sleep(800);
  }

  const errs = s.errors();
  if (errs.length) bad.push('页面里有 JS 报错 ' + errs.length + ' 条：' + errs.slice(0, 3).join(' | '));
  /* 第 31 轮加：SHOTS30_ONLY= 是"局部重拍"，**不许**冒充整轮证据 ——
     上一轮就是它把整轮的 12 张记录覆盖成 5 张（`docs/每屏截图-第30轮.json` 从 12 条掉到 5 条），
     而且 scripts 里谁也没看出来。现在①写进文件（`partial` + `only`），②`shots_check.py` 见到就报红。 */
  const rep = { at: new Date().toISOString(), book: bk, partial: ONLY.length > 0, only: ONLY,
    shots, dupes, bad, errors: errs };
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
  console.log('\n' + (bad.length ? ('有问题 ❌ ' + bad.join('；')) : ('全过 ✅ ' + shots.length + ' 张，无重复、无空白')));
  if (ONLY.length) console.log('!! 这是一次局部重拍（SHOTS30_ONLY=' + ONLY.join(',')
    + '）—— 文件已标 partial，**不能当整轮截图证据**；要交整轮请不带环境变量重跑。');
  console.log('→ ' + path.relative(ROOT, OUT));
  s.close();
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
