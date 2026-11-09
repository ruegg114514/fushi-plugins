'use strict';
/// 歌词：优先 B 站视频字幕（CC 字幕 JSON），否则 LRCLIB；标题清洗移植自 BiliMusic。
/// 宿主本身也有内置 LRCLIB，这里再提供一份是为了歌词插件能力（lyricsSearch/lyricsFetch）
/// 能给**任意来源**的本地曲目搜歌词。

const bili = require('./bili');
const LRCLIB = 'https://lrclib.net';

// 标题噪声词（BiliMusic lyrics.ts 的精简版）
const NOISE = /(official|mv|official\s*(music\s*)?video|pv|tv\s*size|full|完整版|高清|4k|8k|60fps|无损|flac|hires|hi-res|歌词|字幕|翻唱|cover|live|现场|remix|伴奏|inst|纯音乐|op|ed|ost|主题曲|片头|片尾|插入曲|试听|amv|mad|合集|盘点|循环|一小时|一小时|个小时|分钟|【.*?】)/i;
const CJK_QUOTE = /[「『“"《]([^」』”"》]+)[」』”"》]/g;
const SEP = /[-–—_|/\\·•～~「」『』"'`*:：，,;；]/g;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
const CJK_NOISE = /(官方|高清|完整|无损|字幕|歌词|现场|翻唱|合集|盘点|推荐|首发|新歌|专辑|试听|限定|特别版|remaster|202\d|20\d\d)/gi;
const LATIN_NOISE = /\b(official|music|video|lyrics?|audio|hd|hq|4k|8k|full|cover|live|remix|inst(rumental)?|mv|pv|op|ed|ost|feat\.?|ft\.?)\b/gi;

function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function cleanSeg(raw) {
  if (!raw) return '';
  let s = String(raw).normalize('NFKC');
  s = s.replace(/#[^\s#]+/g, ' ');
  s = s.replace(EMOJI, ' ');
  s = s.replace(/[!！?？.。]+/g, ' ');
  s = s.replace(CJK_NOISE, ' ');
  s = s.replace(LATIN_NOISE, ' ');
  s = s.replace(/\b\d+\s*(?:首|小时|分钟|mins?|hours?)\b/gi, ' ');
  s = s.replace(SEP, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function cleanTitle(raw) {
  if (!raw) return '';
  let s = String(raw).normalize('NFKC');
  s = s.replace(CJK_QUOTE, ' $1 ');
  s = s.replace(/[【[(（]([^】\])）]*)[】\])）]/g, (_m, inner) =>
    NOISE.test(inner) ? ' ' : ' ' + inner + ' ');
  return cleanSeg(s) || String(raw).trim().slice(0, 40);
}

function uniqPush(list, value) {
  const v = String(value || '').replace(/\s+/g, ' ').trim();
  if (v.length >= 2 && !list.some((x) => norm(x) === norm(v))) list.push(v);
}

function queryCandidates(raw) {
  const cands = [];
  const normalized = String(raw || '').normalize('NFKC');
  const quotes = [];
  for (const m of normalized.matchAll(CJK_QUOTE)) uniqPush(quotes, cleanSeg(m[1]));
  const context = cleanSeg(normalized.replace(CJK_QUOTE, ' '));
  for (const t of quotes) {
    uniqPush(cands, t);
    if (context) uniqPush(cands, t + ' ' + context);
  }
  const parts = normalized.replace(CJK_QUOTE, ' $1 ').split(/[【】[\]()（）]|[-–—_|/\\·•～~「」『』"'`*:：，,;；]/);
  for (const p of parts) if (!NOISE.test(p)) uniqPush(cands, cleanSeg(p));
  uniqPush(cands, cleanTitle(raw));
  return cands.filter((c) => !/^(av|bv)[\da-z]+$/i.test(c)).slice(0, 8);
}

function dice(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = bigrams(x), B = bigrams(y);
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}

function scoreCandidate(c, ctx) {
  let score = 0;
  const cn = norm(c.title);
  const target = norm(ctx.clean || ctx.title);
  // 完全相等 > 前缀/包含 > 模糊相似度。避免所有同名曲都拿满 360 分。
  if (target && cn === target) score += 420;
  else if (target && cn.indexOf(target) >= 0) score += 260;
  else if (target && target.indexOf(cn) >= 0 && cn.length >= 2) score += 180;
  else score += dice(c.title, ctx.clean || ctx.title) * 160;

  const ca = norm(c.artist || '');
  const artist = norm(ctx.artist || '');
  if (artist && ca) {
    if (ca === artist || ca.indexOf(artist) >= 0 || artist.indexOf(ca) >= 0) score += 340;
    else if (dice(c.artist || '', ctx.artist || '') > 0.4) score += 90;
  }
  if (ctx.durationMs && c.durationMs) {
    const diff = Math.abs(c.durationMs - ctx.durationMs);
    score += diff < 3000 ? 140 : diff < 10000 ? 50 : 0;
  }
  // 语言惩罚：目标是日/中文歌时，歌词正文里大量拉丁/西里尔字符说明是同名异曲。
  const sample = String(c.lyricsSample || c.text || '');
  if (sample) {
    const cjk = (sample.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
    const latin = (sample.match(/[A-Za-z\u00c0-\u024f]/g) || []).length;
    if (latin > 0 && cjk === 0 && /[\u3040-\u30ff\u4e00-\u9fff]/.test(String(ctx.videoTitle || ctx.title || ''))) {
      score -= 220;
    }
  }
  return score;
}

// ── B 站 CC 字幕 → LRC ─────────────────────────────────────────────────────

function lrcFromSubtitle(body) {
  const lines = (body && body.body) || [];
  if (!lines.length) return null;
  const rows = [];
  for (const l of lines) {
    const from = Number(l.from) || 0;
    const to = Number(l.to) || from;
    const content = String(l.content || '').replace(/\r?\n/g, ' ').trim();
    if (!content) continue;
    rows.push({ from, to, content });
  }
  if (!rows.length) return null;
  const stamp = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return '[' + String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0') + ']';
  };
  const out = rows.map((r) => stamp(r.from) + r.content).join('\n');
  return { format: 'lrc', text: out };
}

async function biliSubtitle(id) {
  const ref = String(id || '');
  const i = ref.indexOf(':');
  const kind = i < 0 ? ref : ref.slice(0, i);
  const rest = i < 0 ? '' : ref.slice(i + 1);
  if (kind !== 'bv') return null;
  let d;
  try {
    d = await bili.request('/x/web-interface/view', { bvid: rest });
  } catch (_) {
    return null;
  }
  const cid = d.cid || (d.pages && d.pages[0] && d.pages[0].cid);
  if (!cid) return null;
  // 一次拿 player/v2，字幕轨 + bgm_info 都在这里。
  const player = await bili.playerV2(rest, cid);
  const subs = player && player.subtitle && player.subtitle.subtitles;
  if (!subs || !subs.length) return null;
  const url = subs[0].subtitle_url;
  if (!url) return null;
  const abs = bili.httpsUrl(url);
  try {
    const res = await bili.http(abs, { referer: bili.REFERER });
    // bili.http 返回 JSON.parse 结果；字幕 JSON 直接就是 { body: [...] }
    return lrcFromSubtitle(res);
  } catch (_) {
    return null;
  }
}

// ── 歌词搜索关键词：bgm_info 优先（FuoEvolve lyricsSearchKeyword 的设计） ──
//
// 视频标题常是「【4K】米津玄师《Lemon》2019 神级现场」，直接拿去 LRCLIB 搜
// 命中率很差。B 站的 /x/player/v2 里 bgm_info.music_title 是平台自己识别的
// BGM 名（实测形如「发现《Lemon》」），再提取书名号就是干净的歌名。
// 只有部分视频带该字段，所以三级降级：bgm → 标题清洗 → 原样。

function quotedSongName(s) {
  const m = String(s || '').normalize('NFKC').match(/[《「『“"]([^》」』”"]+)[》」』”"]/);
  return m ? cleanSeg(m[1]) : '';
}

// 从视频标题里猜艺人：常见写法「米津玄师《Lemon》」「Lemon - 米津玄师」
// 「【4K】米津玄師『Lemon』MV」。书名号/引号里是歌名，紧邻的中文/日文片段是艺人。
function guessArtist(rawTitle, songName, uploader) {
  const s = String(rawTitle || '').normalize('NFKC');
  const cands = [];
  const quoted = /[《「『“"]([^》」』”"]+)[》」』”"]/g;
  let m;
  while ((m = quoted.exec(s)) !== null) {
    const before = s.slice(0, m.index);
    const after = s.slice(m.index + m[0].length);
    // 书名号前、后各取一段
    const seg = before.replace(/[【】\[\]()（）|｜/\\·•～~\-–—_#:：,，;；]/g, ' ').trim();
    const seg2 = after.replace(/[【】\[\]()（）|｜/\\·•～~\-–—_#:：,，;；]/g, ' ').trim();
    for (const x of [seg, seg2]) {
      const parts = x.split(/\s+/).filter(Boolean);
      // 取最后一段（紧邻歌名的通常是艺人）
      const tail = parts[parts.length - 1] || '';
      if (tail) cands.push(tail);
    }
  }
  // 「歌名 - 艺人」形式
  const dash = s.match(/(?:^|[\s|｜])([^\s《》「」『』【】\-–—_]+)\s*[-–—]\s*([^\s《》「」『』【】\-–—_]+)/);
  if (dash) cands.push(dash[1], dash[2]);
  const noise = NOISE;
  const good = cands
    .map((x) => cleanSeg(x))
    .filter((x) => x && x.length >= 2 && x.length <= 24 && !noise.test(x) && norm(x) !== norm(songName));
  if (good.length) return good[0];
  return String(uploader || '');
}

async function keywordForTrack(id) {
  const ref = String(id || '');
  const i = ref.indexOf(':');
  const kind = i < 0 ? ref : ref.slice(0, i);
  const rest = i < 0 ? '' : ref.slice(i + 1);
  let d = null;
  try {
    d = kind === 'bv' ? await bili.request('/x/web-interface/view', { bvid: rest }) : null;
  } catch (_) {
    d = null;
  }
  const rawTitle = d ? d.title : '';
  const uploader = d ? (d.owner && d.owner.name) || '' : '';
  const durationMs = d ? (Number(d.duration) || 0) * 1000 : 0;
  const base = { title: '', artist: '', durationMs: durationMs, source: '', videoTitle: rawTitle };

  // 1) bgm_info.music_title
  if (d) {
    const cid = d.cid || (d.pages && d.pages[0] && d.pages[0].cid);
    if (cid) {
      const bgm = await bili.bgmTitle(rest, cid);
      const song = quotedSongName(bgm) || cleanSeg(bgm);
      if (song && song.length >= 2) {
        return Object.assign({}, base, {
          title: song,
          artist: guessArtist(rawTitle, song, uploader),
          source: 'bgm',
        });
      }
    }
  }
  // 2) 标题清洗（书名号优先）
  const quoted = quotedSongName(rawTitle);
  if (quoted) {
    return Object.assign({}, base, {
      title: quoted, artist: guessArtist(rawTitle, quoted, uploader), source: 'quoted',
    });
  }
  const cleaned = cleanTitle(rawTitle);
  if (cleaned) {
    return Object.assign({}, base, {
      title: cleaned, artist: guessArtist(rawTitle, cleaned, uploader), source: 'cleaned',
    });
  }
  return Object.assign({}, base, { title: String(ref), artist: uploader, source: 'raw' });
}

// ── 多轨富歌词（FuoEvolve composeRichLyrics 的 Fushi 契约版） ──────────────
//
// Fushi 的 lyrics 返回 { original, translation?, romanization? }，正好对应
// FuoEvolve 的"原文 / 翻译 / 罗马音三条轨"。LRCLIB 没有翻译轨，但：
//   * 有 syncedLyrics 时用它当 original（lrc）
//   * 若候选里带不同语言版本，按时间配对成 translation
//   * 逐字格式（yrc/qrc/ttml）优先，行级降级

function composeTracks(d) {
  if (!d) return null;
  const synced = d.syncedLyrics || d.synced_lyrics;
  const plain = d.plainLyrics || d.plain_lyrics;
  const text = synced || plain;
  if (!text) return null;
  const out = {
    original: { format: synced ? 'lrc' : 'txt', text: String(text) },
  };
  return out;
}

// 关联缓存：把「视频 id → 选中的 LRCLIB 歌词 id」记住，避免每次重搜。
// FuoEvolve 用持久化 association + 对齐偏移；Fushi 插件只有 storage，够用。
async function rememberAssociation(trackId, ref) {
  try {
    await fushi.storage.set('lyric-assoc:' + trackId, JSON.stringify(ref));
  } catch (_) {
    // 存储不可用时忽略
  }
}

async function readAssociation(trackId) {
  try {
    const raw = await fushi.storage.get('lyric-assoc:' + trackId);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

// ── LRCLIB ─────────────────────────────────────────────────────────────────

async function lrclibSearch(params) {
  const qs = Object.keys(params)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])))
    .join('&');
  const res = await bili.http(LRCLIB + '/api/search?' + qs, { referer: LRCLIB, raw: true });
  return Array.isArray(res) ? res : [];
}

async function lrclibGet(id) {
  const res = await bili.http(LRCLIB + '/api/get/' + encodeURIComponent(String(id)), { referer: LRCLIB, raw: true });
  return res || null;
}

function lrclibToLyric(d) {
  return composeTracks(d);
}

async function lrclibByMeta(args) {
  const title = cleanTitle(args.title || args.query || '');
  const artist = String(args.artist || '');
  const album = String(args.album || '');
  let list = [];
  if (title && artist) {
    list = await lrclibSearch({ track_name: title, artist_name: artist, album_name: album });
  }
  if (!list.length && title && artist) {
    // 精确（三段式）没结果时，用「歌名 + 艺人」组合查询，比裸 q=歌名 准得多。
    list = await lrclibSearch({ q: title + ' ' + artist });
  }
  if (!list.length && title) list = await lrclibSearch({ q: title });
  return list;
}

// 给候选补一份歌词样本，用于语言/内容匹配打分（LRCLIB /api/get 很轻）。
async function enrichCandidates(list, limit) {
  const out = [];
  for (const d of list.slice(0, limit)) {
    const item = Object.assign({}, d);
    try {
      const full = await lrclibGet(d.id);
      if (full) {
        item.lyricsSample = String(full.plainLyrics || full.syncedLyrics || '').slice(0, 400);
        item.full = full;
      }
    } catch (_) {
      // 取不到详情就只用元数据打分
    }
    out.push(item);
  }
  return out;
}

// ── 对外能力 ───────────────────────────────────────────────────────────────

async function forTrack(id) {
  // 0) 手动/记下的关联优先（FuoEvolve 的 manual association 持久化）。
  const assoc = await readAssociation(id);
  if (assoc && assoc.id) {
    try {
      const hit = lrclibToLyric(await lrclibGet(assoc.id));
      if (hit) return hit;
    } catch (_) {
      // 关联失效就重新搜
    }
  }
  // 1) B 站自带 CC 字幕（最贴合视频时间轴）
  try {
    const sub = await biliSubtitle(id);
    if (sub) return { original: sub };
  } catch (_) {
    // 落到 LRCLIB
  }
  // 2) bgm_info → 标题清洗 → 视频标题，拿到的歌名去 LRCLIB 搜并打分
  const meta = await keywordForTrack(id);
  const list = await lrclibByMeta(meta);
  if (list.length) {
    const ctx = {
      clean: cleanTitle(meta.title),
      title: meta.title,
      artist: meta.artist,
      durationMs: meta.durationMs,
      videoTitle: meta.videoTitle,
    };
    // 只给前 5 个候选补歌词样本，控制请求数（QuickJS 沙箱有 32 在途上限）。
    const enriched = await enrichCandidates(list, 5);
    const rest = list.slice(5).map((d) => Object.assign({}, d));
    const best = enriched.concat(rest)
      .sort((a, b) => scoreCandidate(b, ctx) - scoreCandidate(a, ctx))[0];
    const lyric = lrclibToLyric(best.full || best);
    if (lyric) {
      if (best && best.id) await rememberAssociation(id, { id: best.id, title: meta.title });
      return lyric;
    }
  }
  return null;
}

async function search(args) {
  // 宿主会用多个 query 变体调用，不要再加自己的多轮兜底。
  const q = String(args.query || '').trim();
  if (!q) return { items: [] };
  let list = [];
  try {
    list = await lrclibSearch({ q: q });
  } catch (_) {
    return { items: [] };
  }
  const ctx = {
    clean: cleanTitle(args.title || q),
    title: args.title || q,
    artist: args.artist || '',
    durationMs: Number(args.durationMs) || 0,
  };
  const items = list.slice(0, 20).map((d) => ({
    title: String(d.trackName || d.name || ''),
    artist: String(d.artistName || d.artist || ''),
    durationMs: d.duration ? Math.round(Number(d.duration) * 1000) : undefined,
    ref: JSON.stringify({ id: d.id, name: d.trackName || d.name || '', artist: d.artistName || '' }),
  })).filter((x) => x.title);
  items.sort((a, b) => scoreCandidate(b, ctx) - scoreCandidate(a, ctx));
  return { items: items.slice(0, 20) };
}

async function fetch({ ref }) {
  let data;
  try {
    data = typeof ref === 'string' ? JSON.parse(ref) : ref;
  } catch (_) {
    return null;
  }
  if (!data || !data.id) return null;
  try {
    const d = await lrclibGet(data.id);
    const out = lrclibToLyric(d);
    if (!out) return null;
    // 多轨：ref 里若带译文 / 罗马音（未来接入带翻译的歌词源时用），合成到同一时间轴。
    if (data.translation && typeof data.translation === 'string') {
      out.translation = { format: 'lrc', text: data.translation, language: 'zh-Hans' };
    }
    if (data.romanization && typeof data.romanization === 'string') {
      out.romanization = { format: 'lrc', text: data.romanization, language: 'ja-Latn' };
    }
    return out;
  } catch (_) {
    return null;
  }
}

module.exports = {
  cleanTitle, queryCandidates, quotedSongName, keywordForTrack,
  forTrack, search, fetch,
};
