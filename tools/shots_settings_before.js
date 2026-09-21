/* 拍「改前」的设置页（第 3 屏的对照图）。
   注意：现在读的是 apk/assets/www（**上一次同步进来**的那一份 = 旧设置页），
   所以这个脚本必须在 `python3 tools/sync_pkg.py` **之前**跑。 */
const path = require('path');
const { open, sleep } = require('./cdp');
const { readPassword } = require('./preflight');
const ROOT = '/home/ubuntu/novel-app';
(async () => {
  const s = await open({ port: 9376 });
  await s.nav('file://' + ROOT + '/apk/assets/www/index.html');
  await sleep(1600);
  await s.js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
    ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
  await sleep(2200);
  await s.js(`(async () => {
    for (let i = 0; i < 60; i++) {
      const sp = document.getElementById('splash');
      if (!sp || sp.classList.contains('gone') || sp.offsetParent === null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    App.show('settings');
    await new Promise((r) => setTimeout(r, 1500));
    const b = document.getElementById('settings-body');
    if (b) b.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 400));
    return 1;
  })()`);
  await s.shot(path.join(ROOT, 'docs/前端截图/r22-改前-设置-01-总览.png'));
  await s.js(`(async()=>{const b=document.getElementById('settings-body');b.scrollTop=b.scrollHeight*0.55;await new Promise(r=>setTimeout(r,400));return 1})()`);
  await sleep(400);
  await s.shot(path.join(ROOT, 'docs/前端截图/r22-改前-设置-02-下半.png'));
  console.log('改前两张已拍');
  s.close();
})().catch((e) => { console.error(e); process.exit(1); });
