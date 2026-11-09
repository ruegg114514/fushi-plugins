'use strict';
/// 歌曲元数据/搜索/歌词：网易云音乐 + QQ 音乐（移植 feeluown/FuoEvolve 的设计）。
/// 播放流仍由 bili.js 从 B 站公开音轨取得（不需要会员）。
///
/// 端点是两家网页/客户端自己用的公开接口，均免登录、无需 weapi/sign 加密：
///   网易搜索  POST https://music.163.com/api/cloudsearch/pc
///   网易歌词  POST https://music.163.com/api/song/lyric/v1   （lrc / tlyric / romalrc 三轨）
///   QQ 快搜   GET  https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg
///   QQ 歌词   GET  https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?nobase64=1
///
/// 契约见 Fushi GUIDE.md：只有 fushi.* 全局，无 fetch / Buffer / setTimeout。

const NE_BASE = 'https://music.163.com';
const QQ_SEARCH = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg';
const QQ_LYRIC = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function form(params) {
  return Object.keys(params)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k] == null ? '' : params[k])))
    .join('&');
}

async function req(url, opts) {
  opts = opts || {};
  const headers = {
    'User-Agent': UA,
    Referer: opts.referer || NE_BASE + '/',
    Accept: 'application/json, text/plain, */*',
  };
  if (opts.method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  // 显式 cookie 优先；否则是 music.163.com 的请求就自动带网易登录 Cookie
  // （v3.4 之前 req() 完全不带 Cookie，导致登录验证、歌单/收藏接口全部失效）。
  let cookie = opts.cookie || '';
  if (!cookie && String(url).indexOf('music.163.com') >= 0) cookie = await neCookie();
  if (cookie) headers.Cookie = cookie;
  const res = await fushi.http.request({
    url: url,
    method: opts.method || 'GET',
    headers: headers,
    body: opts.method === 'POST' ? (opts.body || '') : undefined,
    timeoutMs: 20000,
    responseType: 'text',
  });
  if (!res || res.status < 200 || res.status >= 300) {
    throw new Error('请求失败：HTTP ' + (res ? res.status : 'no response'));
  }
  let text = res.text;
  // QQ 的 fcg 接口有时返回 JSONP 包裹（callback(...)），剥一层。
  const m = String(text || '').match(/^\s*[\w$.]+\(([\s\S]*)\)\s*;?\s*$/);
  if (m) text = m[1];
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('返回的不是 JSON（可能被风控）');
  }
}

// ── 网易云搜索 ─────────────────────────────────────────────────────────────

function neTrack(s) {
  const artists = (s.ar || []).map((a) => ({ id: 'ne-artist:' + a.id, name: a.name }));
  const al = s.al || {};
  const out = {
    id: 'ne:' + s.id,
    title: String(s.name || '未命名'),
    artists: artists,
    album: al.name ? { id: 'ne-album:' + al.id, title: al.name } : undefined,
    durationMs: Number(s.dt) || undefined,
    coverUrl: al.picUrl ? String(al.picUrl).replace(/^http:/, 'https:') : undefined,
  };
  if (s.fee === 1) out.note = 'VIP';
  return out;
}

function neArtist(a) {
  const out = { id: 'ne-artist:' + a.id, name: a.name };
  if (a.picUrl || a.img1v1Url) out.coverUrl = String(a.picUrl || a.img1v1Url).replace(/^http:/, 'https:');
  return out;
}

function neAlbum(a) {
  const out = { id: 'ne-album:' + a.id, title: a.name };
  if (a.picUrl) out.coverUrl = String(a.picUrl).replace(/^http:/, 'https:');
  if (a.artist) out.artists = [{ name: a.artist.name }];
  if (a.size != null) out.trackCount = Number(a.size) || undefined;
  return out;
}

function nePlaylist(p) {
  const out = { id: 'ne-playlist:' + p.id, title: p.name };
  if (p.coverImgUrl) out.coverUrl = String(p.coverImgUrl).replace(/^http:/, 'https:');
  if (p.trackCount != null) out.trackCount = Number(p.trackCount) || undefined;
  if (p.creator) out.owner = p.creator.nickname;
  if (p.playCount != null) out.playCount = Number(p.playCount) || undefined;
  return out;
}

async function neteaseSearch(query, type, page, pageSize) {
  // type 1=歌曲 10=专辑 100=歌手 1000=歌单
  const stype = type === 'album' ? 10 : type === 'artist' ? 100 : type === 'playlist' ? 1000 : 1;
  const json = await req(NE_BASE + '/api/cloudsearch/pc', {
    method: 'POST',
    body: form({ s: query, type: stype, offset: page * pageSize, limit: pageSize, total: 'true' }),
    referer: NE_BASE + '/',
  });
  if (json.code !== 200) throw new Error('网易搜索 ' + json.code + '：' + (json.message || ''));
  const r = json.result || {};
  let items = [];
  if (stype === 1) items = (r.songs || []).map(neTrack);
  else if (stype === 10) items = (r.albums || []).map(neAlbum);
  else if (stype === 100) items = (r.artists || []).map(neArtist);
  else if (stype === 1000) items = (r.playlists || []).map(nePlaylist);
  const total = r.songCount != null ? r.songCount : (r.albumCount != null ? r.albumCount : (r.artistCount != null ? r.artistCount : r.playlistCount));
  return { items, hasMore: items.length >= pageSize && (page + 1) * pageSize < (total || 0), total: total };
}

// ── QQ 音乐搜索（smartbox 快搜） ───────────────────────────────────────────

