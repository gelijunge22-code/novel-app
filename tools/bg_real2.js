/* bg_real2.js — 只测一件事：传了图之后，页面上到底有没有拿它当背景 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}
const SLUG = 'example-book';
(async () => {
  const p = await open({ port: 9405, width: 390, height: 844, settle: 1200 });
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);

    console.log('=== 1. 造一张刺眼的蓝底黄条图并上传 ===');
    console.log(await p.js(`(async()=>{
      const c=document.createElement('canvas'); c.width=600; c.height=1000;
      const g=c.getContext('2d'); g.fillStyle='#1E5A9E'; g.fillRect(0,0,600,1000);
      g.fillStyle='#FFD24D'; for(let y=0;y<1000;y+=100) g.fillRect(0,y,600,14);
      const blob=await new Promise(r=>c.toBlob(r,'image/png'));
      const fd=new FormData(); fd.append('file', blob, 'probe.png');
      const r=await fetch('/api/appearance/bg?scope=global&slug=${SLUG}', {method:'POST', body:fd});
      return 'HTTP '+r.status+'  '+(await r.text()).slice(0,120);})()`, { timeout: 30000 }));

    console.log('\n=== 2. 重开页面，找"谁在用这张图" ===');
    await p.nav('http://127.0.0.1:8899/'); await sleep(5000);
    console.log(await p.js(`(() => {
      const found = [];
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const bi = getComputedStyle(el).backgroundImage || '';
        if (bi.indexOf('appearance') >= 0 || bi.indexOf('bg/file') >= 0) {
          found.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
            (el.className ? '.' + String(el.className).split(' ')[0] : ''));
        }
      }
      const bd = getComputedStyle(document.body).backgroundImage || '';
      const hd = getComputedStyle(document.documentElement).backgroundImage || '';
      const layer = document.getElementById('bg-layer') || document.querySelector('[class*=appearance],[class*=ubg]');
      return JSON.stringify({
        body有没有背景图: bd.indexOf('none') !== 0 && bd.length > 3 ? bd.slice(0, 70) : '（没有）',
        html有没有背景图: hd.indexOf('none') !== 0 && hd.length > 3 ? hd.slice(0, 70) : '（没有）',
        用这张图的元素共: found.length,
        是哪些: found.slice(0, 6),
        有没有专门的背景层元素: layer ? (layer.id || layer.className) : '（没有）'
      }, null, 1);
    })()`));

    console.log('\n=== 3. 那几张截图看看到底长啥样 ===');
    await p.shot('/home/ubuntu/novel-app/docs/监督人-背景-书架.png');
    await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const b=document.getElementById('btn-shelf-menu'); if(b){b.click(); await w(2500);} return 1;})()`);
    await p.shot('/home/ubuntu/novel-app/docs/监督人-背景-大设置.png');

    console.log('\n=== 4. 收尾：删掉（还原）===');
    console.log(await p.js(`fetch('/api/appearance/bg?scope=global&slug=${SLUG}',{method:'DELETE'}).then(r=>r.text())`, { timeout: 20000 }));
  } catch (e) { console.log('!! 出错:', e.message); }
  finally { await p.close(); }
})();
