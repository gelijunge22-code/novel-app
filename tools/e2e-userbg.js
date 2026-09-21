/* ============================================================
   e2e-userbg.js — 「自定义大背景图」判据（第 43 轮）

   用户原话（一字不改）：
     「整个大背景要弄成可以自己上传图片的，现在这样太丑了」
     「我说的大背景是这整个前端」

   为什么有这东西：这个功能最容易做成"看着有、其实没生效"——
   ① 传上去了但七屏里只有一屏吃到；
   ② 地址自己拼（带了前导斜杠）→ 在 /novel/ 这种子路径下 404，界面静默无图；
   ③ 用户传了张全黑图 → 正文黑底黑字，没人拦。
   所以这里逐条量**真画出来的东西**，不是量"接口返回 ok"。

   判据（每条都要能报红）：
     甲 上传（走真实 UI：点按钮 → CDP 塞文件）→ 服务端存住 + 前端铺上 + 七屏全中 + 阅读器没有
     乙 三种铺法真的换（cover / tile / center 各自的 background-size / repeat 对得上）
     丙 全黑图也不许看不清：逐屏截图 + 逐文字节点交给 tools/check_userbg.py 按像素量对比度
     丁 移除 → 回到默认纸纹（前端 + 服务端两边都干净）
     戊 坏文件 / 超大 / 没口令：都要报出**能看懂的原因**
     己 收尾：设置回空 + **目录回到开跑前**（一个测试图都不许留）

   反证（都会跑一遍，绿=判据是空的）：
     UBG_FORCE=noveil   把对比度那层纱关掉 → **丙 必须红**
     UBG_FORCE=noscreen 只给一屏铺（把别的屏裁掉）→ **甲5 必须红**
     UBG_FORCE=drop     上传后把前端的地址抹掉（模拟"传了没生效"）→ **甲4 必须红**
     UBG_FORCE=stale    把清旧文件那一步跳过（还原第 43 轮那个 glob bug）
                        → **丙0b / 己2 必须红**（实测红 2 条；甲7 那条只在目录里已经有图时才咬得住）

   跑法：node tools/e2e-userbg.js
   产出：docs/背景图实测.json（反证写 -反证-<force>.json）+ docs/前端截图/r43-ubg-*.png
   ============================================================ */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { open, sleep } = require('./cdp');

const ROOT = '/home/ubuntu/novel-app';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const FORCE = process.env.UBG_FORCE || '';
const SHOT = path.join(ROOT, 'docs/前端截图');
const OUT = path.join(ROOT, FORCE ? 'docs/背景图实测-反证-' + FORCE + '.json' : 'docs/背景图实测.json');
const TMP = path.join(ROOT, 'logs');
const BGDIR = path.join(ROOT, 'data/appearance');
const bgFiles = () => (fs.existsSync(BGDIR) ? fs.readdirSync(BGDIR).sort() : []);
const rows = [];
function check(name, ok, why) {
  rows.push({ name, ok: !!ok, why: String(why == null ? '' : why).slice(0, 600) });
  console.log(('  ' + (ok ? '✓ ' : '✗ ')) + name + (ok ? '' : '   —— ' + String(why).slice(0, 300)));
  return !!ok;
}
const pw = () => JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || '';

/* ── 自己写一张 PNG（不引任何依赖，也不往仓库里留测试图）───────────────────
   只需要"一整块纯色"就够了：丙 那条要的是**全黑的图**（对比度最坏情况）。 */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function pngSolid(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Buffer.alloc(w * 3).fill(0).map((_, i) => rgb[i % 3]))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* 在页面里量：每一屏是不是真的把用户图铺上了（数 DOM 上真挂着的值，不猜） */
