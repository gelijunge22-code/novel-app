/* ============================================================
   surfaces.js — 全站"要体检哪些屏/弹层/面板"的唯一一份清单。

   为什么单独一个文件：**不许两套实现并存**。
   e2e-night.js（夜间对比度）和 e2e-uicheck.js（热区/断词/溢出动效）走的是**同一份**清单 ——
   以前各写一份的后果就是"这边加了新面板、那边没跟上"，体检报告看着全绿其实漏了一片。
   加新面板/新弹层，只改这里。
   ============================================================ */
const READER_OPEN = `(async () => {
  App.show('shelf'); await new Promise((r) => setTimeout(r, 700));
  const card = document.querySelector('#shelf-list .book-card');
  if (!card) return 0;
  card.click(); await new Promise((r) => setTimeout(r, 2800));
  return document.body.dataset.tab === 'reader' ? 1 : 0;
})()`;

/* 每一屏都要连**公共外壳**一起量：底部导航 `#tabbar` 不在 `#screen-*` 里面，
   不单独量就会漏掉"导航栏的字夜间看不看得清"。 */
const CHROME = ['#tabbar'];
const SCREENS = [
  { id: 'shelf',    file: '02-登录后书架',  root: '#screen-shelf', extra: CHROME,    settle: 800,
    open: `(async()=>{App.show('shelf');await new Promise(r=>setTimeout(r,700));return 1;})()` },
  { id: 'preset',   file: 'preset-预设',    root: '#screen-preset', extra: CHROME,   settle: 1900,
    open: `(async()=>{App.show('preset');await new Promise(r=>setTimeout(r,1700));return 1;})()` },
  { id: 'lore',     file: '04-设定',        root: '#screen-lore', extra: CHROME,     settle: 1900,
    open: `(async()=>{App.show('lore');await new Promise(r=>setTimeout(r,1700));return 1;})()` },
  { id: 'chat',     file: '05-对话',        root: '#screen-chat', extra: CHROME,     settle: 1900,
    open: `(async()=>{App.show('chat');await new Promise(r=>setTimeout(r,1700));return 1;})()` },
  /* 对话页抽屉**展开态**（第 45 轮加）：用户点名「底下就只能露出来 ge 了」「字儿已经凸出去了」——
     不展开的话 `.cd-body` 是 display:none，那条「人格/模型/出字/渠道」胶囊行根本量不到。
     展开态是**用户会真的看到**的一屏，所以它跟其它屏一样进这份唯一清单（不许另写一套判据）。 */
  { id: 'chat-drawer', file: '05-对话-抽屉展开', root: '#chat-drawer', extra: CHROME, settle: 1400,
    open: `(async()=>{App.show('chat');await new Promise(r=>setTimeout(r,1300));
             const d=document.getElementById('chat-drawer'), h=document.getElementById('chat-drawer-head');
             if(!d||!h) return 0;
             if(!d.classList.contains('open')) h.click();
             await new Promise(r=>setTimeout(r,800));
             return d.classList.contains('open')?1:0;})()`,
    close: `(async()=>{const d=document.getElementById('chat-drawer');
             if(d&&d.classList.contains('open')){const h=document.getElementById('chat-drawer-head'); if(h) h.click();}
             await new Promise(r=>setTimeout(r,400)); return 1;})()` },
  { id: 'tools',    file: 'tools-宫格',     root: '#screen-tools', extra: CHROME,    settle: 900,
    open: `(async()=>{App.show('tools');await new Promise(r=>setTimeout(r,700));return 1;})()` },
  { id: 'settings', file: '03-设置',        root: '#screen-settings', extra: CHROME, settle: 1400,
    open: `(async()=>{App.show('settings');await new Promise(r=>setTimeout(r,1200));return 1;})()` },
  /* #rd-quick（阅读器底部面板）是 index.html 里的独立层、不在 #screen-reader 里；
     不显式加进来的话，安全区/home 条那条扫描根本扫不到它（第 19 轮发现的）。 */
  { id: 'reader',   file: 'reader-阅读',    root: '#screen-reader',
    extra: CHROME.concat(['#rd-quick']),
    settle: 700, open: READER_OPEN },
];

