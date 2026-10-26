// ==UserScript==
// @name         看课助手（题目时间表 + 弹题提醒 + 自动连播/跳过）
// @name:en      Course Helper (quiz schedule + popup alert + auto next)
// @namespace    local.dsh.course-helper
// @version      2.1.0
// @description  一个面板搞定：题目在第几分几秒出现、弹题时电脑+手机提醒、一节播完自动下一节、已刷过的课时自动跳过。所有开关在面板里改，可拖动
// @author       you
// @match        *://*.wnssedu.com/course/newcourse/watch.htm*
// @match        *://*.polyv.net/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      v.polyv.net
// @connect      api.day.app
// @connect      push.ft07.com
// @connect      sctapi.ftqq.com
// @connect      www.pushplus.plus
// @connect      *
// @license      MIT
// ==/UserScript==

/*
 * ============================ 用法 ============================
 * 装好后刷新看课页面，左上角会出现「看课助手」面板（拖动标题栏可以移动）。
 *   题目  —— 本题视频所有问答题目出现的时间点，点一下跳到该时间；顶部是"下一题还有多久"
 *   课时  —— 全部课时列表，已刷过的打勾，点一下直接切过去
 *   设置  —— 所有功能开关和参数，改完立即生效并自动保存
 *
 * 控制台命令：
 *   __helperDiagnose()   复制诊断信息（接口原始返回、课时原始数据等）
 *   __helperTestPush()   立刻发一条手机测试推送
 *   __helperSkipDone()   立刻检查一次"已刷过就跳下一条"
 *   __helperNext()       立刻执行一次"下一节"
 *
 * 注意：本脚本已合并原来三个脚本的功能，请把 quiz-schedule / quiz-push-notify /
 *      auto-next-section 这三个脚本停用，否则会出现重复提醒和重复打勾。
 * =============================================================
 */

/* ============================ 默认配置 ============================ */
const DEFAULTS = {
  /* 自动连播 */
  autoNext: true,           // 本节播完自动下一节
  autoNextDelay: 5,         // 播完后等几秒再跳
  blockWhileQuestion: true, // 有题目弹出时不跳
  kickStart: true,          // 新视频没自动播就帮它播
  abortOnActivity: false,   // 倒计时期间你动键鼠就取消本次跳转

  /* 已刷过的课时 */
  skipDone: true,           // 打开已刷过的课时时自动跳到下一条未刷过的
  doneTail: 60,             // 进度距结尾不足这么多秒就算已刷过
  doneMinSeconds: 600,      // 时长读不到时的退路阈值
  markDone: true,           // 在站点目录里打「✓ 已刷过」
  maxSkips: 10,             // 单页最多自动跳过几次
  skipWaitMs: 3000,         // 页面加载后等多久再判断跳过
  skipDelayMs: 1500,        // 决定要跳之后等多久切

  /* 弹题提醒 —— 电脑 */
  desktopNotify: true,      // 系统桌面通知
  pagePopup: true,          // 页面内提醒卡片
  titleFlash: true,         // 标签页标题闪烁
  focusWindow: false,       // 把浏览器窗口拉到最前（较粗暴）
  popupPos: 'top',          // 提醒卡片位置 top | top-right | center

  /* 弹题提醒 —— 手机 */
  pushEnabled: true,
  pushService: 'bark',      // bark | serverchan | pushplus | custom
  pushKey: '',
  pushCustomUrl: '',
  barkHost: 'https://api.day.app',
  barkSound: 'alarm',

  /* 面板 */
  showPanel: true,
  maxQLines: 3,             // 题干最多显示几行，0 = 不限
  panelX: null,             // 面板位置（拖动后自动保存）
  panelY: null,
  apiBase: 'https://v.polyv.net',
};

const LS_CFG = 'course-helper:cfg:v1';
const LS_CACHE = 'course-helper:qcache:v1';
const LS_VIDMAP = 'course-helper:vidmap:v1'; // 课时ID → 保利威 vid 的映射缓存