const SCREENS = ['shelf', 'chat', 'lore', 'preset', 'settings', 'tools', 'tool'];
const MEASURE_BG = `(() => {
  const d = window.Appearance ? window.Appearance.debug() : null;
  const mark = (d && d.url) ? String(d.url).slice(0, 60) : '';
  const out = { 七屏: {}, 阅读器: '', 调试: d, 标记: mark };
  ${JSON.stringify(SCREENS)}.forEach((s) => {
    const el = document.getElementById('screen-' + s);
    if (!el) { out.七屏[s] = '没这一屏'; return; }
    const cs = getComputedStyle(el);
    out.七屏[s] = { 有几层: (cs.backgroundImage || '').split(/,(?![^(]*\\))/).length,
                    吃到: !!(d && d.url) && cs.backgroundImage.indexOf('appearance/bg/file') >= 0,
                    铺法: cs.backgroundSize.split(',').pop().trim(),
                    重复: cs.backgroundRepeat.split(',').pop().trim() };
  });
  const rd = document.getElementById('screen-reader');
  out.阅读器 = rd ? getComputedStyle(rd).backgroundImage.indexOf('appearance/bg/file') >= 0 : '没这一屏';
  return out; })()`;

/* 逐屏收集"压在最上面的文字节点"（rect + 颜色 + 字号），交给 Python 从像素里再量一遍 */
const MEASURE_TEXT = `(() => {
  const scr = @SCR@;
  const el = document.getElementById('screen-' + scr);
  if (!el) return { 屏: scr, 节点: [] };
  const buf = [];
  const walk = (n) => {
    for (const c of n.children) {
      const cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      const t = Array.from(c.childNodes).filter((x) => x.nodeType === 3).map((x) => x.textContent.trim()).join('');
      const r = c.getBoundingClientRect();
      if (t && r.width > 4 && r.height > 4 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight) {
        buf.push({ t: t.slice(0, 24), x: r.left, y: r.top, w: r.width, h: r.height,
                   c: cs.color, fs: parseFloat(cs.fontSize), fw: cs.fontWeight, sel: c.className || c.tagName });
      }
      if (buf.length > 400) return;
      walk(c);
    }
  };
  walk(el);
  return { 屏: scr, 节点: buf }; })()`;

/* 点「上传图片」，然后把文件塞进那个选图框 —— 走的是**用户真实那一条路**
   （真鼠标点按钮 → 页面自己 new 出一个 input → 我们替他把文件放进去 → change 事件 →
   页面自己的上传逻辑跑）。
   ⚠ 第 43 轮踩到的坑：光靠 `DOM.setFileInputFiles({nodeId})` 只在**第一次**灵，
   第二次开始静默失效（原生选图对话框把渲染进程占住了，文件根本没附上去）——
   表现是"服务端文件名没换"（丙0 报红），特别误导人。
   所以改成：`Page.setInterceptFileChooserDialog` 拦住原生对话框，等 `Page.fileChooserOpened`
   事件拿到 backendNodeId 再附件 —— 这也是 Puppeteer 内部的做法。 */
