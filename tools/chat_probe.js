/* chat_probe.js — 量 AI 对话页：上半固定块多高、下半能滑的剩多少 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}
(async () => {
  const p = await open({ port: 9401, width: 390, height: 844, settle: 1200 });
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);

    console.log('=== 进对话页 ===');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const b=document.querySelector('[data-go="chat"]')||[...document.querySelectorAll('nav button,button')].find(x=>x.textContent.trim()==='对话');
      if(!b) return '找不到对话入口';
      b.click(); await w(2800);
      return '已进：'+document.body.innerText.slice(0,70).replace(/\\n/g,' | ');})()`, { timeout: 20000 }));
    await sleep(1800);

    console.log('\n=== 对话屏的结构：谁固定、谁能滑 ===');
    console.log(await p.js(`(() => {
      const scr = document.querySelector('#screen-chat') || document.body;
      const H = window.innerHeight;
      const out = [];
      const walk = (el, depth) => {
        if (depth > 5) return;
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.height > 20) {
          const scrollable = el.scrollHeight - el.clientHeight > 4;
          const oh = st.overflowY;
          if (scrollable || oh === 'auto' || oh === 'scroll' || st.position === 'fixed' || st.position === 'sticky') {
            out.push({
              标签: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ').slice(0,2).join('.') : ''),
              位置: st.position, overflowY: oh,
              高: Math.round(r.height), 顶: Math.round(r.top), 底: Math.round(r.bottom),
              屏高占比: Math.round(r.height / H * 100) + '%',
              能滑: scrollable ? ('可滑 ' + (el.scrollHeight - el.clientHeight) + 'px') : '不能滑'
            });
          }
        }
        for (const c of el.children) walk(c, depth + 1);
      };
      walk(scr, 0);
      /* 消息列表本身 */
      const list = document.querySelector('#chat-list') || document.querySelector('[class*=chat-list]') || document.querySelector('[class*=msg-list]');
      const lh = list ? Math.round(list.getBoundingClientRect().height) : 0;
      return JSON.stringify({ 屏高: H, 消息列表高: lh, 消息列表占屏: lh ? Math.round(lh / H * 100) + '%' : '?', 结构: out }, null, 1);
    })()`));

    console.log('\n=== 发一条消息再刷新，看历史还在不在（用户报的严重 bug）===');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const inp=document.querySelector('#chat-in,textarea,input[type=text]');
      const before=document.querySelectorAll('[class*=bubble],[class*=msg],[class*=entry]').length;
      return JSON.stringify({有输入框:!!inp, 刷新前元素数:before});})()`, { timeout: 15000 }));
  } catch (e) { console.log('!! 出错:', e.message); }
  finally { await p.close(); }
})();
