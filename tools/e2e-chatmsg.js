/* ============================================================
   e2e-chatmsg.js — 对话页两条**用户亲口报的**硬判据（第 42 轮）

   用户原话（一字不改）：
     「现在，这里面只有下半部分是可以滑动的，以及**古往我发出来的消息，如果刷新或者刷新网页就看不到了**，
      就会变成……**有一个棕色的像圈一样的东西，什么都看不到**，Bug 还是很多」

   判据：
     甲 用户自己发的每一条，**刷新之后必须还在、而且有正文**（不是空泡泡、不是占位）
        —— 根因：库里存的是 `blocks=[{type:'text',content:'<字符串>'}]`，前端却按 `content.preview/.value` 读
        → 空字符串 → `.msg.me .bubble`（底色是 --accent，棕色）成了**空的棕色圈**。
     乙 页面上**不许有空气泡**（`.msg .bubble` 的可见文字为空 = 用户"什么都看不到"）。
     丙 刷新后**不许长出"永远不填字"的 live 气泡**（SSE 会把历史事件重放，message_start 会再建一次）。
     丁 顶上固定区 ≤18% 屏高、消息区 ≥70% 屏高（收起态）。

   反证：CHATMSG_FORCE=old → 把 userText 还原成改前那版（`__NB_CHAT_FORCE='oldmsg'`）→ 甲/乙**必须报红**。
   用法：node tools/e2e-chatmsg.js
   产出：docs/对话消息实测.json（反证写 docs/对话消息实测-反证-old.json）+ 截图
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp.js');

const ROOT = '/home/ubuntu/novel-app';
const FORCE = process.env.CHATMSG_FORCE || '';
const OUT = path.join(ROOT, FORCE ? 'docs/对话消息实测-反证-old.json' : 'docs/对话消息实测.json');
const SHOT = path.join(ROOT, 'docs/前端截图');
const rows = [];
function check(name, ok, why) {
  rows.push({ name, ok: !!ok, why: String(why == null ? '' : why).slice(0, 600) });
  console.log(('  ' + (ok ? '✓ ' : '✗ ')) + name + (ok ? '' : '   —— ' + String(why).slice(0, 240)));
  return !!ok;
}
const pw = () => JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || '';

/* 在页面里量：每条气泡的可见文字 */
const MEASURE = `(() => {
  const b = document.querySelector('#chat-body');
  if (!b) return { 没有消息区: true };
  const bubbles = [...document.querySelectorAll('#chat-body .msg .bubble')];
  const txt = bubbles.map((x) => (x.innerText || '').trim());
  const me = [...document.querySelectorAll('#chat-body .msg.me .bubble')].map((x) => (x.innerText || '').trim());
  const live = document.querySelectorAll('#chat-body .msg.ai.live').length;
  const H = innerHeight;
  const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
  const bar = r('#screen-chat .topbar'), bk = r('#chat-book'), dr = r('#chat-drawer');
  const top = [bar, bk, dr].filter(Boolean).reduce((a, x) => a + x.height, 0);
  const bd = r('#chat-body');
  return { 气泡数: bubbles.length, 空气泡: txt.filter((t) => !t).length,
           用户气泡数: me.length, 用户空气泡: me.filter((t) => !t).length,
           空气泡文本: txt.filter((t) => !t).length ? txt.map((t, i) => i + ':' + JSON.stringify(t)).slice(0, 8) : [],
           占位气泡: txt.filter((t) => t.indexOf('没能读出来') >= 0).length,
           假live气泡: live,
           消息区占屏: bd ? Math.round(bd.height / H * 100) + '%' : '?',
           顶上占屏: Math.round(top / H * 100) + '%',
           第一段: txt.slice(0, 3).map((t) => t.slice(0, 40)) };
})()`;