(function () {
  'use strict';

  /* ============================ 基础 ============================ */
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const IS_TOP = (() => { try { return window.top === window.self; } catch (e) { return false; } })();
  const q = (sel) => document.querySelector(sel);
  const log = (...a) => { if (cfg.log !== false) console.log('%c[看课助手]', 'color:#0a8;font-weight:700', ...a); };
  const warn = (...a) => console.warn('%c[看课助手]', 'color:#c60;font-weight:700', ...a);

  function loadCfg() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_CFG) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  let cfg = loadCfg();
  let saveTimer = null;
  function saveCfg() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (e) { /* 忽略 */ }
    }, 200);
  }
  const mmss = (s) => {
    if (s === null || s === undefined || isNaN(Number(s))) return '--:--';
    const n = Math.max(0, Math.floor(Number(s)));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(n % 60).padStart(2, '0');
  };
  const isVisible = (el) => {
    if (!el) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0;
  };

  /* 时间解析：保利威返回的是 "0:11:51" 这种 H:MM:SS 字符串，也有可能是秒数 */
  function parseTimeValue(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const s = String(v).trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    if (s.indexOf(':') !== -1) {
      const parts = s.split(':').map((x) => Number(String(x).trim()));
      if (!parts.length || parts.some((n) => !isFinite(n))) return null;
      let sec = 0;
      for (const p of parts) sec = sec * 60 + p;
      return sec;
    }
    return null;
  }
  const TIME_KEYS = ['showTime', 'showtime', 'show_time', 'nShowTime', 'strShowTime', 'timePoint', 'nTimePoint', 'nTime', 'playTime', 'startTime', 'nStartTime', 'time'];
  function parseTrio(obj) {
    const h = obj.hours !== undefined ? obj.hours : obj.hour;
    const m = obj.minutes !== undefined ? obj.minutes : obj.minute;
    const s = obj.seconds !== undefined ? obj.seconds : obj.second;
    if (h === undefined && m === undefined && s === undefined) return null;
    const H = Number(h) || 0, M = Number(m) || 0, S = Number(s) || 0;
    if (!isFinite(H) || !isFinite(M) || !isFinite(S)) return null;
    return H * 3600 + M * 60 + S;
  }
  function pickTime(obj, depth) {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of TIME_KEYS) {
      const n = parseTimeValue(obj[k]);
      if (n !== null) return n;
    }
    const trio = parseTrio(obj);
    if (trio !== null) return trio;
    if ((depth || 0) < 2) {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const n = pickTime(v, (depth || 0) + 1);
          if (n !== null) return n;
        }
      }
    }
    return null;
  }
  function nowTime() {
    try {
      if (W.player && typeof W.player.j2s_getCurrentTime === 'function') {
        const t = Number(W.player.j2s_getCurrentTime());
        if (isFinite(t)) return t;
      }
    } catch (e) { /* 忽略 */ }
    const v = document.querySelector('video, audio');
    return v && isFinite(v.currentTime) ? v.currentTime : null;
  }
  function videoDuration() {
    const v = document.querySelector('video, audio');
    return v && isFinite(v.duration) && v.duration > 0 ? v.duration : null;
  }
  function seekTo(sec) {
    try {
      if (typeof W.seek === 'function') { W.seek(sec); return true; }
      if (W.player && typeof W.player.j2s_seekVideo === 'function') { W.player.j2s_seekVideo(sec); return true; }
    } catch (e) { log('跳转失败：', e.message); }
    return false;
  }

  /* 网络：优先 GM_xmlhttpRequest（沙箱里最稳），没有就退回脚本标签 JSONP */
  function httpGet(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url, timeout: timeoutMs || 15000,
          onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status))),
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('超时')),
        });
        return;
      }
      const cb = '__helperJp_' + Math.random().toString(36).slice(2);
      const s = document.createElement('script');
      let done = false;
      const cleanup = () => { try { delete W[cb]; } catch (e) { W[cb] = undefined; } if (s.parentNode) s.parentNode.removeChild(s); };
      const timer = setTimeout(() => { if (!done) { done = true; cleanup(); reject(new Error('超时')); } }, timeoutMs || 15000);
      W[cb] = (data) => { if (done) return; done = true; clearTimeout(timer); cleanup(); resolve(JSON.stringify(data)); };
      s.onerror = () => { if (done) return; done = true; clearTimeout(timer); cleanup(); reject(new Error('加载失败')); };
      s.src = url + (url.indexOf('?') === -1 ? '?' : '&') + 'callback=' + cb;
      (document.head || document.documentElement).appendChild(s);
    });
  }
  function parseJsonp(text) {
    const s = String(text || '').trim();
    if (!s) throw new Error('空响应');
    const i = s.indexOf('('), j = s.lastIndexOf(')');
    const body = (i !== -1 && j > i) ? s.slice(i + 1, j) : s;
    return JSON.parse(body);
  }

  /* ============================ 运行状态 ============================ */
  const state = {
    vid: null,
    list: [],          // [{sec, examId, question}]
    src: '',           // 接口 / 缓存 / 边看边记
    sections: [],      // [{li, a, coursewareId, viewSecond, dur, name, done}]
    quizRows: [],
    secRows: [],
    rawExam: null,
    rawSections: null,
    firstKeys: null,
    skipKey: null,
    skipCount: 0,
    alertShown: false,
  };

  /* ============================ 面板 ============================ */
  let ui = null; // {host, root, els...}
  function panelHTML() {
    const clamp = Number(cfg.maxQLines) > 0
      ? '.qtext{display:-webkit-box;-webkit-line-clamp:' + Number(cfg.maxQLines) + ';-webkit-box-orient:vertical;overflow:hidden}'
      : '.qtext{white-space:normal}';
    return '' +
      '<style>' +
      ':host{all:initial}' +
      '.wrap{font:12px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:#e9eaee;background:rgba(20,22,28,.96);' +
      'border:1px solid rgba(255,255,255,.16);border-radius:10px;width:352px;max-height:78vh;display:flex;flex-direction:column;' +
      'box-shadow:0 10px 30px rgba(0,0,0,.5);user-select:none;overflow:hidden}' +
      '.hd{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:grab;touch-action:none;' +
      'background:rgba(255,255,255,.05);border-bottom:1px solid rgba(255,255,255,.1)}' +
      '.hd:active{cursor:grabbing}' +
      '.hd b{font-size:13px;color:#7fd7a5;white-space:nowrap}' +
      '.hd .st{margin-left:auto;font-size:11px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.tabs{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.08)}' +
      '.tabs button{flex:1}' +
      'button{all:unset;box-sizing:border-box;display:inline-block;cursor:pointer;text-align:center;padding:3px 8px;' +
      'border-radius:6px;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.13);color:#e9eaee}' +
      'button:hover{background:rgba(255,255,255,.2)}' +
      '.tabs button.on{background:#2f6fed;border-color:#2f6fed}' +
      '.body{overflow:auto;flex:1}' +
      '.panel-tab[hidden]{display:none}' +
      '.status{padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.07);opacity:.9}' +
      '.status .hi{color:#ff8a8a;font-weight:700}' +
      '.qest{color:#ffcf6b;margin-top:3px;word-break:break-word}' +
      '.row{padding:5px 10px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);display:flex;gap:8px}' +
      '.row:hover{background:rgba(255,255,255,.08)}' +
      '.row .t{color:#8ab4ff;font-weight:700;font-variant-numeric:tabular-nums;flex:0 0 auto}' +
      '.row .qtext{opacity:.88;word-break:break-word;min-width:0}' +
      '.row.done{opacity:.45}' +
      '.row.next{background:rgba(255,92,92,.16)}' +
      '.row.next .t{color:#ff8a8a}' +
      '.row.ok .t{color:#5bd07a}' +
      '.row.cur{background:rgba(47,111,237,.22)}' +
      '.srow{display:block;padding:6px 10px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.06)}' +
      '.srow:hover{background:rgba(255,255,255,.08)}' +
      '.srow .l1{display:flex;gap:6px;align-items:baseline}' +
      '.srow .mark{flex:0 0 auto;font-weight:700;color:#8ab4ff}' +
      '.srow.ok .mark{color:#5bd07a}' +
      '.srow .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.srow .pct{flex:0 0 auto;font-weight:700;font-variant-numeric:tabular-nums;color:#ffb020}' +
      '.srow.ok .pct{color:#5bd07a}' +
      '.srow .l2{display:flex;gap:6px;align-items:center;margin-top:3px}' +
      '.srow .bar{flex:1;height:5px;border-radius:3px;background:rgba(255,255,255,.15);overflow:hidden}' +
      '.srow .bar i{display:block;height:100%;width:0;background:#2f6fed;border-radius:3px;transition:width .3s}' +
      '.srow.ok .bar i{background:#3fa34d}' +
      '.srow.cur .bar i{background:#ffb020}' +
      '.srow.cur{background:rgba(47,111,237,.18)}' +
      '.srow.todo{box-shadow:inset 3px 0 0 #ffb020}' +
      '.srow .tm{flex:0 0 auto;font-size:11px;opacity:.6;font-variant-numeric:tabular-nums}' +
      '.sumline{padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.07)}' +
      '.sumline button{margin-top:5px;width:100%;text-align:left;padding:4px 8px;border-radius:6px;' +
      'background:rgba(255,176,32,.16);border:1px solid rgba(255,176,32,.4)}' +
      '.sumline button:hover{background:rgba(255,176,32,.28)}' +
      '.empty{padding:8px 10px;opacity:.65}' +
      '.bad{color:#ffb4b4}' +
      '.grp{padding:8px 10px 2px;color:#ffcf6b;font-weight:700}' +
      '.item{display:flex;align-items:center;gap:8px;padding:4px 10px}' +
      '.item label{flex:1;cursor:pointer}' +
      '.item input[type=checkbox]{accent-color:#2f6fed;margin:0;cursor:pointer}' +
      '.item input[type=number],.item input[type=text],.item select{all:unset;box-sizing:border-box;width:120px;' +
      'padding:2px 6px;border-radius:5px;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.18);color:#e9eaee;font:inherit}' +
      '.item input[type=number]{width:64px;text-align:center}' +
      '.item .unit{opacity:.6}' +
      '.item .act{width:auto;padding:2px 10px}' +
      '.ft{padding:6px 10px;border-top:1px solid rgba(255,255,255,.08);font-size:11px;opacity:.6}' +
      clamp +
      '</style>' +
      '<div class="wrap">' +
      '  <div class="hd"><b>看课助手</b><span class="st">加载中…</span><button class="min">–</button></div>' +
      '  <div class="tabs"><button data-tab="quiz" class="on">题目</button>' +
      '    <button data-tab="sections">课时</button><button data-tab="settings">设置</button></div>' +
      '  <div class="body">' +
      '    <div class="panel-tab" data-tab="quiz"><div class="status qstatus"><span class="qsum"></span><div class="qest"></div></div><div class="qlist"></div></div>' +
      '    <div class="panel-tab" data-tab="sections" hidden><div class="status sumline sstatus"></div><div class="slist"></div></div>' +
      '    <div class="panel-tab" data-tab="settings" hidden><div class="status polinfo"></div><div class="settings"></div></div>' +
      '  </div>' +
      '  <div class="ft">拖动标题栏可移动 · 设置自动保存</div>' +
      '</div>' +
      '<button class="mini" hidden>看课助手</button>';
  }

  const SETTINGS = [
    { group: '自动连播', items: [
      { k: 'autoNext', t: 'bool', label: '本节播完自动进入下一节' },
      { k: 'autoNextDelay', t: 'num', label: '播完后等待', unit: '秒' },
      { k: 'blockWhileQuestion', t: 'bool', label: '有题目弹出时不跳' },
      { k: 'kickStart', t: 'bool', label: '新视频没自动播就帮它播' },
      { k: 'abortOnActivity', t: 'bool', label: '倒计时中动键鼠就取消' },
    ] },
    { group: '已刷过的课时', items: [
      { k: 'skipDone', t: 'bool', label: '已刷过的课时自动跳到下一条' },
      { k: 'doneTail', t: 'num', label: '距结尾不足这么多秒算已刷过', unit: '秒' },
      { k: 'doneMinSeconds', t: 'num', label: '时长读不到时的阈值', unit: '秒' },
      { k: 'markDone', t: 'bool', label: '在站点目录里打「✓ 已刷过」' },
      { k: 'maxSkips', t: 'num', label: '单页最多自动跳过', unit: '次' },
    ] },
    { group: '弹题提醒 · 电脑', items: [
      { k: 'desktopNotify', t: 'bool', label: '系统桌面通知' },
      { k: 'pagePopup', t: 'bool', label: '页面内提醒卡片（带题干和选项）' },
      { k: 'titleFlash', t: 'bool', label: '标签页标题闪烁' },
      { k: 'focusWindow', t: 'bool', label: '把浏览器窗口拉到最前' },
      { k: 'popupPos', t: 'sel', label: '提醒卡片位置', opts: [['top', '顶部居中'], ['top-right', '右上角'], ['center', '屏幕正中']] },
    ] },
    { group: '弹题提醒 · 手机', items: [
      { k: 'pushEnabled', t: 'bool', label: '推送到手机' },
      { k: 'pushService', t: 'sel', label: '服务', opts: [['bark', 'Bark'], ['serverchan', 'Server酱³'], ['pushplus', 'pushplus'], ['custom', '自定义 URL']] },
      { k: 'pushKey', t: 'text', label: 'Key / Token / SendKey' },
      { k: 'pushCustomUrl', t: 'text', label: '自定义 URL（{title} {body}）' },
      { k: '_test', t: 'btn', label: '发送一条测试推送' },
    ] },
    { group: '面板与显示', items: [
      { k: 'showPanel', t: 'bool', label: '显示这个面板' },
      { k: 'maxQLines', t: 'num', label: '题干最多显示几行（0=不限）' },
      { k: 'apiBase', t: 'text', label: '题目接口域名' },
    ] },
  ];

  function buildSettings(container) {
    container.innerHTML = '';
    SETTINGS.forEach((g) => {
      const gt = document.createElement('div');
      gt.className = 'grp';
      gt.textContent = g.group;
      container.appendChild(gt);
      g.items.forEach((it) => {
        const row = document.createElement('div');
        row.className = 'item';
        if (it.t === 'bool') {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!cfg[it.k];
          cb.dataset.cfg = it.k;
          cb.dataset.type = 'bool';
          const lb = document.createElement('label');
          lb.textContent = it.label;
          lb.addEventListener('click', () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });
          row.appendChild(cb);
          row.appendChild(lb);
        } else {
          const lb = document.createElement('label');
          lb.textContent = it.label;
          row.appendChild(lb);
          if (it.t === 'num') {
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.value = cfg[it.k];
            inp.dataset.cfg = it.k;
            inp.dataset.type = 'num';
            row.appendChild(inp);
            if (it.unit) { const u = document.createElement('span'); u.className = 'unit'; u.textContent = it.unit; row.appendChild(u); }
          } else if (it.t === 'text') {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.value = cfg[it.k] || '';
            inp.dataset.cfg = it.k;
            inp.dataset.type = 'text';
            row.appendChild(inp);
          } else if (it.t === 'sel') {
            const sel = document.createElement('select');
            sel.dataset.cfg = it.k;
            sel.dataset.type = 'text';
            it.opts.forEach(([v, t]) => {
              const o = document.createElement('option');
              o.value = v; o.textContent = t;
              if (String(cfg[it.k]) === v) o.selected = true;
              sel.appendChild(o);
            });
            row.appendChild(sel);
          } else if (it.t === 'btn') {
            const b = document.createElement('button');
            b.className = 'act';
            b.textContent = '发送';
            b.addEventListener('click', () => {
              sendPush('看课助手 · 测试推送', '如果你在手机上看到这条，说明推送配置成功。\n时间：' + new Date().toLocaleString(), (ok, info) => {
                b.textContent = ok ? '已发送' : '失败';
                setTimeout(() => { b.textContent = '发送'; }, 1800);
                log(ok ? '测试推送成功' : '测试推送失败', info || '');
              });
            });
            row.appendChild(b);
          }
        }
        container.appendChild(row);
      });
    });
  }

  function ensurePanel() {
    if (ui || !document.body) return ui;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = panelHTML();
    document.body.appendChild(host);

    const els = {
      wrap: root.querySelector('.wrap'),
      st: root.querySelector('.st'),
      mini: root.querySelector('.mini'),
      qstatus: root.querySelector('.qstatus'),
      qsum: root.querySelector('.qsum'),
      qest: root.querySelector('.qest'),
      qlist: root.querySelector('.qlist'),
      sstatus: root.querySelector('.sstatus'),
      slist: root.querySelector('.slist'),
      settings: root.querySelector('.settings'),
      tabs: Array.from(root.querySelectorAll('.tabs button')),
      tabPanes: Array.from(root.querySelectorAll('.panel-tab')),
    };
    ui = { host, root, els };

    // 位置
    const x = cfg.panelX === null ? 14 : cfg.panelX;
    const y = cfg.panelY === null ? 64 : cfg.panelY;
    movePanel(x, y, true);

    // 标签页
    els.tabs.forEach((b) => b.addEventListener('click', () => {
      els.tabs.forEach((x2) => x2.classList.toggle('on', x2 === b));
      els.tabPanes.forEach((p) => { p.hidden = p.dataset.tab !== b.dataset.tab; });
      renderAll();
    }));

    // 收起 / 展开
    root.querySelector('.min').addEventListener('click', () => { cfg.showPanel = false; saveCfg(); applyPanelVisibility(); });
    els.mini.addEventListener('click', () => { cfg.showPanel = true; saveCfg(); applyPanelVisibility(); });

    // 拖动
    const hd = root.querySelector('.hd');
    let drag = null;
    hd.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || (ev.target.closest && ev.target.closest('button'))) return;
      const r = host.getBoundingClientRect();
      drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
      try { hd.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
      ev.preventDefault();
    });
    hd.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      movePanel(ev.clientX - drag.dx, ev.clientY - drag.dy, false);
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      const r = host.getBoundingClientRect();
      cfg.panelX = Math.round(r.left);
      cfg.panelY = Math.round(r.top);
      saveCfg();
    };
    hd.addEventListener('pointerup', endDrag);
    hd.addEventListener('pointercancel', endDrag);

    // 设置项绑定（事件委托）
    els.settings.addEventListener('change', onSettingChange);
    els.settings.addEventListener('input', (ev) => {
      const el = ev.target;
      if (el.dataset && el.dataset.type === 'text') onSettingChange(ev); // 文本框边打边存
    });

    buildSettings(els.settings);
    applyPanelVisibility();
    renderAll();
    return ui;
  }

  function onSettingChange(ev) {
    const el = ev.target;
    const key = el.dataset && el.dataset.cfg;
    if (!key) return;
    const t = el.dataset.type;
    if (t === 'bool') cfg[key] = !!el.checked;
    else if (t === 'num') cfg[key] = Number(el.value);
    else cfg[key] = el.value;
    saveCfg();
    log('设置已更新：' + key + ' =', cfg[key]);
    applySettings();
  }

  function applySettings() {
    applyPanelVisibility();
    if (!cfg.titleFlash) flashTitle(false);
    if (!cfg.pagePopup) hideAlertCard();
    if (cfg.markDone) markDone(); else clearMarks();
    if (cfg.skipDone) skipDone();
    renderAll();
  }

  function applyPanelVisibility() {
    if (!ui) return;
    ui.els.wrap.style.display = cfg.showPanel ? '' : 'none';
    ui.els.mini.hidden = !!cfg.showPanel;
    if (cfg.showPanel) renderAll(); // 收起时不刷 DOM（省电），展开时补一次
  }

  function movePanel(x, y, silent) {
    if (!ui) return;
    const r = ui.host.getBoundingClientRect();
    const w = r.width || 352, h = r.height || 200;
    const nx = Math.min(Math.max(4, x), Math.max(4, window.innerWidth - w - 4));
    const ny = Math.min(Math.max(4, y), Math.max(4, window.innerHeight - h - 4));
    ui.host.style.left = nx + 'px';
    ui.host.style.top = ny + 'px';
    if (!silent) { cfg.panelX = nx; cfg.panelY = ny; }
  }

  /* ============================ 瞬态提示条（右下角） ============================ */
  let toastHost = null, toastRoot = null, toastTimer = null;
  function toast(html, buttons, autoHideMs) {
    if (!document.body) return;
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
      toastRoot = toastHost.attachShadow({ mode: 'open' });
      toastRoot.innerHTML =
        '<style>:host{all:initial}.b{font:13px/1.55 system-ui,"Microsoft YaHei",sans-serif;color:#e9eaee;' +
        'background:rgba(20,22,28,.96);border:1px solid rgba(255,255,255,.16);border-left:4px solid #2f6fed;' +
        'border-radius:10px;padding:10px 12px;max-width:320px;box-shadow:0 8px 26px rgba(0,0,0,.45)}' +
        '.b .bs{margin-top:8px;display:flex;gap:6px}button{all:unset;display:inline-block;cursor:pointer;padding:3px 10px;' +
        'border-radius:6px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15)}' +
        'button:hover{background:rgba(255,255,255,.22)}</style><div class="b"><div class="m"></div><div class="bs"></div></div>';
      document.body.appendChild(toastHost);
    }
    toastRoot.querySelector('.m').innerHTML = html;
    const bs = toastRoot.querySelector('.bs');
    bs.innerHTML = '';
    (buttons || []).forEach((b) => {
      const el = document.createElement('button');
      el.textContent = b.label;
      el.addEventListener('click', b.onClick);
      bs.appendChild(el);
    });
    toastHost.style.display = '';
    if (toastTimer) clearTimeout(toastTimer);
    if (autoHideMs) toastTimer = setTimeout(hideToast, autoHideMs);
  }
  function hideToast() { if (toastHost) toastHost.style.display = 'none'; }

  /* ============================ 功能 1：题目时间表 ============================ */
  function readQCache() {
    try { return JSON.parse(localStorage.getItem(LS_CACHE) || '{}'); } catch (e) { return {}; }
  }
  function writeQCache(o) {
    try { localStorage.setItem(LS_CACHE, JSON.stringify(o)); } catch (e) { /* 忽略 */ }
  }
  function getVid() {
    try {
      const g = W.g_video;
      if (g && g.strVideoInfo) {
        const info = JSON.parse(g.strVideoInfo);
        if (info && (info.strVid || info.vid)) return info.strVid || info.vid;
      }
    } catch (e) { /* 忽略 */ }
    try { if (W.player && W.player.vid) return W.player.vid; } catch (e) { /* 忽略 */ }
    return null;
  }
  function asArray(res) {
    if (Array.isArray(res)) return res;
    if (!res || typeof res !== 'object') return null;
    for (const k of ['data', 'list', 'cdoList', 'examList', 'result', 'rows', 'items', 'exams']) {
      const v = res[k];
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object') { const inner = asArray(v); if (inner) return inner; }
    }
    return null;
  }
  function normalizeExams(res) {
    state.rawExam = res;
    const arr = asArray(res);
    if (!arr) { warn('题目接口返回里找不到数组：', res); return []; }
    if (arr[0]) {
      state.firstKeys = Object.keys(arr[0]);
      log('题目接口第一条的字段名：', state.firstKeys);
    }
    const out = arr.map((it) => ({
      sec: pickTime(it),
      examId: it.examId || it.id || it.lId || '',
      question: String(it.question || it.title || it.strQuestion || it.content || '').trim(),
    })).filter((it) => it.question || it.examId);
    out.sort((a, b) => (a.sec === null ? 1e9 : a.sec) - (b.sec === null ? 1e9 : b.sec));
    if (out.length && out.every((it) => it.sec === null)) warn('题目时间没解析出来，请把 __helperDiagnose() 的内容发我');
    return out;
  }
  /* ---------------- 时钟预测：几点几分遇到下一道题 ---------------- */
  function fmtClock(ms) {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const today = new Date();
    return (d.toDateString() === today.toDateString() ? '' : '次日 ') + hh + ':' + mm;
  }
  function readVidMap() {
    try { return JSON.parse(localStorage.getItem(LS_VIDMAP) || '{}'); } catch (e) { return {}; }
  }
  function writeVidMap(o) {
    try { localStorage.setItem(LS_VIDMAP, JSON.stringify(o)); } catch (e) { /* 忽略 */ }
  }
  // 站点的 Myhttp 就是 jQuery 表单 POST，这里用 fetch 复刻（同源、自动带 cookie）
  async function siteApiPost(url, data) {
    const body = Object.keys(data).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(data[k])).join('&');
    const res = await fetch(location.origin + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  // 课时ID → 保利威 vid（题目接口要的是 vid，不是站点的 lVideoId）
  async function resolveVid(siteVideoId) {
    const map = readVidMap();
    if (map[siteVideoId]) return map[siteVideoId];
    const r = await siteApiPost('/course/rest/v1/course/getVideoInfoById', { lId: siteVideoId });
    if (!r || !r.return || r.return.nCode !== 0) throw new Error('getVideoInfoById 返回异常');
    const info = JSON.parse(r.response.cdoItem.strVideoInfo);
    const vid = info.strVid || info.vid;
    if (!vid) throw new Error('解析不出 strVid');
    map[siteVideoId] = vid;
    writeVidMap(map);
    log('课时 ' + siteVideoId + ' 的 vid = ' + vid);
    return vid;
  }
  // 带缓存的题目列表（当前视频和"下一节"共用）
  async function getExamList(vid) {
    const cache = readQCache();
    const hit = cache[vid];
    if (hit && Array.isArray(hit.list) && Date.now() - hit.at < 12 * 3600 * 1000) return { list: hit.list, src: '缓存' };
    const text = await httpGet(cfg.apiBase + '/uc/exam/get?vid=' + encodeURIComponent(vid));
    const list = normalizeExams(parseJsonp(text));
    if (list.length) { cache[vid] = { at: Date.now(), list }; writeQCache(cache); }
    return { list, src: '接口' };
  }
  function firstQuizAhead() {
    const cur = nowTime();
    if (cur === null) return null;
    const arr = (state.list || [])
      .filter((x) => x.sec !== null && x.sec > cur + 2)
      .sort((a, b) => a.sec - b.sec);
    return arr[0] || null;
  }
  async function estimateNext() {
    const v = document.querySelector('video, audio');
    const cur = nowTime();
    const dur = videoDuration();
    const rate = (v && Number(v.playbackRate)) || 1;
    const playing = v ? !v.paused : false;
    const mk = (o) => Object.assign({ playing, rate, computedAt: Date.now() }, o);

    // ① 当前视频里还有没播到的题 → 直接算它
    const ahead = firstQuizAhead();
    if (ahead) {
      const remain = Math.max(0, (ahead.sec - cur) / rate);
      return mk({
        kind: 'quiz',
        remain,
        targetAt: Date.now() + remain * 1000,
        label: '本题第 ' + (state.list.indexOf(ahead) + 1) + ' 题',
        question: ahead.question,
      });
    }

    // ② 当前视频的题目都播完了 → 找下一个"未刷过"的课时，算它的第一道题
    const list = sections();
    const curId = currentCoursewareId();
    const i = list.findIndex((s) => s.coursewareId === curId);
    const after = (i >= 0 ? list.slice(i + 1) : list).filter((s) => !s.done);
    if (!after.length) return mk({ kind: 'none', remain: null, targetAt: null, label: '后面没有未刷过的课时了' });
    const next = after[0];
    let remain = 5; // 切换 + 加载播放器，先按 5 秒估
    if (dur && cur !== null) remain += Math.max(0, (dur - cur) / rate);
    let q = null;
    try {
      const vid = await resolveVid(next.videoId);
      const got = await getExamList(vid);
      const arr = (got.list || []).filter((x) => x.sec !== null).sort((a, b) => a.sec - b.sec);
      q = arr[0] || null;
    } catch (e) {
      log('取下一节题目失败：' + e.message);
    }
    if (q) remain += q.sec / rate;
    return mk({
      kind: q ? 'nextQuiz' : 'nextSection',
      remain,
      targetAt: Date.now() + remain * 1000,
      label: '第 ' + (next.idx + 1) + ' 节「' + next.name + '」' + (q ? '第 1 题' : '开始'),
      question: q ? q.question : '',
    });
  }
  async function refreshEstimate(force) {
    if (state.estBusy) return;
    if (!force && Date.now() - (state.estAt || 0) < 4000) return;
    state.estBusy = true;
    state.estAt = Date.now();
    try { state.est = await estimateNext(); } catch (e) { log('预测失败：' + e.message); }
    state.estBusy = false;
    renderEstimate();
  }
  function renderEstimate() {
    if (!ui || !ui.els.qest) return;
    const el = ui.els.qest;
    const e = state.est;
    if (!e) { el.textContent = '正在估算下一道题的时间…'; return; }
    if (e.kind === 'none') { el.textContent = '⏰ ' + e.label; return; }
    const left = Math.max(0, Math.round((e.targetAt - Date.now()) / 1000));
    el.textContent = '⏰ 预计 ' + fmtClock(e.targetAt) + ' 遇到 ' + e.label +
      '（还有 ' + mmss(left) + '）' + (e.playing ? '' : ' · 已暂停，按继续播放算');
    el.style.color = e.kind === 'quiz' ? '#ffcf6b' : '#9ecbff';
  }

  async function loadExams(vid) {
    const cache = readQCache();
    const hit = cache[vid];
    if (hit && Array.isArray(hit.list) && Date.now() - hit.at < 12 * 3600 * 1000) {
      state.list = hit.list;
      state.src = '缓存';
      renderQuizzes();
      return;
    }
    try {
      const url = cfg.apiBase + '/uc/exam/get?vid=' + encodeURIComponent(vid);
      log('请求题目列表：' + url);
      const text = await httpGet(url);
      const res = parseJsonp(text);
      if (cfg.log !== false) log('题目接口原始返回：', res);
      state.list = normalizeExams(res);
      state.src = '接口';
      if (state.list.length) {
        cache[vid] = { at: Date.now(), list: state.list };
        writeQCache(cache);
      }
      log('拿到 ' + state.list.length + ' 道题');
    } catch (e) {
      log('题目接口失败：' + e.message + '（改为边看边记）');
      state.list = (cache[vid] && cache[vid].list) || [];
      state.src = '边看边记';
    }
    renderQuizzes();
  }
  function recordQuiz(vid, item) {
    if (!vid) return;
    const t = nowTime();
    const sec = t !== null ? Math.round(t) : pickTime(item);
    if (sec === null) return;
    const cache = readQCache();
    const rec = cache[vid] || { at: Date.now(), list: [] };
    const examId = (item && (item.examId || item.id)) || '';
    const question = String((item && (item.question || item.title)) || '').trim();
    if (examId && rec.list.some((x) => x.examId === examId)) return;
    rec.list.push({ sec, examId, question });
    rec.list.sort((a, b) => (a.sec === null ? 1e9 : a.sec) - (b.sec === null ? 1e9 : b.sec));
    rec.at = Date.now();
    cache[vid] = rec;
    writeQCache(cache);
    state.list = rec.list;
    state.src = '边看边记';
    renderQuizzes();
    log('记录到一道题：' + mmss(sec) + ' ' + question.slice(0, 30));
  }

  /* ============================ 播放器策略（只读） ============================ */
  // 播放器里 playbackRateInit() 会算一个上限 r = Math.max(param.maxPlaybackRateLimit,
  // param.speed ? param.speed[0] : 1)，每次 ratechange 时如果 playbackRate > r，
  // 就触发 #025（maxPlaybackRateLimitError）→ serverError → 站点 s2j_onPlayerError
  // → recordtime2.js 的 saveErrorInfo() 把 "#025" 上报到 /rest/v1/coursestudy/savePlayerError。
  // 另外这段代码还会检查 HTMLMediaElement.prototype.playbackRate 的 getter 是否原生：
  // 只要有人改写它（伪装倍速），同样触发 #025。
  function policyInfo() {
    const info = { limit: null, limitRaw: undefined, speedList: null, rate: null, spStat: null, over: false, supported: false };
    try {
      const v = document.querySelector('video, audio');
      if (v) info.rate = Number(v.playbackRate);
      const p = W.player;
      if (p && p.param) {
        info.supported = true;
        info.limitRaw = p.param.maxPlaybackRateLimit;
        info.speedList = Array.isArray(p.param.speed) ? p.param.speed : null;
        const n = Number(info.limitRaw);
        const base = info.speedList && info.speedList.length ? Number(info.speedList[0]) || 1 : 1;
        const r = Math.max(isFinite(n) ? n : NaN, base);
        info.limit = isFinite(r) ? r : null; // NaN 表示播放器实际不拦（数值比较永远为假）
      }
      if (p && p.hashFunctionMap) info.spStat = !!p.hashFunctionMap.speedStatisticsEnabled;
    } catch (e) { /* 忽略 */ }
    info.over = info.limit !== null && info.rate !== null && info.rate > info.limit + 1e-6;
    return info;
  }
  function refreshPolicy() {
    if (!ui) return;
    const p = policyInfo();
    const el = ui.els.polinfo;
    if (!el) return;
    let txt = '播放器倍速上限：' + (p.limit === null ? '未设置（客户端不拦）' : p.limit + '×');
    if (p.rate !== null) txt += ' · 当前倍速 ' + p.rate + '×';
    txt += ' · 倍速上报统计：' + (p.spStat === null ? '读不到' : (p.spStat ? '已开启（倍速会发给保利威）' : '关闭'));
    el.textContent = txt + (p.over ? ' ⚠ 已超限，会触发 #025 异常并被上报' : '');
    el.style.color = p.over ? '#ffb4b4' : '';
    if (p.over) el.textContent = txt + ' ⚠ 已超限，会触发 #025 异常并被上报给学校';
  }

  function renderQuizzes() {
    if (!ui) return;
    const box = ui.els.qlist;
    const list = state.list || [];
    box.innerHTML = '';
    state.quizRows = [];
    if (ui.els.qsum) ui.els.qsum.textContent = list.length ? '共 ' + list.length + ' 题 · 来源：' + state.src : (state.src ? '来源：' + state.src : '正在获取题目…');
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = '这个视频没有取到题目时间。可能是没配问答，或者接口结构变了——用 __helperDiagnose() 把信息发我。';
      box.appendChild(d);
      return;
    }
    if (list.every((it) => it.sec === null)) {
      const d = document.createElement('div');
      d.className = 'empty bad';
      d.textContent = '⚠ 时间字段没解析出来（都显示 --:--）。用 __helperDiagnose() 把原始数据发我。';
      box.appendChild(d);
    }
    const cur = nowTime();
    list.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (it.sec === null ? '' : (cur !== null && it.sec < cur - 2 ? ' done' : ''));
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = mmss(it.sec);
      const txt = document.createElement('span');
      txt.className = 'qtext';
      txt.textContent = (i + 1) + '. ' + (it.question || '(无题干)');
      row.appendChild(t);
      row.appendChild(txt);
      row.title = it.question || '';
      if (it.sec !== null) row.addEventListener('click', () => { if (seekTo(it.sec)) log('已跳到 ' + mmss(it.sec)); });
      box.appendChild(row);
      state.quizRows.push({ el: row, sec: it.sec });
    });
  }

  function tickQuiz() {
    if (!ui) return;
    const cur = nowTime();
    let next = null;
    state.quizRows.forEach((r) => {
      if (r.sec === null) return;
      r.el.classList.remove('next');
      if (cur !== null) r.el.classList.toggle('done', r.sec < cur - 2);
      if (!next && cur !== null && r.sec > cur) next = r;
    });
    if (next) next.el.classList.add('next');
    const dur = videoDuration();
    const prog = cur !== null && dur ? mmss(cur) + ' / ' + mmss(dur) : (cur !== null ? mmss(cur) : '--');
    let line = '进度 ' + prog;
    if (next) line += ' · 下一题 ' + mmss(next.sec) + '（还有 ' + mmss(Math.max(0, next.sec - cur)) + '）';
    else if (state.quizRows.length) line += ' · 题目都播过了';
    ui.els.st.textContent = line;
  }

  /* ============================ 功能 2：弹题提醒 ============================ */
  function toArrayOfChoices(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; } }
    return v && typeof v === 'object' ? [v] : [];
  }
  function choiceText(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return String(v.answer || v.text || v.content || v.label || v.title || '');
    return String(v);
  }
  function extractQuiz(data) {
    let d = data;
    if (Array.isArray(d)) d = d[0] || {};
    if (d && d.data && (d.data.question || d.data.choices)) d = d.data;
    if (d && d.question && typeof d.question === 'object') d = d.question;
    d = d || {};
    return {
      title: String(d.question || d.title || d.name || d.content || '').trim(),
      list: toArrayOfChoices(d.choices || d.options || d.answers || []).map(choiceText).map((s) => s.trim()).filter(Boolean),
      examId: d.examId || d.id || '',
    };
  }
  let quizCount = 0;
  function buildQuizMessage(ex) {
    quizCount += 1;
    const t = nowTime();
    const lines = ['第 ' + quizCount + ' 题' + (t !== null ? ' · 视频 ' + mmss(t) : ''), ''];
    if (ex.title) lines.push('题干：' + ex.title);
    if (ex.list.length) {
      lines.push('');
      ex.list.forEach((c, i) => lines.push('  ' + (i + 1) + '. ' + c.replace(/\s+/g, ' ')));
    }
    lines.push('', '（提交答案后视频才会继续播放）');
    let body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (body.length > 900) body = body.slice(0, 888) + '…(已截断)';
    return { title: '【看课提醒】视频弹出题目，请作答', body };
  }

  /* 手机推送 */
  function buildPushRequest(title, body, forceGet) {
    const enc = encodeURIComponent;
    const key = String(cfg.pushKey || '').trim();
    const S = cfg.pushService;
    if (!key && S !== 'custom') throw new Error('还没填推送 Key');
    if (S === 'bark') {
      const host = String(cfg.barkHost || 'https://api.day.app').replace(/\/+$/, '');
      if (forceGet) return { url: host + '/' + enc(key) + '/' + enc(title) + '/' + enc(body), method: 'GET' };
      const payload = { device_key: key, title, body };
      if (cfg.barkSound) payload.sound = cfg.barkSound;
      payload.group = '看课提醒';
      return { url: host + '/push', method: 'POST', headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(payload) };
    }
    if (S === 'serverchan') {
      const m = key.match(/^sctp(\d+)t/i);
      const send = m
        ? 'https://' + m[1] + '.push.ft07.com/send/' + key + '.send'
        : 'https://sctapi.ftqq.com/' + key + '.send';
      const params = 'title=' + enc(title) + '&desp=' + enc(body);
      if (forceGet) return { url: send + '?' + params, method: 'GET' };
      return { url: send, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: params };
    }
    if (S === 'pushplus') {
      if (forceGet) return { url: 'https://www.pushplus.plus/send?token=' + enc(key) + '&title=' + enc(title) + '&content=' + enc(body) + '&template=txt', method: 'GET' };
      return { url: 'https://www.pushplus.plus/send', method: 'POST', headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ token: key, title, content: body, template: 'txt' }) };
    }
    let u = String(cfg.pushCustomUrl || '');
    if (!u) throw new Error('自定义 URL 是空的');
    if (u.indexOf('{title}') !== -1 || u.indexOf('{body}') !== -1) {
      u = u.replace(/\{title\}/g, enc(title)).replace(/\{body\}/g, enc(body));
      return { url: u, method: 'POST' };
    }
    return { url: u, method: 'POST', headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ title, body }) };
  }
  function sendPush(title, body, done) {
    if (!cfg.pushEnabled) { if (done) done(false, '推送已关闭'); return; }
    let req;
    try { req = buildPushRequest(title, body, false); }
    catch (e) {
      try { req = buildPushRequest(title, body, true); }
      catch (e2) { log('推送请求构造失败：' + e2.message); if (done) done(false, e2.message); return; }
    }
    const finish = (ok, info) => {
      log(ok ? '手机推送已发出 ✓' : '手机推送失败 ✗', info || '');
      if (!ok && !state.alertShown) localAlert(title, body);
      if (done) done(ok, info);
    };
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: req.method, url: req.url, headers: req.headers || {}, data: req.data || undefined, timeout: 15000,
        onload: (r) => {
          const txt = String(r.responseText || '').slice(0, 200);
          const ok = r.status >= 200 && r.status < 300 && !/"code"\s*:\s*(4|5)\d\d/.test(txt);
          finish(ok, 'HTTP ' + r.status + ' ' + txt);
        },
        onerror: (e) => finish(false, '网络错误 ' + ((e && e.error) || '')),
        ontimeout: () => finish(false, '超时'),
      });
      return;
    }
    try {
      const getReq = buildPushRequest(title, body, true);
      fetch(getReq.url, { method: 'GET', mode: 'no-cors', credentials: 'omit' })
        .then(() => finish(true, '(no-cors)')).catch((e) => finish(false, e.message));
    } catch (e) { finish(false, e.message); }
  }

  /* 电脑提醒：桌面通知 + 页面卡片 + 标题闪烁 */
  let titleTimer = null, originalTitle = null;
  let alertCard = null, alertRoot = null, alertOpenAt = 0;
  function ensureNotifyPermission() {
    try {
      if (typeof Notification !== 'function') return;
      if (Notification.permission !== 'default') return;
      Notification.requestPermission().catch(() => {});
    } catch (e) { /* 忽略 */ }
  }
  function desktopNotify(title, body) {
    if (!cfg.desktopNotify) return;
    try {
      if (typeof Notification !== 'function') { log('这个环境不支持桌面通知'); return; }
      if (Notification.permission === 'denied') { log('桌面通知被拒绝，可在地址栏左侧重新允许'); return; }
      const fire = () => {
        try {
          const n = new Notification(title, { body, tag: 'course-helper', requireInteraction: true });
          n.onclick = () => { try { window.focus(); n.close(); } catch (e) { /* 忽略 */ } };
          log('已弹出桌面通知');
        } catch (e) { log('桌面通知失败：' + e.message); }
      };
      if (Notification.permission === 'granted') fire();
      else Notification.requestPermission().then((p) => { if (p === 'granted') fire(); });
    } catch (e) { /* 忽略 */ }
  }
  function flashTitle(on) {
    if (!cfg.titleFlash) { on = false; }
    try {
      if (on) {
        if (originalTitle === null) originalTitle = document.title.replace(/^【请答题】/, '');
        if (titleTimer) return;
        let flip = true;
        titleTimer = setInterval(() => {
          document.title = flip ? '【请答题】' + originalTitle : originalTitle;
          flip = !flip;
        }, 900);
        document.title = '【请答题】' + originalTitle;
      } else {
        if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
        if (originalTitle !== null) { document.title = originalTitle; originalTitle = null; }
      }
    } catch (e) { /* 忽略 */ }
  }
  function showAlertCard(title, body) {
    if (!cfg.pagePopup) return;
    try {
      if (!alertCard) {
        const pos = cfg.popupPos === 'center' ? 'top:50%;left:50%;transform:translate(-50%,-50%);'
          : cfg.popupPos === 'top-right' ? 'top:14px;right:14px;'
          : 'top:14px;left:50%;transform:translateX(-50%);';
        alertCard = document.createElement('div');
        alertCard.style.cssText = 'position:fixed;' + pos + 'z-index:2147483646;';
        alertRoot = alertCard.attachShadow({ mode: 'open' });
        alertRoot.innerHTML =
          '<style>:host{all:initial}.c{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:#fff;background:rgba(18,20,26,.97);' +
          'border:1px solid rgba(255,255,255,.18);border-left:4px solid #ff5c5c;border-radius:10px;padding:12px 14px;max-width:420px;' +
          'box-shadow:0 10px 30px rgba(0,0,0,.5)}.t{font-weight:700;color:#ff9a9a;margin-bottom:6px}' +
          '.b{white-space:pre-wrap;word-break:break-word;max-height:45vh;overflow:auto}' +
          'button{all:unset;display:inline-block;cursor:pointer;margin-top:8px;padding:4px 12px;border-radius:6px;' +
          'background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.16)}button:hover{background:rgba(255,255,255,.22)}' +
          '</style><div class="c"><div class="t"></div><div class="b"></div><button class="ok">知道了</button></div>';
        alertRoot.querySelector('.ok').addEventListener('click', hideAlertCard);
        (document.body || document.documentElement).appendChild(alertCard);
      }
      alertRoot.querySelector('.t').textContent = title;
      alertRoot.querySelector('.b').textContent = body;
      alertCard.style.display = '';
      alertOpenAt = Date.now();
    } catch (e) { log('提醒卡片失败：' + e.message); }
  }
  function hideAlertCard() {
    if (alertCard) alertCard.style.display = 'none';
    flashTitle(false);
  }
  function localAlert(title, body) {
    state.alertShown = true;
    desktopNotify(title, body);
    showAlertCard(title, body);
    flashTitle(true);
    if (cfg.focusWindow) { try { window.focus(); } catch (e) { /* 忽略 */ } }
  }

  /* 弹题处理（去重） */
  const recent = new Map();
  let lastNotifyAt = 0;
  function shouldNotify(key) {
    const now = Date.now();
    for (const [k, t] of recent) if (now - t > 30000) recent.delete(k);
    if (now - lastNotifyAt < 15000) { log('静默窗口内（同一题的第二次触发），跳过'); return false; }
    if (recent.has(key)) { log('这道题已经提醒过了'); return false; }
    recent.set(key, now);
    lastNotifyAt = now;
    return true;
  }
  function handleQuizPopup(data) {
    const ex = extractQuiz(data);
    log('收到弹题，原始数据：', data);
    const key = String(ex.examId || ex.title || 'unknown').slice(0, 200);
    if (!shouldNotify(key)) return;
    const msg = buildQuizMessage(ex);
    log('提醒内容：\n' + msg.title + '\n' + msg.body);
    state.alertShown = false;
    localAlert(msg.title, msg.body);
    sendPush(msg.title, msg.body);
  }

  /* ============================ 功能 3：自动连播 + 跳过已刷过 ============================ */
  let arming = null, armTimer = null, armCountdown = null;
  const doneSections = new Set();

  function sectionKey() {
    const id = currentCoursewareId();
    return id ? 'cw' + id : 'x';
  }
  function parseArgs(str) {
    const m = /showVideo\s*\(\s*this\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(str || '');
    if (!m) return null;
    return { coursewareId: m[1], videoId: m[2], viewSecond: Number(m[3]), type: Number(m[4]) };
  }
  function parseDuration(text) {
    const m = String(text || '').match(/(\d+)\s*:\s*(\d+)(?:\s*:\s*(\d+))?/);
    if (!m) return null;
    return m[3] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
  }
  function isDone(viewSecond, dur) {
    return (dur && dur > 0) ? viewSecond >= dur - Number(cfg.doneTail) : viewSecond >= Number(cfg.doneMinSeconds);
  }
  function sections() {
    const out = [];
    document.querySelectorAll('.chapter_list > li').forEach((li, i) => {
      const a = li.querySelector('a[onclick*="showVideo"]');
      const args = parseArgs(a && a.getAttribute('onclick'));
      if (!args) return;
      const durEl = li.querySelector('.chapter_subtit_four');
      const nameEl = li.querySelector('.chapter_subtit_third');
      const dur = parseDuration(durEl && durEl.textContent);
      out.push(Object.assign({
        li, a, idx: i, dur,
        name: ((nameEl && nameEl.textContent) || ('第 ' + (i + 1) + ' 节')).trim(),
      }, args, { done: isDone(args.viewSecond, dur) }));
    });
    return out;
  }
  function currentCoursewareId() {
    try {
      const v = new URL(location.href).searchParams.get('lCoursewareId');
      if (v) return v;
    } catch (e) { /* 忽略 */ }
    const li = document.querySelector('.chapter_list li.active');
    const a = li && li.querySelector('a[onclick*="showVideo"]');
    const args = parseArgs(a && a.getAttribute('onclick'));
    return args ? args.coursewareId : null;
  }
  function markDone() {
    if (!cfg.markDone) return;
    sections().forEach((s) => {
      const tag = s.li.querySelector('.helper-done-tag');
      if (s.done) {
        if (!tag) {
          const span = document.createElement('span');
          span.className = 'helper-done-tag';
          span.textContent = '✓ 已刷过';
          span.style.cssText = 'color:#3fa34d;font-size:12px;margin-left:6px;white-space:nowrap';
          s.li.appendChild(span);
        }
      } else if (tag) tag.remove();
    });
  }
  function clearMarks() {
    document.querySelectorAll('.helper-done-tag').forEach((el) => el.remove());
  }
  function jumpToSection(target) {
    if (!target || !target.a) return;
    try { target.a.click(); log('已切到「' + target.name + '」'); } catch (e) { log('切换失败：' + e.message); }
  }
  function skipDone(manual) {
    if ((!cfg.skipDone || !cfg.autoNext) && !manual) return;
    const list = sections();
    if (!list.length) return;
    state.sections = list;
    const curId = currentCoursewareId();
    let curIdx = list.findIndex((s) => s.coursewareId === curId);
    if (curIdx < 0) curIdx = list.findIndex((s) => s.li.classList.contains('active'));
    if (curIdx < 0) return;
    const cur = list[curIdx];
    if (!cur.done) return;
    const key = cur.coursewareId + '|' + list.length;
    if (!manual && state.skipKey === key) return;
    let target = null;
    for (let i = curIdx + 1; i < list.length; i++) if (!list[i].done) { target = list[i]; break; }
    if (!target) for (let i = 0; i < curIdx; i++) if (!list[i].done) { target = list[i]; break; }
    if (!target) {
      log('所有课时都刷过了');
      toast('<b>全部课时都已刷过</b><br>没找到没刷过的课时', [{ label: '知道了', onClick: hideToast }]);
      return;
    }
    if (state.skipCount >= Number(cfg.maxSkips)) { log('自动跳过已达上限'); return; }
    state.skipKey = key;
    state.skipCount += 1;
    const durTxt = cur.dur ? mmss(cur.dur) : '未知';
    log('当前课时已刷过（进度 ' + mmss(cur.viewSecond) + ' / ' + durTxt + '），准备跳到「' + target.name + '」');
    toast('<b>这一节已刷过</b><br>进度 ' + mmss(cur.viewSecond) + ' / ' + durTxt + '<br>即将切到：' + target.name,
      [{ label: '立即切换', onClick: () => { hideToast(); jumpToSection(target); } },
       { label: '取消', onClick: () => { hideToast(); log('已取消本次跳过'); } }]);
    setTimeout(() => { hideToast(); jumpToSection(target); }, Number(cfg.skipDelayMs));
  }
  function secSignature(list) {
    return list.map((s) => [s.coursewareId, s.done ? 1 : 0, s.viewSecond, s.dur === null ? 'x' : s.dur, s.name].join(':')).join('|');
  }
  // 一节看了百分之多少：服务端存的进度为准，当前这一节再和播放器实时位置取较大的那个
  function progressOf(s, curId) {
    let view = s.viewSecond || 0;
    const isCur = s.coursewareId === curId;
    if (isCur) {
      const live = nowTime();
      if (live !== null && live > view) view = live;
    }
    if (s.dur && s.dur > 0) return { pct: Math.max(0, Math.min(100, Math.round(view / s.dur * 100))), view, dur: s.dur, live: isCur };
    return { pct: s.done ? 100 : null, view, dur: null, live: isCur };
  }
  function renderSections(force) {
    if (!ui) return;
    const list = sections();
    state.sections = list;
    const sig = secSignature(list);
    // 内容没变就不重建，免得每秒重建打断你的点击
    if (!force && sig === state.secSig && ui.els.slist.childElementCount) return;
    state.secSig = sig;
    const curId = currentCoursewareId();
    const doneN = list.filter((s) => s.done).length;

    // 总进度按各节时长加权
    let sumDur = 0, sumView = 0, durKnown = 0;
    list.forEach((s) => {
      const p = progressOf(s, curId);
      if (p.dur) { durKnown += 1; sumDur += p.dur; sumView += Math.min(p.view, p.dur); }
    });
    const totalPct = sumDur > 0 ? Math.round((sumView / sumDur) * 100) : null;
    const firstTodo = list.find((s) => !s.done);

    // 汇总 + 一键继续
    const st = ui.els.sstatus;
    st.innerHTML = '';
    const sum = document.createElement('div');
    sum.textContent = list.length
      ? ('共 ' + list.length + ' 节 · 已刷过 ' + doneN + ' 节' +
        (totalPct !== null ? ' · 总进度 ' + totalPct + '%' : '') +
        (durKnown < list.length ? '（' + (list.length - durKnown) + ' 节时长读不到，未计入）' : ''))
      : '还没有拿到课时列表';
    st.appendChild(sum);
    if (list.length) {
      const b = document.createElement('button');
      if (firstTodo) {
        const p = progressOf(firstTodo, curId);
        b.textContent = '继续刷：第 ' + (firstTodo.idx + 1) + ' 节 ' + firstTodo.name + (p.pct !== null ? '（已看 ' + p.pct + '%）' : '') + ' →';
        b.title = '点击切到这一节';
        b.addEventListener('click', () => jumpToSection(firstTodo));
      } else {
        b.textContent = '✓ 全部课时都刷完了';
        b.addEventListener('click', hideToast);
      }
      st.appendChild(b);
    }

    const box = ui.els.slist;
    box.innerHTML = '';
    state.secRows = [];
    list.forEach((s) => {
      const p = progressOf(s, curId);
      const row = document.createElement('div');
      row.className = 'srow' + (s.done ? ' ok' : '') + (s.coursewareId === curId ? ' cur' : '') +
        (firstTodo && s.coursewareId === firstTodo.coursewareId ? ' todo' : '');
      const l1 = document.createElement('div');
      l1.className = 'l1';
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = s.done ? '✓' : '·';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = (s.idx + 1) + ' ' + s.name;
      const pct = document.createElement('span');
      pct.className = 'pct';
      pct.textContent = p.pct === null ? '--' : p.pct + '%';
      l1.appendChild(mark);
      l1.appendChild(name);
      l1.appendChild(pct);
      const l2 = document.createElement('div');
      l2.className = 'l2';
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = (p.pct === null ? 0 : p.pct) + '%';
      bar.appendChild(fill);
      const tm = document.createElement('span');
      tm.className = 'tm';
      tm.textContent = mmss(p.view) + (p.dur ? ' / ' + mmss(p.dur) : ' / 时长未知');
      l2.appendChild(bar);
      l2.appendChild(tm);
      row.appendChild(l1);
      row.appendChild(l2);
      row.title = '进度 ' + mmss(p.view) + (p.dur ? ' / ' + mmss(p.dur) : '') + '，点击切到这一节';
      row.addEventListener('click', () => jumpToSection(s));
      box.appendChild(row);
      state.secRows.push({ coursewareId: s.coursewareId, view: s.viewSecond || 0, dur: s.dur, pct, fill, tm });
    });
  }
  // 当前这一节的进度条实时涨（原地改，不重建 DOM，免得打断点击）
  function tickSections() {
    if (!ui || !state.secRows.length) return;
    const curId = currentCoursewareId();
    const live = nowTime();
    if (live === null) return;
    state.secRows.forEach((r) => {
      if (r.coursewareId !== curId || !r.dur) return;
      const view = Math.max(r.view, live);
      const pct = Math.max(0, Math.min(100, Math.round((view / r.dur) * 100)));
      r.pct.textContent = pct + '%';
      r.fill.style.width = pct + '%';
      r.tm.textContent = mmss(view) + ' / ' + mmss(r.dur);
    });
  }

  /* 自动下一节 */
  function scheduleNext(reason) {
    if (!cfg.autoNext || arming) return;
    const key = sectionKey();
    if (doneSections.has(key)) return;
    const btn = q('#btn3');
    if (!isVisible(btn)) { log('没有"下一节"按钮（可能是最后一节）'); doneSections.add(key); return; }
    const nextName = (q('#commentDiv') && q('#commentDiv').textContent.trim()) || '';
    const delay = Number(cfg.autoNextDelay) * 1000;
    let left = Math.ceil(delay / 1000);
    arming = reason;
    const render = () => toast('<b>本节已播完</b><br>' + (nextName ? '下一节：' + nextName + '<br>' : '') + left + ' 秒后自动进入下一节',
      [{ label: '立即进入', onClick: () => { clearArm(); fireNext('手动立即'); } },
       { label: '取消这次', onClick: () => { clearArm(); doneSections.add(key); hideToast(); log('已取消本次自动跳转'); } }]);
    render();
    if (armCountdown) clearInterval(armCountdown);
    armCountdown = setInterval(() => { left -= 1; if (left > 0) render(); }, 1000);
    armTimer = setTimeout(() => { clearArm(); fireNext('倒计时结束'); }, delay);
    log('本节播完（' + reason + '），' + (delay / 1000) + ' 秒后进下一节');
  }
  function clearArm() {
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    if (armCountdown) { clearInterval(armCountdown); armCountdown = null; }
    arming = null;
  }
  function fireNext(reason) {
    const key = sectionKey();
    if (cfg.blockWhileQuestion && q('.pv-ask-modal-wrap')) {
      log('有题目弹层，先不跳');
      toast('<b>有题目没答</b><br>答完再自动进入下一节', [{ label: '知道了', onClick: hideToast }]);
      return;
    }
    const btn = q('#btn3');
    if (!isVisible(btn)) { doneSections.add(key); hideToast(); return; }
    doneSections.add(key);
    hideToast();
    log('点击下一节（' + reason + '）');
    btn.click();
    if (cfg.kickStart) kickStartPlayback();
  }
  function kickStartPlayback() {
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      const v = q('video');
      if (v && !v.paused) { clearInterval(t); return; }
      if (v && v.paused && !v.ended && !(cfg.blockWhileQuestion && q('.pv-ask-modal-wrap'))) {
        const p = v.play();
        if (p && p.catch) p.catch((e) => log('播放被拦下：' + e.message));
      }
      if (tries >= 8) clearInterval(t);
    }, 1500);
  }

  /* ============================ 启动 ============================ */
  function bootVid() {
    const vid = getVid();
    if (!vid) return false;
    if (vid === state.vid) return true;
    state.vid = vid;
    state.list = [];
    state.rawExam = null;
    state.est = null;
    state.estAt = 0;
    log('视频 vid = ' + vid);
    // 等题目列表回来再算"几点遇到下一题"，否则会误判成本节没有题目
    loadExams(vid).then(() => refreshEstimate(true)).catch(() => {});
    return true;
  }

  function bindHooks() {
    // 弹题事件（链式：不影响站点或其它脚本已挂的处理函数）
    if (!bindHooks.quiz) {
      const prev = W.onQuestionPopUp;
      let siteHandler = null;
      const handler = function (data) {
        try { if (typeof prev === 'function') prev.apply(W, arguments); } catch (e) { /* 忽略 */ }
        try { if (typeof siteHandler === 'function') siteHandler.apply(W, arguments); } catch (e) { /* 忽略 */ }
        try { handleQuizPopup(data); } catch (e) { log('弹题处理出错：', e); }
        try {
          let d = data;
          if (Array.isArray(d)) d = d[0] || {};
          if (d && d.data) d = d.data;
          recordQuiz(state.vid, d);
        } catch (e) { /* 忽略 */ }
      };
      try {
        Object.defineProperty(W, 'onQuestionPopUp', {
          configurable: true,
          get() { return handler; },
          set(fn) { siteHandler = fn; },
        });
        bindHooks.quiz = true;
        log('已挂载 window.onQuestionPopUp');
      } catch (e) {
        try { W.onQuestionPopUp = handler; bindHooks.quiz = true; } catch (e2) { /* 等下次 */ }
      }
    }
    // 播放结束回调
    if (!bindHooks.playOver) {
      const prev = W.s2j_onPlayOver;
      let siteHandler = null;
      const handler = function () {
        try { if (typeof prev === 'function') prev.apply(W, arguments); } catch (e) { /* 忽略 */ }
        try { if (typeof siteHandler === 'function') siteHandler.apply(W, arguments); } catch (e) { /* 忽略 */ }
        setTimeout(() => scheduleNext('播放结束回调'), 300);
      };
      try {
        Object.defineProperty(W, 's2j_onPlayOver', {
          configurable: true,
          get() { return handler; },
          set(fn) { siteHandler = fn; },
        });
        bindHooks.playOver = true;
        log('已挂载 window.s2j_onPlayOver');
      } catch (e) {
        try { W.s2j_onPlayOver = handler; bindHooks.playOver = true; } catch (e2) { /* 等下次 */ }
      }
    }
    // 课时列表原始数据探针
    if (!bindHooks.videoList && typeof W.showNewCourseVideoList === 'function') {
      const orig = W.showNewCourseVideoList;
      W.showNewCourseVideoList = function (cdoList) {
        try {
          if (cdoList && cdoList[0]) {
            state.rawSections = cdoList[0];
            log('课时列表字段名：', Object.keys(cdoList[0]));
            log('课时列表第一条原始数据：', cdoList[0]);
          }
        } catch (e) { /* 忽略 */ }
        const r = orig.apply(this, arguments);
        setTimeout(() => { markDone(); renderSections(); }, 50);
        return r;
      };
      bindHooks.videoList = true;
      log('已挂载 showNewCourseVideoList');
    }
  }

  function renderAll() {
    if (!ui) return;
    renderQuizzes();
    renderSections();
    tickQuiz();
    refreshPolicy();
    renderEstimate();
    refreshEstimate(true);
  }

  function start() {
    ensurePanel();
    if (!ui) { setTimeout(start, 300); return; }
    renderAll();

    // 视频 id 轮询（换课时会变）
    let tries = 0;
    const waitVid = setInterval(() => {
      tries += 1;
      if (bootVid() || tries > 60) clearInterval(waitVid);
    }, 500);
    setInterval(bootVid, 2000);

    // 弹题 / 播放结束 / 课时列表 钩子
    bindHooks();
    [0, 500, 1500, 3000, 6000].forEach((ms) => setTimeout(bindHooks, ms));

    // 自动下一节：三个信号
    setInterval(() => {
      if (arming) return;
      const overlay = isVisible(q('#replay'));
      if (!overlay) { doneSections.delete(sectionKey()); return; }
      if (isVisible(q('#btn3')) && !doneSections.has(sectionKey())) scheduleNext('轮询到遮罩');
    }, 1000);
    document.addEventListener('ended', (e) => {
      if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) setTimeout(() => scheduleNext('ended 事件'), 500);
    }, true);
    if (cfg.abortOnActivity) {
      ['mousemove', 'mousedown', 'keydown', 'wheel'].forEach((ev) => {
        window.addEventListener(ev, () => {
          if (!armTimer) return;
          clearArm();
          doneSections.add(sectionKey());
          hideToast();
          log('检测到你回来了，取消本次自动跳转');
        }, true);
      });
    }

    // 已刷过跳过 + 目录打勾 + 面板刷新
    setTimeout(() => { bindHooks(); skipDone(); }, Number(cfg.skipWaitMs));
    setInterval(() => { bindHooks(); if (cfg.markDone) markDone(); }, 2000);
    setInterval(() => skipDone(), 4000);
    // 面板收起后就不刷新 DOM 了（省电；脚本本身开销相比视频解码可以忽略）
    setInterval(() => { if (ui && cfg.showPanel) { renderSections(); tickQuiz(); tickSections(); refreshPolicy(); renderEstimate(); refreshEstimate(); } }, 1000);

    // 题目答完自动收起提醒卡片
    setInterval(() => {
      if (!alertCard || alertCard.style.display === 'none') return;
      if (Date.now() - alertOpenAt < 3000) return;
      if (!q('.pv-ask-modal-wrap')) { log('题目已答完，收起提醒'); hideAlertCard(); }
    }, 2000);

    // 通知权限
    ensureNotifyPermission();
    let asked = false;
    ['click', 'keydown'].forEach((ev) => window.addEventListener(ev, () => {
      if (asked) return;
      asked = true;
      ensureNotifyPermission();
    }, true));

    log('已启动 v2.0.0（面板见左上角）');
  }

  /* ============================ 控制台命令 ============================ */
  function diagnose() {
    const info = {
      页面: location.href,
      vid: state.vid,
      题目来源: state.src,
      题目第一条字段名: state.firstKeys,
      解析出的题目: state.list.map((it) => ({ 时间: mmss(it.sec), 秒: it.sec, 题干: it.question })),
      题目接口原始返回: state.rawExam,
      课时第一条原始数据: state.rawSections,
      课时解析结果: sections().map((s) => ({ 课时: s.name, 课件ID: s.coursewareId, 进度: s.viewSecond, 时长: s.dur, 已刷过: s.done })),
      播放器策略: policyInfo(),
      下一题预测: state.est,
      当前设置: cfg,
    };
    log('诊断信息：', info);
    try {
      navigator.clipboard.writeText(JSON.stringify(info, null, 2));
      toast('<b>诊断信息已复制</b><br>可以直接粘贴给我', [{ label: '知道了', onClick: hideToast }], 3000);
    } catch (e) {
      toast('<b>复制失败</b><br>请从控制台手动复制', [{ label: '知道了', onClick: hideToast }], 3000);
    }
    return info;
  }
  try {
    W.__helperDiagnose = diagnose;
    W.__helperTestPush = () => sendPush('看课助手 · 测试推送', '配置看起来没问题。');
    W.__helperSkipDone = () => { state.skipKey = null; state.skipCount = 0; skipDone(true); };
    W.__helperNext = () => fireNext('手动触发');
    W.__helperConfig = (patch) => { Object.assign(cfg, patch || {}); saveCfg(); applySettings(); return cfg; };
  } catch (e) { /* 忽略 */ }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
