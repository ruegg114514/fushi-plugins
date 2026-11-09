'use strict';
/// B 站 API 层：WBI 签名、通用请求、实体映射。
/// 移植自 HanversionOvO/BiliMusic (src/services/bilibiliApi.ts, electron/biliApi.ts)。
/// 运行环境是 Fushi 的 QuickJS 沙箱：只能用 fushi.http / fushi.crypto / fushi.encoding / fushi.storage /
/// fushi.credentials，没有 fetch、setTimeout、Buffer、TextEncoder、process。

const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
const REFERER = 'https://www.bilibili.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// B 站音频 CDN 的 baseUrl / backupUrl 都要带 Referer，否则 403。
const AUDIO_HEADERS = {
  Referer: REFERER,
  'User-Agent': UA,
};

const CRED_KEYS = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];

function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += ('0' + (bytes[i] & 255).toString(16)).slice(-2);
  }
  return s;
}

function md5Hex(str) {
  // fushi.crypto.md5 接受字符串或 Uint8Array，返回 Uint8Array。
  return toHex(fushi.crypto.md5(str));
}

function httpsUrl(u) {
  if (!u) return '';
  if (u.slice(0, 2) === '//') return 'https:' + u;
  if (u.slice(0, 7) === 'http://') return 'https://' + u.slice(7);
  return u;
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// 形如 "3:20" / "12:05" / "1:02:03" → 毫秒
function parseDuration(text) {
  const parts = String(text || '').split(':').map((x) => Number(x) || 0);
  if (!parts.length) return 0;
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s * 1000;
}

function encodeURIComponentStrict(value) {
  // WBI 要求参数值里的 !'()* 先删掉，再编码；与 BiliMusic 的 encodeWbi 一致。
  return encodeURIComponent(String(value).replace(/[!'()*]/g, ''));
}

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

function mixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n] || '').join('').slice(0, 32);
}

let wbiCache = null;

async function getWbiKeys() {
  // 缓存 2 小时；密钥每日轮换，实例随时可能重建，所以同时存 storage。
  if (wbiCache && Date.now() - wbiCache.ts < 2 * 3600 * 1000) {
    return wbiCache;
  }
  try {
    const cached = await fushi.storage.get('wbi');
    if (cached) {
      const v = JSON.parse(cached);
      if (v && v.imgKey && v.subKey && Date.now() - v.ts < 2 * 3600 * 1000) {
        wbiCache = v;
        return v;
      }
    }
  } catch (_) {
    // 忽略坏缓存
  }
  const res = await request('/x/web-interface/nav', {}, { raw: true });
  const wbi = res && res.data && res.data.wbi_img;
  if (!wbi || !wbi.img_url || !wbi.sub_url) {
    throw new Error('无法获取 B 站 WBI 签名密钥（nav 接口异常）');
  }
  const fileName = (u) => u.slice(u.lastIndexOf('/') + 1).split('.')[0];
  const v = {
    imgKey: fileName(wbi.img_url),
    subKey: fileName(wbi.sub_url),
    ts: Date.now(),
  };
  wbiCache = v;
  try {
    await fushi.storage.set('wbi', JSON.stringify(v));
  } catch (_) {
    // storage 不可用时仅用内存缓存
  }
  return v;
}

async function encodeWbi(params) {
  const keys = await getWbiKeys();
  const mixin = mixinKey(keys.imgKey + keys.subKey);
  const signed = Object.assign({}, params, { wts: Math.round(Date.now() / 1000) });
  const query = Object.keys(signed)
    .sort()
    .map((k) => k + '=' + encodeURIComponentStrict(signed[k]))
    .join('&');
  return query + '&w_rid=' + md5Hex(query + mixin);
}

async function readCredentialString() {
  const parts = [];
  for (const name of CRED_KEYS) {
    let v = null;
    try {
      v = await fushi.credentials.get(name);
    } catch (_) {
      v = null;
    }
    if (v) parts.push(name + '=' + v);
  }
  return parts.join('; ');
}

async function writeCredentialString(cookie) {
  const map = {};
  for (const pair of String(cookie || '').split(';')) {
    const i = pair.indexOf('=');
    if (i < 1) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (CRED_KEYS.indexOf(k) >= 0) map[k] = v;
  }
  for (const name of CRED_KEYS) {
    if (map[name]) {
      await fushi.credentials.set(name, map[name]);
    } else {
      try {
        await fushi.credentials.remove(name);
      } catch (_) {
        // 键不存在时忽略
      }
    }
  }
  return map;
}

async function clearCredentials() {
  for (const name of CRED_KEYS) {
    try {
      await fushi.credentials.remove(name);
    } catch (_) {
      // 忽略
    }
  }
}

async function http(url, opts) {
  opts = opts || {};
  const headers = {
    Referer: opts.referer || REFERER,
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    Origin: REFERER,
  };
  const cookie = await readCredentialString();
  if (cookie) headers.Cookie = cookie;
  if (opts.method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (opts.headers) Object.assign(headers, opts.headers);
  const res = await fushi.http.request({
    url: url,
    method: opts.method || 'GET',
    headers: headers,
    body: opts.method === 'POST' ? (opts.body || formBody(opts.params || {})) : undefined,
    timeoutMs: opts.timeoutMs || 20000,
    responseType: 'text',
  });
  if (opts.rawResponse) return res;
  if (!res || res.status < 200 || res.status >= 300) {
    throw new Error('B 站请求失败：HTTP ' + (res ? res.status : 'no response'));
  }
  let json;
  try {
    json = JSON.parse(res.text);
  } catch (_) {
    // 未带 WBI 签名 / 被反爬时 B 站会回一个 HTML 风控页。
    throw new Error('B 站返回的不是 JSON（可能触发风控，请检查 WBI 签名或稍后重试）');
  }
  return json;
}

function formBody(params) {
  return Object.keys(params)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])))
    .join('&');
}