const QQ_FULL_SEARCH = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp';

async function qqSearch(query, type, page, pageSize) {
  // 歌曲：client_search_cp（免登录、真分页、total 可达数百）
  // 专辑/艺人：smartbox（QQ 没有免登录的分页专辑/艺人搜索，只给第一页）
  if (type === 'song') {
    const json = await req(QQ_FULL_SEARCH + '?format=json&p=' + (page + 1) +
      '&n=' + pageSize + '&w=' + encodeURIComponent(query), { referer: 'https://y.qq.com/' });
    if (json.code !== 0) throw new Error('QQ 搜索 ' + json.code);
    const sg = (json.data && json.data.song) || {};
    const items = (sg.list || []).map((x) => ({
      id: 'qq:' + (x.songmid || x.mid),
      title: String(x.songname || '').replace(/<[^>]+>/g, ''),
      artists: (x.singer || []).map((a) => ({ name: a.name })),
      album: x.albumname ? { id: 'qq-album:' + x.albummid, title: String(x.albumname).replace(/<[^>]+>/g, '') } : undefined,
      coverUrl: qqCover(x.albummid),
      durationMs: (Number(x.interval) || 0) * 1000 || undefined,
    })).filter((x) => x.id && x.title);
    const total = Number(sg.totalnum) || 0;
    return { items, hasMore: (page + 1) * pageSize < total, total };
  }
  if (page > 0) return { items: [], hasMore: false };
  const json = await req(QQ_SEARCH + '?key=' + encodeURIComponent(query) + '&format=json', {
    referer: 'https://y.qq.com/',
  });
  if (json.code !== 0) throw new Error('QQ 搜索 ' + json.code);
  const d = json.data || {};
  let items = [];
  if (type === 'artist') {
    // Artist 实体的显示字段是 name（写成 title 会被宿主整条丢掉）
    items = ((d.singer && d.singer.itemlist) || []).map((x) => ({
      id: 'qq-artist:' + x.mid, name: x.name, coverUrl: x.pic ? String(x.pic).replace(/^http:/, 'https:') : undefined,
    })).filter((x) => x.id && x.name);
  } else if (type === 'album') {
    items = ((d.album && d.album.itemlist) || []).map((x) => ({
      id: 'qq-album:' + x.mid, title: x.name, artists: x.singer ? [{ name: x.singer }] : [],
      coverUrl: x.pic ? String(x.pic).replace(/^http:/, 'https:') : undefined,
    })).filter((x) => x.id && x.title);
  } else {
    items = ((d.song && d.song.itemlist) || []).map((x) => ({
      id: 'qq:' + x.mid, title: x.name, artists: x.singer ? [{ name: x.singer }] : [],
      coverUrl: qqCover(x.albummid),
    })).filter((x) => x.id && x.title);
  }
  return { items: items.slice(0, pageSize), hasMore: false, total: items.length };
}

// ── 歌词（核心：三轨） ─────────────────────────────────────────────────────

// 网易新版「逐字 JSON 歌词」→ 标准 LRC。
// 形状：每行 {"t":212,"c":[{"tx":"作词: "},{"tx":"米津玄師",...}]}
function neteaseJsonLrcToLrc(raw) {
  const lines = [];
  for (const row of String(raw || '').split('\n')) {
    const s = row.trim();
    if (!s) continue;
    if (s.charAt(0) !== '{') { lines.push(s); continue; } // 已是 LRC 行
    let obj;
    try { obj = JSON.parse(s); } catch (_) { continue; }
    const t = Number(obj.t) || 0;
    const text = (obj.c || []).map((c) => String(c.tx || '')).join('');
    if (!text.trim()) continue;
    const m = Math.floor(t / 60000);
    const sec = (t % 60000) / 1000;
    const stamp = '[' + String(m).padStart(2, '0') + ':' + sec.toFixed(2).padStart(5, '0') + ']';
    lines.push(stamp + text);
  }
  return lines.join('\n');
}

function textOf(v) {
  if (!v) return '';
  const s = typeof v === 'string' ? v : (v.lyric || '');
  return String(s || '');
}

async function neteaseLyric(songId) {
  const json = await req(NE_BASE + '/api/song/lyric/v1', {
    method: 'POST',
    body: form({ id: songId, cp: 'false', tv: '0', lv: '0', rv: '0', kv: '0', yv: '0', ytv: '0', yrv: '0' }),
    referer: NE_BASE + '/',
  });
  if (json.code !== 200) return null;
  // 优先逐字轨 yrc / klyric，退回 lrc
  const mainRaw = textOf(json.yrc) || textOf(json.klyric) || textOf(json.lrc);
  if (!mainRaw.trim()) return null;
  const main = mainRaw.charAt(0) === '{' ? neteaseJsonLrcToLrc(mainRaw) : mainRaw;
  if (!main.trim()) return null;
  const out = { original: { format: 'lrc', text: main, language: 'ja' } };
  const trans = textOf(json.ytlrc) || textOf(json.tlyric);
  if (trans.trim()) out.translation = { format: 'lrc', text: trans, language: 'zh-Hans' };
  const roma = textOf(json.yromalrc) || textOf(json.romalrc);
  if (roma.trim()) out.romanization = { format: 'lrc', text: roma, language: 'ja-Latn' };
  return out;
}

