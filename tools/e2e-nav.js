/* ============================================================
   e2e-nav.js — 切屏：**切过去就得真在那一屏上**（治"切出一片空白"和"切了又弹回去"）

   两个真 bug 都是这套判据抓出来的（第 30 轮），用户现场也够得着：
     ① **切出一片空白**：转场收尾是异步的（`switchScreen` 要等 aIn/aOut 的 finished），
        用户在动画没演完时又切了一次屏，**旧的那次收尾会晚到**，它照着自己闭包里的旧 outEl
        去 `hidden` —— 而那元素说不定正是**现在该显示的那一屏** → 整屏只剩一层底色。
        （无头实测原话：`App.show('shelf')` 之后 `body.dataset.tab` 是 shelf，
          `#screen-shelf` 却带着 `hidden`，截图墨迹 0.000。）
        修法：`finish()` 里藏元素前先看"它还是不是当前屏" + `App.revealCurrent()` 兜底。
     ② **切了又弹回阅读器**：`Reader.quickClose` / `tocClose` 的导出写成 `() => closeQuick()`，
        把 `fromBack` 这个参数**吞了** → App.show 从阅读器换屏时被当成"用户自己收面板" →
        走 `closeOverlay()` → `history.back()` → 又弹回阅读器那一格 → App.show 白切一场。
        （实测：`App.show('settings')` 之后 dataset.tab 又变回 reader，"大设置"那张截图是阅读器。）

   要证的（每条都能报红）：
     ① 从任意一屏切到另一屏，落点必须是目标屏：`body.dataset.tab === name`
     ② 目标屏真的露着（不是 `hidden`/`display:none`），**别的屏都藏着**
     ③ 屏上**必须有货**：截图墨迹 ≥ 1%（纯底色 = 空白屏，机器判）
     ④ 切完 1.5 秒之后再量一遍（晚到的收尾要是把屏藏了，这里抓得到）
     ⑤ 从**阅读器（面板开着）**换屏也必须一次到位（上面 bug ② 的回归）
     ⑥ 自愈：人为把当前屏藏掉，1.5 秒内必须自己露回来（bug ① 的另一半）

   跑法：
     node tools/e2e-nav.js                    # 正常：以上全绿
     NAV_FORCE=1 node tools/e2e-nav.js        # 反证：关掉自愈 + 人为藏掉当前屏
                                              #       → ①②③ **必须报红**（报绿=判据是空的）
   产出：docs/切屏实测.json + docs/切屏截图/（反证：docs/切屏实测-反证.json + docs/截图判据反证/）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { open, sleep } = require('./cdp');

const ROOT = '/home/ubuntu/novel-app';
const FORCE = process.env.NAV_FORCE === '1';
const OUT = path.join(ROOT, FORCE ? 'docs/切屏实测-反证.json' : 'docs/切屏实测.json');
/* 切屏证据单独放一个目录：这里**故意**会有"同一屏拍好几张"（从不同起点切到同一屏，
   逐字节一样才是对的）。混进 docs/前端截图/ 会被"同一轮不许两张一样"那条判据误报，
   那条规定管的是"那一步没生效"，跟这儿不是一回事。 */
const SHOTDIR = path.join(ROOT, FORCE ? 'docs/截图判据反证' : 'docs/切屏截图');
const pw = (() => { try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; } catch (e) { return ''; } })();
const SHOTS = ['shelf', 'chat', 'lore', 'preset', 'settings', 'tools'];

function stat(file) {
  try {
    return JSON.parse(execFileSync(path.join(ROOT, 'server/venv/bin/python'),
      [path.join(ROOT, 'tools/imgstat.py'), file], { encoding: 'utf8' }));
  } catch (e) { return { ink: -1, core: -1 }; }
}

