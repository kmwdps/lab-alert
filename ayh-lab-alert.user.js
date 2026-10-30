// ==UserScript==
// @name         AYH Lab Result Alert
// @namespace    ayh-lab-alert
// @version      1.8
// @updateURL    https://raw.githubusercontent.com/kmwdps/lab-alert/main/ayh-lab-alert.user.js
// @downloadURL  https://raw.githubusercontent.com/kmwdps/lab-alert/main/ayh-lab-alert.user.js
// @description  เฝ้าดูผลแล็บวันนี้ตาม HN (สูงสุด 15) เช็คทุก 5 นาที แจ้งเตือนเมื่อแล็บออก
// @match        http://ayhlab.ayhosp.go.th/iReportAG/Home/Result*
// @match        https://ayhlab.ayhosp.go.th/iReportAG/Home/Result*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const MAX_HN = 15;
  const INTERVAL_MS = 5 * 60 * 1000;
  const LOAD_TIMEOUT = 30000;
  const CONTROL_TIMEOUT = 15000;
  const RESULT_TIMEOUT = 20000;
  const KEY = 'ayhLabAlert.v1';
  const LOGIN = 'LOGIN';
  const PAGE_URL = location.origin + '/iReportAG/Result/ResView/Search'; // หน้าค้นหาจริง (อยู่ใน iframe #FamSearch)
  const DATE_RE = /\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/;

  // ---------- sleep ผ่าน Worker (กัน Chrome หน่วง timer ตอนแท็บอยู่เบื้องหลัง) ----------
  let worker = null;
  let wid = 0;
  const waiters = new Map();
  try {
    const src = 'onmessage=function(e){setTimeout(function(){postMessage(e.data.id)},e.data.ms)}';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = (e) => {
      const w = waiters.get(e.data);
      if (w) { waiters.delete(e.data); w.res(); }
    };
    worker.onerror = () => {
      worker = null;
      for (const [id, w] of waiters) { waiters.delete(id); setTimeout(w.res, w.ms); }
    };
  } catch (e) { worker = null; }

  function sleep(ms) {
    return new Promise((res) => {
      if (worker) { const id = ++wid; waiters.set(id, { res, ms }); worker.postMessage({ id, ms }); }
      else setTimeout(res, ms);
    });
  }

  // ---------- state ----------
  function load() {
    try { return Object.assign({ patients: [], selector: '' }, JSON.parse(GM_getValue(KEY, '{}'))); }
    catch (e) { return { patients: [], selector: '' }; }
  }
  const state = load();
  const DEFAULT_IGNORE = [
    'Hemo C/S', 'Urine C/S', 'Sputum C/S', 'Gram Stain',
    'ABO Group (Gel Test)', 'Rh Group (Gel Test)', "Indirect Coombs' test (Gel Test)",
    'Hepatitis B Surface Antigen (HBsAg)', 'Hepatitis B Surface Antibody (Anti-HBs)',
    'Hepatitis C Virus Antibody (Anti-HCV)', 'HIV Ab (CMI)'
  ];
  if (!Array.isArray(state.ignore)) state.ignore = [];
  if ((state.ignoreVer || 0) < 2) {
    for (const k of DEFAULT_IGNORE) if (!state.ignore.some((x) => x.toLowerCase() === k.toLowerCase())) state.ignore.push(k);
    state.ignoreVer = 2;
    GM_setValue(KEY, JSON.stringify(state));
  }
  function isIgnored(name) {
    const t = (name || '').toLowerCase();
    return state.ignore.some((k) => k && t.includes(k.toLowerCase()));
  }
  // ตัด test ที่ไม่สนใจออกจากชื่อ; ถ้าเหลือ 0 = ข้ามทั้งใบ
  function keepTests(tests) {
    if (!tests) return tests;
    return tests.split(',').map((x) => x.trim()).filter((x) => x && !isIgnored(x)).join(', ');
  }
  function save() { GM_setValue(KEY, JSON.stringify(state)); }

  let running = false;
  let paused = false;
  let current = null;
  let nextAt = 0;
  let lastCycle = null;
  let loginWarned = false;
  let collapsed = false;

  // ---------- helpers ----------
  function txt(el) { return (el.innerText || el.textContent || '').replace(/[ \t ]+/g, ' '); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function hhmm(t) { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

  function isToday(text) {
    const re = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+\d{1,2}:\d{2}/g;
    const n = new Date();
    let m;
    while ((m = re.exec(text))) {
      const d = +m[1], mo = +m[2], y = +m[3];
      if (d === n.getDate() && mo === n.getMonth() + 1 && (y === n.getFullYear() || y === n.getFullYear() + 543)) return true;
    }
    return false;
  }

  function parseRgb(s) {
    const m = s && s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    if (p.length === 4 && p[3] === 0) return null;
    return p;
  }

  function colorKind(p) {
    if (!p) return null;
    const [r, g, b] = p;
    if (r >= 170 && g <= 90 && b <= 90) return 'pending'; // แดง = ยังไม่ออก
    if (b >= 170 && r <= 90 && g <= 180) return 'done';   // ฟ้า = ออกแล้ว
    return null;
  }

  function rowOf(el) {
    const tr = el.closest('tr');
    if (tr) return tr;
    let p = el.parentElement;
    for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
      if (DATE_RE.test(txt(p))) return p;
    }
    return null;
  }

  function findTests(row) {
    const cands = [row];
    let s = row.nextElementSibling;
    for (let i = 0; i < 3 && s; i++, s = s.nextElementSibling) {
      if (DATE_RE.test(txt(s))) break; // ถึงแถว request ถัดไปแล้ว
      cands.push(s);
    }
    for (const c of cands) {
      const t = txt(c);
      const i = t.indexOf('Test:');
      if (i >= 0) {
        let out = t.slice(i + 5).split('\n')[0];
        out = out.split(/\s(?:AT\s+RJ|Ward:)/)[0];
        return out.trim();
      }
    }
    return '';
  }

  function findName(row) {
    const tds = row.querySelectorAll ? [...row.querySelectorAll('td')] : [];
    const byCol = tds.find((td) => { const c = td.getAttribute('aria-describedby') || ''; return /name$/i.test(c) && !/hosp|ward|test|doc|sect|user/i.test(c); });
    if (byCol && txt(byCol).trim()) return txt(byCol).trim();
    const thai = tds.map((td) => txt(td).trim()).filter((t) => t && t.length < 60 && !/Test:|Ward:/.test(t) && /[\u0E00-\u0E7F]/.test(t));
    const pref = thai.find((t) => /^(นาย|นางสาว|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|เด็ก)/.test(t));
    return pref || thai[0] || '';
  }

  function parseRows(doc) {
    const win = doc.defaultView;
    const out = [];
    const used = new Set();
    if (!doc.body) return out;
    const els = doc.body.querySelectorAll('*');
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 5 || r.width > 30 || r.height < 5 || r.height > 30) continue;
      const kind = colorKind(parseRgb(win.getComputedStyle(el).backgroundColor));
      if (!kind) continue;
      const row = rowOf(el);
      if (!row || used.has(row)) continue;
      const rowText = txt(row);
      if (!DATE_RE.test(rowText)) continue;
      used.add(row);
      const time = (rowText.match(DATE_RE) || [''])[0];
      const reqNo = (rowText.match(/\b\d{8,}\b/) || [''])[0];
      const tests = findTests(row);
      out.push({ kind, row, rowText, reqNo, time, tests, name: findName(row), today: isToday(rowText), key: reqNo || (tests + '@' + time) });
    }
    return out;
  }

  // ---------- hidden iframe ----------
  // สร้าง iframe ใหม่ทุกครั้ง และอ่าน document สดทุกครั้ง (หน้าเว็บอาจ redirect/โหลดซ้ำหลัง onload)
  let frame = null;
  let navLog = [];
  function liveDoc(d) {
    try { return d && d.location && d.location.href !== 'about:blank' ? d : null; } catch (e) { return null; }
  }
  function fdoc() {
    let d = liveDoc(frame && frame.contentDocument);
    // ถ้าได้หน้า Home/Result ให้ลงไปใน iframe #FamSearch
    for (let i = 0; d && i < 3; i++) {
      const inner = d.querySelector('iframe#FamSearch');
      if (!inner) break;
      d = liveDoc(inner.contentDocument);
    }
    return d;
  }

  function loadFrame(url) {
    if (frame) frame.remove();
    navLog = [];
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    f.style.cssText = 'position:fixed;left:-20000px;top:0;width:1500px;height:1000px;border:0;';
    frame = f;
    return new Promise((res, rej) => {
      let done = false;
      f.addEventListener('load', () => {
        const d = fdoc();
        navLog.push(d ? d.location.href : '(null/blank)');
        if (!done && d) { done = true; res(); }
      });
      f.src = url;
      document.body.appendChild(f);
      sleep(LOAD_TIMEOUT).then(() => { if (!done) { done = true; rej(new Error('โหลดหน้าไม่ขึ้น')); } });
    });
  }

  function vis(el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }

  function elText(e) { return ((e.innerText || e.textContent || e.value || '') + '').replace(/\s+/g, ' ').trim(); }

  function findButton(doc) {
    const CLICK = 'button, input[type=button], input[type=submit], a, [role=button], .btn, .dx-button';
    const list = [];
    for (const e of doc.querySelectorAll(CLICK)) {
      if (vis(e) && /^search$/i.test(elText(e))) list.push(e);
    }
    // fallback: element ใดๆ ที่มีข้อความ "Search" แล้วไต่ขึ้นหาตัวที่คลิกได้
    if (!list.length) {
      for (const e of doc.querySelectorAll('span, div, i, b, label')) {
        if (e.children.length > 2 || !vis(e) || !/^search$/i.test(elText(e))) continue;
        list.push(e.closest(CLICK) || e);
      }
    }
    // ตัด tab "Search" ด้านบนออก: เลือกตัวที่อยู่ล่างสุดบนจอ
    list.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return list[0] || null;
  }

  function findControls() {
    const doc = fdoc();
    if (!doc || !doc.body) return { btn: null, input: null };
    if (doc.querySelector('input[type=password]')) throw new Error(LOGIN);
    const btn = findButton(doc);
    let input = state.selector ? doc.querySelector(state.selector) : null;
    if (!input) input = [...doc.querySelectorAll('input[placeholder]')].find((i) => vis(i) && /HN/i.test(i.placeholder)) || null;
    if (!input && btn) {
      const inputs = [...doc.querySelectorAll('input')].filter((i) =>
        vis(i) && !i.readOnly && ['text', 'search', 'tel', 'number'].includes(i.type) &&
        !/\d{1,2}\/\d{1,2}\/\d{4}/.test(i.value) &&
        (i.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING));
      input = inputs[inputs.length - 1] || null;
    }
    return { btn, input };
  }

  async function waitControls() {
    const t0 = Date.now();
    while (Date.now() - t0 < CONTROL_TIMEOUT) {
      const c = findControls();
      if (c.btn && c.input) return c;
      await sleep(300);
    }
    throw new Error('หาช่องค้นหา/ปุ่ม Search ไม่เจอ');
  }

  function setVal(input, v) {
    const w = input.ownerDocument.defaultView;
    const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, v);
    for (const t of ['input', 'change', 'keyup']) input.dispatchEvent(new w.Event(t, { bubbles: true }));
    // DevExtreme textbox (ถ้ามี)
    try {
      const $ = w.jQuery;
      const host = input.closest('.dx-textbox');
      if ($ && host && $(host).dxTextBox) $(host).dxTextBox('instance').option('value', v);
    } catch (e) { /* ignore */ }
  }

  function realClick(el) {
    const w = el.ownerDocument.defaultView;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: w, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    try { el.dispatchEvent(new w.PointerEvent('pointerdown', o)); } catch (e) { /* ignore */ }
    el.dispatchEvent(new w.MouseEvent('mousedown', o));
    try { el.dispatchEvent(new w.PointerEvent('pointerup', o)); } catch (e) { /* ignore */ }
    el.dispatchEvent(new w.MouseEvent('mouseup', o));
    el.click();
  }

  async function waitResults(hn) {
    const t0 = Date.now();
    let lastSig = null;
    let stable = 0;
    while (Date.now() - t0 < RESULT_TIMEOUT) {
      await sleep(700);
      const d = fdoc();
      const rows = d ? parseRows(d).filter((r) => r.rowText.includes(hn)) : [];
      const sig = rows.map((r) => r.key + r.kind).join('|');
      if (rows.length) {
        if (sig === lastSig) { if (++stable >= 2) return rows; }
        else { stable = 0; lastSig = sig; }
      }
    }
    const d = fdoc();
    return d ? parseRows(d).filter((r) => r.rowText.includes(hn)) : [];
  }

  async function searchHN(hn) {
    await loadFrame(PAGE_URL);
    const { btn, input } = await waitControls();
    setVal(input, hn);
    await sleep(300);
    realClick(btn);
    return { rows: await waitResults(hn) };
  }

  // ---------- notify ----------
  let actx = null;
  function initAudio() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch (e) { /* ignore */ }
  }
  function beep() {
    if (!actx) return;
    try {
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime;
      [0, 0.25, 0.5].forEach((d) => {
        const o = actx.createOscillator();
        const g = actx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.25, t + d);
        g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.2);
        o.connect(g).connect(actx.destination);
        o.start(t + d);
        o.stop(t + d + 0.2);
      });
    } catch (e) { /* ignore */ }
  }

  const baseTitle = document.title;
  let flashTimer = null;
  function flashTitle(msg) {
    if (flashTimer) clearInterval(flashTimer);
    let on = false;
    flashTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        clearInterval(flashTimer); flashTimer = null; document.title = baseTitle; return;
      }
      on = !on;
      document.title = on ? msg : baseTitle;
    }, 1000);
  }

  function sendNotif(title, text) {
    try { GM_notification({ title, text, silent: false, onclick: () => window.focus() }); } catch (e) { /* ignore */ }
    beep();
    flashTitle('🔔 ' + title);
  }

  function notifyDone(p, fresh, pendN) {
    const name = (fresh.find((r) => r.name) || {}).name || '';
    const title = 'Lab ออก HN ' + p.hn + (name ? ' ' + name : '');
    const body = fresh.map((r) => '✅ ' + (r.tests || r.reqNo)).join('\n') +
      (pendN ? '\nยังรออีก ' + pendN + ' รายการ' : '\nครบทุกรายการของวันนี้แล้ว');
    sendNotif(title, body);
  }

  // ---------- check loop ----------
  async function checkPatient(p) {
    const { rows } = await searchHN(p.hn);
    const today = rows.filter((r) => r.today).map((r) => Object.assign({}, r, { tests: keepTests(r.tests) }))
      .filter((r) => r.tests !== '' || !rows.find((x) => x.key === r.key).tests);
    const done = today.filter((r) => r.kind === 'done');
    const pend = today.filter((r) => r.kind === 'pending');
    const seen = new Set(p.seen || []);
    const fresh = done.filter((r) => !seen.has(r.key));
    if (p.baseline && fresh.length) notifyDone(p, fresh, pend.length);
    p.seen = done.map((r) => r.key);
    p.baseline = true;
    p.status = { done: done.map((r) => r.tests || r.reqNo), pending: pend.map((r) => r.tests || r.reqNo) };
    p.err = null;
    p.checkedAt = Date.now();
  }

  async function cycle() {
    if (running) return;
    running = true;
    render();
    for (const p of [...state.patients]) {
      if (!state.patients.includes(p)) continue;
      current = p.hn;
      render();
      try {
        await checkPatient(p);
        loginWarned = false;
      } catch (e) {
        if (e.message === LOGIN) {
          p.err = 'หลุดล็อกอิน';
          if (!loginWarned) { loginWarned = true; sendNotif('Lab Alert: หลุดล็อกอิน', 'กรุณาล็อกอิน iReportAG ใหม่'); }
          break;
        }
        p.err = e.message;
      }
      save();
      render();
    }
    current = null;
    running = false;
    lastCycle = Date.now();
    nextAt = Date.now() + INTERVAL_MS;
    render();
  }

  async function mainLoop() {
    for (;;) {
      const needFirst = state.patients.some((p) => !p.baseline && !p.err);
      if (!paused && state.patients.length && (Date.now() >= nextAt || needFirst)) await cycle();
      await sleep(3000);
      render();
    }
  }

  // ---------- diagnostics ----------
  async function diagnose() {
    const hn = (state.patients[0] && state.patients[0].hn) || prompt('ใส่ HN สำหรับทดสอบ');
    if (!hn) return;
    const info = { url: PAGE_URL, hn, when: new Date().toString() };
    try {
      await loadFrame(PAGE_URL);
      let c;
      try { c = await waitControls(); } catch (e) { info.ctrlErr = e.message; c = findControls(); }
      let doc = fdoc();
      info.navLog = navLog.slice();
      if (!doc) throw new Error('iframe ไม่มี document (nav: ' + navLog.join(' -> ') + ')');
      info.btn = c.btn ? c.btn.outerHTML.slice(0, 500) : null;
      info.input = c.input ? c.input.outerHTML.slice(0, 500) : null;
      info.frameUrl = doc.location.href;
      info.frameTitle = doc.title;
      info.searchCandidates = [...doc.querySelectorAll('*')].filter((e) => e.children.length < 4 && /search/i.test(elText(e)) && elText(e).length < 30).slice(0, 15).map((e) => e.outerHTML.slice(0, 300));
      info.inputs = [...doc.querySelectorAll('input')].slice(0, 25).map((e) => e.outerHTML.slice(0, 200));
      if (c.btn && c.input) {
        setVal(c.input, hn);
        await sleep(300);
        realClick(c.btn);
        await sleep(6000);
      }
      doc = fdoc() || doc;
      info.navLogAfter = navLog.slice();
      const rows = parseRows(doc);
      info.parsed = rows.slice(0, 8).map((r) => ({ kind: r.kind, reqNo: r.reqNo, time: r.time, today: r.today, tests: r.tests }));
      const tr = [...doc.querySelectorAll('tr')].find((t) => txt(t).includes(hn) && DATE_RE.test(txt(t)));
      if (tr) {
        let html = tr.outerHTML;
        let s = tr.nextElementSibling;
        for (let i = 0; i < 2 && s; i++, s = s.nextElementSibling) html += '\n' + s.outerHTML;
        info.sampleRow = html.slice(0, 6000);
      } else {
        info.noTr = true;
        info.bodySnippet = (doc.body ? doc.body.innerHTML : '').slice(0, 6000);
      }
    } catch (e) {
      info.error = e.message;
    }
    GM_setClipboard(JSON.stringify(info, null, 1));
    alert('คัดลอกข้อมูล Debug แล้ว — วางส่งให้ Claude ได้เลย');
  }

  // ---------- UI ----------
  const box = document.createElement('div');
  box.id = 'ayh-lab-alert';
  box.style.cssText = 'position:fixed;left:8px;bottom:8px;width:340px;max-height:62vh;overflow:auto;z-index:2147483000;' +
    'background:#fff;border:2px solid #d35400;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);' +
    'font:13px/1.4 Tahoma,sans-serif;color:#222;';
  document.body.appendChild(box);

  const css = document.createElement('style');
  css.textContent =
    '#ayh-lab-alert button{cursor:pointer;border:1px solid #bbb;background:#f5f5f5;border-radius:4px;padding:2px 7px;font:12px Tahoma,sans-serif}' +
    '#ayh-lab-alert input{border:1px solid #bbb;border-radius:4px;padding:3px 5px;font:13px Tahoma,sans-serif}' +
    '#ayh-lab-alert .hd{background:#d35400;color:#fff;padding:5px 8px;display:flex;align-items:center;gap:6px;position:sticky;top:0}' +
    '#ayh-lab-alert .hd b{flex:1}' +
    '#ayh-lab-alert .pt{border-top:1px solid #eee;padding:5px 8px}' +
    '#ayh-lab-alert .ok{color:#1565c0}#ayh-lab-alert .wait{color:#c62828}#ayh-lab-alert .err{color:#c62828;font-weight:bold}' +
    '#ayh-lab-alert .sm{font-size:12px}#ayh-lab-alert .cur{background:#fff8e1}';
  document.head.appendChild(css);

  function statusLine() {
    if (paused) return '⏸ หยุดชั่วคราว';
    if (running) return '🔄 กำลังเช็ค HN ' + (current || '');
    if (!state.patients.length) return 'ยังไม่มี HN';
    const left = Math.max(0, nextAt - Date.now());
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    return (lastCycle ? 'เช็คล่าสุด ' + hhmm(lastCycle) + ' · ' : '') + 'รอบถัดไป ' + m + ':' + String(s).padStart(2, '0');
  }

  function render() {
    if (collapsed) {
      box.innerHTML = '<div class="hd"><b>🔔 Lab Alert (' + state.patients.length + ')</b><button data-a="expand">▲</button></div>';
      return;
    }
    const focused = document.activeElement && box.contains(document.activeElement) ? document.activeElement.id : null;
    const hnVal = (box.querySelector('#ala-hn') || {}).value || '';

    let h = '<div class="hd"><b>🔔 Lab Alert (' + state.patients.length + '/' + MAX_HN + ')</b>' +
      '<button data-a="now" title="เช็คเดี๋ยวนี้">⟳</button>' +
      '<button data-a="pause" title="หยุด/เริ่ม">' + (paused ? '▶' : '⏸') + '</button>' +
      '<button data-a="collapse" title="ย่อ">▼</button></div>';
    h += '<div class="pt sm">' + esc(statusLine()) + '</div>';
    h += '<div class="pt" style="display:flex;gap:4px">' +
      '<input id="ala-hn" placeholder="HN" style="flex:1;min-width:0" value="' + esc(hnVal) + '">' +
      '<button data-a="add">เพิ่ม</button></div>';

    for (const p of state.patients) {
      const st = p.status;
      h += '<div class="pt' + (current === p.hn ? ' cur' : '') + '">';
      h += '<div style="display:flex;align-items:center;gap:6px"><b>' + esc(p.hn) + '</b>' +
        '<span style="flex:1"></span>';
      if (st) h += '<span class="ok">✅' + st.done.length + '</span> <span class="wait">⏳' + st.pending.length + '</span>';
      h += '<button data-a="del" data-hn="' + esc(p.hn) + '" title="เอาออก">✕</button></div>';
      if (p.err) h += '<div class="sm err">⚠ ' + esc(p.err) + '</div>';
      if (st) {
        if (!st.done.length && !st.pending.length) h += '<div class="sm" style="color:#888">ยังไม่มีแล็บของวันนี้</div>';
        if (st.done.length) h += '<div class="sm ok">' + st.done.map(esc).join(' · ') + '</div>';
        if (st.pending.length) h += '<div class="sm wait">รอ: ' + st.pending.map(esc).join(' · ') + '</div>';
        if (st.done.length && !st.pending.length) h += '<div class="sm ok"><b>ครบแล้ว</b></div>';
      } else if (!p.err) {
        h += '<div class="sm" style="color:#888">รอเช็ครอบแรก…</div>';
      }
      h += '</div>';
    }
    h += '<div class="pt sm" style="display:flex;align-items:center;gap:6px">' +
      '<span style="flex:1"></span>' +
      '<button data-a="ignore" title="test ที่ไม่ต้องเช็ค/เตือน">🔕 ' + state.ignore.length + '</button><button data-a="test" title="ทดสอบแจ้งเตือน">🔔 ทดสอบ</button><button data-a="debug">Debug</button></div>';
    box.innerHTML = h;

    if (focused) {
      const el = box.querySelector('#' + focused);
      if (el) { el.focus(); const v = el.value; el.value = ''; el.value = v; }
    }
  }

  function addHN() {
    const hnEl = box.querySelector('#ala-hn');
    const hn = (hnEl.value || '').replace(/[\s-]/g, '');
    if (!/^\d{3,12}$/.test(hn)) { alert('HN ต้องเป็นตัวเลข'); return; }
    if (state.patients.some((p) => p.hn === hn)) { alert('HN นี้มีอยู่แล้ว'); return; }
    if (state.patients.length >= MAX_HN) { alert('ใส่ได้สูงสุด ' + MAX_HN + ' HN'); return; }
    state.patients.push({ hn, seen: [], baseline: false, status: null, err: null, checkedAt: null });
    save();
    hnEl.value = '';
    render();
    box.querySelector('#ala-hn').focus();
  }

  box.addEventListener('click', (e) => {
    initAudio();
    const b = e.target.closest('button');
    if (!b) return;
    const a = b.getAttribute('data-a');
    if (a === 'add') addHN();
    else if (a === 'del') {
      const hn = b.getAttribute('data-hn');
      state.patients = state.patients.filter((p) => p.hn !== hn);
      save(); render();
    } else if (a === 'now') { nextAt = 0; for (const p of state.patients) if (p.err) p.err = null; render(); }
    else if (a === 'pause') { paused = !paused; render(); }
    else if (a === 'collapse') { collapsed = true; render(); }
    else if (a === 'expand') { collapsed = false; render(); }
    else if (a === 'debug') diagnose();
    else if (a === 'test') {
      // หน่วง 5 วิ ให้สลับไปแท็บอื่นก่อนได้
      b.textContent = '⏳ 5 วิ…';
      sleep(5000).then(() => {
        sendNotif('ทดสอบ Lab Alert', 'ถ้าเห็นข้อความนี้และได้ยินเสียง แปลว่าใช้งานได้ ✅');
        render();
      });
    }
    else if (a === 'ignore') {
      const v = prompt('ชื่อ test ที่ไม่ต้องเช็ค/เตือน (คั่นด้วย , )\nพิมพ์แค่บางส่วนของชื่อก็ได้ เช่น Hemo C/S, Urine', state.ignore.join(', '));
      if (v !== null) {
        state.ignore = v.split(',').map((x) => x.trim()).filter(Boolean);
        save();
        nextAt = 0;
        render();
      }
    }
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'ala-hn') addHN();
  });
  document.addEventListener('click', initAudio, { once: true });

  render();
  mainLoop();
})();