const OVERLAYS = [
  { id: 'chip-pick', file: 'overlay-弹层-切书书单', root: '#sheet-panel', settle: 900, needBack: 'shelf',
    open: `(async()=>{App.show('shelf');await new Promise(r=>setTimeout(r,600));
             if(!window.BookCtx) return 0; BookCtx.sheet(); await new Promise(r=>setTimeout(r,900)); return 1;})()`,
    close: `(async()=>{try{App.closeSheet();}catch(e){} await new Promise(r=>setTimeout(r,400)); return 1;})()` },
  /* 目录里长按一章弹出的「改章名 / 删除」小抽屉。
     注意：以前这里测的是"右上角三个点"那套整屏弹层（`sheet-rd`）——
     用户点名把那套删掉了（"右上角的三个点完全去掉"），所以这个入口已经不存在；
     现在改从底部面板的目录页**长按**进（真实路径），别再测一个删掉的东西。 */
  { id: 'chapter-menu', file: 'overlay-弹层-章节长按菜单', root: '#sheet-panel', settle: 900,
    open: `(async()=>{
      if (document.body.dataset.tab !== 'reader') { const ok = await (${READER_OPEN}); if (!ok) return 0; }
      /* 目录现在是**独立的一整块**（#rd-toc），底栏「目录」直达（第 2 屏） */
      const b = document.querySelector('#reader-foot .rd-fb[aria-label="目录"]');
      if (b) { b.click(); await new Promise(r=>setTimeout(r,700)); }
      const row = document.querySelector('#rd-toc-body .rd-toc-item[data-path]');
      if (!row) return 0;
      row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: 100 }));
      await new Promise(r=>setTimeout(r,900));
      return 1; })()`,
    close: `(async()=>{try{App.closeSheet();}catch(e){} await new Promise(r=>setTimeout(r,400)); return 1;})()` },
  { id: 'modal',     file: 'overlay-弹层-确认弹窗', root: '#modal-panel', settle: 500,
    open: `(async()=>{App.confirm('夜间体检用的一条确认文案，看看字压在这个底上够不够清楚。',()=>{},'好');
             await new Promise(r=>setTimeout(r,420)); return 1;})()`,
    close: `(async()=>{try{App.closeModal();}catch(e){} await new Promise(r=>setTimeout(r,320)); return 1;})()` },
  /* 阅读器底部面板：**5 个页签**各拍一张（用户点名的"这面板丑不丑"就在这儿）。
     目录**不在**这儿 —— 它是独立的一块（见下面 `rdtoc`）。 */
  ...[['type', '排版'], ['theme', '背景'], ['tts', '听书'], ['mark', '书签'], ['note', '笔记']]
    .map(([q, cn]) => ({
      id: 'rdquick-' + q, file: 'rdquick-底部面板-' + cn, root: '#rd-quick', settle: 1000,
      open: `(async()=>{ if(document.body.dataset.tab!=='reader'){ const ok = await (${READER_OPEN}); if(!ok) return 0; }
               const b=document.querySelector('#reader-foot .rd-fb[aria-label="设置"]'); if(!b) return 0;
               b.click(); await new Promise(r=>setTimeout(r,520));
               const t=document.querySelector('.rd-qbtn[data-q=${JSON.stringify(q)}]'); if(t) t.click();
               await new Promise(r=>setTimeout(r,700)); return 1; })()`,
      close: `(async()=>{const b=document.querySelector('#rd-quick [data-act="reader-quick-close"]'); if(b) b.click();
               await new Promise(r=>setTimeout(r,400)); return 1;})()`,
    })),
  /* 目录：**独立的一块**（用户点名："点开目录之后，只是相当于在设置里面点开了目录一样，
     并没有那种简洁的感觉，而且很乱"）。它跟设置面板是两样东西，所以各占一面。 */
  { id: 'rdtoc', file: 'rdtoc-目录', root: '#rd-toc', settle: 900,
    open: `(async()=>{ if(document.body.dataset.tab!=='reader'){ const ok = await (${READER_OPEN}); if(!ok) return 0; }
             if(!(window.Reader && Reader.toc)) return 0;
             Reader.toc(); await new Promise(r=>setTimeout(r,700)); return 1; })()`,
    close: `(async()=>{try{Reader.tocClose();}catch(e){} await new Promise(r=>setTimeout(r,400)); return 1;})()` },
  { id: 'toast',     file: 'toast-提示条', root: '#toast', settle: 300,
    open: `(async()=>{App.toast('已保存');await new Promise(r=>setTimeout(r,260));return 1;})()`,
    close: `(async()=>{const t=document.getElementById('toast'); if(t) t.classList.add('hidden'); return 1;})()` },
];

/* 工具子面板：宫格里的 26 张卡（studio.js 那批也走同一份 TOOLS） */
function toolSurfaces(ids) {
  return ((ids && ids.length ? ids : (global.__TOOLIDS__ || [])).map((t) => (typeof t === 'string' ? { id: t } : t))).map((t) => ({
    id: 'tool-' + t.id, file: 'tool-工具-' + t.id, root: '#tool-body', settle: 1800,
    open: `(async()=>{try{Tools.open(${JSON.stringify(t.id)});}catch(e){return 0;}
             await new Promise(r=>setTimeout(r,1500)); return document.body.dataset.tab==='tool'?1:0;})()`,
    close: `(async()=>{try{Tools.back();}catch(e){} await new Promise(r=>setTimeout(r,500)); return 1;})()`,
  }));
}

module.exports = { READER_OPEN, CHROME, SCREENS, OVERLAYS, toolSurfaces };
