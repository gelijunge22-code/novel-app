/* rdq_probe.js — 「书里的设置」改前/改后 自测探针（第 40 轮）
   量：面板高度、网格三列等宽、图标、对齐基准线、× 尺寸与位置、单滚动容器（滚一起动没动）。
   顺手拍：整屏（顶）+ 滚到底 + 放大（那排格子）。
*/
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
const readPassword = () => { try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json','utf8')).app_password||''; } catch(e){ return ''; } };
const ROOT='/home/ubuntu/novel-app';

const SCAN = `(() => {
  const el = document.getElementById('rd-quick');
  const sc = document.getElementById('rd-quick-scroll');
  const tabs = el.querySelector('.rd-quick-tabs');
  const body = document.getElementById('rd-quick-body');
  const bar = el.querySelector('.rd-quick-bar');
  const x = el.querySelector('[data-act="reader-quick-close"]');
  const group = body.querySelector('.settings-group');
  const row = body.querySelector('.settings-row');
  const r = (n) => { const b = n.getBoundingClientRect(); return {l:Math.round(b.left),t:Math.round(b.top),r:Math.round(b.right),b:Math.round(b.bottom),w:Math.round(b.width),h:Math.round(b.height)}; };
  const cells = [...tabs.querySelectorAll('.rd-qbtn')];
  const c0 = cells.map((c) => r(c));
  const rowsTop = [...new Set(c0.map((c) => c.t))].sort((a,b)=>a-b);
  return {
    panel: Object.assign(r(el), {ratio: Math.round(el.getBoundingClientRect().height / innerHeight * 100) / 100, screenH: innerHeight}),
    tabs: r(tabs), body: r(body), bar: r(bar),
    barPos: getComputedStyle(bar).position, tabsPos: getComputedStyle(tabs).position,
    scroller: sc ? { scrollH: sc.scrollHeight, clientH: sc.clientHeight, scrollable: sc.scrollHeight > sc.clientHeight + 2 } : null,
    cells: cells.map((c, i) => ({q: c.dataset.q, txt: c.textContent.trim(), svg: !!c.querySelector('svg'),
       ...c0[i], fs: getComputedStyle(c).fontSize, pad: getComputedStyle(c).padding})),
    rowTops: rowsTop, perRow: rowsTop.map((t) => c0.filter((c) => c.t === t).length),
    xs: Object.assign(r(x), { rightGap: Math.round(el.getBoundingClientRect().right - x.getBoundingClientRect().right) }),
    group: group ? r(group) : null, settingsRow: row ? r(row) : null,
    h3: body.querySelector('h3') ? r(body.querySelector('h3')) : null,
    tabLeftVsGroupLeft: group ? Math.round(c0[0].l - r(group).l) : null,
    tabRightVsGroupRight: group ? Math.round(c0[2].r - r(group).r) : null,
  };
})()`;

const SCROLLTEST = `(async () => {
  const sc = document.getElementById('rd-quick-scroll');
  const tabs = document.querySelector('#rd-quick .rd-quick-tabs');
  const rows = document.querySelector('#rd-quick-body .settings-group');
  /* 内容不够高就没得滚 —— 在**最后**塞一个占位撑出来（只动测试，不动作品） */
  let spacer = null;
  if (sc.scrollHeight <= sc.clientHeight + 4) {
    spacer = document.createElement('div'); spacer.id = 'rdq-probe-spacer'; spacer.style.height = '700px';
    sc.appendChild(spacer);
  }
  sc.scrollTop = 0;
  await new Promise((r) => requestAnimationFrame(r));
  const t0 = Math.round(tabs.getBoundingClientRect().top);
  const g0 = Math.round(rows.getBoundingClientRect().top);
  sc.scrollTop = 120;
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => setTimeout(r, 60));
  const t1 = Math.round(tabs.getBoundingClientRect().top);
  const g1 = Math.round(rows.getBoundingClientRect().top);
  const out = { canScroll: sc.scrollHeight > sc.clientHeight + 2, tabsDelta: t1 - t0, bodyDelta: g1 - g0,
                sameDelta: (t1 - t0) === (g1 - g0), tabsPos: getComputedStyle(tabs).position };
  if (spacer) spacer.remove();
  sc.scrollTop = 0;
  return out;
})()`;

(async()=>{
  const p = await open({port:9413,width:390,height:844,settle:1200});
  try{
    await p.nav('file://'+ROOT+'/apk/assets/www/index.html'); await sleep(1800);
    await p.js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
      ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(2000);
    const opened = await p.js(`(async()=>{
      for (let i=0;i<50;i++){ const sp=document.getElementById('splash'); if(!sp||sp.classList.contains('gone')) break; await new Promise(r=>setTimeout(r,120)); }
      const c=document.querySelector('#shelf-list .book-card'); if(!c) return 'nobook'; c.click();
      for (let i=0;i<60;i++){ await new Promise(r=>setTimeout(r,200)); if(window.Reader&&Reader.isOpen()&&Reader.state.text) break; }
      const b=document.querySelector('#reader-foot .rd-fb[aria-label="设置"]'); if(!b) return 'nobtn'; b.click();
      await new Promise(r=>setTimeout(r,700));
      return 'ok';
    })()`,{timeout:60000});
    console.log('open:', opened);
    await sleep(500);
    const r1 = await p.js(SCAN,{timeout:40000});
    console.log(JSON.stringify(r1, null, 1));
    await p.shot(ROOT+'/docs/监督人-书设置-改后-顶.png');
    const st = await p.js(SCROLLTEST,{timeout:30000});
    console.log('scroll test:', JSON.stringify(st));
    /* 换到内容更长的「听书」页 → 滚到底再拍一张（这时才真有得滚：内容比面板高） */
    const ttsInfo = await p.js(`(async()=>{
      const t=document.querySelector('#rd-quick .rd-qbtn[data-q="tts"]'); if(!t) return {err:'no tts tab'};
      t.click(); await new Promise(r=>setTimeout(r,600));
      const sc=document.getElementById('rd-quick-scroll');
      const before=sc.scrollTop; sc.scrollTop=sc.scrollHeight; await new Promise(r=>setTimeout(r,300));
      return { on:(document.querySelector('#rd-quick .rd-qbtn.on')||{}).dataset?document.querySelector('#rd-quick .rd-qbtn.on').dataset.q:'',
        scrollH:sc.scrollHeight, clientH:sc.clientHeight, scrollTop:sc.scrollTop, canScroll:sc.scrollHeight>sc.clientHeight+2 };
    })()`,{timeout:30000});
    console.log('tts tab:', JSON.stringify(ttsInfo));
    await sleep(400);
    await p.shot(ROOT+'/docs/监督人-书设置-改后-听书-滚到底.png');
    /* 放大那排格子 */
    const box = await p.js(`(()=>{const t=document.querySelector('#rd-quick .rd-quick-tabs');const b=t.getBoundingClientRect();
      return {x:Math.max(0,b.left-6),y:Math.max(0,b.top-6),w:b.width+12,h:b.height+12};})()`,{timeout:20000});
    await p.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});
    await sleep(200);
    const shot = await p.send('Page.captureScreenshot',{format:'png',clip:{x:box.x,y:box.y,width:box.w,height:box.h,scale:3}});
    if (shot.result && shot.result.data) fs.writeFileSync(ROOT+'/docs/监督人-书设置-改后-格子放大.png', Buffer.from(shot.result.data,'base64'));
    await p.send('Emulation.clearDeviceMetricsOverride');
    console.log('shots done');
  }catch(e){console.log('!!', e.message);}finally{await p.close();}
})();
