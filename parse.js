// 音声認識の文字列を、数字・言葉・コマンドに分ける。
// ブラウザでは window.VoiceParse、node（テスト）では module.exports で使う。
(function (root) {
  'use strict';

  // ひらがなの数詞 → 漢数字（長いものから順に試す）
  const KANA_NUM = [
    ['きゅう', '九'], ['じゅう', '十'], ['じゅっ', '十'], ['じっ', '十'],
    ['ひゃく', '百'], ['びゃく', '百'], ['ぴゃく', '百'],
    ['ぜろ', '〇'], ['れい', '〇'], ['まる', '〇'],
    ['いち', '一'], ['いっ', '一'], ['さん', '三'], ['よん', '四'],
    ['ろく', '六'], ['ろっ', '六'], ['なな', '七'], ['しち', '七'],
    ['はち', '八'], ['はっ', '八'], ['せん', '千'], ['ぜん', '千'],
    ['まん', '万'], ['てん', '点'],
    ['に', '二'], ['し', '四'], ['よ', '四'], ['ご', '五'], ['く', '九'],
  ];
  const KANJI_DIGIT = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  const KANJI_UNIT = { '十': 10, '百': 100, '千': 1000 };

  // 単位：数字のあとに付いたものを記号に置き換える（大きさの換算に使う）
  const UNIT_WORDS = [
    [/きろぐらむ|きろ|kg/g, ' ⟨kg⟩ '],
    [/ぐらむ|(?<=\d)\s*g(?![a-z])/g, ' ⟨g⟩ '],
    [/せんち(めーとる)?|(?<=\d)\s*cm/g, ' ⟨cm⟩ '],
    [/みり(めーとる)?|(?<=\d)\s*mm/g, ' ⟨mm⟩ '],
  ];

  const COMMANDS = [
    { cmd: 'undo', re: /とりけし|取り消し|取消|きゃんせる|まちがい|間違い|もどして|戻して/ },
    { cmd: 'skip', re: /すきっぷ|ぱす|とばす|飛ばす|^なし$|^無し$/ },
    { cmd: 'next', re: /^(つぎ|次|ねくすと)$/ },
  ];

  function toHiragana(s) {
    return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }

  // NFKC（全角→半角）、カタカナ→ひらがな、小文字、長音などの揺れをそろえる
  function normalize(text) {
    let s = String(text || '').normalize('NFKC');
    s = toHiragana(s).toLowerCase();
    s = s.replace(/[、。,，!！?？「」]/g, (c) => (c === ',' || c === '，' ? ',' : ' '));
    s = s.replace(/(\d),(?=\d{3}(\D|$))/g, '$1'); // 1,200 → 1200
    s = s.replace(/,/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
  }

  // ひらがなだけの並びを、数詞として全部読めるときだけ漢数字に置き換える
  function kanaRunToKanji(run) {
    let out = '';
    let i = 0;
    while (i < run.length) {
      const hit = KANA_NUM.find(([k]) => run.startsWith(k, i));
      if (!hit) return null;
      out += hit[1];
      i += hit[0].length;
    }
    return out;
  }

  function replaceKanaNumbers(s) {
    return s.replace(/[ぁ-ゖー]+/g, (run) => {
      const k = kanaRunToKanji(run.replace(/ー/g, ''));
      // 「に」「ご」「し」「よ」「く」1文字だけは助詞などの可能性があるので変えない
      if (k === null || (run.length === 1 && !/^[〇]$/.test(k))) return run;
      return k;
    });
  }

  // 漢数字の整数部分（例：三百十二 → 312、二五三 → 253）
  function kanjiIntToNumber(str) {
    if (!/[十百千万]/.test(str)) {
      // 単位のない並びは1けたずつ（二五三 → 253）
      return Number(str.split('').map((c) => (c in KANJI_DIGIT ? KANJI_DIGIT[c] : c)).join(''));
    }
    let total = 0;
    let section = 0;
    let digit = null;
    for (const c of str) {
      if (c in KANJI_DIGIT) {
        digit = (digit === null ? 0 : digit * 10) + KANJI_DIGIT[c];
      } else if (/\d/.test(c)) {
        digit = (digit === null ? 0 : digit * 10) + Number(c);
      } else if (c in KANJI_UNIT) {
        section += (digit === null ? 1 : digit) * KANJI_UNIT[c];
        digit = null;
      } else if (c === '万') {
        total += (section + (digit || 0) || 1) * 10000;
        section = 0;
        digit = null;
      }
    }
    return total + section + (digit || 0);
  }

  function replaceKanjiNumbers(s) {
    const re = /([〇零一二三四五六七八九十百千万\d]+)(?:点([〇零一二三四五六七八九\d]+))?/g;
    return s.replace(re, (m, intPart, decPart) => {
      if (/^\d+$/.test(intPart) && decPart === undefined) return m;
      const intVal = /^\d+$/.test(intPart) ? Number(intPart) : kanjiIntToNumber(intPart);
      if (decPart === undefined) return String(intVal);
      const dec = decPart.split('').map((c) => (c in KANJI_DIGIT ? KANJI_DIGIT[c] : c)).join('');
      return `${intVal}.${dec}`;
    });
  }

  // 文字列 → [{type:'num', value, text, unit}, {type:'word', text}]（話した順）
  function tokenize(text) {
    let s = normalize(text);
    // 単位を先に記号にする（「ごせんち」の「せん」を千と読まないように）
    for (const [re, mark] of UNIT_WORDS) s = s.replace(re, mark);
    s = replaceKanaNumbers(s);
    s = replaceKanjiNumbers(s);
    s = s.replace(/(\d)\s*(?:点|てん)\s*(\d)/g, '$1.$2');

    const tokens = [];
    const re = /(\d+(?:\.\d+)?)\s*(?:⟨(kg|g|cm|mm)⟩)?/g;
    let last = 0;
    let m;
    const pushWords = (chunk) => {
      chunk.replace(/⟨[a-z]+⟩/g, ' ').split(' ').map((w) => w.trim()).filter(Boolean)
        .forEach((w) => tokens.push({ type: 'word', text: w }));
    };
    while ((m = re.exec(s)) !== null) {
      pushWords(s.slice(last, m.index));
      tokens.push({ type: 'num', value: Number(m[1]), text: m[1], unit: m[2] || null });
      last = re.lastIndex;
    }
    pushWords(s.slice(last));
    return tokens;
  }

  // 先頭が「メモ」なら、その後ろの文字をメモとして返す
  function parseMemo(text) {
    const m = String(text || '').trim().match(/^(メモ|めも|memo)[\s、:：]*(.*)$/i);
    return m ? m[2].trim() : null;
  }

  function parseCommand(text) {
    const s = normalize(text).replace(/\s/g, '');
    for (const { cmd, re } of COMMANDS) if (re.test(s)) return cmd;
    return null;
  }

  // 単位を項目の単位にそろえる（例：1.2キロ → 1200 g）
  function convertUnit(value, spoken, fieldUnit) {
    if (!spoken || !fieldUnit || spoken === fieldUnit) return value;
    const factor = { kg: 1000, g: 1, cm: 10, mm: 1 };
    const group = (u) => (u === 'kg' || u === 'g' ? 'w' : 'l');
    if (!(spoken in factor) || !(fieldUnit in factor) || group(spoken) !== group(fieldUnit)) return value;
    return Math.round((value * factor[spoken] / factor[fieldUnit]) * 1e6) / 1e6;
  }

  // 選択肢の言い方（ひらがな・漢字）と比べる
  function matchOption(word, options) {
    const w = normalize(word).replace(/\s/g, '');
    for (const opt of options) {
      const names = [opt.label].concat(opt.aliases || []).map((a) => normalize(a).replace(/\s/g, ''));
      if (names.some((n) => n && (w === n || w.includes(n)))) return opt.label;
    }
    return null;
  }

  const api = { normalize, tokenize, parseCommand, parseMemo, convertUnit, matchOption, toHiragana };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