async function qqLyric(songMid) {
  const json = await req(QQ_LYRIC + '?songmid=' + encodeURIComponent(songMid) + '&format=json&nobase64=1', {
    referer: 'https://y.qq.com/',
  });
  if (json.retcode !== 0 && json.code !== 0) return null;
  let raw = json.lyric || '';
  // 没给 nobase64 时 QQ 会 base64，这里兜底解一次（纯 JS，fushi.encoding 可用）。
  if (raw && !/\[\d+:/.test(raw)) {
    try {
      const bytes = fushi.encoding.base64Decode(raw);
      raw = fushi.encoding.utf8Decode(bytes);
    } catch (_) {
      // 解不开就按原文返回
    }
  }
  const lrc = String(raw).replace(/^\[ti:.*$/gm, '').trim();
  if (!lrc) return null;
  const out = { original: { format: 'lrc', text: lrc, language: 'ja' } };
  if (json.trans) out.translation = { format: 'lrc', text: String(json.trans), language: 'zh-Hans' };
  return out;
}

// 统一入口：按 id 前缀分发到对应家的歌词接口。
async function lyricsForId(id) {
  const s = String(id || '');
  const i = s.indexOf(':');
  const kind = i < 0 ? s : s.slice(0, i);
  const rest = i < 0 ? '' : s.slice(i + 1);
  if (kind === 'ne') return await neteaseLyric(rest);
  if (kind === 'qq') return await qqLyric(rest);
  return null;
}

// 从 id 反查「歌名 + 艺人」的展示信息（供 B 站找视频用）。
// 搜索结果里已把标题/艺人编码进 id 的查询缓存，这里从 storage 读。
async function trackMeta(id) {
  try {
    const raw = await fushi.storage.get('meta:' + id);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

async function saveTrackMeta(id, meta) {
  try {
    await fushi.storage.set('meta:' + id, JSON.stringify(meta));
  } catch (_) {
    // 存储不可用时忽略
  }
}

// ── 网易登录态（Cookie）与 weapi 加密直连 ───────────────────────────────────
//
// 第 5 条：免费歌直接播官方流，VIP 歌自动转 B 站。
// 网易 /api/song/enhance/player/url 对免登录一律 code:-110（实测），所以需要
// 登录 Cookie；/weapi/song/enhance/player/url 还要 weapi 加密。这里实现完整链路，
// 但任何一步失败都返回 null，由 main.js 的 stream() 自动降级到 B 站。

const WE_FIRST_KEY = '0CoJUm6Qyw8W8jud';
const WE_IV = '0102030405060708';
const WE_PUBKEY = '010001';
const WE_MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';

function b64(bytes) {
  // fushi.encoding.base64Encode 接受 Uint8Array 或字符串
  return fushi.encoding.base64Encode(bytes);
}

function randomKey() {
  const alphabet = '0123456789abcdef';
  const b = fushi.crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[b[i] & 15];
  return out;
}

function aesEncrypt(text, key, iv) {
  const enc = fushi.crypto.aes({
    mode: 'cbc', key: key, iv: iv, data: fushi.encoding.utf8Encode(text), padding: 'pkcs7',
  });
  return b64(enc);
}

function rsaRaw(text, exponent, modulus) {
  // 无填充 RSA：把 text 左补零到模长，按大端做 modpow。
  const data = fushi.encoding.utf8Encode(text);
  const mod = hexBytes(modulus);
  const exp = hexBytes(exponent);
  const n = mod.length;
  const buf = new Uint8Array(n);
  // 右对齐（等价于左补零）
  for (let i = 0; i < data.length && i < n; i++) buf[n - data.length + i] = data[i];
  const out = modPow(buf, exp, mod);
  return fushi.encoding.hexEncode(out);
}

function hexBytes(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  const out = new Uint8Array(Math.ceil(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16) || 0;
  return out;
}

// 大整数 modpow（字节数组，大端）。仅用于 encSecKey，模 256 字节，QuickJS 2s 预算内。
function modPow(base, exp, mod) {
  // QuickJS ES2023 支持 BigInt：字节数组 ↔ BigInt（大端）
  function toBig(a) {
    let n = 0n;
    for (let i = 0; i < a.length; i++) n = (n << 8n) | BigInt(a[i]);
    return n;
  }
  function fromBig(n, len) {
    const out = new Uint8Array(len);
    for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
    return out;
  }
  const m = toBig(mod), e = toBig(exp);
  let r = 1n % m, b = toBig(base) % m;
  let ee = e;
  while (ee > 0n) {
    if (ee & 1n) r = (r * b) % m;
    b = (b * b) % m;
    ee >>= 1n;
  }
  return fromBig(r, mod.length);
}

function rsaRaw(text, exponent, modulus) {
  // 无填充 RSA：把 text 左补零到模长，按大端做 modpow。
  const data = fushi.encoding.utf8Encode(text);
  const mod = hexBytes(modulus);
  const exp = hexBytes(exponent);
  const n = mod.length;
  const buf = new Uint8Array(n);
  // 右对齐（等价于左补零）
  for (let i = 0; i < data.length && i < n; i++) buf[n - data.length + i] = data[i];
  const out = modPow(buf, exp, mod);
  return fushi.encoding.hexEncode(out);
}

function hexBytes(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  const out = new Uint8Array(Math.ceil(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16) || 0;
  return out;
}

// 大整数 modpow（字节数组，大端）。仅用于 encSecKey，模 256 字节，QuickJS 2s 预算内。
function modPow(base, exp, mod) {
  // 用 16 位字（大端）做平方-乘，避免 BigInt（QuickJS 无 Intl 但 BigInt 有；这里用字节更稳）
  // 简化实现：逐位平方-乘，字节数组乘法用学校算法。
  function mul(a, b) {
    const r = new Uint8Array(a.length + b.length);
    for (let i = a.length - 1; i >= 0; i--) {
      let carry = 0;
      for (let j = b.length - 1; j >= 0; j--) {
        const k = i + j + 1;
        const t = a[i] * b[j] + r[k] + carry;
        r[k] = t & 255;
        carry = t >> 8;
      }
      r[i] += carry;
    }
    return trim(r);
  }
  function trim(a) {
    let i = 0;
    while (i < a.length - 1 && a[i] === 0) i++;
    return a.slice(i);
  }
  function cmp(a, b) {
    if (a.length !== b.length) return a.length - b.length;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  }
  function sub(a, b) { // a >= b
    const r = a.slice();
    let borrow = 0;
    for (let i = r.length - 1; i >= 0; i--) {
      let t = r[i] - (b[b.length - (r.length - i)] || 0) - borrow;
      if (t < 0) { t += 256; borrow = 1; } else borrow = 0;
      r[i] = t;
    }
    return trim(r);
  }
  function modReduce(a, m) {
    let r = trim(a);
    // 长除法（位级）
    const q = new Uint8Array(r.length);
    let rem = new Uint8Array([0]);
    for (let i = 0; i < r.length * 8; i++) {
      const byte = r[Math.floor(i / 8)];
      const bit = (byte >> (7 - (i % 8))) & 1;
      // rem = rem*2 + bit
      const shifted = rem.slice();
      let carry = bit;
      for (let j = shifted.length - 1; j >= 0; j--) {
        const v = (shifted[j] << 1) | carry;
        shifted[j] = v & 255;
        carry = v >> 8;
      }
      rem = carry ? new Uint8Array([carry]).concat ? concat(new Uint8Array([carry]), shifted) : shifted : shifted;
      if (cmp(rem, m) >= 0) rem = sub(rem, m);
    }
    return trim(rem);
  }
  function concat(a, b) {
    const r = new Uint8Array(a.length + b.length);
    r.set(a, 0); r.set(b, a.length);
    return r;
  }
  let result = new Uint8Array([1]);
  let b = modReduce(base, mod);
  // 从最高位到最低位
  for (let i = 0; i < exp.length * 8; i++) {
    const byte = exp[Math.floor(i / 8)];
    // 大端 exp：先处理最高字节的最高位
  }
  // 用简单的「从左到右」平方乘：exp 按字节遍历，bit 7→0
  let started = false;
  for (let ei = 0; ei < exp.length; ei++) {
    const ebyte = exp[ei];
    for (let bit = 7; bit >= 0; bit--) {
      if (!started) {
        started = true;
        // result 初始为 1，第一次直接取 b
        if ((ebyte >> bit) & 1) result = modReduce(b, mod);
        continue;
      }
      result = modReduce(mul(result, result), mod);
      if ((ebyte >> bit) & 1) result = modReduce(mul(result, b), mod);
    }
  }
  // 补齐到模长
  const out = new Uint8Array(mod.length);
  out.set(result, mod.length - result.length);
  return out;
}

function weapiEncrypt(obj) {
  const text = JSON.stringify(obj);
  const secret = randomKey();
  const params = aesEncrypt(aesEncrypt(text, WE_FIRST_KEY, WE_IV), secret, WE_IV);
  const encSecKey = rsaRaw(secret.split('').reverse().join(''), WE_PUBKEY, WE_MODULUS);
  return { params: params, encSecKey: encSecKey };
}

async function neCookie() {
  try { return (await fushi.credentials.get('ne_cookie')) || ''; } catch (_) { return ''; }
}
async function setNeCookie(v) {
  try { await fushi.credentials.set('ne_cookie', v || ''); } catch (_) { /* noop */ }
}
async function neCsrf() {
  const c = await neCookie();
  const m = c.match(/__csrf=([^;]+)/);
  return m ? m[1] : '';
}

async function neWeapi(path, payload) {
  const enc = weapiEncrypt(Object.assign({ csrf_token: await neCsrf() }, payload));
  const headers = {
    'User-Agent': UA,
    Referer: NE_BASE + '/',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const ck = await neCookie();
  if (ck) headers.Cookie = ck;
  const res = await fushi.http.request({
    url: NE_BASE + path, method: 'POST', headers: headers,
    body: form(enc), timeoutMs: 20000, responseType: 'text',
  });
  if (!res || res.status < 200 || res.status >= 300) return null;
  try { return JSON.parse(res.text); } catch (_) { return null; }
}

// 尝试网易官方直连（需登录）；免费歌返回 url，VIP/失败返回 null。
async function neteaseDirect(songId, quality) {
  const ck = await neCookie();
  if (!ck) return null;
  const br = quality === 'lossless' || quality === 'hires' ? 999000
    : quality === 'high' ? 320000 : 128000;
  let json = null;
  try {
    json = await neWeapi('/weapi/song/enhance/player/url', {
      ids: JSON.stringify([Number(songId)]), br: br,
    });
  } catch (_) { return null; }
  const d = json && json.data && json.data[0];
  if (!d || !d.url) return null;
  const out = { url: d.url, headers: { Referer: NE_BASE + '/', 'User-Agent': UA } };
  if (d.br) out.bitrateKbps = Math.round(Number(d.br) / 1000);
  if (d.type) out.codec = String(d.type).toLowerCase().indexOf('flac') >= 0 ? 'flac' : 'mp3';
  if (d.freeTrialInfo) out.trial = { startMs: 0, endMs: 30000 };
  return out;
}

// ── 网易推荐 / 榜单 / 新歌（第 4 条：推荐页换成这两家） ─────────────────────

async function neteaseRecommend() {
  // 每日推荐需登录；未登录时用「飙升榜/新歌榜」替代。
  const ck = await neCookie();
  let tracks = [];
  if (ck) {
    try {
      const j = await neWeapi('/weapi/v3/discovery/recommend/songs', {});
      const ds = (j && j.recommend) || [];
      tracks = ds.map((x) => ({
        id: 'ne:' + x.id, title: x.name,
        artists: artistsOfRaw(x), durationMs: durationOfRaw(x),
        coverUrl: coverOfRaw(x),
      }));
    } catch (_) { /* 落到榜单 */ }
  }
  if (!tracks.length) {
    try {
      // 飙升榜 id=19723756 / 新歌榜 3779629 / 原创榜 2884035
      const j = await req(NE_BASE + '/api/playlist/detail?id=19723756', { referer: NE_BASE + '/' });
      tracks = ((j && j.result && j.result.tracks) || []).slice(0, 30).map((x) => ({
        id: 'ne:' + x.id, title: x.name,
        artists: artistsOfRaw(x), durationMs: durationOfRaw(x), coverUrl: coverOfRaw(x),
      }));
    } catch (_) { tracks = []; }
  }
  return tracks;
}

async function neteaseTopPlaylists() {
  try {
    const j = await req(NE_BASE + '/api/playlist/highquality/tag?limit=12', { referer: NE_BASE + '/' });
    return ((j && j.playlists) || []).slice(0, 12).map((x) => ({
      id: 'ne-playlist:' + x.id, title: x.name,
      coverUrl: x.coverImgUrl ? String(x.coverImgUrl).replace(/^http:/, 'https:') : undefined,
      playCount: Number(x.playCount) || undefined,
    }));
  } catch (_) { return []; }
}

async function qqTopCharts() {
  // QQ 音乐排行榜（免登录），按 song mid 出曲目
  try {
    const j = await req('https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?format=json', { referer: 'https://y.qq.com/' });
    const list = ((j && jtop(j)) || []).slice(0, 12);
    return list.map((x) => ({
      id: 'qq-playlist:' + (x.id || x.topID), title: x.name || x.ListName,
      coverUrl: x.pic ? String(x.pic).replace(/^http:/, 'https:') : undefined,
    }));
  } catch (_) { return []; }
}
function jtop(j) {
  if (!j) return [];
  return j.topList || (j.data && j.data.topList) || j.list || [];
}

function artistsOfRaw(x) {
  const raw = (x && (x.ar || x.artists)) || [];
  return raw.map((a) => ({ name: a.name })).filter((a) => a.name);
}
function durationOfRaw(x) {
  const v = x && (x.dt != null ? x.dt : x.duration);
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : undefined;
}
function coverOfRaw(x) {
  const u = x && ((x.al && x.al.picUrl) || (x.album && x.album.picUrl) || x.picUrl);
  return u ? String(u).replace(/^http:/, 'https:') : undefined;
}

// ── 歌单 / 收藏 / 下载（第 3 条） ───────────────────────────────────────────

async function neLoginState() {
  const ck = await neCookie();
  if (!ck) return { loggedIn: false };
  // 验证端点：/api/nuser/account/get（明文 GET，带 Cookie；实测无 Cookie 返回
  // account:null，有登录返回 account/profile）。不要用 /weapi/w/nrc/home——它
  // 返回空 body，JSON 解析不了，会把登录误判成未登录（v3.4 之前的 bug）。
  try {
    const j = await req(NE_BASE + '/api/nuser/account/get', { referer: NE_BASE + '/' });
    const acct = j && (j.account || (j.data && j.data.account));
    const prof = j && (j.profile || (j.data && j.data.profile));
    const ok = !!(j && j.code === 200 && (acct || prof));
    const name = (prof && prof.nickname) || (acct && acct.nickname) || '';
    return { loggedIn: ok, name: name };
  } catch (_) {
    return { loggedIn: false };
  }
}

async function nePlaylistCreate(name) {
  const j = await neWeapi('/weapi/playlist/create', { name: name, privacy: '0' });
  if (!j || !j.id) throw new Error('创建歌单失败（需登录）');
  return { id: 'ne-playlist:' + j.id, title: name, editable: true };
}

async function nePlaylistAdd(playlistId, songIds) {
  const ids = songIds.map((x) => String(x).replace(/^ne:/, ''));
  const j = await neWeapi('/weapi/playlist/manipulate/tracks', {
    tracks: JSON.stringify(ids.map((id) => ({ id: id, v: 0 }))),
    pid: playlistId, op: 'add', imme: 'true',
  });
  if (!j || j.code !== 200) throw new Error('加入歌单失败（需登录或该歌单不可编辑）');
  return null;
}

async function nePlaylistRemove(playlistId, songIds) {
  const ids = songIds.map((x) => String(x).replace(/^ne:/, ''));
  await neWeapi('/weapi/playlist/manipulate/tracks', {
    tracks: JSON.stringify(ids.map((id) => ({ id: id, v: 0 }))), pid: playlistId, op: 'del',
  });
  return null;
}

async function nePlaylistDelete(playlistId) {
  await neWeapi('/weapi/playlist/remove', { ids: JSON.stringify([playlistId]) });
  return null;
}

async function neFavoriteSong(songId, on) {
  await neWeapi('/weapi/song/like', {
    trackId: songId, like: on ? 'true' : 'false', v: '1',
  });
  return null;
}

async function neFavoriteAlbum(albumId, on) {
  await neWeapi('/weapi/album/' + (on ? 'sub' : 'unsub'), { id: albumId });
  return null;
}

async function neFavoritePlaylist(playlistId, on) {
  await neWeapi('/weapi/playlist/' + (on ? 'subscribe' : 'unsubscribe'), { id: playlistId });
  return null;
}

// 下载：把流地址交给宿主（Fushi 的 Stream 契约没有"下载"动作，
// 但 playlistEdit/add 可以把曲目加进「下载」歌单；这里提供一个显式能力入口）。
// 实际下载由宿主播放器的下载功能完成，插件只需保证 stream 可解析。
async function downloadUrlFor(id) {
  // 供 main.js 的 playlistEdit/自定义入口使用：返回可下载直链（若可得）
  return null;
}

// ── B 站搜索结果（第 2 条：三组一起放） ─────────────────────────────────────

// ── QQ 音乐官方直连（FuoEvolve QQMusicProvider.qqMediaUrl 的 JS 版） ─────────
//
// sign = "zza" + 随机 10~16 位字母数字 + md5("CJBPACrRuNy7" + data)
// musicu.fcg 的 vkey.GetVkeyServer/CgiGetVkey 返回 midurlinfo[].purl，
// 拼上 sip 得到直链。实测：免登录 / 假 Cookie 时 purl 为空（VIP 与登录门槛），
// 真 QQ 登录 Cookie（qqmusic_key / wxuin / qm_keyst）时可用。

const QQ_VKEY_BASE = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QQ_AUDIO_BASE = 'http://isure.stream.qqmusic.qq.com';
const QQ_SIGN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function qqSign(data) {
  const r = fushi.crypto.randomBytes(16);
  const n = 10 + (r[0] % 7);
  let rp = '';
  for (let i = 0; i < n; i++) rp += QQ_SIGN_ALPHABET[r[i + 1] % QQ_SIGN_ALPHABET.length];
  const md5 = fushi.encoding.hexEncode(fushi.crypto.md5('CJBPACrRuNy7' + data));
  return 'zza' + rp + md5;
}

async function qqCookie() {
  try { return (await fushi.credentials.get('qq_cookie')) || ''; } catch (_) { return ''; }
}
async function setQqCookie(v) {
  try { await fushi.credentials.set('qq_cookie', v || ''); } catch (_) { /* noop */ }
}
function qqUin(cookie) {
  const m = String(cookie || '').match(/(?:wxuin|uin)=o?(\d+)/);
  return m ? m[1] : '0';
}
function qqGuid() {
  // 稳定 guid（QQ 要求 8~10 位数字）
  try {
    const g = fushi.storage.get('qq_guid');
    if (g) return g;
  } catch (_) { /* noop */ }
  const r = fushi.crypto.randomBytes(8);
  let n = 100000000;
  for (let i = 0; i < 4; i++) n = (n + r[i] * (i + 1)) % 900000000 + 100000000;
  const g = String(n);
  try { fushi.storage.set('qq_guid', g); } catch (_) { /* noop */ }
  return g;
}

async function qqDirect(songMid, quality) {
  const cookie = await qqCookie();
  if (!cookie) return null;
  const uin = qqUin(cookie);
  const guid = qqGuid();
  // 质量前缀：C400=m4a 128k, M500=mp3 128k, M800=mp3 320k, F000=flac, O4M000=m4a
  const qmap = { standard: ['C400', 'm4a'], high: ['M800', 'mp3'], lossless: ['F000', 'flac'], hires: ['O4M000', 'm4a'] };
  const [prefix, ext] = qmap[quality] || qmap.standard;
  const request = JSON.stringify({
    req_0: {
      module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
      param: {
        filename: [prefix + songMid + '.' + ext],
        guid: guid, songmid: [songMid], songtype: [0],
        uin: uin, loginflag: 1, platform: '20',
      },
    },
    comm: { uin: uin, format: 'json', ct: 19, cv: 0 },
  });
  const params = {
    sign: qqSign(request), g_tk: '5381', loginUin: '', hostUin: '0',
    format: 'json', inCharset: 'utf8', outCharset: 'utf-8',
    platform: 'yqq.json', needNewCode: '0', data: request,
  };
  const qs = Object.keys(params)
    .map((k) => k + '=' + encodeURIComponent(String(params[k])))
    .join('&');
  let json = null;
  try {
    const res = await fushi.http.request({
      url: QQ_VKEY_BASE + '?' + qs, method: 'GET',
      headers: { 'User-Agent': UA, Referer: 'http://y.qq.com/', Cookie: cookie },
      timeoutMs: 20000, responseType: 'text',
    });
    if (res && res.status >= 200 && res.status < 300) json = JSON.parse(res.text);
  } catch (_) { return null; }
  const d = json && json.req_0 && json.req_0.data;
  const info = d && d.midurlinfo && d.midurlinfo[0];
  let purl = info && info.purl;
  if (!purl) return null;
  if (!/^https?:/.test(purl)) {
    const sip = (d.sip && (d.sip[0] || d.sip[1])) || QQ_AUDIO_BASE + '/';
    purl = sip.replace(/\/$/, '') + '/' + purl.replace(/^\//, '');
  }
  const out = { url: purl, headers: { Referer: 'http://y.qq.com/', 'User-Agent': UA } };
  if (ext === 'flac') out.codec = 'flac';
  else if (ext === 'mp3') out.codec = 'mp3';
  else out.codec = 'm4a';
  return out;
}

// QQ 登录态（给 account() 用）
async function qqLoginState() {
  const cookie = await qqCookie();
  if (!cookie) return { loggedIn: false };
  // 有 uin + qm_keyst 视为已登录
  const ok = /(?:wxuin|uin)=o?\d+/.test(cookie) && /qm_keyst=/.test(cookie);
  return { loggedIn: ok };
}


// ── 按曲目 id 直接取元数据（跨插件包时 radio 用；两家都有免登录详情接口） ──

async function neSongDetail(songId) {
  try {
    const j = await req(NE_BASE + '/api/song/detail?ids=' + encodeURIComponent('[' + songId + ']'), { referer: NE_BASE + '/' });
    const x = j && j.songs && j.songs[0];
    if (!x) return null;
    return {
      title: String(x.name || ''),
      artist: ((x.ar || x.artists || [])[0] || {}).name || '',
      album: ((x.al || x.album) || {}).name || '',
      durationMs: Number(x.dt || x.duration) || 0,
    };
  } catch (_) { return null; }
}

async function qqSongDetail(songMid) {
  try {
    const j = await req('https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=' + encodeURIComponent(songMid) + '&format=json', { referer: 'https://y.qq.com/' });
    const x = j && j.data && j.data[0];
    if (!x) return null;
    return {
      title: String(x.name || ''),
      artist: ((x.singer || [])[0] || {}).name || '',
      album: (x.album || {}).name || '',
      coverUrl: qqCover((x.album || {}).mid),
      durationMs: (Number(x.interval) || 0) * 1000,
    };
  } catch (_) { return null; }
}

// 任意曲目 id → 元数据（先查 storage，再打本家详情接口）
async function resolveMeta(id) {
  const local = await trackMeta(id);
  if (local && local.title) return local;
  const ref = String(id || '');
  const bar = ref.indexOf(':');
  const kind = bar < 0 ? ref : ref.slice(0, bar);
  const rest = bar < 0 ? '' : ref.slice(bar + 1);
  let meta = null;
  if (kind === 'ne') meta = await neSongDetail(rest);
  else if (kind === 'qq') meta = await qqSongDetail(rest);
  if (meta && meta.title) await saveTrackMeta(id, Object.assign({}, meta, { source: '' }));
  return meta;
}


// ── QQ 原生详情接口（实测 2026-11-08 打通，免登录） ────────────────────────
//
// 艺人热门曲：musicu.fcg GetSingerDetail(mid→数字id) + GetSingerSongList(数字id)
// 艺人专辑  ：c.y.qq.com/v8/fcg-bin/fcg_v8_singer_album.fcg?singermid=
// 专辑曲目  ：c.y.qq.com/v8/fcg-bin/fcg_v8_album_detail_cp.fcg?albummid=

const QQ_MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QQ_SINGER_ALBUM = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_singer_album.fcg';
const QQ_ALBUM_DETAIL = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_detail_cp.fcg';

function qqMusicu(reqObj) {
  const data = JSON.stringify(reqObj);
  const url = QQ_MUSICU + '?_=' + Date.now() +
    '&sign=' + encodeURIComponent(qqSign(data)) +
    '&data=' + encodeURIComponent(data);
  return req(url, { referer: 'https://y.qq.com/' });
}

function qqCover(albumMid) {
  return albumMid ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + albumMid + '.jpg' : undefined;
}

function qqSongItem(x) {
  const info = (x && (x.songInfo || x.track_info || x)) || {};
  return {
    id: 'qq:' + (info.mid || ''),
    title: String(info.title || info.name || '').replace(/<[^>]+>/g, ''),
    artists: (info.singer || []).map((a) => ({ name: a.name })),
    album: info.album ? { id: 'qq-album:' + (info.album.mid || ''), title: String(info.album.name || '') } : undefined,
    coverUrl: qqCover(info.album && info.album.mid),
    durationMs: (Number(info.interval) || 0) * 1000 || undefined,
  };
}

// mid → 数字 singerid（缓存进 storage，GetSingerSongList 只认数字 id）
async function qqSingerId(singerMid) {
  try {
    const hit = await fushi.storage.get('qqsid:' + singerMid);
    if (hit) return hit;
  } catch (_) { /* noop */ }
  try {
    const d = await qqMusicu({
      req_0: { module: 'music.musichallSinger.SingerInfoInter', method: 'GetSingerDetail',
        param: { singer_mids: [singerMid], pic: 1, group_singer: 1, wiki_singer: 1, ex_singer: 1 } },
      comm: { g_tk: '5381', uin: '0', format: 'json' },
    });
    const list = (d && d.req_0 && d.req_0.data && d.req_0.data.singer_list) || [];
    const bi = (list[0] && list[0].basic_info) || {};
    const sid = String(bi.singer_id || (list[0] && list[0].singer_id) || '');
    if (sid) { try { await fushi.storage.set('qqsid:' + singerMid, sid); } catch (_) { /* noop */ } }
    return sid;
  } catch (_) { return ''; }
}

async function qqSingerSongs(singerMid, offset, limit) {
  const sid = await qqSingerId(singerMid);
  if (!sid) return { items: [], total: 0 };
  try {
    const d = await qqMusicu({
      req_0: { module: 'music.musichallSong.SongListInter', method: 'GetSingerSongList',
        param: { singerid: Number(sid), begin: offset, num: limit, order: 1, newsong: 1 } },
      comm: { g_tk: '5381', uin: '0', format: 'json' },
    });
    const data = (d && d.req_0 && d.req_0.data) || {};
    const items = (data.songList || []).map(qqSongItem).filter((x) => x.id !== 'qq:');
    return { items, total: Number(data.totalNum) || 0 };
  } catch (_) { return { items: [], total: 0 }; }
}

async function qqSingerAlbums(singerMid, offset, limit) {
  try {
    const d = await req(QQ_SINGER_ALBUM + '?singermid=' + encodeURIComponent(singerMid) +
      '&order=time&begin=' + offset + '&num=' + limit, { referer: 'https://y.qq.com/' });
    const data = (d && d.data) || {};
    const items = (data.list || []).map((x) => ({
      id: 'qq-album:' + (x.albumMID || ''),
      title: String(x.albumName || ''),
      artists: [{ name: String(x.singername || '') }].filter((a) => a.name),
      coverUrl: x.albumMID ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + x.albumMID + '.jpg' : undefined,
      year: Number(String(x.pubTime || '').slice(0, 4)) || undefined,
      trackCount: (x.latest_song && x.latest_song.song_count) || undefined,
    })).filter((x) => x.id !== 'qq-album:');
    return { items, total: Number(data.total) || 0 };
  } catch (_) { return { items: [], total: 0 }; }
}

async function qqAlbumTracks(albumMid, limit) {
  try {
    const d = await req(QQ_ALBUM_DETAIL + '?albummid=' + encodeURIComponent(albumMid) +
      '&format=json&newsong=1', { referer: 'https://y.qq.com/' });
    const data = (d && d.data) || {};
    const songs = data.getSongInfo || [];
    const items = songs.map((x) => ({
      id: 'qq:' + (x.mid || ''),
      title: String(x.title || x.name || ''),
      artists: (x.singer || []).map((a) => ({ name: a.name })),
      coverUrl: qqCover(x.album && x.album.mid ? x.album.mid : albumMid),
      durationMs: (Number(x.interval) || 0) * 1000 || undefined,
      trackNo: Number(x.index_cd) || undefined,
    })).filter((x) => x.id !== 'qq:').slice(0, limit || 50);
    const info = data.getAlbumInfo || {};
    return {
      album: {
        id: 'qq-album:' + albumMid,
        title: String(info.Falbum_name || ''),
        coverUrl: albumMid ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + albumMid + '.jpg' : undefined,
        year: Number(String(info.Fpublic_time || '').slice(0, 4)) || undefined,
        trackCount: items.length || undefined,
      },
      tracks: items,
    };
  } catch (_) { return { album: { id: 'qq-album:' + albumMid, title: '' }, tracks: [] }; }
}


// ── 网易原生艺人接口（实测 2026-11-08 免登录可用） ─────────────────────────
// 热门曲：GET /api/artist/{id} → hotSongs（50 首，官方"热门50首"）
// 专辑：  GET /api/artist/albums/{id}?offset&limit → hotAlbums + total

async function neArtistSongs(artistId, limit) {
  const j = await req(NE_BASE + '/api/artist/' + encodeURIComponent(artistId), { referer: NE_BASE + '/' });
  const hs = (j && j.hotSongs) || [];
  return hs.slice(0, limit || 50).map((x) => ({
    id: 'ne:' + x.id,
    title: String(x.name || ''),
    artists: (x.artists || []).map((a) => ({ name: String(a.name || '') })).filter((a) => a.name),
    album: x.album ? { id: 'ne-album:' + x.album.id, title: String(x.album.name || '') } : undefined,
    durationMs: Number(x.duration) || undefined,
  })).filter((x) => x.id !== 'ne:' && x.title);
}

async function neArtistAlbums(artistId, offset, limit) {
  const j = await req(NE_BASE + '/api/artist/albums/' + encodeURIComponent(artistId) +
    '?offset=' + (offset || 0) + '&limit=' + (limit || 30), { referer: NE_BASE + '/' });
  const ha = (j && j.hotAlbums) || [];
  const items = ha.map((x) => {
    let year;
    if (x.publishTime) { const d = new Date(Number(x.publishTime)); if (!isNaN(d.getFullYear())) year = d.getFullYear(); }
    return {
      id: 'ne-album:' + x.id,
      title: String(x.name || ''),
      artists: [{ name: String((x.artist && x.artist.name) || '') }].filter((a) => a.name),
      coverUrl: x.picUrl ? String(x.picUrl).replace(/^http:/, 'https:') : undefined,
      year: year,
      trackCount: Number(x.size) || undefined,
    };
  }).filter((x) => x.id !== 'ne-album:' && x.title);
  return { items, total: Number(j && j.total) || items.length };
}


module.exports = {
  NE_BASE, QQ_SEARCH, QQ_LYRIC, UA,
  form, req,
  neteaseSearch, qqSearch,
  neteaseLyric, qqLyric, lyricsForId,
  trackMeta, saveTrackMeta,
  neTrack, neArtist, neAlbum, nePlaylist,
  // v3 新增
  neteaseDirect, neCookie, setNeCookie, neCsrf, neWeapi, weapiEncrypt,
  neteaseRecommend, neteaseTopPlaylists, qqTopCharts,
  neLoginState, nePlaylistCreate, nePlaylistAdd, nePlaylistRemove, nePlaylistDelete,
  neFavoriteSong, neFavoriteAlbum, neFavoritePlaylist,
  artistsOfRaw, durationOfRaw, coverOfRaw,
  neSongDetail, qqSongDetail, resolveMeta,
  qqSingerSongs, qqSingerAlbums, qqAlbumTracks, qqSingerId,
  neArtistSongs, neArtistAlbums,
  // v3.1 新增
  qqDirect, qqSign, qqCookie, setQqCookie, qqLoginState,
};