async function pickAndSet(p, file) {
  await p.send('DOM.enable');
  const n0 = p.events.length;
  await p.clickSel('#ubg-up');
  let ev = null;
  for (let i = 0; i < 40 && !ev; i++) {
    await sleep(120);
    ev = p.events.slice(n0).find((m) => m.method === 'Page.fileChooserOpened');
  }
  if (ev && ev.params && ev.params.backendNodeId) {
    await p.send('DOM.setFileInputFiles', { files: [file], backendNodeId: ev.params.backendNodeId });
    return 'chooser';
  }
  /* 兜底（拦截没生效时）：按 nodeId 塞 */
  await p.send('DOM.getDocument', { depth: -1, pierce: true });
  const q = await p.send('DOM.querySelector', { nodeId: 1, selector: '#ubg-file' });
  if (q && q.result && q.result.nodeId) {
    await p.send('DOM.setFileInputFiles', { files: [file], nodeId: q.result.nodeId });
    return 'node';
  }
  return '';
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(SHOT, { recursive: true });
  const good = path.join(TMP, 'ubg-test-color.png');
  const black = path.join(TMP, 'ubg-test-black.png');
  const bad = path.join(TMP, 'ubg-test-notimage.txt');
  const huge = path.join(TMP, 'ubg-test-huge.png');
  fs.writeFileSync(good, pngSolid(240, 320, [30, 120, 160]));
  fs.writeFileSync(black, pngSolid(240, 320, [0, 0, 0]));
  fs.writeFileSync(bad, '这不是图片，是一段文字\n');
  fs.writeFileSync(huge, Buffer.concat([pngSolid(8, 8, [1, 2, 3]), Buffer.alloc(9 * 1024 * 1024, 7)]));

  const dir0 = bgFiles();   /* 开跑前目录快照：收尾必须一模一样地还回去 */
  const p = await open({ port: 9433, width: 390, height: 844, settle: 1200 });
  /* 原生选图对话框一律拦下来（headless 里它会占住渲染进程，第二次上传就静默失效） */
  await p.send('Page.setInterceptFileChooserDialog', { enabled: true });
  const surfaces = [];
  try {
    await p.nav(BASE); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(pw())}})}).then(r=>r.text())`);
    await p.nav(BASE); await sleep(4200);

    /* ── 进大设置 ───────────────────────────────────────────── */
    await p.clickSel('#btn-shelf-menu'); await sleep(900);
    await p.js(`(() => { const b = [...document.querySelectorAll('.sheet button, .sheet [data-act], button')]
      .find((x) => (x.innerText || '').indexOf('设置') >= 0); if (b) b.click(); return 1; })()`);
    await sleep(1600);
    const grp = await p.js(`(() => {
      const h = [...document.querySelectorAll('#settings-body h3')].map((x) => x.textContent.trim());
      return { 标题组: h, 有背景组: h.indexOf('背景') >= 0, 有预览: !!document.querySelector('#ubg-prev'),
               有上传键: !!document.querySelector('#ubg-up') }; })()`);
    check('甲1 大设置里有「背景」这一组（预览 + 上传键都在）',
      grp.有背景组 && grp.有预览 && grp.有上传键, JSON.stringify(grp));

    /* ── 上传：点按钮（真人鼠标）→ CDP 塞文件（等价于用户从相册挑一张）── */
    const how = await pickAndSet(p, good);
    await sleep(2600);
    check('甲2 点「上传图片」真的叫出了选图框（真鼠标点出来的）',
      !!how, '没等到 fileChooserOpened，也没找到 #ubg-file');

    const srv = await p.js(`fetch('api/appearance/bg?slug=' + encodeURIComponent((window.BookCtx&&BookCtx.slug())||''))
      .then((r) => r.json()).then((d) => ({ 全局有: d.global.has, 这本有: d.book.has,
        生效档: d.effective.scope, 铺法: d.effective.mode }))`);
    const wantBytes = fs.statSync(good).size;
    const gotBytes = await p.js(`fetch('api/appearance/bg/file?scope=global&v=' + Date.now())
      .then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
    check('甲3 服务端真的存住了（同一张图，字节数对得上）',
      (srv.全局有 || srv.这本有) && gotBytes === wantBytes,
      JSON.stringify({ srv, 期望字节: wantBytes, 实到字节: gotBytes }));

    /* ⚠ 第 43 轮真 bug 的判据：上传时"清旧文件"用的是 `glob(prefix + '.*')`，
       而落盘名是 `global-<时间戳>.<ext>` —— 一个都匹配不到 → 目录里越堆越多
       （监督人实测到 3 张残留、我这边堆到 9 张，用户看到的就是"换不了图"）。
       所以这里**直接数目录**，不看接口脸色。 */
    const d1 = await p.js(`fetch('api/appearance/bg').then((r) => r.json()).then((d) => d.global.file)`);
    const files1 = bgFiles().filter((f) => /^global-/.test(f));
    check('甲7 这一档目录里**只有 1 张**（传新的必须把旧的删掉，不然"换图"是假的）',
      files1.length === 1 && files1[0] === d1, JSON.stringify({ 目录: files1, 设置里记的: d1 }));

    let m = await p.js(MEASURE_BG);
    if (FORCE === 'drop') { await p.js(`(document.documentElement.style.removeProperty('--userbg'), 1)`); m = await p.js(MEASURE_BG); }
    check('甲4 前端真的用上了（html 上挂着图地址 + 铺法 class）',
      !!(m.调试 && m.调试.has && m.调试.url && m.调试.cls.length),
      JSON.stringify(m.调试));

    const miss = SCREENS.filter((s) => !(m.七屏[s] && m.七屏[s].吃到));
    if (FORCE === 'noscreen') {
      /* 反证：把六屏的层人为摘掉（只留书架）—— 甲5 必须红 */
      await p.js(`(() => { ['chat','lore','preset','settings','tools','tool'].forEach((s) => {
        const e = document.getElementById('screen-' + s);
        if (e) e.style.backgroundImage = 'none'; }); return 1; })()`);
      m = await p.js(MEASURE_BG);
    }
    const miss2 = FORCE === 'noscreen'
      ? SCREENS.filter((s) => !(m.七屏[s] && m.七屏[s].吃到)) : miss;
    check('甲5 七个屏**每一个**都铺上了（漏一屏就是"整个前端"没做到）',
      miss2.length === 0, '漏的屏：' + JSON.stringify(miss2));
    check('甲6 阅读器一层都没有（正文要干净 —— 底纹跟字打架最不划算）',
      m.阅读器 === false, JSON.stringify({ 阅读器: m.阅读器 }));

    await p.shot(path.join(SHOT, 'r43-ubg-' + (FORCE || 'ok') + '-shelf.png'));

    /* ── 乙、三种铺法 ─────────────────────────────────────── */
    /* 量的是**声明值**（html 上那几个 CSS 变量），不是浏览器解析后的像素值 ——
       平铺那条 `min(46vw,300px) auto` 会被算成 "179.4px"，拿数字去比对永远对不上。 */
    const modeOf = () => p.js(`(() => { const e = document.getElementById('screen-shelf');
      const cs = getComputedStyle(e);
      const rootCS = getComputedStyle(document.documentElement);
      return { cls: document.documentElement.className.split(/\\s+/).filter((x) => x.indexOf('ubg-') === 0),
               size: rootCS.getPropertyValue('--userbg-size').trim(),
               raw: cs.backgroundSize.split(',').pop().trim(),
               repeat: cs.backgroundRepeat.split(',').pop().trim() }; })()`);
    await p.js(`(() => { const b = [...document.querySelectorAll('#settings-body [data-ubg="mode"] button')]
      .find((x) => x.innerText.trim() === '平铺'); if (b) b.click(); return 1; })()`);
    await sleep(1500);
    const tile = await modeOf();
    check('乙1 切「平铺」真的换了铺法（repeat + 固定砖块尺寸，不许拉伸变形）',
      tile.repeat === 'repeat' && /min\(/.test(tile.size) && tile.cls.join() === 'ubg-tile',
      JSON.stringify(tile));
    await p.js(`(() => { const b = [...document.querySelectorAll('#settings-body [data-ubg="mode"] button')]
      .find((x) => x.innerText.trim() === '居中'); if (b) b.click(); return 1; })()`);
    await sleep(1500);
    const cen = await modeOf();
    check('乙2 切「居中」真的换了（contain + 不重复）',
      cen.repeat === 'no-repeat' && cen.size === 'contain' && cen.cls.join() === 'ubg-center',
      JSON.stringify(cen));
    await p.js(`(() => { const b = [...document.querySelectorAll('#settings-body [data-ubg="mode"] button')]
      .find((x) => x.innerText.trim() === '铺满'); if (b) b.click(); return 1; })()`);
    await sleep(1500);
    const cov = await modeOf();
    check('乙3 切回「铺满」（cover）', cov.size === 'cover' && cov.cls.join() === 'ubg-cover', JSON.stringify(cov));

    /* ── 丙、全黑图：逐屏截图 + 逐文字节点交给 Python 按像素量 ── */
    const file0 = await p.js(`fetch('api/appearance/bg').then(r=>r.json()).then(d=>d.global.file)`);
    const how2 = await pickAndSet(p, black);
    await sleep(2800);
    check('丙0a 第二次也能叫出选图框（第一次之后就失效 = 判据自己有病）', !!how2, String(how2));
    const file1 = await p.js(`fetch('api/appearance/bg').then(r=>r.json()).then(d=>d.global.file)`);
    check('丙0 黑图真的换上了（服务端文件名换了新的）',
      !!file1 && file1 !== file0, JSON.stringify({ 改前: file0, 改后: file1 }));
    const files2 = bgFiles().filter((f) => /^global-/.test(f));
    check('丙0b 换第二张之后，旧文件真的不在了（目录里仍然只有 1 张）',
      files2.length === 1 && files2[0] === file1,
      JSON.stringify({ 目录: files2, 该在的: file1, 上一张: file0 }));
    if (FORCE === 'noveil') await p.js(`(window.__UBG_NOVEIL = 1, window.Appearance.apply(), 1)`);
    await sleep(500);
    for (const s of SCREENS) {
      await p.js(`App.show(${JSON.stringify(s === 'tool' ? 'tools' : s)})`); await sleep(700);
      const t = await p.js(MEASURE_TEXT.replace('@SCR@', JSON.stringify(s)));
      const f = path.join(SHOT, 'r43-ubg-' + (FORCE || 'ok') + '-black-' + s + '.png');
      await p.shot(f);
      surfaces.push({ id: 'ubg-' + s, file: path.relative(ROOT, f), nodes: (t && t.节点) || [] });
    }
    /* 全黑图必须**在界面上看得出是黑的**（不然丙那条是空的：图没生效，对比度当然好）*/
    await p.js(`App.show('shelf')`); await sleep(700);
    const paint = await p.js(`(() => { const e = document.getElementById('screen-shelf');
      const cs = getComputedStyle(e); return { img: cs.backgroundImage.slice(0, 90),
        有图: cs.backgroundImage.indexOf('appearance/bg/file') >= 0 }; })()`);
    const dbgNow = await p.js(`window.Appearance ? window.Appearance.debug() : null`);
    check('丙1 全黑图真的铺上去了（不是"图没生效所以对比度当然好"）',
      paint.有图, JSON.stringify({ paint, dbg: dbgNow }));

    /* ── 丁、移除 → 回默认 ────────────────────────────────── */
    await p.js(`(() => { const b = document.querySelector('#ubg-del'); if (b) b.click(); return !!b; })()`);
    await sleep(1800);
    const gone = await p.js(`(() => { const d = window.Appearance.debug();
      const e = document.getElementById('screen-shelf');
      return { 还有图: d.has, url: d.url, cls: d.cls,
               屏上还有: getComputedStyle(e).backgroundImage.indexOf('appearance/bg/file') >= 0 }; })()`);
    check('丁1 移除之后回到默认纸纹（前端 + 屏上都没有那张图了）',
      !gone.还有图 && !gone.url && !gone.cls.length && !gone.屏上还有, JSON.stringify(gone));

    /* ── 乙·成对基准：**默认态**（没有用户图）下的同七屏截图 ──────────
       为什么要这一组：丙 那条要按像素回答"这一屏到底有没有把用户的图铺上"。
       只看 CSS 变量会骗自己（那层纱、那个不透明度、被卡片盖住…都能让图"声明了却看不见"）。
       所以把默认态的同七屏也拍下来 —— 像素判据拿两张**成对**比：
       图没真铺上时，两张会几乎一模一样 → 必须报红（第 43 轮那条"取整屏众数色"的老判法是
       误报：屏上大片是**不透明**纸卡片，众数永远取到纸色）。 */
    const baselines = [];
    for (const s of SCREENS) {
      await p.js(`App.show(${JSON.stringify(s === 'tool' ? 'tools' : s)})`); await sleep(700);
      const f = path.join(SHOT, 'r43-ubg-' + (FORCE || 'ok') + '-base-' + s + '.png');
      await p.shot(f);
      baselines.push({ id: 'ubg-' + s, file: path.relative(ROOT, f) });
    }
    const baseOK = baselines.every((b) => fs.existsSync(path.join(ROOT, b.file)));
    check('丙2 默认态基准也拍全了（像素判据要拿它成对比，缺一张就没得比）',
      baseOK, JSON.stringify(baselines.filter((b) => !fs.existsSync(path.join(ROOT, b.file)))));

    /* ── 戊、坏情况都要说人话 ─────────────────────────────── */
    const bads = await p.js(`(async () => {
      const post = async (blob, name) => {
        const fd = new FormData(); fd.append('file', blob, name); fd.append('scope', 'global'); fd.append('mode', 'cover');
        const r = await fetch('api/appearance/bg', { method: 'POST', body: fd });
        let j = null; try { j = await r.json(); } catch (e) {}
        return { status: r.status, why: (j && (j.detail || j.message)) || '' };
      };
      const out = {};
      out.不是图片 = await post(new Blob(['这不是图片']), 'x.txt');
      out.超大 = await post(new Blob([new Uint8Array(9 * 1024 * 1024)]), 'big.png');
      out.空文件 = await post(new Blob([]), 'e.png');
      return out; })()`);
    check('戊1 传的不是图片 → 说人话地拒了（415/400 + 中文原因）',
      bads.不是图片.status >= 400 && /图|图片/.test(bads.不是图片.why), JSON.stringify(bads.不是图片));
    check('戊2 超过 8MB → 说人话地拒了（别让人干等）',
      bads.超大.status === 413 && /8MB|大/.test(bads.超大.why), JSON.stringify(bads.超大));
    const noTok = await p.js(`fetch('api/appearance/bg/file?scope=global', { credentials: 'omit' })
      .then((r) => r.status).catch(() => 0)`);
    check('戊3 媒体地址不带口令 → 401（说明口令必须挂在地址上，App 里 file:// 没 cookie）',
      noTok !== 200, String(noTok));

    /* ── 收尾：把测试留下的那档清干净（绝不把测试东西留在用户机上）── */
    await p.js(`fetch('api/appearance/bg?scope=global', { method: 'DELETE' }).then((r) => r.status)`);
    await p.js(`fetch('api/appearance/bg?scope=book&slug=' + encodeURIComponent((window.BookCtx&&BookCtx.slug())||''),
      { method: 'DELETE' }).then((r) => r.status)`);
    const clean = await p.js(`fetch('api/appearance/bg').then((r) => r.json()).then((d) => [d.global.has, d.book.has])`);
    const dir1 = bgFiles();
    check('己1 收尾清干净（用户机上一个测试图都不留）', clean[0] === false && clean[1] === false, JSON.stringify(clean));
    check('己2 目录也回到开跑前的样子（测试不许往 data/appearance/ 里留图）',
      dir1.join('|') === dir0.join('|'), JSON.stringify({ 开跑前: dir0, 收尾后: dir1 }));

    const rep = { at: new Date().toISOString().replace('T', ' ').slice(0, 19), force: FORCE || null,
                  rows, surfaces, baselines,
                  summary: { total: rows.length, bad: rows.filter((r) => !r.ok).length } };
    fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
    const badsN = rows.filter((r) => !r.ok).length;
    console.log('\n' + (badsN ? '红 ' + badsN + ' 条：' + rows.filter((r) => !r.ok).map((r) => r.name).join(' / ')
                             : '全过 ✅') + '\n→ ' + OUT);
    await p.close();
    try { fs.unlinkSync(good); fs.unlinkSync(black); fs.unlinkSync(bad); fs.unlinkSync(huge); } catch (e) {}
    process.exit(badsN ? 1 : 0);
  } catch (e) {
    console.log('  ⚠ 探针出错：' + (e && e.message));
    try { await p.close(); } catch (e2) {}
    process.exit(2);
  }
})();