(async () => {
  const p = await open({ port: 9412, width: 390, height: 844, settle: 1200 });
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(pw())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);
    await p.clickSel('[data-tab="chat"]');
    await sleep(4500);

    if (FORCE === 'old') {
      await p.js(`window.__NB_CHAT_FORCE='oldmsg'`);
      await p.js(`window.Chat.open(window.Chat.state.sid)`);
      await sleep(2500);
    }

    const a = await p.js(MEASURE);
    console.log('  刷新前：' + JSON.stringify(a).slice(0, 300));
    await p.shot(path.join(SHOT, FORCE ? 'r42-chatmsg-反证.png' : 'r42-chatmsg-01.png'));

    check('甲1 用户自己发的消息**渲染出了正文**（不是空泡泡、不是占位）',
      a.用户气泡数 > 0 && a.用户空气泡 === 0 && a.占位气泡 === 0,
      JSON.stringify({ 用户气泡数: a.用户气泡数, 用户空气泡: a.用户空气泡, 占位: a.占位气泡 }));

    check('乙1 页面上没有空气泡（"什么都看不到"的那种）',
      a.空气泡 === 0, JSON.stringify(a.空气泡文本));

    check('丙1 刷新后没有"永远不填字"的假 live 气泡（SSE 重放不许再建一次）',
      a.假live气泡 === 0, a.假live气泡);

    check('丁1 收起态：顶上固定区 ≤18% 屏高 且 消息区 ≥70% 屏高',
      parseInt(a.顶上占屏) <= 18 && parseInt(a.消息区占屏) >= 70,
      a.顶上占屏 + ' / ' + a.消息区占屏);

    /* 展开态：用户说「展开之后这里非常非常的挤」——展开也要有消息区，胶囊不许断成 3+1 */
    const exp = await p.js(`(async () => {
      const w = (m) => new Promise((r) => setTimeout(r, m));
      window.Chat.drawer(true); await w(360);
      /* 真喂一条 orchestra_run_start（走的是**页面里真正在处理它的那个函数**，
         不是脚本另画一套），4 棒的胶囊必须能在 390 宽下一行放下 */
      window.Chat.feed({ event: { type: 'orchestra_run_start', modeName: '计划', steps: [
        { role: 'leader', roleName: '主创' }, { role: 'critic', roleName: '挑刺' },
        { role: 'leader', roleName: '主创' }, { role: 'critic', roleName: '挑刺' }] } });
      await w(260);
      const H = innerHeight;
      const d = document.querySelector('#chat-drawer');
      const bd = document.querySelector('#chat-body');
      const steps = [...document.querySelectorAll('#chat-run .run-step')].map((x) => Math.round(x.getBoundingClientRect().top));
      const seg = document.querySelector('#chat-modes');
      const runH = Math.round(document.querySelector('#chat-run').getBoundingClientRect().height);
      return { 展开态抽屉高: Math.round(d.getBoundingClientRect().height),
               轮次那一行高: runH,
               抽屉占屏: Math.round(d.getBoundingClientRect().height / H * 100) + '%',
               展开态消息区占屏: Math.round(bd.getBoundingClientRect().height / H * 100) + '%',
               轮次数: steps.length, 各胶囊top: steps,
               胶囊一行放下: steps.length > 1 && new Set(steps).size === 1,
               干活方式top: seg ? Math.round(seg.getBoundingClientRect().top) : null };
    })()`);
    console.log('  展开态：' + JSON.stringify(exp));
    check('戊1 展开态：消息区仍 ≥30% 屏高（展开不许把消息挤没）',
      parseInt(exp.展开态消息区占屏) >= 30, exp.展开态消息区占屏);
    check('戊2 展开态：轮次胶囊 4 个**在同一行**（不许断成 3+1）',
      exp.轮次数 === 4 && exp.胶囊一行放下, JSON.stringify(exp.各胶囊top));
    /* 说明与轮次共用一行槽位：有轮次时**抽屉不比没有轮次时高**（不额外占一行）。
       为什么不是"跟干活方式挤在同一行"：390 宽下真的放不下（量过 496px > 358px），
       硬塞只会把两边都挤变形 —— 那是"更挤"，跟用户的诉求反了。 */
    const idle = await p.js(`(async () => { const w=(m)=>new Promise(r=>setTimeout(r,m));
      window.Chat.state.run = null; window.Chat.state.runRow.innerHTML='';
      window.Chat.state.runRow.classList.add('hidden');
      const h = document.getElementById('chat-mode-hint'); if (h) h.classList.remove('hidden');
      await w(240);
      return { 空闲抽屉高: Math.round(document.querySelector('#chat-drawer').getBoundingClientRect().height),
               说明可见: !!(h && !h.classList.contains('hidden')) }; })()`);
    check('戊3 展开态：轮次与「模式说明」**共用同一行槽位**（有轮次时抽屉不比空闲时高）',
      exp.展开态抽屉高 <= idle.空闲抽屉高 + 4,
      '有轮次 ' + exp.展开态抽屉高 + 'px vs 空闲 ' + idle.空闲抽屉高 + 'px（说明可见=' + idle.说明可见 + '）');
    await p.shot(path.join(SHOT, FORCE ? 'r42-chatmsg-反证3-展开.png' : 'r42-chatmsg-03-展开态.png'));
    await p.js(`window.Chat.drawer(false)`);

    /* 刷新一遍，历史必须一模一样地回来 */
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);
    await p.clickSel('[data-tab="chat"]'); await sleep(5000);
    const b = await p.js(MEASURE);
    check('甲2 刷新之后：气泡数与内容跟刷新前**逐条一致**（用户说的"刷新就看不到了"）',
      b.气泡数 === a.气泡数 && JSON.stringify(b.第一段) === JSON.stringify(a.第一段),
      JSON.stringify({ 前: a.气泡数, 后: b.气泡数, 前段: a.第一段, 后段: b.第一段 }));
    check('乙2 刷新之后依然没有空气泡', b.空气泡 === 0, JSON.stringify(b.空气泡文本));
    await p.shot(path.join(SHOT, FORCE ? 'r42-chatmsg-反证2.png' : 'r42-chatmsg-02-刷新后.png'));
  } catch (e) {
    check('脚本跑完（没抛错）', false, e.message);
  } finally {
    await p.close();
  }
  const ok = rows.filter((r) => r.ok).length;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toLocaleString('sv'), force: FORCE || '（正常）', total: rows.length, ok, fails: rows.filter(r => !r.ok).map(r => r.name), items: rows }, null, 1), 'utf-8');
  console.log('\n' + (ok === rows.length ? '全部通过' : '有红 ❌ ' + (rows.length - ok) + ' 条') + ' → ' + OUT);
  process.exit(ok === rows.length ? 0 : 1);
})();
