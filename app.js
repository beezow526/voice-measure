// 画面・音声認識・読み上げ・保存・送信。記録の中身の処理は core.js（VoiceCore）。
(function () {
  'use strict';

  const C = window.VoiceCore;
  const $ = (id) => document.getElementById(id);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // Android の Chrome は、連続モードだと「それまでに話した分をつなげた文字」を毎回送ってくる（555 → 555555 → …）。
  // そのため Android では1回話すごとに聞き取りを区切る
  const IS_ANDROID = /Android/i.test(navigator.userAgent);

  // ---------- 端末への保存（localStorage） ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        showBanner('端末に保存できませんでした。CSV保存で控えを取ってください', 'bad');
        return false;
      }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (e) { /* 何もしない */ }
    },
  };
  const loadSession = (id) => store.get('vm:s:' + id, null);
  const sessionIds = () => store.get('vm:index', []);
  function saveSession(s) {
    store.set('vm:s:' + s.id, s);
    const ids = sessionIds();
    if (!ids.includes(s.id)) store.set('vm:index', [s.id].concat(ids));
  }
  function removeSession(id) {
    store.remove('vm:s:' + id);
    store.set('vm:index', sessionIds().filter((x) => x !== id));
  }

  // 記録を受け取る GAS の Webアプリ（voice-measure/gas）。所属ごとのフォルダにスプレッドシートを作る
  const GAS_URL = 'https://script.google.com/macros/s/AKfycbzSwDfakMCXdYPFTU2f1qdnmwQdnpmcS4JS33yRVx8imIua1E_06z5kdMQBb4dJfo4/exec';
  const ORGS = { rf: 'RF社員', marine: 'マリン社員' };
  let session = null;
  let password = store.get('vm:pass', '');

  // ---------- 画面の切り替え ----------
  function go(name) {
    for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== name;
    window.scrollTo(0, 0);
    if (name === 'home') renderHome();
  }
  for (const b of document.querySelectorAll('[data-go]')) b.addEventListener('click', () => go(b.dataset.go));

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  const titleOf = (s) => `${s.meta.date} ${s.meta.name || '(名前なし)'}`;

  // ---------- はじめの画面 ----------
  function renderHome() {
    const list = $('sessionList');
    const sessions = sessionIds().map(loadSession).filter(Boolean);
    $('noSessions').hidden = sessions.length > 0;
    list.innerHTML = sessions.map((s) => {
      const unsent = s.rev !== s.syncedRev;
      return `<li data-id="${esc(s.id)}">
        <div class="title">${esc(titleOf(s))}</div>
        <div class="muted">${s.rows.length} 尾 ・ ${esc(s.fields.map((f) => f.label).join('・'))}${s.meta.measurer ? ' ・ ' + esc(s.meta.measurer) : ''}${ORGS[s.meta.org] ? ' ・ ' + ORGS[s.meta.org] : ''}</div>
        <div class="${unsent ? 'warn' : 'muted'}">${unsent ? '未送信の変更があります' : (s.syncedRev ? 'スプレッドシートに送信済み' : '')}</div>
        <div class="acts">
          <button data-act="open" class="primary">続ける</button>
          <button data-act="csv">CSV保存</button>
          ${unsent ? '<button data-act="sync">送信</button>' : ''}
          ${s.sheetUrl ? `<a href="${esc(s.sheetUrl)}" target="_blank" rel="noopener"><button type="button">シートを開く</button></a>` : ''}
          <button data-act="del" class="danger">消す</button>
        </div></li>`;
    }).join('');
  }

  $('sessionList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('li').dataset.id;
    const s = loadSession(id);
    if (!s) return;
    const act = btn.dataset.act;
    if (act === 'open') openMeasure(s);
    else if (act === 'csv') downloadCsv(s);
    else if (act === 'sync') {
      btn.disabled = true;
      btn.textContent = '送信中…';
      const r = await syncSession(s);
      if (!r.ok) alert('送信できませんでした：' + r.msg);
      renderHome();
    } else if (act === 'del') {
      const unsent = s.rev !== s.syncedRev;
      const msg = `「${titleOf(s)}」（${s.rows.length} 尾）をこの端末から消しますか？` +
        (unsent ? '\n\n⚠️ スプレッドシートに送っていない変更があります。消すと戻せません。' : '\n（スプレッドシートの記録は消えません）');
      if (confirm(msg)) {
        removeSession(id);
        renderHome();
      }
    }
  });

  // パスワード：GAS に確かめてもらい、合っていれば端末に覚える
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btnLogin');
    btn.disabled = true;
    $('loginMsg').textContent = '';
    password = $('loginPass').value;
    const r = await callGas({ action: 'login' });
    btn.disabled = false;
    if (!r.ok) {
      $('loginMsg').textContent = r.msg;
      return;
    }
    store.set('vm:pass', password);
    $('loginPass').value = '';
    go('home');
  });
  function requireLogin(msg) {
    stopListening();
    password = '';
    store.remove('vm:pass');
    $('loginMsg').textContent = msg || '';
    go('login');
  }

  $('btnNew').addEventListener('click', () => openSetup());

  // 所属（保存先のフォルダ）。前回選んだものを覚えておく
  let org = store.get('vm:org', '');
  function renderOrg() {
    for (const b of document.querySelectorAll('#orgChoice [data-org]')) b.setAttribute('aria-checked', String(b.dataset.org === org));
  }
  $('orgChoice').addEventListener('click', (e) => {
    const b = e.target.closest('[data-org]');
    if (!b) return;
    org = b.dataset.org;
    store.set('vm:org', org);
    renderOrg();
  });

  // ---------- 記録の準備（項目選び） ----------
  let setupFields = [];

  function openSetup() {
    const last = store.get('vm:lastSetup', null);
    if (last && last.fields) {
      setupFields = last.fields;
      // 前回使わなかったひな形の項目も、選べるように下に並べる
      for (const p of C.PRESET_FIELDS) {
        if (!setupFields.some((x) => x.field.key === p.key)) setupFields.push({ field: clone(p), on: false });
      }
      $('optReadback').checked = last.options.readback !== false;
      $('optCheck').checked = last.options.check !== false;
      $('metaMeasurer').value = last.measurer || '';
      $('metaName').value = last.name || '';
    } else {
      setupFields = C.PRESET_FIELDS.map((p) => ({ field: clone(p), on: p.key === 'sl' || p.key === 'bw' }));
    }
    $('metaDate').value = today();
    renderOrg();
    renderFieldList();
    go('setup');
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  const UNIT_CHOICES = { length: ['cm', 'mm'], weight: ['g', 'kg'] };

  function renderFieldList() {
    $('fieldList').innerHTML = setupFields.map((x, i) => {
      const f = x.field;
      const units = UNIT_CHOICES[f.kind];
      const unit = units
        ? `<select data-i="${i}" data-act="unit">${units.map((u) => `<option ${u === f.unit ? 'selected' : ''}>${u}</option>`).join('')}</select>`
        : (f.unit ? `<span class="muted">${esc(f.unit)}</span>` : '');
      const opts = f.type === 'choice' ? `<span class="muted">${esc((f.options || []).map((o) => o.label).join('/'))}</span>` : '';
      return `<li class="${x.on ? '' : 'off'}">
        <input type="checkbox" data-i="${i}" data-act="on" ${x.on ? 'checked' : ''} aria-label="${esc(f.label)}を記録する">
        <span class="name">${esc(f.label)}</span>${opts}${unit}
        <button data-i="${i}" data-act="up" aria-label="上へ">↑</button>
        <button data-i="${i}" data-act="down" aria-label="下へ">↓</button>
        ${f.custom ? `<button data-i="${i}" data-act="rm" aria-label="削除">✕</button>` : ''}
      </li>`;
    }).join('');
  }

  $('fieldList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const i = Number(b.dataset.i);
    const j = b.dataset.act === 'up' ? i - 1 : i + 1;
    if (b.dataset.act === 'rm') setupFields.splice(i, 1);
    else if (j >= 0 && j < setupFields.length) [setupFields[i], setupFields[j]] = [setupFields[j], setupFields[i]];
    renderFieldList();
  });
  $('fieldList').addEventListener('change', (e) => {
    const el = e.target;
    const x = setupFields[Number(el.dataset.i)];
    if (el.dataset.act === 'on') x.on = el.checked;
    if (el.dataset.act === 'unit') x.field.unit = el.value;
    renderFieldList();
  });

  $('btnAddField').addEventListener('click', () => {
    const label = $('newLabel').value.trim();
    if (!label) return alert('項目名を入れてください');
    if (setupFields.some((x) => x.field.label === label)) return alert('同じ名前の項目があります');
    const type = $('newType').value;
    const f = { key: 'c' + Date.now().toString(36), label, type, custom: true, aliases: [] };
    if ($('newUnit').value.trim()) f.unit = $('newUnit').value.trim();
    if (type === 'choice') {
      f.options = $('newOptions').value.split(/[,、，]/).map((s) => s.trim()).filter(Boolean).map((l) => ({ label: l, aliases: [] }));
      if (!f.options.length) return alert('選択肢を「,」で区切って入れてください');
    }
    setupFields.push({ field: f, on: true });
    for (const id of ['newLabel', 'newUnit', 'newOptions']) $(id).value = '';
    renderFieldList();
  });

  $('btnStart').addEventListener('click', () => {
    const fields = setupFields.filter((x) => x.on).map((x) => x.field);
    if (!fields.length) return alert('記録する項目を1つ以上選んでください');
    if (!ORGS[org]) return alert('所属（RF社員・マリン社員）を選んでください');
    const meta = { org, date: $('metaDate').value || today(), name: $('metaName').value.trim(), measurer: $('metaMeasurer').value.trim() };
    const options = { readback: $('optReadback').checked, check: $('optCheck').checked };
    store.set('vm:lastSetup', { fields: setupFields, options, measurer: meta.measurer, name: meta.name });
    const s = C.newSession(meta, fields, options);
    saveSession(s);
    openMeasure(s);
  });

  // ---------- 測定の画面 ----------
  function openMeasure(s) {
    session = s;
    // 前回、確定待ちのまま閉じていたら確定しておく
    if (s.pending) {
      C.flushPending(s);
      saveSession(s);
    }
    $('mTitle').textContent = titleOf(s);
    $('heard').textContent = '—';
    hideBanner();
    renderAll();
    go('measure');
    if (!SR) showBanner('このブラウザでは音声認識が使えません。手入力はできます（Android は Chrome、iPhone は Safari）', 'bad');
  }

  function renderAll() {
    renderCurrent();
    renderTable();
    renderSync();
  }

  function renderCurrent() {
    const cur = session.current;
    const nf = C.nextField(session);
    $('curNo').textContent = cur.no;
    $('curFields').innerHTML = session.fields.map((f) => {
      const has = Object.prototype.hasOwnProperty.call(cur.values, f.key);
      const v = has ? cur.values[f.key] : '';
      const cls = ['cf', nf && nf.key === f.key ? 'now' : '', has ? 'filled' : ''].join(' ');
      const unit = f.unit ? ` <small>${esc(f.unit)}</small>` : '';
      let input;
      if (f.type === 'choice') {
        input = `<select data-key="${f.key}"><option value=""></option>${(f.options || []).map((o) => `<option ${o.label === v ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      } else {
        const mode = f.type === 'number' ? 'inputmode="decimal"' : '';
        input = `<input data-key="${f.key}" ${mode} value="${esc(v)}" placeholder="${has ? '（空欄）' : ''}" autocomplete="off">`;
      }
      return `<div class="${cls}"><span class="lbl">${esc(f.label)}${unit}</span>${input}</div>`;
    }).join('');
    $('curMemo').hidden = !cur.memo;
    $('curMemo').textContent = cur.memo ? 'メモ：' + cur.memo : '';
  }

  // 手入力：入力欄を変えたら今の魚に入れる（確定はボタンか、最後の欄で Enter）
  $('curFields').addEventListener('change', (e) => {
    const key = e.target.dataset.key;
    if (!key) return;
    C.setCurrentValue(session, key, e.target.value.trim());
    changed();
    renderCurrent();
  });
  $('curFields').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.dataset.key) return;
    e.preventDefault();
    C.setCurrentValue(session, e.target.dataset.key, e.target.value.trim());
    const nf = C.nextField(session);
    if (!nf) handleEvents(C.commitCurrent(session));
    else {
      changed();
      renderCurrent();
      const next = document.querySelector(`#curFields [data-key="${nf.key}"]`);
      if (next) next.focus();
    }
  });

  let freshNo = null;
  function renderTable() {
    const fields = session.fields;
    $('countRows').textContent = session.rows.length;
    $('rowsTable').tHead.innerHTML = `<tr><th>No</th>${fields.map((f) => `<th>${esc(f.label)}</th>`).join('')}<th>メモ</th></tr>`;
    const rows = session.rows.slice().sort((a, b) => b.no - a.no);
    $('rowsTable').tBodies[0].innerHTML = rows.map((r) => {
      const flag = r.flags && r.flags.length;
      const cls = [flag ? 'flag' : '', r.no === freshNo ? 'fresh' : ''].join(' ');
      const memo = [r.memo, flag ? '⚠ ' + r.flags.join(' ') : ''].filter(Boolean).join(' ');
      return `<tr data-no="${r.no}" class="${cls}"><td>${r.no}</td>${fields.map((f) => `<td>${esc(r.values[f.key])}</td>`).join('')}<td class="memo-cell">${esc(memo)}</td></tr>`;
    }).join('');
  }

  // 行をタップ → 直すダイアログ
  let editingNo = null;
  $('rowsTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tbody tr');
    if (!tr) return;
    const row = session.rows.find((r) => r.no === Number(tr.dataset.no));
    if (!row) return;
    editingNo = row.no;
    $('editNo').textContent = row.no;
    $('editFields').innerHTML = session.fields.map((f) => {
      const v = row.values[f.key];
      if (f.type === 'choice') {
        return `<label>${esc(f.label)}<select data-key="${f.key}"><option value=""></option>${(f.options || []).map((o) => `<option ${o.label === v ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
      }
      return `<label>${esc(f.label)}${f.unit ? `（${esc(f.unit)}）` : ''}<input data-key="${f.key}" ${f.type === 'number' ? 'inputmode="decimal"' : ''} value="${esc(v)}"></label>`;
    }).join('');
    $('editMemo').value = row.memo || '';
    $('editDlg').showModal();
  });
  $('editDlg').addEventListener('close', () => {
    const act = $('editDlg').returnValue;
    if (act === 'save') {
      const values = {};
      for (const el of $('editFields').querySelectorAll('[data-key]')) {
        const f = session.fields.find((x) => x.key === el.dataset.key);
        const raw = el.value.trim();
        values[f.key] = f.type === 'number' && raw !== '' && !isNaN(Number(raw)) ? Number(raw) : raw;
      }
      C.updateRow(session, editingNo, values, $('editMemo').value.trim());
    } else if (act === 'delete') {
      if (!confirm(`No.${editingNo} の行を消しますか？`)) return;
      C.deleteRow(session, editingNo);
    } else return;
    changed();
    renderTable();
  });

  $('btnUndo').addEventListener('click', () => runText('とりけし'));
  $('btnSkip').addEventListener('click', () => runText('なし'));
  $('btnCommit').addEventListener('click', () => handleEvents(C.commitCurrent(session)));
  $('btnCsv').addEventListener('click', () => downloadCsv(session));
  $('btnSyncNow').addEventListener('click', () => syncSession(session).then(renderSync));
  $('btnLeave').addEventListener('click', () => {
    stopListening();
    clearTimeout(pendingTimer);
    if (session) {
      if (session.pending) C.flushPending(session);
      saveSession(session);
      if (session.rev !== session.syncedRev) syncSession(session);
    }
    session = null;
    go('home');
  });

  // ---------- 発話の処理 ----------
  function runText(text) {
    $('heard').textContent = text;
    handleEvents(C.applyUtterance(session, text, Date.now()));
  }

  // 音声認識の候補（言い方の候補が複数来る）のうち、最初にちゃんと読めたものを使う
  function handleAlternatives(alts) {
    let chosen = null;
    for (const t of alts) {
      const trial = clone(session);
      const ev = C.applyUtterance(trial, t, Date.now());
      const ok = !ev.some((x) => x.type === 'error');
      if (ok) { chosen = { trial, ev, t }; break; }
      if (!chosen) chosen = { trial, ev, t };
    }
    if (!chosen) return;
    $('heard').textContent = chosen.t;
    Object.assign(session, chosen.trial);
    handleEvents(chosen.ev);
  }

  // 確定待ちの魚は、続きの数字が来なければ MERGE_MS 後に確定する
  let pendingTimer = null;
  function schedulePending() {
    clearTimeout(pendingTimer);
    if (!session || !session.pending) return;
    const wait = session.lastSet ? Math.max(0, session.lastSet.at + C.MERGE_MS - Date.now()) : 0;
    pendingTimer = setTimeout(() => {
      if (session && session.pending) handleEvents(C.flushPending(session));
    }, wait + 50);
  }

  function handleEvents(events) {
    schedulePending();
    if (!events.length) return;
    let commitRow = null;
    let error = null;
    for (const ev of events) {
      if (ev.type === 'commit') commitRow = ev.row;
      if (ev.type === 'error') error = ev;
    }
    changed();
    if (commitRow) freshNo = commitRow.no;
    renderCurrent();
    renderTable();

    if (error) {
      beep('bad');
      showBanner(`${error.message}${error.heard ? `「${error.heard}」` : ''}`, 'bad');
      return;
    }
    const last = events[events.length - 1];
    if (commitRow && commitRow.flags && commitRow.flags.length) {
      beep('bad');
      showBanner(`No.${commitRow.no} 要確認：${commitRow.flags.join(' ')}（「とりけし」で直せます）`, 'bad');
      speak(`確認。${commitRow.flags.join('、').replace(/？/g, '')}`);
    } else if (commitRow) {
      beep('commit');
      showBanner(`No.${commitRow.no} 記録しました`, 'ok');
      if (session.options.readback) {
        const vals = session.fields.map((f) => commitRow.values[f.key]).filter((v) => v !== '' && v !== undefined);
        speak(vals.join('、'));
      }
    } else if (last.type === 'undo') {
      beep('bad');
      showBanner(`No.${last.no || session.current.no} の${last.label}を取り消しました`, 'ok');
      if (session.options.readback) speak(`${last.label}、取り消し`);
    } else if (last.type === 'memo') {
      beep('ok');
      showBanner(`No.${last.no} にメモ：${last.memo}`, 'ok');
    } else {
      beep('ok');
      hideBanner();
    }
  }

  function changed() {
    saveSession(session);
    scheduleSync();
    renderSync();
  }

  let bannerTimer = null;
  function showBanner(text, kind) {
    const b = $('banner');
    b.textContent = text;
    b.className = 'banner ' + kind;
    b.hidden = false;
    clearTimeout(bannerTimer);
    if (kind === 'ok') bannerTimer = setTimeout(hideBanner, 3000);
  }
  function hideBanner() {
    $('banner').hidden = true;
  }

  // ---------- 音声認識 ----------
  let rec = null;
  let wantListen = false;
  let running = false;
  let speaking = false;
  let wakeLock = null;

  function startRec() {
    if (!SR || !wantListen || speaking || running) return;
    rec = new SR();
    rec.lang = 'ja-JP';
    rec.continuous = !IS_ANDROID;
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    const done = new Set(); // 同じ結果を何度も返すことがあるので、処理した番号を覚える
    let prevFinal = '';     // この聞き取りで前に確定した文字（つなげて送られてきたときに、新しい部分だけを取り出す）
    rec.onstart = () => { running = true; renderMic(); };
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          if (done.has(i)) continue;
          done.add(i);
          const full = Array.from(r).map((a) => a.transcript.trim()).filter(Boolean);
          // つなげて送ってくるのは Android だけ。iPhone で同じ数字を続けて言ったときに消さないように、Android のときだけ取り出す
          const alts = IS_ANDROID ? full.map((t) => newPart(t, prevFinal)).filter(Boolean) : full;
          if (full.length) prevFinal = full[0];
          if (alts.length && session && !isRepeat(alts[0])) handleAlternatives(alts);
        } else {
          interim += r[0].transcript;
        }
      }
      if (interim) $('heard').textContent = interim + ' …';
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wantListen = false;
        showBanner('マイクが使えません。ブラウザの設定でマイクを「許可」にしてください', 'bad');
      } else if (e.error === 'network') {
        showBanner('音声認識にはインターネット接続が必要です', 'bad');
      } else if (e.error === 'audio-capture') {
        wantListen = false;
        showBanner('マイクが見つかりません', 'bad');
      }
    };
    rec.onend = () => {
      running = false;
      renderMic();
      // 黙っていると止まるので、聞き取り中のあいだは自動でつなぎ直す
      if (wantListen && !speaking) setTimeout(startRec, 150);
    };
    try {
      rec.start();
    } catch (e) {
      running = false;
    }
  }

  // 前に確定した文字を頭に含んでいたら、その後ろだけを返す（「555」のあとの「555555」→「555」）
  function newPart(text, prev) {
    const strip = (x) => x.replace(/\s/g, '');
    const a = strip(text);
    const b = strip(prev);
    if (!b || a === b || !a.startsWith(b)) return a === b ? '' : text;
    return a.slice(b.length);
  }

  // 同じ文字が1秒以内に続けて届いたら、二重に届いたものとみなす
  let lastHeard = { text: '', at: 0 };
  function isRepeat(text) {
    const t = text.replace(/\s/g, '');
    const now = Date.now();
    const rep = t === lastHeard.text && now - lastHeard.at < 1000;
    lastHeard = { text: t, at: now };
    return rep;
  }

  function startListening() {
    wantListen = true;
    unlockAudio();
    startRec();
    renderMic();
    if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then((w) => { wakeLock = w; }).catch(() => {});
  }
  function stopListening() {
    wantListen = false;
    if (rec) try { rec.abort(); } catch (e) { /* 何もしない */ }
    renderMic();
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  function renderMic() {
    const b = $('btnMic');
    b.classList.toggle('on', wantListen);
    b.textContent = wantListen ? '■ 聞き取り中（押すと止める）' : '🎤 聞き取り開始';
  }
  $('btnMic').addEventListener('click', () => (wantListen ? stopListening() : startListening()));
  // 画面を戻ってきたとき、画面ロックを取り直す
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wantListen && 'wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then((w) => { wakeLock = w; }).catch(() => {});
    }
  });

  // ---------- 読み上げと音 ----------
  // 読み上げ中は認識を止める（自分の声を数字として拾わないように）
  let speakGuard = null;
  function speak(text) {
    if (!('speechSynthesis' in window) || !text) return;
    speaking = true;
    if (rec && running) try { rec.abort(); } catch (e) { /* 何もしない */ }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 1.15;
    const finish = () => {
      clearTimeout(speakGuard);
      if (!speaking) return;
      speaking = false;
      renderMic();
      if (wantListen) startRec();
    };
    u.onend = finish;
    u.onerror = finish;
    clearTimeout(speakGuard);
    speakGuard = setTimeout(finish, 8000);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  let audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      // iPhone は最初の読み上げをボタン操作の中で行わないと、あとで声が出ない
      if ('speechSynthesis' in window && !unlockAudio.done) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
        unlockAudio.done = true;
      }
    } catch (e) { /* 何もしない */ }
  }
  function beep(kind) {
    if (!audioCtx) return;
    const tones = { ok: [[1200, 0.07]], commit: [[880, 0.08], [1320, 0.12]], bad: [[300, 0.18], [220, 0.25]] }[kind];
    let t = audioCtx.currentTime;
    for (const [freq, dur] of tones) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = freq;
      o.type = kind === 'bad' ? 'square' : 'sine';
      g.gain.setValueAtTime(0.25, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + dur);
      t += dur + 0.03;
    }
  }

  // ---------- スプレッドシートへの送信 ----------
  // GAS へは text/plain で送る（CORS の事前確認が要らない形）
  async function callGas(body) {
    try {
      const res = await fetch(GAS_URL, { method: 'POST', body: JSON.stringify(Object.assign({ password }, body)) });
      const data = await res.json();
      if (!data.success) {
        // パスワードが変わったときは入れ直してもらう（記録は端末に残っている）
        if (data.authError && body.action !== 'login') requireLogin('パスワードを入れ直してください（記録は端末に残っています）');
        return { ok: false, msg: data.msg || '失敗しました', data };
      }
      return { ok: true, data };
    } catch (e) {
      return { ok: false, msg: navigator.onLine === false ? 'インターネットにつながっていません' : '送信先に届きません' };
    }
  }

  const syncing = new Set();
  const syncError = {};
  let syncTimer = null;

  function payload(s) {
    const { head, rows } = C.toTable(s);
    // 番号・選択・文字の列は、文字として書く（001 が 1 にならないように）
    const textCols = s.fields.map((f, i) => (f.type === 'number' ? -1 : 4 + i)).filter((i) => i >= 0);
    return { id: s.id, meta: s.meta, head, rows, textCols };
  }

  async function syncSession(s) {
    if (syncing.has(s.id)) return { ok: false, msg: '送信中です' };
    if (s.rev === s.syncedRev) return { ok: true };
    syncing.add(s.id);
    renderSync();
    const rev = s.rev;
    const r = await callGas({ action: 'save', session: payload(s) });
    syncing.delete(s.id);
    // 送っているあいだに測定画面で変わっているかもしれないので、最新のものに書き込む
    const target = session && session.id === s.id ? session : (loadSession(s.id) || s);
    if (r.ok) {
      target.syncedRev = Math.max(target.syncedRev, rev);
      target.sheetUrl = r.data.sheetUrl;
      delete syncError[s.id];
      saveSession(target);
    } else {
      syncError[s.id] = r.msg;
    }
    renderSync();
    if (session && session.id === s.id && session.rev !== session.syncedRev) scheduleSync(r.ok ? 1000 : 20000);
    return r;
  }

  function scheduleSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { if (session) syncSession(session); }, delay || 4000);
  }

  function renderSync() {
    if (!session) return;
    const el = $('syncState');
    const err = syncError[session.id];
    el.classList.toggle('err', !!err && session.rev !== session.syncedRev);
    if (syncing.has(session.id)) el.textContent = '送信中…';
    else if (session.rev === session.syncedRev) el.textContent = session.syncedRev ? '✓ 送信済み' : '✓';
    else if (err) el.textContent = '未送信（' + err + '）';
    else el.textContent = '未送信';
  }
  window.addEventListener('online', () => { if (session) scheduleSync(500); });

  function downloadCsv(s) {
    const blob = new Blob(['﻿' + C.toCsv(s)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${s.meta.date}_${(s.meta.name || '記録').replace(/[\\/:*?"<>|\s]+/g, '_')}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------- はじめ ----------
  $('srWarn').hidden = !!SR;
  go(password ? 'home' : 'login');
  // テストから触れるように
  window.__vm = { runText, handleAlternatives, get session() { return session; } };
})();
