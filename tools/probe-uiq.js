/* 临时探针（第19轮收口）：① 切书小方块在顶栏里到底怎么"溢出"的；② 全站哪些元素是"真横滑容器"。
   用完就删。 */
const { open, sleep } = require('./cdp');
const { readPassword } = require('./preflight');
const R = `(() => {
  const chip = document.querySelector('.screen:not(.hidden) .topbar .bk-mini[data-book-chip]');
  const out = { chip: null, hscroll: [] };
  if (chip) { const r = chip.getBoundingClientRect(); const sp = chip.querySelector('span');
    const dot = chip.querySelector('.bk-dot'); const tb = chip.closest('.topbar');
    out.chip = { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      scrollW: chip.scrollWidth, clientW: chip.clientWidth,
      span: sp ? [Math.round(sp.getBoundingClientRect().width), sp.scrollWidth, sp.clientWidth] : null,
      dot: dot ? (() => { const d = dot.getBoundingClientRect();
        return [Math.round(d.left), Math.round(d.right), Math.round(innerWidth)]; })() : null,
      tb: tb ? (() => { const t = tb.getBoundingClientRect();
        return [Math.round(t.left), Math.round(t.right)]; })() : null,
      style: getComputedStyle(chip).overflow + '/' + getComputedStyle(chip).display };
  }
  document.querySelectorAll('*').forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      out.hscroll.push({ el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
          + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : ''),
        sw: el.scrollWidth, cw: el.clientWidth, oy: cs.overflowY,
        w: Math.round(r.width), h: Math.round(r.height),
        txt: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 20) });
    }
  });
  out.hscroll = out.hscroll.slice(0, 25);
  return out;
})()`;
(async () => {
  const s = await open({ port: 9399, width: 390, height: 844, settle: 900 });
  const js = s.js;
  await s.nav('http://127.0.0.1:8899/?probe=' + Date.now());
  for (let i = 0; i < 40; i++) { const g = await js("(()=>{const sp=document.getElementById('splash');return !!(sp&&(sp.classList.contains('gone')||getComputedStyle(sp).opacity==='0'));})()"); if (g) break; await sleep(120); }
  if (await js("document.getElementById('login') && !document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword())
      + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4200);
  }
  for (const tab of ['shelf', 'tools', 'settings']) {
    await js("App.show('" + tab + "')"); await sleep(900);
    console.log('### ' + tab + ' → ' + JSON.stringify(await js(R)));
  }
  if (await js("document.querySelector('.tool-card[data-id=\"refs\"]')"))
    { await js("App.show('tools')"); await sleep(600); await js("document.querySelector('.tool-card[data-id=\"refs\"]').click()"); await sleep(1200); }
  console.log('### tool-refs → ' + JSON.stringify(await js(R)));
  if (await js("(App.show('reader'),1)")) { await sleep(1600); }
  console.log('### reader → ' + JSON.stringify(await js(R)));
  s.close(); process.exit(0);
})().catch((e) => { console.error('probe 挂了', e); process.exit(2); });
