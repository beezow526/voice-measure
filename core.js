// 測定の記録（セッション）を進める処理。画面や音声認識には触らない。
// ブラウザでは window.VoiceCore、node（テスト）では module.exports で使う。
(function (root) {
  'use strict';

  const P = typeof module !== 'undefined' && module.exports ? require('./parse.js') : root.VoiceParse;

  // 項目のひな形（記録を始めるときに選ぶ）
  const PRESET_FIELDS = [
    { key: 'id', label: '識別番号', type: 'id', aliases: ['番号', 'ばんごう', 'id', 'あいでぃー', '識別'] },
    {
      key: 'sex', label: '性別', type: 'choice', aliases: ['せいべつ'],
      options: [
        { label: 'オス', aliases: ['おす', '雄', '♂', 'おとこ'] },
        { label: 'メス', aliases: ['めす', '雌', '♀', 'おんな'] },
        { label: '不明', aliases: ['ふめい', 'わからない', 'わかんない'] },
      ],
    },
    { key: 'tl', label: '全長', type: 'number', unit: 'cm', kind: 'length', aliases: ['ぜんちょう'] },
    { key: 'sl', label: '体長', type: 'number', unit: 'cm', kind: 'length', aliases: ['たいちょう'] },
    { key: 'fl', label: '尾叉長', type: 'number', unit: 'cm', kind: 'length', aliases: ['びさちょう', '尾さ長'] },
    { key: 'bw', label: '体重', type: 'number', unit: 'g', kind: 'weight', aliases: ['たいじゅう'] },
  ];

  const MIN_ROWS_FOR_CHECK = 5;  // これより少ないうちは外れ値を調べない
  const VALUE_RATIO = 2.5;       // 中央値の 2.5 倍より大きい・1/2.5 より小さい値は要確認
  const K_RATIO = 1.35;          // 肥満度（体重 / 長さ^3）が中央値の 1.35 倍・1/1.35 を超えたら要確認

  function newSession(meta, fields, options) {
    return {
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      createdAt: new Date().toISOString(),
      meta: Object.assign({ date: '', name: '', measurer: '' }, meta),
      fields: fields.map((f) => Object.assign({}, f)),
      options: Object.assign({ readback: true, check: true }, options),
      rows: [],
      current: emptyFish(1),
      rev: 0,
      syncedRev: 0,
      finished: false,
    };
  }

  function emptyFish(no) {
    return { no, values: {}, order: [], memo: '' };
  }

  function isFilled(fish, key) {
    return Object.prototype.hasOwnProperty.call(fish.values, key);
  }

  function nextField(session, fish) {
    const f = fish || session.current;
    return session.fields.find((fd) => !isFilled(f, fd.key)) || null;
  }

  function touch(session) {
    session.rev += 1;
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // それまでの魚と比べて、おかしそうな値を探す（聞き間違い・けた違いの検出）
  function checkRow(session, row, others) {
    const flags = [];
    if (!session.options.check) return flags;
    const prev = others || session.rows.filter((r) => r.no !== row.no);
    const num = (r, key) => (typeof r.values[key] === 'number' ? r.values[key] : null);

    for (const f of session.fields.filter((fd) => fd.type === 'number')) {
      const v = num(row, f.key);
      if (v === null) continue;
      const vals = prev.map((r) => num(r, f.key)).filter((x) => x !== null && x > 0);
      if (vals.length < MIN_ROWS_FOR_CHECK) continue;
      const med = median(vals);
      if (v > med * VALUE_RATIO) flags.push(`${f.label}が大きすぎ？`);
      else if (v < med / VALUE_RATIO) flags.push(`${f.label}が小さすぎ？`);
    }

    const lf = session.fields.find((fd) => fd.kind === 'length');
    const wf = session.fields.find((fd) => fd.kind === 'weight');
    if (lf && wf && flags.length === 0) {
      const k = (r) => {
        const l = num(r, lf.key);
        const w = num(r, wf.key);
        return l > 0 && w > 0 ? w / (l * l * l) : null;
      };
      const kv = k(row);
      const ks = prev.map(k).filter((x) => x !== null);
      if (kv !== null && ks.length >= MIN_ROWS_FOR_CHECK) {
        const med = median(ks);
        if (kv > med * K_RATIO) flags.push(`${lf.label}のわりに${wf.label}が重すぎ？`);
        else if (kv < med / K_RATIO) flags.push(`${lf.label}のわりに${wf.label}が軽すぎ？`);
      }
    }
    return flags;
  }

  function setValue(session, key, value) {
    const cur = session.current;
    cur.values[key] = value;
    cur.order = cur.order.filter((k) => k !== key).concat(key);
    touch(session);
  }

  // 全部の項目が埋まったら1尾分として確定し、次の魚に進む
  function commitIfComplete(session, events) {
    if (nextField(session)) return;
    commit(session, events);
  }

  function commit(session, events) {
    const cur = session.current;
    const row = {
      no: cur.no,
      values: Object.assign({}, cur.values),
      order: cur.order.slice(),
      memo: cur.memo,
      time: new Date().toISOString(),
    };
    for (const f of session.fields) if (!isFilled(row, f.key)) row.values[f.key] = '';
    row.flags = checkRow(session, row);
    session.rows.push(row);
    session.current = emptyFish(nextNo(session));
    touch(session);
    events.push({ type: 'commit', row });
  }

  function nextNo(session) {
    return session.rows.reduce((m, r) => Math.max(m, r.no), 0) + 1;
  }

  // 項目1つ分を、話した言葉の並びから取り出す
  function consume(field, tokens, i) {
    if (field.type === 'number') {
      let j = i;
      while (j < tokens.length && tokens[j].type !== 'num') j++;
      if (j >= tokens.length) return null;
      const t = tokens[j];
      return { value: P.convertUnit(t.value, t.unit, field.unit), next: j + 1 };
    }
    if (field.type === 'choice') {
      const t = tokens[i];
      if (!t || t.type !== 'word') return null;
      const v = P.matchOption(t.text, field.options || []);
      return v === null ? null : { value: v, next: i + 1 };
    }
    if (field.type === 'id') {
      const t = tokens[i];
      if (!t) return null;
      // 「A」「12」のように英字と数字に分かれたら1つにする
      if (t.type === 'word' && /^[a-z]{1,3}$/.test(t.text) && tokens[i + 1] && tokens[i + 1].type === 'num') {
        return { value: (t.text + tokens[i + 1].text).toUpperCase(), next: i + 2 };
      }
      return { value: t.type === 'num' ? t.text : t.text.toUpperCase(), next: i + 1 };
    }
    return null;
  }

  // 「体重 312」のように項目名から始まっていたら、その項目を返す
  function matchFieldPrefix(session, text) {
    const s = P.normalize(text).replace(/\s/g, '');
    for (const f of session.fields) {
      const names = [f.label].concat(f.aliases || []).map((a) => P.normalize(a).replace(/\s/g, ''));
      // 長い名前から試す（「体長」と「全長」などの取り違えを防ぐ）
      names.sort((a, b) => b.length - a.length);
      for (const n of names) {
        if (n && s.startsWith(n)) return { field: f, rest: restAfter(text, n) };
      }
    }
    return null;
  }

  function restAfter(text, normName) {
    const raw = String(text);
    for (let i = 1; i <= raw.length; i++) {
      if (P.normalize(raw.slice(0, i)).replace(/\s/g, '') === normName) return raw.slice(i);
    }
    return '';
  }

  function undo(session, events) {
    let cur = session.current;
    if (!cur.order.length && !cur.memo && session.rows.length) {
      const row = session.rows.pop();
      session.current = cur = {
        no: row.no,
        values: Object.assign({}, row.values),
        order: row.order.slice(),
        memo: row.memo,
      };
      // 空欄のまま確定した項目は「未入力」に戻す
      for (const k of Object.keys(cur.values)) if (cur.values[k] === '' && !cur.order.includes(k)) delete cur.values[k];
    }
    const key = cur.order.pop();
    if (key === undefined) {
      if (cur.memo) {
        cur.memo = '';
        touch(session);
        events.push({ type: 'undo', label: 'メモ' });
      } else {
        events.push({ type: 'error', message: '取り消すものがありません' });
      }
      return;
    }
    const field = session.fields.find((f) => f.key === key);
    delete cur.values[key];
    touch(session);
    events.push({ type: 'undo', key, label: field ? field.label : key, no: cur.no });
  }

  // 1回の発話を処理する。戻り値は画面に知らせる出来事の一覧
  function applyUtterance(session, text) {
    const events = [];
    const raw = String(text || '').trim();
    if (!raw) return events;

    const memo = P.parseMemo(raw);
    if (memo !== null) {
      const target = session.current.order.length || !session.rows.length ? session.current : session.rows[session.rows.length - 1];
      target.memo = target.memo ? `${target.memo} ${memo}` : memo;
      touch(session);
      events.push({ type: 'memo', no: target.no, memo: target.memo });
      return events;
    }

    const cmd = P.parseCommand(raw);
    if (cmd === 'undo') {
      undo(session, events);
      return events;
    }
    if (cmd === 'skip') {
      const f = nextField(session);
      if (f) {
        setValue(session, f.key, '');
        events.push({ type: 'set', key: f.key, label: f.label, value: '' });
        commitIfComplete(session, events);
      }
      return events;
    }
    if (cmd === 'next') {
      if (session.current.order.length) commit(session, events);
      return events;
    }

    // 文字の項目は、言ったことをそのまま入れる
    const nf = nextField(session);
    if (nf && nf.type === 'text') {
      setValue(session, nf.key, raw);
      events.push({ type: 'set', key: nf.key, label: nf.label, value: raw });
      commitIfComplete(session, events);
      return events;
    }

    let tokens;
    const pre = matchFieldPrefix(session, raw);
    if (pre) {
      tokens = P.tokenize(pre.rest);
      const r = pre.field.type === 'text' ? { value: pre.rest.trim(), next: tokens.length } : consume(pre.field, tokens, 0);
      if (!r) {
        events.push({ type: 'error', message: `${pre.field.label}の値が聞き取れません`, heard: raw });
        return events;
      }
      setValue(session, pre.field.key, r.value);
      events.push({ type: 'set', key: pre.field.key, label: pre.field.label, value: r.value });
      tokens = tokens.slice(r.next);
      commitIfComplete(session, events);
    } else {
      tokens = P.tokenize(raw);
    }

    let i = 0;
    let used = 0;
    while (i < tokens.length) {
      const f = nextField(session);
      if (!f || f.type === 'text') break;
      const r = consume(f, tokens, i);
      if (!r) break;
      setValue(session, f.key, r.value);
      events.push({ type: 'set', key: f.key, label: f.label, value: r.value });
      used += 1;
      i = r.next;
      commitIfComplete(session, events);
    }
    if (!pre && used === 0) {
      const f = nextField(session);
      events.push({ type: 'error', message: f ? `${f.label}として聞き取れません` : '聞き取れません', heard: raw });
    }
    return events;
  }

  // 画面で手入力した値（空文字なら未入力に戻す）
  function setCurrentValue(session, key, value) {
    const cur = session.current;
    if (value === '' || value === null || value === undefined) {
      delete cur.values[key];
      cur.order = cur.order.filter((k) => k !== key);
      touch(session);
      return;
    }
    const f = session.fields.find((fd) => fd.key === key);
    const v = f && f.type === 'number' ? Number(value) : value;
    setValue(session, key, f && f.type === 'number' && isNaN(v) ? value : v);
  }

  // 「この魚を確定」ボタン。何か入っていれば、残りは空欄で確定する
  function commitCurrent(session) {
    const events = [];
    if (session.current.order.length || session.current.memo) commit(session, events);
    return events;
  }

  // 手で直した行を保存する（確認済みとして、要確認の印は消す）
  function updateRow(session, no, values, memo) {
    const row = session.rows.find((r) => r.no === no);
    if (!row) return false;
    row.values = Object.assign({}, row.values, values);
    row.memo = memo;
    row.flags = [];
    touch(session);
    return true;
  }

  function deleteRow(session, no) {
    const n = session.rows.length;
    session.rows = session.rows.filter((r) => r.no !== no);
    if (session.rows.length !== n) touch(session);
    return session.rows.length !== n;
  }

  // スプレッドシートに書く表（見出し＋行）
  function toTable(session) {
    const head = ['日付', '記録名', '測定者', 'No']
      .concat(session.fields.map((f) => (f.unit ? `${f.label}(${f.unit})` : f.label)))
      .concat(['メモ', '要確認', '記録時刻']);
    const rows = session.rows.slice().sort((a, b) => a.no - b.no).map((r) => [session.meta.date, session.meta.name, session.meta.measurer, r.no]
      .concat(session.fields.map((f) => (r.values[f.key] === undefined ? '' : r.values[f.key])))
      .concat([r.memo || '', (r.flags || []).join(' '), formatTime(r.time)]));
    return { head, rows };
  }

  function formatTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function toCsv(session) {
    const { head, rows } = toTable(session);
    const esc = (v) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [head].concat(rows).map((r) => r.map(esc).join(',')).join('\r\n');
  }

  const api = {
    PRESET_FIELDS, newSession, applyUtterance, nextField, setCurrentValue, commitCurrent,
    updateRow, deleteRow, checkRow, toTable, toCsv,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
