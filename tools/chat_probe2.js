/* chat_probe2.js — AI 对话页（第 42 批）
   ① 量：顶上那块占多少屏高、消息区剩多少（用户：「可以滑动的地方很少」）
   ② 复现用户报的严重 bug：**刷新之后历史消息全没了，只剩一个棕色圆圈**
   用法：node tools/chat_probe2.js
   产出：docs/监督人-对话页-*.png */
const fs = require('fs');
const { open, sleep } = require('./cdp.js');
const OUT = '/home/ubuntu/novel-app/docs';
function pw() { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
const J = (x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1));

(async () => {
  const p = await open({ port: 9402, width: 390, height: 844, settle: 1200 });
  const errs = [];
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(pw())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);

    const hit = await p.clickSel('[data-tab="chat"]');
    if (!hit) { console.log('!! 没找到底部「对话」tab'); return; }
    await sleep(3000);

    console.log('=== ① 对话屏结构（收起态）===');
    console.log(J(await p.js(`(() => {
      const H = innerHeight, scr = document.querySelector('#screen-chat');
      const r = (el) => el ? el.getBoundingClientRect() : null;
      const bar = r(document.querySelector('#screen-chat .topbar'));
      const bk = r(document.querySelector('#chat-book'));
      const dr = r(document.querySelector('#chat-drawer'));
      const qk = r(document.querySelector('#chat-quick'));
      const cp = r(document.querySelector('#chat-compose'));
      const bd = r(document.querySelector('#chat-body'));
      const top = [bar, bk, dr].filter(Boolean).reduce((a, x) => a + x.height, 0);
      const out = { 屏高: H,
        顶栏: bar && Math.round(bar.height), 当前书: bk && Math.round(bk.height),
        抽屉_收起: dr && Math.round(dr.height), 抽屉开着: !!(document.querySelector('#chat-drawer.open')),
        常用指令: qk && Math.round(qk.height), 输入栏: cp && Math.round(cp.height),
        消息区: bd && Math.round(bd.height),
        顶上固定区合计: Math.round(top), 顶上占屏: Math.round(top / H * 100) + '%',
        消息区占屏: bd ? Math.round(bd.height / H * 100) + '%' : '?' };
      return out; })()`)));

    await p.shot(OUT + '/监督人-对话页-01-收起态.png');

    console.log('\n=== ② 刷新前：屏幕上几条消息 / 有没有"棕色圆圈" ===');
    const before = await p.js(`(() => {
      const b = document.querySelector('#chat-body');
      const sp = document.querySelector('#chat-body .spinner');
      return { 气泡数: document.querySelectorAll('#chat-body .msg').length,
               正文长度: (b ? b.innerText.length : 0),
               有转圈: !!sp, 开头: (b ? b.innerText.slice(0, 60).replace(/\\n/g, ' | ') : '') }; })()`);
    console.log(J(before));

    console.log('\n=== ②b 详细：开的哪个会话 / 快照里几条 / 每条是什么 ===');
    console.log(J(await p.js(`(async()=>{
      const S = window.Chat.state;
      const sid = S.sid;
      const snap = await (await fetch('/api/agent/sessions/'+encodeURIComponent(sid))).json();
      const es = (snap.history && snap.history.entries) || [];
      return { 会话: sid, 标题: (snap.summary||{}).title, 库里条数: es.length,
        每条: es.map((e)=>({type:e.type, 有正文:!!(e.content&&(e.content.preview||e.content.value)),
          工具:(e.toolCalls||[]).map(t=>t.name).join(','), id:e.id})),
        页面上气泡: document.querySelectorAll('#chat-body .msg').length };})()`, { timeout: 30000 })));

    console.log('\n=== ③ 刷新页面（用户就是这么干的）→ 再进对话 ===');
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);
    await p.clickSel('[data-tab="chat"]');
    await sleep(5000);
    const after = await p.js(`(() => {
      const b = document.querySelector('#chat-body');
      const sp = document.querySelector('#chat-body .spinner');
      const st = document.querySelector('#chat-st');
      return { 气泡数: document.querySelectorAll('#chat-body .msg').length,
               正文长度: (b ? b.innerText.length : 0),
               有转圈: !!sp, 状态条: st ? st.textContent : '',
               开头: (b ? b.innerText.slice(0, 60).replace(/\\n/g, ' | ') : '') }; })()`);
    console.log(J(after));
    await p.shot(OUT + '/监督人-对话页-02-刷新之后.png');
    console.log('\n刷新前后对比：气泡 ' + before.气泡数 + ' → ' + after.气泡数 +
                '；正文 ' + before.正文长度 + ' → ' + after.正文长度 +
                (after.气泡数 === 0 && before.气泡数 > 0 ? '   ★★ 历史丢了（用户报的 bug 复现成功）' : ''));

    console.log('\n=== ④ 抽屉：点开看能不能展开、展开后多高、自己能不能滚 ===');
    const opened = await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const h=document.querySelector('#chat-drawer-head'); if(!h) return '没有抽屉头';
      h.click(); await w(400);
      const d=document.querySelector('#chat-drawer'), b=document.querySelector('#cd-body')||document.querySelector('#chat-drawer-body');
      const bd=document.querySelector('#chat-body');
      return { 开着: d.classList.contains('open'), 抽屉高: Math.round(d.getBoundingClientRect().height),
        抽屉占屏: Math.round(d.getBoundingClientRect().height/innerHeight*100)+'%',
        肚能滚: b ? (b.scrollHeight-b.clientHeight) : 0,
        消息区占屏: Math.round(bd.getBoundingClientRect().height/innerHeight*100)+'%' };})()`);
    console.log(J(opened));
    await p.shot(OUT + '/监督人-对话页-03-展开态.png');

    console.log('\n=== ⑤ 页面上的 JS 报错 ===');
    console.log(J(await p.js(`JSON.stringify(window.__errs||[])`)));
  } catch (e) { console.log('!! 出错：' + e.message); }
  finally { await p.close(); }
})();
/* 追加：把"到底开的哪个会话 / 快照里几条 / 每条是什么"打出来 */
