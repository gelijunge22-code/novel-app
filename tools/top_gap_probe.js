/* top_gap_probe.js — 量：各屏顶部那一大块空白到底多高 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}
(async () => {
  const p = await open({ port: 9406, width: 390, height: 844, settle: 1200 });
  const measure = async (label) => {
    const r = await p.js(`(() => {
      const H = window.innerHeight;
      const scr = document.querySelector('.screen:not(.hidden)') || document.body;
      const sr = scr.getBoundingClientRect();
      /* 找这一屏里第一个"有内容"的元素（有文字或图片，且可见） */
      let first = null;
      const walk = (el) => {
        if (first) return;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return;
        const r = el.getBoundingClientRect();
        if (r.height < 8 || r.width < 8) return;
        if (el.tagName === 'SECTION' || el.tagName === 'BODY' || el.tagName === 'HTML') {
          for (const c of el.children) walk(c);
          return;
        }
        const hasText = el.childElementCount === 0 && (el.textContent || '').trim().length > 0;
        const hasBg = (getComputedStyle(el).backgroundImage || '').indexOf('none') < 0;
        if (hasText || hasBg || el.tagName === 'IMG' || el.tagName === 'BUTTON') { first = el; return; }
        for (const c of el.children) walk(c);
      };
      for (const c of scr.children) walk(c);
      const fr = first ? first.getBoundingClientRect() : null;
      return JSON.stringify({
        屏: scr.id || '(无id)',
        屏高: H,
        顶部第一个有内容的元素: first ? (first.tagName.toLowerCase() + (first.id ? '#' + first.id : '') + (first.className ? '.' + String(first.className).split(' ')[0] : '')) : '(找不到)',
        它的顶边: fr ? Math.round(fr.top) : null,
        顶部空白高度: fr ? Math.round(fr.top) : null,
        占屏比: fr ? Math.round(fr.top / H * 100) + '%' : null,
        它的文字: first ? (first.textContent || '').trim().slice(0, 24) : ''
      });
    })()`);
    console.log('  [' + label + '] ' + r);
  };
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4500);
    await measure('书架');
    for (const [名称, 文字] of [['预设','预设'],['设定','设定'],['对话','对话'],['工具','工具']]) {
      await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
        const b=[...document.querySelectorAll('nav button,button')].find(x=>x.textContent.trim()===${JSON.stringify(文字)});
        if(b){b.click(); await w(2200);} return 1;})()`, { timeout: 15000 });
      await measure(名称);
    }
    /* 大设置（弹层） */
    await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const b=document.getElementById('btn-shelf-menu'); if(b){b.click(); await w(2400);} return 1;})()`, { timeout: 15000 });
    await measure('大设置(弹层)');
    await p.shot('/home/ubuntu/novel-app/docs/监督人-顶部空白-大设置.png');
  } catch (e) { console.log('!! 出错:', e.message); }
  finally { await p.close(); }
})();
