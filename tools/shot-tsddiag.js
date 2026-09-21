/* 拍一张「听书自检」的图（给自审清单当证据用）：走用户真走的路 ——
   书架点进书 → 大设置 · 听书 → 点「听书自检」 → 等它逐项亮灯 → 拍。 */
const path = require('path');
const { open, sleep } = require('./cdp');
const { readPassword } = require('./preflight');
const ROOT = '/home/ubuntu/novel-app';
(async () => {
  const s = await open({ port: 9393 });
  await s.nav('file://' + ROOT + '/apk/assets/www/index.html');
  await sleep(1500);
  await s.js("(()=>{const i=document.getElementById('login-pass');i.value=" +
    JSON.stringify(readPassword()) +
    ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
  await sleep(1600);
  await s.js(`(async () => { for (let i = 0; i < 90; i++) { const e = document.getElementById('splash');
      if (!e || e.classList.contains('gone') || getComputedStyle(e).display === 'none') return true;
      await new Promise((r) => setTimeout(r, 100)); } return false; })()`, 45000);
  const info = await s.js(`(async () => {
    const list = await API.shelf();
    const b = ((list && list.projects) || []).filter((x) => !/^zz-/.test(x.slug))[0];
    const book = await API.book(b.slug);
    const first = ((book.chapters || [])[0] || {}).path;
    Shelf.open(b.slug);
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 200));
      if (document.body.dataset.tab === 'reader') break; }
    if (Reader.goChapter) await Reader.goChapter(first, 0);
    await new Promise((r) => setTimeout(r, 800));
    App.show('settings');
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 200));
      const btn = document.getElementById('do-ttsdiag');
      if (btn) { btn.scrollIntoView({ block: 'center' }); break; } }
    await new Promise((r) => setTimeout(r, 400));
    return { slug: b.slug, path: first }; })()`, 60000);
  console.log('书：' + JSON.stringify(info));
  await s.shot(path.join(ROOT, 'docs/前端截图/r33-听书自检-入口.png'));
  await s.js(`(async () => { const btn = document.getElementById('do-ttsdiag'); btn.click();
    for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 200));
      const b2 = document.getElementById('tsd-body');
      if (b2 && b2.querySelector('.tsd-why')) return 1; } return 0; })()`, 60000);
  await sleep(500);
  await s.shot(path.join(ROOT, 'docs/前端截图/r33-听书自检-结果.png'));
  await s.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
