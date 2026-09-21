const { open, sleep } = require('../cdp');
const { readPassword } = require('../preflight');
const ROOT = '/home/ubuntu/novel-app';
(async () => {
  const s = await open({ port: 9394 });
  await s.nav('file://' + ROOT + '/apk/assets/www/index.html');
  await sleep(1600);
  await s.js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword())
    + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
  await sleep(2200);
  await s.js("(()=>{const st=document.createElement('style');st.textContent='#settings-body select.input{text-overflow:clip !important;max-width:var(--sp-16) !important}';document.head.appendChild(st);return 1})()");
  await s.js("(async()=>{App.show('settings');await new Promise(r=>setTimeout(r,1200));return 1})()");
  const r = await s.js(`(()=>{
    const cv=document.createElement('canvas').getContext('2d');
    return [...document.querySelectorAll('#settings-body select.input')].map(sel=>{const cs=getComputedStyle(sel);
      cv.font=cs.fontWeight+' '+cs.fontSize+' '+cs.fontFamily;
      const o=sel.options[sel.selectedIndex];
      return {txt:o?o.textContent:'', overflow:cs.overflow, to:cs.textOverflow, cw:sel.clientWidth,
        sw:sel.scrollWidth, w:Math.round(cv.measureText(o?o.textContent:'').width)};});
  })()`);
  console.log(JSON.stringify(r, null, 1));
  s.close();
})();
