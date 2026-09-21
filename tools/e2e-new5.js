/* ============================================================
   e2e-new5.js — 第 19 轮「自己想出来的 5 个新功能」逐条实测（第 19 轮）

   为什么有这东西：这 5 个功能是**新写的**，没验过就等于没做。
   验法一律走**用户真会走的路径**（开面板 / 点按钮 / 进阅读器），不许只调接口就说"能用"。

   ① 故事线      行数 = 章节数；摘要取自正文；改过的存得住；点一行进那一章
   ② 常用指令    加一条 → 列表里有；**按书隔离**（换本书看不到）；点一条真的发出去
   ③ 小批注      加一条 → 面板里看得到 → 点它跳那一章 → 删掉就没了；
                 **反证**：导出 txt 里搜不到批注那句话（批注不许进正文）
   ④ 点一下看设定 正文里标出登记过的名字 → 点一下弹设定卡；**按书隔离**（另一本不标）
   ⑤ 章节顺序    上移 → 顺序真变、序号重排、正文一字不变；**挂过的 cast/events 跟着走**
                 （反证：老写法只改一行、元数据成孤儿 → 这一条必须报红）

   用法：node tools/e2e-new5.js
   产出：docs/新功能实测.json + docs/前端截图/new5-*.png
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');

const ROOT = '/home/ubuntu/novel-app';
const SHOT = path.join(ROOT, 'docs/前端截图');
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const OUT = path.join(ROOT, 'docs/新功能实测.json');
let password = '';
try { password = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
catch (e) {}

const R = [];                       // 逐条结果
function chk(name, ok, detail) {
  R.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
}

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  const s = await open({ port: 9391, width: 390, height: 844, settle: 900 });
  const js = s.js;
  const stamp = Date.now().toString().slice(-6);
  const BOOK = '测试·新功能-' + stamp;
  const OTHER = '测试·隔离对照-' + stamp;

  await s.nav(BASE + '?new5=' + Date.now());
  for (let i = 0; i < 40; i++) {
    const g = await js("(()=>{const sp=document.getElementById('splash');return !!(sp&&(sp.classList.contains('gone')||getComputedStyle(sp).opacity==='0'));})()");
    if (g) break; await sleep(120);
  }
  if (await js("document.getElementById('login') && !document.getElementById('login').classList.contains('hidden')"))
    { await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(password)
        + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
      await sleep(4200); }
  const api = (p, o) => js("(async()=>{try{const r=await API.nb(" + JSON.stringify(p) + ", " + JSON.stringify(o || null)
    + "); return r;}catch(e){return {__err:String(e && e.message || e)};}})()");

  /* ── 造两本临时书（一本测功能、一本验隔离） ── */
  const b1 = await api('api/projects', { method: 'POST', body: { title: BOOK, summary: '新功能实测用完就删' } });
  const b2 = await api('api/projects', { method: 'POST', body: { title: OTHER, summary: '隔离对照用完就删' } });
  const S1 = b1 && b1.slug, S2 = b2 && b2.slug;
  chk('建两本临时书', !!S1 && !!S2, { S1, S2 });
  if (!S1 || !S2) { s.close(); fs.writeFileSync(OUT, JSON.stringify({ items: R }, null, 1)); process.exit(1); }

  /* 建书时后端会**默认送一章**空的「第001章-未命名.md」（store.py 里写明了原因：
     新书点进去立刻能写）。这里先把那一章删掉，让本轮的基线就是干净的 3 章 ——
     否则后面"行数 = 章节数"、上移/下移、插一章全都要按 4 章重算，判据会被这章带偏。 */
  for (const sl of [S1, S2]) {
    await api('api/chapter/delete', { method: 'POST', body: { slug: sl, path: 'manuscript/第001章-未命名.md' } });
  }
  const CH = ['manuscript/第001章-起点.md', 'manuscript/第002章-中段.md', 'manuscript/第003章-收束.md'];
  const WORD = '沈砚';
  const BODY = ['# 第一章\n\n' + WORD + '推开木门，雪落进来。\n', '# 第二章\n\n' + WORD + '在灯下抄书。\n',
                '# 第三章\n\n' + WORD + '把那枚断刃收进袖里。\n'];
  for (let i = 0; i < 3; i++) {
    const r = await api('api/chapter/new', { method: 'POST', body: { slug: S1, path: CH[i], content: BODY[i] } });
    if (r && r.__err) chk('建第 ' + (i + 1) + ' 章', false, r.__err);
  }
  for (let i = 0; i < 3; i++) await api('api/chapter/new',
    { method: 'POST', body: { slug: S2, path: CH[i], content: BODY[i] } });
  await api('api/world/entity', { method: 'POST', body: { slug: S1, name: WORD, kind: 'character',
    aliases: [WORD + '哥'], data: { summary: '雪夜捡到断刃的人' } } });

  /* ═════════ ① 故事线 ═════════ */
  const st = await api('api/storyline?slug=' + encodeURIComponent(S1));
  chk('① 故事线：行数 = 章节数', (st.items || []).length === 3, { n: (st.items || []).length });
  chk('① 故事线：每行都有摘要（取自正文，不是空）',
    (st.items || []).every((x) => (x.summary || '').trim().length > 0),
    (st.items || []).map((x) => x.summary));
  const want = '雪夜捡到断刃，被巡夜人撞见';
  await api('api/storyline', { method: 'POST', body: { slug: S1, path: CH[1], summary: want } });
  const st2 = await api('api/storyline?slug=' + encodeURIComponent(S1));
  const row2 = (st2.items || []).find((x) => x.path === CH[1]) || {};
  chk('① 故事线：改过的一句话存得住（重开还在）', row2.summary === want && row2.mine === true,
    { got: row2.summary, mine: row2.mine });

  /* ═════════ ② 常用指令 ═════════ */
  const q0 = await api('api/quick?slug=' + encodeURIComponent(S1));
  chk('② 常用指令：第一次打开有默认几条', (q0.items || []).length > 0, (q0.items || []).length);
  const MY = '接着写 800 字·' + stamp;
  const qa = await api('api/quick', { method: 'POST', body: { slug: S1, text: MY } });
  const q1 = await api('api/quick?slug=' + encodeURIComponent(S1));
  chk('② 常用指令：加一条 → 列表里真有', (q1.items || []).some((x) => x.text === MY), !!qa.id);
  const q2 = await api('api/quick?slug=' + encodeURIComponent(S2));
  chk('② 常用指令：**按书隔离**（另一本看不到这条）', !(q2.items || []).some((x) => x.text === MY),
    (q2.items || []).map((x) => x.text));
  await api('api/quick?slug=' + encodeURIComponent(S1) + '&id=' + qa.id, { method: 'DELETE', body: {} });
  const q3 = await api('api/quick?slug=' + encodeURIComponent(S1));
  chk('② 常用指令：删掉就没了', !(q3.items || []).some((x) => x.text === MY));

  /* ═════════ ③ 小批注 ═════════ */
  const SECRET = '批注生造词-' + stamp;
  const ma = await api('api/notes/margin', { method: 'POST', body: { slug: S1, path: CH[1], percent: 20,
    quote: WORD + '在灯下抄书', note: '这里要补一场打斗 ' + SECRET } });
  const ml = await api('api/notes/margin?slug=' + encodeURIComponent(S1));
  chk('③ 小批注：加一条 → 读得到', (ml.items || []).some((x) => (x.note || '').includes(SECRET)), !!ma.id);
  /* 反证：批注**不许**进正文 —— 导出 txt 里必须搜不到那句话 */
  const exp = await js("(async()=>{const r=await fetch(API.abs('api/export/text?slug=' + encodeURIComponent("
    + JSON.stringify(S1) + "))); const t=await r.text(); return {len:t.length, has:t.includes(" + JSON.stringify(SECRET) + ")};})()");
  chk('③ 小批注【反证】：导出 txt 里搜不到批注那句话', exp && exp.has === false, exp);

  /* ═════════ ④ 点一下看设定 ═════════ */
  const ents = await api('api/world/entities?slug=' + encodeURIComponent(S1));
  chk('④ 看设定：这本书登记过 ' + WORD, (ents.items || []).some((x) => x.name === WORD),
    (ents.items || []).map((x) => x.name));
  const ent2 = await api('api/world/entities?slug=' + encodeURIComponent(S2));
  chk('④ 看设定：另一本**没有**这个名字（按书隔离）', !(ent2.items || []).some((x) => x.name === WORD));

  /* ═════════ ⑤ 章节顺序（含"元数据跟着走"的反证） ═════════ */
  await api('api/plot/chapter', { method: 'PATCH', body: { slug: S1, path: CH[2],
    cast: ['沈砚', '巡夜人'], events: ['捡到断刃'] } });
  const ovMeta = await api('api/plot/overview?slug=' + encodeURIComponent(S1));
  const before = ((ovMeta.chapters || []).find((c) => c.path === CH[2])) || {};
  const beforeTxt = await api('api/chapter?slug=' + encodeURIComponent(S1) + '&path=' + encodeURIComponent(CH[2]));
  chk('⑤ 章节顺序：先给第 3 章挂上出场角色/关键事件',
    (before.cast || []).length === 2 && (before.events || []).length === 1, before.cast);

  const mv = await api('api/chapter/move', { method: 'POST', body: { slug: S1, path: CH[2], dir: 'up' } });
  const l2 = await api('api/storyline?slug=' + encodeURIComponent(S1));
  const order = (l2.items || []).map((x) => x.path);
  /* 比「顺序」要比章节的**名字**，不能比整条路径 ——
     上移会把文件重命名成「第002章-收束.md」（这本该如此），直接比路径会永远不等。 */
  const stem = (q) => String(q).replace(/^manuscript\/第\d+章-/, '').replace(/\.md$/, '');
  chk('⑤ 章节顺序：上移之后顺序真的变了',
    stem(order[1]) === stem(CH[2]) && stem(order[2]) === stem(CH[1]),
    { now: order.map(stem), want: [stem(CH[0]), stem(CH[2]), stem(CH[1])] });
  chk('⑤ 章节顺序：文件名序号跟着重排（.md 都还在）',
    order.every((p) => p.endsWith('.md')) && new Set(order).size === 3, order);
  const afterTxt = await api('api/chapter?slug=' + encodeURIComponent(S1) + '&path=' + encodeURIComponent(order[1]));
  chk('⑤ 章节顺序：**正文一个字没变**', afterTxt.content === beforeTxt.content,
    { before: (beforeTxt.content || '').length, after: (afterTxt.content || '').length });
  /* 关键反证：挪完之后，那一章的 cast/events 必须还在（老写法只改文件名 → 元数据成孤儿） */
  let metaOk = null, metaDetail = null;
  const ovMeta2 = await api('api/plot/overview?slug=' + encodeURIComponent(S1));
  for (const p of order) {
    const m = ((ovMeta2.chapters || []).find((c) => c.path === p)) || {};
    if ((m.cast || []).length) { metaOk = (m.cast || []).length === 2 && (m.events || []).length === 1; metaDetail = { p, cast: m.cast }; break; }
  }
  chk('⑤ 章节顺序【反证】：挪完 meta（出场角色/关键事件）还在，没成孤儿', metaOk === true, metaDetail);
  const ins = await api('api/chapter/insert', { method: 'POST', body: { slug: S1, after: order[0], title: '插曲·' + stamp } });
  const l3 = await api('api/storyline?slug=' + encodeURIComponent(S1));
  chk('⑤ 章节顺序：插一章 → 插在指定章的后面、总数 +1',
    (l3.items || []).length === 4 && (l3.items || [])[1].title.includes('插曲'), (l3.items || []).map((x) => x.title));

  /* ═════════ 界面路径：这 5 个入口在界面上真的点得到 ═════════ */
  await js("(async()=>{ BookCtx.set(" + JSON.stringify(S1) + "," + JSON.stringify(BOOK) + "); return 1; })()");
  await sleep(400);

  /* 故事线面板 */
  await js("(async()=>{App.show('tools');await new Promise(r=>setTimeout(r,500)); Tools.open('story');"
    + " await new Promise(r=>setTimeout(r,1500)); return 1;})()");
  await sleep(700);
  /* 第 36 轮起：「故事线」点开先是【大纲】；"一章一句话"那份收进折叠区（一个功能没删），
     判据要**先展开折叠区**再数行，否则数到 0 = 假红。 */
  await js("(()=>{const a=document.querySelector('#tool-body details.acc');"
    + "if(a){a.open=true;a.dispatchEvent(new Event('toggle'));}return 1})()");
  await sleep(1600);
  const uiStory = await js("(()=>{const rows=document.querySelectorAll('#tool-body .al-row');"
    + "return {rows:rows.length, first:(rows[0]&&rows[0].querySelector('.al-title')||{}).textContent||''};})()");
  await s.shot(path.join(SHOT, 'new5-01-故事线.png'));
  chk('① 界面：工具里有「故事线」，行数 = 章节数',
    uiStory && uiStory.rows === 4, uiStory);

  /* 章节顺序面板 + 点一下上移 */
  await js("(async()=>{Tools.open('order'); await new Promise(r=>setTimeout(r,1500)); return 1;})()");
  await sleep(600);
  const uiOrd = await js("(()=>{const rows=[...document.querySelectorAll('#tool-body .al-row')];"
    + "return {rows:rows.length, btns:document.querySelectorAll('#tool-body .al-btn').length};})()");
  await s.shot(path.join(SHOT, 'new5-05-章节顺序.png'));
  chk('⑤ 界面：工具里有「章节顺序」，每行都有上移/下移/插入', uiOrd && uiOrd.rows === 4 && uiOrd.btns === 12, uiOrd);
  const moved = await js("(async()=>{const rows=[...document.querySelectorAll('#tool-body .al-row')];"
    + "const row=rows[3]; const up=row.querySelector('[data-mv=\\\"up\\\"]'); if(!up) return '没按钮'; up.click();"
    + " await new Promise(r=>setTimeout(r,1800));"
    + " const now=[...document.querySelectorAll('#tool-body .al-title')].map(x=>x.textContent.trim());"
    + " return {order:now};})()");
  chk('⑤ 界面：点一下「上移」→ 面板里的顺序真的变了',
    moved && moved.order && moved.order.join('|') !== (l3.items || []).map((x) => x.title).join('|'), moved);

  /* 常用指令条（对话页） */
  await js("(async()=>{App.show('chat');await new Promise(r=>setTimeout(r,2200));return 1;})()");
  await sleep(800);
  const uiQuick = await js("(()=>{const el=document.getElementById('chat-quick'); if(!el) return {miss:1};"
    + "return {chips:[...el.querySelectorAll('.cq-chip')].map(b=>b.textContent.trim()), hidden:el.classList.contains('hidden')};})()");
  await s.shot(path.join(SHOT, 'new5-02-常用指令条.png'));
  chk('② 界面：对话页上出现常用指令条（且不是空的）',
    uiQuick && !uiQuick.hidden && (uiQuick.chips || []).length >= 2, uiQuick);

  /* 小批注：面板里能看到 + 点一下跳章 + 删掉 */
  await js("(async()=>{ Shelf.openBook(" + JSON.stringify(S1) + ", {slug:" + JSON.stringify(S1)
    + ", path:" + JSON.stringify(CH[0]) + "}); await new Promise(r=>setTimeout(r,3200));"
    + " const b=document.querySelector('#reader-foot [data-act=\\\"reader-quick\\\"]'); if(b) b.click();"
    + " await new Promise(r=>setTimeout(r,600));"
    + " const t=document.querySelector('.rd-qbtn[data-q=\\\"note\\\"]'); if(t) t.click();"
    + " await new Promise(r=>setTimeout(r,1500)); return 1;})()");
  await sleep(600);
  const uiNote = await js("(()=>{const b=document.getElementById('rd-quick-body'); if(!b) return {miss:1};"
    + "const ms=[...b.querySelectorAll('[data-margin]')].map(x=>x.textContent);"
    + "return {hasAdd: !!b.querySelector('[data-addmargin]'), margins: ms,"
    + " hasSecret: b.textContent.includes(" + JSON.stringify(SECRET) + ")};})()");
  await s.shot(path.join(SHOT, 'new5-03-小批注.png'));
  chk('③ 界面：笔记页里有批注那一段 + 加批注按钮 + 那条批注',
    uiNote && uiNote.hasAdd && uiNote.hasSecret, uiNote);
  const jump = await js("(async()=>{const el=document.querySelector('#rd-quick-body [data-margin]'); if(!el) return {miss:1};"
    + "el.click(); await new Promise(r=>setTimeout(r,2600));"
    + " return {tab:document.body.dataset.tab, path:(window.Reader.state||{}).path||''};})()");
  chk('③ 界面：点一条批注 → 跳到那一章', jump && jump.tab === 'reader' && /第00[0-9]/.test(String(jump.path)), jump);

  /* 点一下看设定 */
  const term = await js("(async()=>{await new Promise(r=>setTimeout(r,900));"
    + " const t=document.querySelectorAll('#reader-page .rd-term'); return {n:t.length, first:t[0]?t[0].textContent:''};})()");
  await s.shot(path.join(SHOT, 'new5-04-正文标设定.png'));
  chk('④ 界面：正文里标出了登记过的名字', term && term.n > 0 && term.first === WORD, term);
  const card = await js("(async()=>{const t=document.querySelector('#reader-page .rd-term'); if(!t) return {miss:1};"
    + " t.click(); await new Promise(r=>setTimeout(r,600));"
    + " const p=document.getElementById('sheet-panel'); "
    + " const open=!!(p && !document.getElementById('sheet').classList.contains('hidden'));"
    + " return {open:open, text:(p?p.textContent:'').slice(0,60)};})()");
  await s.shot(path.join(SHOT, 'new5-04b-设定卡.png'));
  chk('④ 界面：点一下 → 弹出设定卡（写着这个名字）',
    card && card.open && String(card.text).includes(WORD), card);

  /* ── 清理临时书（只删这两本测试书，用户的稿子不动） ── */
  for (const sl of [S1, S2]) {
    const d = await api('api/book/delete', { method: 'POST', body: { slug: sl } });
    if (d && d.__err) console.log('  清理 ' + sl + ' 失败：' + d.__err);
  }
  const left = await api('api/shelf');
  chk('清理：两本测试书删干净了（用户那本还在）',
    !(left.items || []).some((x) => x.slug === S1 || x.slug === S2), (left.items || []).map((x) => x.slug));

  const bad = R.filter((x) => !x.ok);
  const rep = { at: new Date().toISOString(), base: BASE, round: 'new5', total: R.length,
                fails: bad.length, items: R };
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
  console.log('\n' + (bad.length ? '有 ' + bad.length + ' 条没过' : '全部通过') + ' → ' + OUT);
  s.close();
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('跑挂了：', e); process.exit(2); });
