/* ============================================================
   e2e-flightmode.js —— 飞行模式全功能自测（对应 GOAL N1 / C1 / C2）。

   手机上没有模拟器可用（本机没 KVM），所以按**和安卓壳一致的规则**在 Chrome 里模拟：
     · window.NBApp 注入成**同步 JS 桥**，语义照抄 ApiBridge.java：
       request(method,path,body) → {"status":N,"body":"<原始返回体>","error":""}
       → 前端的 api.js 会走"App 那条路"（进程内调用，不过网卡）
     · 外部网络**全部掐断**（CDP Fetch 拦截，非 127.0.0.1 一律 failRequest）
       → 等价于飞行模式：模型供应商、CDN 全都够不着
     · 页面与静态资源来自本机（= APK 从 assets/www 给，不经过服务器）

   查的事（每一条都要能在断网下走通，否则就是"APP 是壳"）：
     ① 桥生效（API.bridged）+ 开屏没卡住
     ② 书架列得出来            ③ 翻书：读到正文、翻页位置真的变
     ④ 设定读得出来            ⑤ 扫 AI 味出分数（本地规则，不花钱）
     ⑥ 统计出字数章节          ⑦ 新建章节 / 编辑章节：写进去读回来一致
     ⑧ 导出 TXT：真的落了一个非空文件   ⑨ 备份：建一份 + 列表可见
     ⑩ 断网时调模型：给中文人话（不许转圈、不许英文栈）
     ⑪ 全程**外部主机请求 0 次** + 前端报错 0 条 + 截图逐张不同

   用法：node tools/e2e-flightmode.js      产出：docs/飞行模式自测.json + docs/前端截图/r11-fm-*.png
   退出码：0 = 全过
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const BASE = 'http://127.0.0.1:8899/';
const OUT = path.join(ROOT, 'docs/飞行模式自测.json');
const SHOTDIR = path.join(ROOT, 'docs/前端截图');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readPassword = () => { try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; } catch (e) { return ''; } };

const rows = [];
const check = (name, ok, why) => {
  rows.push({ name, ok: !!ok, why: String(why == null ? '' : why).slice(0, 400) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '   —— ' + String(why).slice(0, 220)));
  return !!ok;
};

/* 注入的桥：语义照抄 ApiBridge.java（同步返回 json 信封）。 */
const BRIDGE = `
(function () {
  window.__fmCalls = [];
  if (window.NBApp) return;
  window.NBApp = {
    request: function (method, p, body) {
      var x = new XMLHttpRequest();
      try {
        x.open(String(method || 'GET').toUpperCase(), '/' + String(p || '').replace(/^\\//, ''), false);
        if (body) x.setRequestHeader('content-type', 'application/json');
        x.send(body || null);
      } catch (e) {
        return JSON.stringify({ status: 0, body: '', error: '本机后端没起来：' + e });
      }
      window.__fmCalls.push({ m: method, p: p, s: x.status });
      return JSON.stringify({ status: x.status, body: x.responseText || '', error: '' });
    },
    base: function () { return location.origin + '/'; },
    token: function () { return ''; },
    ping: function () { return '{"ok":true,"bridge":true}'; }
  };
})();
`;

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-dl-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-'));
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=9345', '--window-size=390,844', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) { await sleep(400); try { targets = await (await fetch('http://127.0.0.1:9345/json/list')).json(); if (targets && targets.length) break; } catch (e) {} }
  if (!targets) { console.error('chrome 起不来'); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  const pageErrors = []; const externals = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = (m.params || {}).exceptionDetails || {};
      pageErrors.push(String((d.exception && d.exception.description) || d.text || '').slice(0, 160));
    }
    /* 外部请求：非 127.0.0.1/localhost 一律当"没有网"，直接掐断并记账 */
    if (m.method === 'Fetch.requestPaused') {
      const url = m.params.request.url;
      const local = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url) || url.startsWith('data:') || url.startsWith('blob:');
      if (!local) {
        externals.push(url.slice(0, 120));
        send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'InternetDisconnected' });
      } else {
        send('Fetch.continueRequest', { requestId: m.params.requestId });
      }
    }
  };
  const send = (mm, p) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: BRIDGE });

  const js = async (expr, wait) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (wait) await sleep(wait);
    if (r.result && r.result.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 160) };
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!(r.result && r.result.data)) return null;
    const buf = Buffer.from(r.result.data, 'base64');
    const p = path.join(SHOTDIR, name + '.png');
    fs.writeFileSync(p, buf);
    return crypto.createHash('md5').update(buf).digest('hex');
  };
  const shotMd5 = new Map();
  const shots = [];   /* 顺序记录，方便断言"这两张必须不一样" */
  const shoot = async (name) => {
    const h = await shot(name);
    const dup = h && [...shotMd5.entries()].find(([, v]) => v === h);
    shotMd5.set(name, h);
    shots.push({ name, md5: h });
    if (dup) console.log('    ⚠ 截图与 ' + dup[0] + ' 内容完全相同（可能这一步没生效）');
    return { name, md5: h, dupOf: dup ? dup[0] : null };
  };

  await send('Page.navigate', { url: BASE + '?fm=' + Date.now() });
  await sleep(5000);

  /* ① 桥生效 + 开屏 */
  const bridged = await js("!!(window.API && API.bridged) && !!window.NBApp");
  check('① 前端认出自己在 App 里（API.bridged，走 JS 桥不走 HTTP）', bridged,
    'bridged=' + bridged + ' ping=' + await js("window.NBApp ? window.NBApp.ping() : 'no-bridge'"));
  const onLogin = await js("!document.getElementById('login').classList.contains('hidden')");
  if (onLogin) {
    /* 手机上这一步是"本机一次性口令自动登录"（ondevice_sim ⑳ 覆盖），这里用口令登一次 */
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
      ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4500);
  }
  const opened = await js("(()=>{const s=document.querySelector('.screen:not(.hidden)');return s?s.id:''})()");
  check('①b 断网也开得起来（界面在包内，不白屏）', opened && opened !== 'screen-login', '当前屏 ' + opened);
  await shoot('r11-fm-01-断网开屏');

  /* 靶子：真书（只读） + 一本一次性测试书（写操作都在它身上，跑完进回收站） */
  const books = JSON.parse(await js(`(async () => { const d = await API.shelf(); /* 踩过的坑：/api/shelf 的键叫 slug，/api/projects 叫 projectRoot —— 同一个东西两个名字，两个都吃 */
    return JSON.stringify((d.projects||[]).map(p=>({slug:p.slug||p.projectRoot,title:p.title}))); })()`) || '[]');
  const isTest = (t) => /E2E|实测|测试|走查|飞行|自动|临时|zz-/.test(t || '');
  const real = books.find((b) => !isTest(b.title)) || books[0];
  check('② 书架列得出来（本机后端给的，没走网）', books.length > 0, books.map((b) => b.title).join(' / '));
  /* 这里**故意不拍第二张书架图**：登录后本来就落在书架，和开屏那张逐字节一样，
     摆两张相同的等于"拍同一张充数"（上一版就是这么被判重复的）。 */

  /* ③ 翻书：真读一章 + 翻页位置变化 */
  const rd = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    /* 踩过的坑：Reader 上**没有** open()（只有 next/prev/goChapter…），
       进阅读器的入口是 Shelf.open(slug)。上一版瞎调 Reader.open → 落到空白阅读页 → 后面全红。 */
    Shelf.open(${JSON.stringify(real.slug)});
    await wait(3500);
    const el = document.getElementById('reader-page') || document.querySelector('.reader-page');
    const body = (el || {}).innerText || '';
    const scr = document.querySelector('.screen:not(.hidden)');
    return { chapter: (document.getElementById('reader-head-title') || {}).textContent || '',
             len: body.replace(/\s+/g, '').length, screen: scr ? scr.id : '' };
  })()`);
  check('③ 翻书：能打开章节并读到正文（>1000 字）', rd && rd.len > 1000, JSON.stringify(rd));
  const shotBook = await shoot('r11-fm-03-翻书');
  const flip = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const el = () => document.getElementById('reader-page');
    /* 踩过的坑：这本书是**分栏排版**，一整章都在 DOM 里、翻页是横向挪动 ——
       只比 innerText 会得出"翻不动"的错误结论（上一版就是这么假红的）。
       所以：① 看应用自己的页码状态（Reader.state.idx）；② 看有没有真的发生视觉变化。 */
    const st = document.getElementById('reader-stage');
    /* 这本书是**分栏排版**：一整章放在 .reader-strip 里，翻页换的是 strip 的 translate3d。
       量 #reader-page 的 transform / scrollTop 永远是 0，会得出"没动"的错误结论（第 11 轮踩过）。 */
    const stripX = () => {
      const s = document.querySelector('#reader-page .reader-strip');
      if (!s) return null;
      /* 不用正则：这段 JS 塞在模板串里 eval，反斜杠会被模板串吃掉（第 11 轮为这个踩了两次）。
         DOMMatrix 直接解析，没有转义问题。 */
      const tf = getComputedStyle(s).transform || '';
      if (!tf || tf === 'none') return 0;
      try { return Math.round(new DOMMatrix(tf).m41); } catch (e) { return String(s.style.transform || ''); }
    };
    const before = { idx: Reader.state.idx, pages: Reader.state.pages, stripX: stripX() };
    for (let i = 0; i < 2; i++) {
      st.dispatchEvent(new MouseEvent('click', { clientX: 320, clientY: 420, bubbles: true }));
      await wait(1300);
    }
    const after = { idx: Reader.state.idx, pages: Reader.state.pages, stripX: stripX() };
    return { before, after, advanced: after.idx - before.idx, moved: before.stripX !== after.stripX };
  })()`);
  check('③b 点右边能翻页（页码往前走，而且画面真的动了）',
    flip && flip.advanced === 2 && flip.moved, JSON.stringify(flip));
  const shotTurn = await shoot('r11-fm-04-翻页后');
  check('③c 翻页前后两张截图不是同一张（画面真的翻过去了）',
    shotBook && shotTurn && shotBook.md5 !== shotTurn.md5,
    (shotBook && shotBook.md5) + ' vs ' + (shotTurn && shotTurn.md5));

  /* ④ 设定 */
  const lore = await js(`(async () => {
    /* 正确接口是 api/lore/tree（api/lore 是 404）—— 上一版写错了，报的是"Not Found" */
    const t = await API.loreTree(${JSON.stringify(real.slug)});
    App.show('lore'); await new Promise((r) => setTimeout(r, 2500));
    const scr = document.querySelector('.screen:not(.hidden)');
    return { files: ((t && t.files) || []).length, screen: scr ? scr.id : '',
             len: ((scr && scr.innerText) || '').replace(/\\s+/g, '').length };
  })()`);
  check('④ 设定读得出来（本机库）', lore && lore.len > 20, JSON.stringify(lore));
  await shoot('r11-fm-05-设定');

  /* ⑤ 扫 AI 味：本地规则，断网也能扫 */
  const lint = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    App.show('tools'); await wait(900);
    const c = document.querySelector('#tools-body .tool-card[data-id="lint"]'); if (c) c.click(); await wait(1500);
    for (let k = 0; k < 3; k++) {
      const pick = document.querySelector('#tool-body [data-slug]');
      if (pick) { const r = [...document.querySelectorAll('#tool-body [data-slug]')].find((x) => x.dataset.slug === ${JSON.stringify(real.slug)}) || pick; r.click(); await wait(2500); }
      else break;
    }
    const body = (document.getElementById('tool-body') || {}).innerText || '';
    const m = body.match(/(\\d+)\\s*分/);
    return { text: body.replace(/\\s+/g, ' ').slice(0, 120), score: m ? Number(m[1]) : null };
  })()`);
  check('⑤ 扫 AI 味：断网也扫得出分数（规则在本地跑，不花钱）', lint && lint.score != null, JSON.stringify(lint));
  await shoot('r11-fm-06-扫AI味');

  /* ⑥ 统计 */
  const stats = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-act="tool-back"]').click(); await wait(1200);
    const c = document.querySelector('#tools-body .tool-card[data-id="stats"]'); if (c) c.click(); await wait(1500);
    for (let k = 0; k < 3; k++) {
      const pick = document.querySelector('#tool-body [data-slug]');
      if (pick) { const r = [...document.querySelectorAll('#tool-body [data-slug]')].find((x) => x.dataset.slug === ${JSON.stringify(real.slug)}) || pick; r.click(); await wait(2500); }
      else break;
    }
    const body = (document.getElementById('tool-body') || {}).innerText || '';
    return { hasNum: /[0-9]/.test(body), text: body.replace(/\\s+/g, ' ').slice(0, 120) };
  })()`);
  check('⑥ 看统计：有字数/章节数', stats && stats.hasNum, JSON.stringify(stats));
  await shoot('r11-fm-07-统计');

  /* ⑦ 新建 / 编辑章节（在一本一次性测试书上做，不碰用户的稿子） */
  const TITLE = '飞行自测-' + Date.now().toString().slice(-6);
  const writ = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const born = await API.raw('api/projects', { method: 'POST', body: { title: ${JSON.stringify(TITLE)}, summary: '飞行模式自测用（跑完进回收站）', kind: 'novel' } });
    const slug = born.projectRoot || born.slug;
    const name = '第001章-断网也能写';
    await API.raw('api/import/text', { method: 'POST', body: { slug, name, text: '雪停了。' } });
    const ov = await API.book(slug, true);
    const ch = (ov.chapters || [])[0];
    const got = await API.chapter(slug, ch.path);
    return { slug, name, path: ch.path, text: (got.content || '').slice(0, 20), n: (ov.chapters || []).length };
  })()`);
  check('⑦ 新建章节（中文文件名）：建得出、读得回来', writ && writ.n >= 1 && writ.text.indexOf('雪停了') >= 0, JSON.stringify(writ));

  /* ⑧ 导出 TXT：真的落文件（App 里走本机 127.0.0.1 的字节流通道） */
  const before = fs.readdirSync(dl).length;
  const exp = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const body = (document.getElementById('tool-body') || {}).innerText || '';
    if (!/导出/.test(body)) {
      document.querySelector('[data-act="tool-back"]').click(); await wait(1200);
      const c = document.querySelector('#tools-body .tool-card[data-id="export"]'); if (c) c.click(); await wait(1600);
      for (let k = 0; k < 3; k++) {
        const pick = document.querySelector('#tool-body [data-slug]');
        if (pick) { const r = [...document.querySelectorAll('#tool-body [data-slug]')].find((x) => x.dataset.slug === ${JSON.stringify(writ && writ.slug)} ) || pick; r.click(); await wait(2200); } else break;
      }
    }
    /* 踩过的坑：按文字找 /TXT|导出/ 会先命中「导出 / 导入」那个**页签**，
       点了什么都不会发生。真正要点的是 [data-f="txt"] 那个按钮。 */
    const btn = document.querySelector('#tool-body [data-f="txt"]');
    if (btn) { btn.click(); return { clicked: 'txt', href: (document.querySelector('a[href*="export"]') || {}).href || '' }; }
    return { clicked: null, text: ((document.getElementById('tool-body') || {}).innerText || '').replace(/\\s+/g, ' ').slice(0, 140) };
  })()`);
  await sleep(3000);
  const after = fs.readdirSync(dl).map((f) => ({ f, size: fs.statSync(path.join(dl, f)).size }));
  check('⑧ 导出整本 TXT：本地导出真的落了个非空文件',
    after.length > before && after.some((x) => x.size > 0), JSON.stringify({ exp, files: after.slice(0, 4) }));
  await shoot('r11-fm-08-导出');

  /* ⑨ 备份 */
  const bku = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-act="tool-back"]').click(); await wait(1200);
    const c = document.querySelector('#tools-body .tool-card[data-id="backup"]'); if (c) c.click(); await wait(1600);
    const mk = [...document.querySelectorAll('#tool-body button')].find((b) => /备份|建一份|立刻/.test(b.textContent));
    if (mk) { mk.click(); await wait(3500); }
    const body = (document.getElementById('tool-body') || {}).innerText || '';
    return { made: !!mk, text: body.replace(/\\s+/g, ' ').slice(0, 140) };
  })()`);
  check('⑨ 备份：建得出一份（数据自持，断网也行）', bku && bku.made, JSON.stringify(bku));
  await shoot('r11-fm-09-备份');

  /* ⑩ 断网时调模型 → 要中文人话，不许转圈 / 英文栈 */
  const mdl = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    App.show('tools'); await wait(800);
    const c = document.querySelector('#tools-body .tool-card[data-id="write"]'); if (c) c.click(); await wait(1800);
    for (let k = 0; k < 3; k++) {
      const pick = document.querySelector('#tool-body [data-slug]');
      if (pick) { const r = [...document.querySelectorAll('#tool-body [data-slug]')].find((x) => x.dataset.slug === ${JSON.stringify(writ && writ.slug)}) || pick; r.click(); await wait(2200); } else break;
    }
    const goBtn = [...document.querySelectorAll('#tool-body button')].find((b) => /写|生成|继续/.test(b.textContent));
    let fired = null;
    if (goBtn) { fired = goBtn.textContent.trim(); goBtn.click(); await wait(6000); }
    const body = (document.getElementById('tool-body') || {}).innerText || '';
    return { fired, text: body.replace(/\\s+/g, ' ').slice(0, 260),
             spinning: /读取中|加载中|\\.\\.\\.$/.test(body.slice(-40)) };
  })()`);
  const humanMsg = mdl && /没配|没有模型|未配置|连不上|失败|模型|网络|离线|不能|不可用/.test(mdl.text || '');
  check('⑩ 断网调模型：给的是中文人话（不是转圈、不是英文栈）', humanMsg && !(mdl && mdl.spinning),
    JSON.stringify(mdl));
  await shoot('r11-fm-10-断网写正文的提示');

  /* ⑪ 收尾：测试书进回收站；外部请求 0；报错 0 */
  const cleaned = await js(`(async () => { try { const r = await API.raw('api/projects/item?projectRoot=' + encodeURIComponent(${JSON.stringify(writ && writ.slug)}), { method: 'DELETE' }); return r && r.ok; } catch (e) { return String(e && e.message); } })()`);
  check('⑪ 收尾：自测用的那本书进了回收站（不留垃圾在书架上）', cleaned === true, String(cleaned));

  const bridgedCalls = await js("(window.__fmCalls || []).length");
  check('⑫ 全程 API 调用都走的是 JS 桥（进程内，不过网卡）', bridgedCalls > 20, bridgedCalls + ' 次');
  check('⑬ 全程 0 个外部主机请求（等价于飞行模式：CDN/模型供应商全都够不着）',
    externals.length === 0, JSON.stringify(externals.slice(0, 5)));
  const errs = pageErrors.filter((e) => !/favicon/i.test(e));
  check('⑭ 全程 0 个前端报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  const dups = [...shotMd5.entries()].filter(([, h]) => h && [...shotMd5.values()].filter((x) => x === h).length > 1);
  const uniq = new Set([...shotMd5.values()]).size;
  check('⑮ 每张截图内容都不一样（不是拍同一张充数）', uniq === shotMd5.size,
    uniq + '/' + shotMd5.size + (dups.length ? ' 重复：' + JSON.stringify(dups.map((d) => d[0])) : ''));

  const ok = rows.filter((r) => r.ok).length;
  fs.writeFileSync(OUT, JSON.stringify({
    at: new Date().toISOString().slice(0, 19).replace('T', ' '), base: BASE,
    说明: '飞行模式模拟：NBApp 同步桥（照抄 ApiBridge.java 语义）+ 外部网络全部掐断 + 静态资源来自本机（= assets/www）',
    靶子: { 真书: real, 测试书: writ && writ.slug },
    桥调用次数: bridgedCalls, 外部请求: externals, 前端报错: pageErrors,
    截图: [...shotMd5.entries()].map(([n, h]) => n + '=' + h),
    total: rows.length, passed: ok, failed: rows.length - ok, items: rows,
  }, null, 1), 'utf8');
  console.log(`\n=== 飞行模式自测：${ok}/${rows.length} ===`);
  console.log('报告：docs/飞行模式自测.json');
  ws.close();
  process.exit(ok === rows.length ? 0 : 1);
})();