// 普通 API：检查 code !== 0 抛错，返回 data。
async function request(path, params, opts) {
  opts = opts || {};
  const p = params || {};
  let url;
  let queryParams = p;
  if (opts.absolute) {
    url = path;
  } else {
    url = API + path;
  }
  // POST 的参数走表单 body；GET 走 query（cookie / csrf 已在 http() 里注入）。
  if (opts.method === 'POST') {
    const json = await http(url, Object.assign({}, opts, { params: p }));
    if (opts.raw) return json;
    if (json.code !== 0) {
      throw new Error('B 站 API ' + json.code + '：' + (json.message || '未知错误'));
    }
    return json.data;
  }
  const qs = Object.keys(queryParams)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(queryParams[k])))
    .join('&');
  if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs;
  const json = await http(url, opts);
  if (opts.raw) return json;
  if (json.code !== 0) {
    throw new Error('B 站 API ' + json.code + '：' + (json.message || '未知错误'));
  }
  return json.data;
}

// WBI 签名接口：query 必须原样拼接，不能经过 URL 对象再编码。
async function requestWbi(path, params, opts) {
  const query = await encodeWbi(params);
  const referer = (opts && opts.referer) || REFERER;
  const json = await http(API + path + '?' + query, { referer });
  if (json.code !== 0) {
    throw new Error('B 站 API ' + json.code + '：' + (json.message || '未知错误'));
  }
  return json.data;
}

// ── 综合搜索（移植自 FuoEvolve BilibiliComprehensiveSearchProvider） ────────
//
// /x/web-interface/search/all/v2 免 WBI 签名，一次请求同时返回多组结果：
//   video / bili_user / media_bangumi / media_ft / ...
// 比按 type 分别打 wbi/search/type 少一次请求，且能拿"平台原生最佳匹配"。
// 实测：34KB、code=0、video 组 20 条，title 里带 <em class="keyword"> 高亮。

async function comprehensiveSearch(keyword) {
  const url = API + '/x/web-interface/search/all/v2?keyword=' + encodeURIComponent(keyword);
  const json = await http(url, { referer: REFERER });
  if (json.code !== 0) {
    throw new Error('B 站综合搜索 ' + json.code + '：' + (json.message || '未知错误'));
  }
  const groups = (json.data && json.data.result) || [];
  const out = { tracks: [], artists: [], albums: [], videos: [], nativeBest: null };
  for (const g of groups) {
    const type = g && g.result_type;
    const rows = (g && g.data) || [];
    for (const v of rows) {
      if (type === 'video') {
        const t = trackFromVideo(v);
        out.tracks.push(t);
        if (v.bvid) out.videos.push({ id: String(v.bvid), title: stripHtml(v.title || '') });
        if (!out.nativeBest && v.bvid) out.nativeBest = { kind: 'track', value: t };
      } else if (type === 'bili_user' || type === 'user') {
        const a = artistFromUser({ mid: v.mid, uname: v.uname || v.name, upic: v.upic || v.face, usign: v.usign, fans: v.fans, videos: v.videos });
        out.artists.push(a);
        if (!out.nativeBest) out.nativeBest = { kind: 'artist', value: a };
      } else if (type === 'media_bangumi' || type === 'media_ft') {
        const sid = v.season_id || v.seasonId;
        if (sid) {
          const album = {
            id: 'season:' + sid,
            title: stripHtml(v.title || v.org_title || '未命名'),
            description: String(v.evaluate || (v.new_ep && v.new_ep.index_show) || '').slice(0, 20000),
            coverUrl: httpsUrl(v.cover || ''),
          };
          out.albums.push(album);
          if (!out.nativeBest) out.nativeBest = { kind: 'album', value: album };
        }
      }
    }
  }
  return out;
}