/* 量"现在屏幕上是谁"：当前屏露着 + 别的屏全藏着 */
const PROBE = `(() => {
  const SC = ['shelf','reader','chat','lore','preset','settings','tools','tool'];
  const cur = document.body.dataset.tab;
  const vis = SC.filter((s) => { const e = document.getElementById('screen-' + s);
    return e && !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none'; });
  return { cur: cur, vis: vis, others: vis.filter((s) => s !== cur) };
})()`;

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const s = await open({ port: 9377, width: 390, height: 844 });
  const rows = [], fails = [];

  await s.nav('http://127.0.0.1:8899/?nav=' + Date.now());
  await sleep(2500);
  await s.js(`(() => { const l = document.getElementById('login');
    if (l && !l.classList.contains('hidden')) {
      const i = document.getElementById('login-pass'); i.value = ${JSON.stringify(pw)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login-go').click();
    } return 1; })()`);
  await sleep(3000);
  const sp = await s.js(`(async () => { for (let i = 0; i < 90; i++) {
      const e = document.getElementById('splash');
      if (!e || e.classList.contains('gone') || getComputedStyle(e).display === 'none') return true;
      await new Promise((r) => setTimeout(r, 120)); } return false; })()`, 45000);
  if (!sp) { console.error('启动页没退场'); s.close(); process.exit(1); }
  if (FORCE) {
    /* 反证：把自愈关掉（App.revealCurrent 是公开的，关了就等于少了那道兜底） */
    await s.js('(() => { App.revealCurrent = () => {}; return 1; })()');
  }

  /* 一次切屏 + 三连量：落下、1.5 秒后（晚到的收尾）、像素有货 */
  const go = async (from, to, tag) => {
    await s.js(`(() => { App.show(${JSON.stringify(from)}); return 1; })()`);
    await sleep(1200);
    await s.js(`(() => { App.show(${JSON.stringify(to)}); return 1; })()`);
    /* 故意在动画没演完时再切一次 —— 这就是"旧收尾晚到"的触发条件 */
    await sleep(60);
    await s.js(`(() => { App.show(${JSON.stringify(to)}); return 1; })()`);
    await sleep(500);
    const a = await s.js(PROBE);
    await sleep(1500);
    const b = await s.js(PROBE);
    const file = path.join(SHOTDIR, (FORCE ? 'navforce-' : 'r30-nav-') + tag + '.png');
    await s.shot(file);
    const st = stat(file); const k = st.core;
    if (FORCE && to !== 'shelf') {   /* 反证：人为把当前屏藏掉（模拟晚到的收尾真藏了它） */
      await s.js(`(() => { document.getElementById('screen-' + document.body.dataset.tab)
        .classList.add('hidden'); return 1; })()`);
      await sleep(1600);
      const c = await s.js(PROBE);
      const f2 = path.join(SHOTDIR, 'navforce-' + tag + '-查.png');
      await s.shot(f2);
      const st2 = stat(f2); const k2 = st2.core;
      rows.push({ from, to, tag, at: a, late: b, ink: k, forced: c, forced_ink: k2 });
      /* 判"屏上真没东西"用**屏幕主体**的墨迹（core），不用整幅：顶栏底栏长在屏幕元素外面，
         当前屏被藏了它们也还在，整幅量出来有 5%~8%，会把空白屏放过去（头一次跑就踩了）。 */
      const bad = c.cur === to && c.vis.indexOf(to) < 0 && k2 < 0.01;
      if (!bad) fails.push(tag + '：反证没复现（藏了当前屏，界面居然还有货 ink=' + k2 + '）');
      console.log('  ' + (bad ? '✓' : '✗') + ' 反证 ' + tag + ' 藏屏后 主体墨迹=' + k2);
      return;
    }
    rows.push({ from, to, tag, at: a, late: b, core: k });
    const ok = a.cur === to && a.vis.indexOf(to) >= 0 && a.others.length === 0
      && b.cur === to && b.vis.indexOf(to) >= 0 && b.others.length === 0 && k >= 0.01;
    if (!ok) {
      fails.push(tag + '：切到 ' + to + ' 之后 —— 落点=' + a.cur
        + ' 露着的屏=[' + a.vis.join(',') + '] 1.5s 后=[' + b.vis.join(',') + '] 像素墨迹=' + k);
    }
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + tag.padEnd(22)
      + ' 落点=' + String(a.cur).padEnd(9) + ' 露着=[' + a.vis.join(',') + ']'
      + ' 1.5s 后=[' + b.vis.join(',') + '] 主体墨迹=' + (k * 100).toFixed(1) + '%');
  };

  console.log(FORCE ? '反证：关掉自愈 + 人为藏掉当前屏 → 必须报红' : '正常：切屏必须一次到位');
  for (const to of SHOTS) await go('shelf', to, 'shelf→' + to);
  for (const to of SHOTS) if (to !== 'shelf') await go(to, 'shelf', to + '→shelf');

  /* ⑤ 从阅读器（设置面板开着）换屏：bug ② 的回归 —— 一次出去就不许弹回来 */
  if (!FORCE) {
    const bk = await s.js(`(async () => {
      App.show('shelf'); await new Promise((r) => setTimeout(r, 900));
      const bad = /^(zz-|zzperf|界面实测|走查|e2e|性能自测|tmp-|test-)/i;
      const cs = [...document.querySelectorAll('#shelf-list .book-card')];
      const c = cs.find((x) => !bad.test(x.dataset.slug || '')) || cs[0];
      if (!c) return null; c.click();
      for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 150));
        if (window.Reader && Reader.isOpen()) break; }
      return c.dataset.slug || 'book'; })()`, 45000);
    if (!bk) { fails.push('书架上没有书，阅读器那条没法测'); }
    else {
      for (const to of ['settings', 'chat']) {
        await s.js("(() => { Reader.quickToggle('type'); return 1; })()");
        await sleep(700);
        await s.js(`(() => { App.show(${JSON.stringify(to)}); return 1; })()`);
        await sleep(1500);
        const a = await s.js(PROBE);
        const file = path.join(SHOTDIR, 'r30-nav-reader→' + to + '.png');
        await s.shot(file);
        const k = stat(file).core;
        const ok = a.cur === to && a.vis.indexOf(to) >= 0 && a.others.length === 0 && k >= 0.01;
        if (!ok) fails.push('阅读器（面板开着）→ ' + to + '：落点=' + a.cur
          + ' 露着=[' + a.vis.join(',') + '] 主体墨迹=' + k);
        console.log('  ' + (ok ? '✓' : '✗') + ' 阅读器(面板开着)→' + to.padEnd(10)
          + ' 落点=' + a.cur + ' 露着=[' + a.vis.join(',') + '] 主体墨迹=' + (k * 100).toFixed(1) + '%');
        rows.push({ from: 'reader', to, tag: 'reader→' + to, at: a, ink: k });
      }
      /* 收拾：回书架，别把书开着 */
      await s.js("(() => { Reader.quickClose(true); App.show('shelf'); return 1; })()");
      await sleep(800);
    }
  } else {
    /* 反证里的自愈那半条：把当前屏藏掉，自愈被关掉 → 必须一直是空的 */
    await s.js("(() => { App.show('shelf'); return 1; })()");
    await sleep(1200);
    await s.js("(() => { document.getElementById('screen-shelf').classList.add('hidden'); return 1; })()");
    await sleep(1600);
    const a = await s.js(PROBE);
    const file = path.join(SHOTDIR, 'navforce-selfheal.png');
    await s.shot(file);
    const k = stat(file).core;
    const bad = a.vis.length === 0 && k < 0.01;
    if (!bad) fails.push('反证·自愈：藏了当前屏却还有货 主体墨迹=' + k + ' 露着=[' + a.vis.join(',') + ']');
    console.log('  ' + (bad ? '✓' : '✗') + ' 反证·自愈关掉后藏屏 → 主体墨迹=' + k + ' 露着=[' + a.vis.join(',') + ']');
    rows.push({ tag: 'selfheal-forced', at: a, core: k });
  }

  const errs = s.errors();
  const rep = { at: new Date().toISOString(), force: FORCE, rows, fails, errors: errs };
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
  console.log('\n' + (fails.length ? ('没过 ❌ ' + fails.join('；')) : ('全过 ✅ ' + rows.length + ' 条')));
  console.log('→ ' + path.relative(ROOT, OUT));
  s.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
