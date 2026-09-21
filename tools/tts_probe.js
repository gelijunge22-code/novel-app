/* ============================================================
   tts_probe.js — 监督人亲测：网页版点「听书」到底发生了什么
   抓：网络请求（/api/tts/*）+ 每个 Audio 元素的真实状态 + 页面 toast
   用法：node tools/tts_probe.js
   ============================================================ */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');

function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}
const SLUG = 'example-book';

(async () => {
  const p = await open({ port: 9391, width: 390, height: 844, settle: 1200,
    // 关键：在页面里挂钩 Audio，把每个音频元素都记下来
    shims: [`window.__audios=[];
      (function(){ const A=window.Audio;
        window.Audio=function(...a){ const el=new A(...a); window.__audios.push(el);
          el.addEventListener('error',()=>{ el.__errAt=Date.now(); }); return el; };
        window.Audio.prototype=A.prototype; })();
      window.__toasts=[];
      (function(){ const t=window.setTimeout; })();`] });

  try {
    console.log('=== 1. 打开网页版 ===');
    await p.nav('http://127.0.0.1:8899/');
    await sleep(3500);
    console.log('  URL:', await p.js('location.href'));
    console.log('  标题:', await p.js('document.title'));

    console.log('\n=== 2. 登录 ===');
    const lg = await p.js(`(async()=>{
      const r = await fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({password:${JSON.stringify(readPassword())}})});
      return r.status + ' ' + (await r.text()).slice(0,60);
    })()`);
    console.log('  登录结果:', lg);
    await p.nav('http://127.0.0.1:8899/');
    await sleep(3500);

    console.log('\n=== 3. 打开书 + 第一章 ===');
    const st = await p.js(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const card=document.querySelector('#shelf-list .book-card');
      if(!card) return 'shelf 上没书卡：'+document.body.innerText.slice(0,120);
      card.click(); await wait(3000);
      return '书卡点了；当前 body 前 80 字: '+document.body.innerText.slice(0,80).replace(/\\n/g,' ');
    })()`);
    console.log(' ', st);
    await sleep(2500);

    console.log('\n=== 4. 点「听书」 ===');
    const tts = await p.js(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      let b=document.querySelector('[data-a="tts"]')
        || [...document.querySelectorAll('button')].find(x=>/听书|朗读/.test(x.textContent));
      if(!b){ const mb=document.querySelector('[data-act="reader-menu"]'); if(mb){mb.click(); await wait(900);} 
        b=document.querySelector('[data-a="tts"]')||[...document.querySelectorAll('button')].find(x=>/听书|朗读/.test(x.textContent)); }
      if(!b) return '找不到听书按钮';
      b.click();
      await wait(9000);            // 给它足够时间：拿段落 → 取音频 → play
      return '点了听书，等了 9 秒';
    })()`, { timeout: 30000 });
    console.log(' ', tts);

    console.log('\n=== 5. 网络：/api/tts/ 的请求与响应 ===');
    const net = p.events.filter(e => e.method === 'Network.responseReceived' || e.method === 'Network.requestWillBeSent')
      .filter(e => String((e.params.response && e.params.response.url) || (e.params.request && e.params.request.url) || '').includes('/tts/') )
      .map(e => {
        if (e.method === 'Network.requestWillBeSent') return '  → 请求 ' + e.params.request.url;
        const r = e.params.response;
        return '  ← ' + r.status + '  ' + (r.mimeType || '') + '  ' + r.url;
      });
    console.log(net.length ? net.slice(-14).join('\n') : '  （没有一条 /tts/ 请求 —— 说明根本没发出去）');

    console.log('\n=== 6. 音频元素的真实状态 ===');
    const au = await p.js(`(()=>{
      const a = window.__audios || [];
      if(!a.length) return '页面里一个 Audio 都没创建过';
      return a.map((el,i)=>({
        序号:i, src:String(el.src||'').slice(-110), readyState:el.readyState,
        networkState:el.networkState, paused:el.paused, muted:el.muted,
        音量:el.volume, 时长:el.duration, 当前位置:el.currentTime,
        错误码:(el.error&&el.error.code)||null, 错误说明:(el.error&&el.error.message)||''
      }));
    })()`);
    console.log(JSON.stringify(au, null, 1));

    console.log('\n=== 7. 页面上的提示（toast）===');
    const toasts = await p.js(`(()=>{
      const t=[...document.querySelectorAll('.toast,.app-toast,[class*=toast]')].map(x=>x.textContent.trim());
      return t.length? t : '（没有 toast）';
    })()`);
    console.log(JSON.stringify(toasts));

    console.log('\n=== 8. 页面控制台报错 ===');
    const errs = p.errors();
    console.log(errs.length ? errs.slice(-8).join('\n') : '（无）');

    await p.shot('/home/ubuntu/novel-app/docs/监督人-听书探测.png');
    console.log('\n截图: docs/监督人-听书探测.png');
  } catch (e) {
    console.log('!! 探针出错:', e.message);
  } finally {
    await p.close();
  }
})();