// 从 /x/player/v2 的 bgm_info.music_title 取 B 站自己识别的背景音乐名。
// FuoEvolve 用它当歌词搜索关键词（比视频标题可靠）；实测只有部分视频带这个字段，
// 且值常形如「发现《Lemon》」，需要歌词层再做书名号提取。
async function playerV2(bvid, cid) {
  try {
    return await request('/x/player/v2', { bvid: bvid, cid: cid });
  } catch (_) {
    return null;
  }
}

async function bgmTitle(bvid, cid) {
  const d = await playerV2(bvid, cid);
  const t = d && d.bgm_info && d.bgm_info.music_title;
  return t ? String(t).trim() : '';
}

// ── 实体映射 ────────────────────────────────────────────────────────────────

// 搜索结果 / UP 主视频 / 收藏夹 / 排行榜统一转成 Fushi Track。
// id 用 "bv:<bvid>"，stream 时再拆出 cid 取流；纯 avid+cid 回退用 "av:<aid>:<cid>"。
function trackFromVideo(v, fallback) {
  const bvid = v.bvid || (fallback && fallback.bvid) || '';
  const aid = v.aid || v.avid || (fallback && fallback.aid) || 0;
  const cid = v.cid || (fallback && fallback.cid) || 0;
  const title = stripHtml(v.title || (fallback && fallback.title) || '未命名');
  const artists = [];
  const name = stripHtml(
    v.author || v.owner || (v.owner && v.owner.name) || (fallback && fallback.artist) || '',
  );
  if (name) artists.push({ name: name });
  const cover = httpsUrl(v.pic || v.cover || (fallback && fallback.coverUrl) || '');
  const id = bvid ? 'bv:' + bvid : 'av:' + aid + ':' + cid;
  const out = {
    id: id,
    title: title,
    artists: artists,
    album: v.albumTitle ? { title: stripHtml(v.albumTitle) } : undefined,
  };
  const rawDur = v.duration != null ? v.duration : v.length;
  if (typeof rawDur === 'number' && rawDur > 0) {
    out.durationMs = rawDur > 100000 ? rawDur : rawDur * 1000;
  } else {
    const ms = parseDuration(rawDur || v.durationText);
    if (ms > 0) out.durationMs = ms;
  }
  if (cover) out.coverUrl = cover;
  if (v.note) out.note = String(v.note);
  return out;
}

function albumFromVideo(v) {
  const out = {
    id: 'bv:' + v.bvid,
    title: stripHtml(v.title || '未命名'),
  };
  const name = stripHtml(v.author || (v.owner && v.owner.name) || '');
  if (name) out.artists = [{ name: name }];
  const cover = httpsUrl(v.pic || v.cover || '');
  if (cover) out.coverUrl = cover;
  if (v.play != null) out.playCount = Number(v.play) || 0;
  return out;
}

function artistFromUser(u) {
  const out = { id: 'mid:' + u.mid, name: stripHtml(u.uname || u.name || 'UID ' + u.mid) };
  const face = httpsUrl(u.upic || u.face || '');
  if (face) out.coverUrl = face;
  if (u.usign) out.description = String(u.usign).slice(0, 20000);
  if (u.fans != null || u.videos != null) {
    out.stats = {
      fanCount: Number(u.fans) || 0,
      trackCount: Number(u.videos) || 0,
    };
  }
  return out;
}

module.exports = {
  API,
  PASSPORT,
  REFERER,
  UA,
  AUDIO_HEADERS,
  CRED_KEYS,
  md5Hex,
  httpsUrl,
  stripHtml,
  parseDuration,
  encodeWbi,
  request,
  requestWbi,
  comprehensiveSearch,
  playerV2,
  bgmTitle,
  http,
  readCredentialString,
  writeCredentialString,
  clearCredentials,
  trackFromVideo,
  albumFromVideo,
  artistFromUser,
};
