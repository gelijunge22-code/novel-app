/* ============================================================
   voice-try.js — 试听「这一把声音」（全站唯一一份实现）

   为什么要单独抽出来：试听这件事以前只有写作台里有（studio.js 里内联那段），
   设置页的音色只能"选"不能"听" —— 挑音色全靠名字猜。
   重做设置页时要用同一个能力，如果照抄一份就是"两套实现并存"（本项目红线）。
   所以抽成这一个模块：**谁要试听都调它**。

   它做的事很小、但都有理由：
     · 全 App **只有一个** <audio>：切音色 / 离开面板都会把上一把停掉
       （否则会出现"上一把还在念，你已经点了另一把"的错乱）；
     · 出声失败（断网 / 服务器合成失败）**必须说人话**，
       不许静默无声 —— 此处指出过"听书没声音"，静默无声最难查；
     · 播放期间给按钮一个"忙"的样子（调用方给 busyHTML），结束时恢复原样。

   合成在服务器上做（edge-tts / cosyvoice），所以**断网就是没声音**，这不是手机坏了。
   ============================================================ */
(function () {
  let cur = null;              // 当前在播的那个 Audio

  /** 停掉正在试听的声音（切音色、离开面板、换页时都该调） */
  function stop() {
    if (cur) { try { cur.pause(); } catch (e) { /* 已经播完 / 被回收，无所谓 */ } cur = null; }
  }

  /**
   * play({ voice, engine, rate, text, el, busyHTML, idleHTML, onDone })
   *   el       要变成"忙"样子的按钮（可选）
   *   busyHTML 播的时候按钮里显示什么（可选）
   *   idleHTML 播完恢复成什么（可选，默认用点击前的 innerHTML）
   *   onDone(msg) 播完/失败回调；msg 非空表示失败，调用方负责弹提示
   * 返回 true 表示已经去取了（能否出声由服务器决定）。
   */
  function play(o) {
    const opt = o || {};
    stop();
    if (!window.API || !API.previewTtsUrl) return false;
    const url = API.previewTtsUrl(opt.voice, opt.engine, opt.rate, opt.text);
    const el = opt.el;
    const idleHTML = opt.idleHTML != null ? opt.idleHTML : (el ? el.innerHTML : '');
    if (el) {
      if (opt.busyHTML != null) el.innerHTML = opt.busyHTML;
      el.classList.add('busy');
    }
    const a = new Audio(url);
    cur = a;
    const done = (msg) => {
      if (el) { el.classList.remove('busy'); el.innerHTML = idleHTML; }
      if (cur === a) cur = null;
      if (opt.onDone) opt.onDone(msg || '');
    };
    a.onended = () => done('');
    /* 三种失败都要收敛到同一句人话：出声这件事全靠服务器。
       （以前这里是"什么都不做"—— 用户只看到点了没反应。） */
    a.onerror = () => done('没出声：连不上服务器，或这一段合成失败（试听要走服务器）');
    try {
      const p = a.play();
      if (p && p.catch) p.catch(() => done('没出声：连不上服务器，或这一段合成失败（试听要走服务器）'));
    } catch (e) {
      done('没出声：连不上服务器，或这一段合成失败（试听要走服务器）');
    }
    return true;
  }

  window.VoiceTry = { play, stop, playing: () => !!cur };
})();
