/* tts_probe6.js — 用「真实鼠标点击」（CDP 派发，浏览器认它是真人操作）
   测听书到底能不能播。这是唯一能定案的测法。 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}
(async () => {
  const p = await open({ port: 9398, width: 390, height: 844, settle: 1200,
    flags: ['--autoplay-policy=user-gesture-required'],
    shims: [`window.__audios=[];
      (function(){ const A=window.Audio;
        window.Audio=function(...a){ const el=new A(...a); window.__audios.push(el); return el; };
        window.Audio.prototype=A.prototype; })();
      window.__playErrs=[];
      (function(){ const P=HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play=function(){ const r=P.apply(this,arguments);
          if(r&&r.catch) r.catch(e=>window.__playErrs.push(e.name)); return r; }; })();`] });

  const realClick = async (sel, fx, fy) => {
    const box = await p.js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
      if(!e) return null; e.scrollIntoView({block:'center'});
      const r=e.getBoundingClientRect();
      return {x:Math.round(r.left+r.width*${fx == null ? 0.5 : fx}), y:Math.round(r.top+r.height*${fy == null ? 0.5 : fy})};})()`);
    if (!box) { console.log('   找不到 ' + sel); return false; }
    await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(60);
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    return true;
  };

  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4000);

    console.log('=== 1. 进书（真实点击书卡）===');
    console.log('   点到了吗:', await realClick('#shelf-list .book-card', 0.35, 0.35));
    await sleep(6500);
    console.log('   现在正文:', await p.js(`String((document.querySelector('#reader-body')||{}).innerText||'').slice(0,40)`));

    console.log('\n=== 2. 真实点击「听书」按钮 ===');
    if (!await p.js("!!document.querySelector('[data-a=\"tts\"]')")) {
      console.log('   tts 按钮还没出来，屏幕文字:', await p.js("document.body.innerText.slice(0,150).replace(/\\n/g,' | ')"));
      // 试试底栏那个"听书"
      console.log('   改点底栏「听书」:', await realClick('#reader-foot [data-act="toggle-tts"]'));
    } else {
      console.log('   点到了吗:', await realClick('[data-a="tts"]'));
    }
    await sleep(14000);

    console.log('\n=== 3. 结果 ===');
    console.log(await p.js(`JSON.stringify((window.__audios||[]).map((el,i)=>({i, readyState:el.readyState,
      paused:el.paused, dur:el.duration, cur:Number(el.currentTime.toFixed(2)),
      muted:el.muted, err:(el.error&&el.error.code)||null})),null,1)`));
    console.log('   play() 被拒次数:', await p.js(`JSON.stringify(window.__playErrs||[])`));
    console.log('   界面提示:', await p.js(`JSON.stringify([...document.querySelectorAll('.toast,.app-toast,[class*=toast]')].map(x=>x.textContent.trim()))`));
    const n = p.events.filter(e=>e.method==='Network.responseReceived').map(e=>e.params.response)
      .filter(r=>String(r.url).includes('/tts/seg?')).map(r=>'     '+r.status+' '+r.mimeType);
    console.log('   音频请求:'); console.log(n.length? n.slice(-5).join('\n') : '     （无）');
  } catch (e) { console.log('!! 出错:', e.message); }
  finally { await p.close(); }
})();
