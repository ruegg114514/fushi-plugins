'use strict';
/// <reference path="./fushi-plugin.d.ts" />
/// Fushi 音乐插件：Bilibili 音乐源（完整版）。
/// 移植自 HanversionOvO/BiliMusic（MIT 未声明，仅作个人本地使用；逻辑改写以适配 Fushi 插件契约）。
/// 契约见 GUIDE.md。运行于 QuickJS：只有 fushi.* 全局，无 fetch / setTimeout / Buffer / import。

const config = require('./config');
const SOURCE = config.SOURCE;

const bili = require('./bili');
const lyricSvc = require('./lyrics');
const providers = require('./providers');

// ── 通用小工具 ──────────────────────────────────────────────────────────────

function ensure(cond, msg) {
  if (!cond) throw new Error(msg);
}

function num(v, d) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : d;
}

// 网易不同接口的曲目字段名不一致：cloudsearch 用 ar/dt，playlist/detail 用 artists/duration。
function artistsOf(x) {
  const raw = (x && (x.ar || x.artists)) || [];
  return raw.map((a) => ({ name: a.name })).filter((a) => a.name);
}
function durationOf(x) {
  const v = x && (x.dt != null ? x.dt : x.duration);
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : undefined;
}
function coverOf(x) {
  const u = x && ((x.al && x.al.picUrl) || (x.album && x.album.picUrl) || x.picUrl);
  return u ? String(u).replace(/^http:/, 'https:') : undefined;
}

// id 形状：bv:<bvid> / av:<aid>:<cid> / mid:<mid> / fav:<mid>:<folderId> /
//          rank:<rid>:<day> / chart:<type> / radio:<seed>
function parseId(id) {
  const s = String(id || '');
  const i = s.indexOf(':');
  return i < 0 ? { kind: s, rest: '' } : { kind: s.slice(0, i), rest: s.slice(i + 1) };
}

function cleanVideoList(list) {
  return (list || []).map((v) => bili.trackFromVideo(v)).filter((t) => t && t.id && t.title);
}

// B 站视频详情 → 单曲 Track（album 页把「视频的多 P」当曲目）
function trackFromDetail(detail, page) {
  const p = page || {};
  return {
    id: 'bv:' + detail.bvid,
    title: bili.stripHtml(p.part || detail.title || '未命名'),
    artists: [{ name: bili.stripHtml((detail.owner && detail.owner.name) || '') }],
    album: { title: bili.stripHtml(detail.title || '') },
    durationMs: (Number(p.duration) || Number(detail.duration) || 0) * 1000 || undefined,
    coverUrl: bili.httpsUrl(detail.pic || ''),
    trackNo: p.page || undefined,
  };
}

// ── 搜索 ────────────────────────────────────────────────────────────────────
//
// 设计：FuoEvolve 的 LYRICS_ASSOCIATION_PROVIDER_IDS —— 歌曲元数据/搜索/歌词
// 只从有歌词的源（网易云 / QQ 音乐）拿，播放流另由 B 站提供。
//   * 主：网易云 /api/cloudsearch/pc（歌曲/专辑/艺人/歌单四类，带分页）
//   * 补充：QQ smartbox 快搜（网易失败或结果不足时合并，去重靠 id 前缀）
// 每条结果都把「歌名 + 艺人 + 时长」存进 storage，供 stream 去 B 站找视频。

const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const _memCache = {};

async function cached(key, ttlMs, producer) {
  const now = Date.now();
  const hit = _memCache[key];
  if (hit && now - hit.ts < ttlMs) return hit.value;
  let value;
  try { value = await producer(); }
  catch (e) { if (hit) return hit.value; throw e; }
  _memCache[key] = { ts: now, value: value };
  return value;
}

function normName(s) {
  return bili.stripHtml(s || '').trim().toLowerCase().replace(/\s+/g, '');
}

// 记住曲目的「歌名/艺人/时长」，stream 会用它去 B 站综合搜索找可播视频。
async function remember(items) {
  for (const t of items) {
    if (!t || !t.id || (!t.title && !t.name)) continue;
    await providers.saveTrackMeta(t.id, {
      title: t.title || t.name || '',
      artist: (t.artists && t.artists[0] && t.artists[0].name) || '',
      album: (t.album && t.album.title) || '',
      durationMs: t.durationMs || 0,
    });
  }
}

async function netease(query, type, page, pageSize) {
  return cached('ne:' + query + ':' + type + ':' + page + ':' + pageSize, SEARCH_CACHE_TTL,
    () => providers.neteaseSearch(query, type, page, pageSize));
}

async function qq(query, type, page, pageSize) {
  return cached('qq:' + query + ':' + type + ':' + page + ':' + pageSize, SEARCH_CACHE_TTL,
    () => providers.qqSearch(query, type, page, pageSize));
}

async function search({ query, type, page, pageSize }) {
  const q = String(query || '').trim();
  if (q.length < 2) return { items: [], hasMore: false };
  const p = num(page, 0) | 0;
  const ps = Math.min(num(pageSize, 30) | 0, 30);
  const t = type || 'song';

  // 三个来源各是一个插件包（宿主按插件出「来源」chip，三家天然分列）。
  // 本包只返回自己来源的结果。
  if (SOURCE === 'ne') {
    try {
      const r = await netease(q, t, p, ps);
      await remember(r.items);
      return r;
    } catch (_) { return { items: [], hasMore: false }; }
  }
  if (SOURCE === 'qq') {
    try {
      const r = await qq(q, t, p, ps);
      await remember(r.items);
      return r;
    } catch (_) { return { items: [], hasMore: false }; }
  }
  // bili：视频 / UP 主结果，过滤「合集/精选/超长」垃圾；只第一页
  if (p > 0) return { items: [], hasMore: false };
  if (t === 'playlist') return { items: [], hasMore: false }; // B 站无公开歌单实体
  try {
    const comp = await cached('bilisearch:' + q, SEARCH_CACHE_TTL,
      () => bili.comprehensiveSearch(q));
    if (t === 'artist') {
      const artists = (comp && comp.artists) || [];
      return { items: artists.slice(0, 15), hasMore: artists.length > 15 };
    }
    const filterOn = (await fushi.storage.get('cfg:bili_filter').catch(() => null)) === '1';
    const allVids = (comp && comp.tracks) || [];
    const vids = filterOn ? allVids.filter((v) => {
      const ms = Number(v.durationMs) || 0;
      if (ms > 10 * 60000) return false;
      if (/合集|精选|100首|50首|循环|后台播放|纯享|歌单/.test(v.title || '')) return false;
      return true;
    }) : allVids;
    const out = vids.slice(0, 15).map((v) => (t === 'album'
      ? { id: v.id, title: v.title, artists: v.artists, coverUrl: v.coverUrl, trackCount: 1 }
      : v));
    await remember(out);
    return { items: out, hasMore: vids.length > 15 };
  } catch (_) { return { items: [], hasMore: false }; }
}

function tag(x, source) {
  const y = Object.assign({}, x);
  y.note = source + (y.note ? ' · ' + y.note : '');
  return y;
}

// 最佳匹配：艺人精确匹配 > 艺人第一条 > 歌曲第一条。
// 短查询不发（同 search 的理由）；艺人/歌曲两个请求并行。
async function searchBest({ query }) {
  if (SOURCE !== 'ne') return null;
  const q = String(query || '').trim();
  if (q.length < 2) return null;
  const [artists, songs] = await Promise.all([
    netease(q, 'artist', 0, 5).catch(() => ({ items: [] })),
    netease(q, 'song', 0, 5).catch(() => ({ items: [] })),
  ]);
  if (artists.items.length) {
    const hit = artists.items.find((a) => normName(a.name) === normName(q)) || artists.items[0];
    return { artist: tag(hit, '网易云') };
  }
  if (songs.items.length) return { playlist: { id: songs.items[0].id, title: songs.items[0].title } };
  return null;
}

async function videoDetail(bvid) {
  return bili.request('/x/web-interface/view', { bvid: bvid });
}

async function album({ id }) {
  const ref = parseId(id);
  if (ref.kind === 'bv') {
    const d = await videoDetail(ref.rest);
    const albumObj = {
      id: 'bv:' + d.bvid,
      title: bili.stripHtml(d.title || '未命名'),
      artists: [{ name: bili.stripHtml((d.owner && d.owner.name) || '') }],
      coverUrl: bili.httpsUrl(d.pic || ''),
      description: String(d.desc || '').slice(0, 20000),
      trackCount: (d.pages || []).length || 1,
    };
    const tracks = (d.pages && d.pages.length ? d.pages : [{}]).map((pg) => trackFromDetail(d, pg));
    return { album: albumObj, tracks: tracks };
  }
  if (ref.kind === 'qq-album') {
    // QQ 原生专辑详情（免登录，实测 2026-11-08）
    const r = await providers.qqAlbumTracks(ref.rest, 60);
    if (r.tracks.length) {
      await remember(r.tracks);
      return { album: r.album, tracks: r.tracks };
    }
    return { album: { id: id, title: (r.album && r.album.title) || '专辑' }, tracks: [] };
  }
  if (ref.kind === 'ne-album') {
    // 网易专辑详情接口已下线；用「专辑名」走搜索拿曲目兜底。
    const meta = await providers.trackMeta(id);
    const name = (meta && meta.title) || '';
    if (name) {
      try {
        const r = await providers.neteaseSearch(name, 'song', 0, 30);
        const tracks = r.items.slice(0, 30);
        await remember(tracks);
        return { album: { id: id, title: name, trackCount: tracks.length }, tracks: tracks };
      } catch (_) { /* 落到空 */ }
    }
    return { album: { id: id, title: name || '专辑' }, tracks: [] };
  }
  // 单曲 id 当单曲专辑
  const meta = await providers.trackMeta(id);
  const track = meta ? {
    id: id, title: meta.title,
    artists: meta.artist ? [{ name: meta.artist }] : [],
    album: meta.album ? { title: meta.album } : undefined,
    durationMs: meta.durationMs || undefined,
  } : { id: id, title: String(id) };
  return {
    album: { id: id, title: track.title, trackCount: 1 },
    tracks: [track],
  };
}

async function playlist({ id }) {
  const ref = parseId(id);
  if (ref.kind === 'fav') {
    const parts = ref.rest.split(':');
    if (!parts[1]) {
      const d = await bili.request('/x/web-interface/index/top/rcmd', { ps: 30, fresh_type: 3 }).catch(() => ({ item: [] }));
      return { playlist: { id: id, title: '我喜欢的视频', editable: false }, tracks: cleanVideoList(d.item) };
    }
    let data;
    try {
      data = await bili.request('/x/v3/fav/resource/list', {
        media_id: parts[1], pn: 1, ps: 50, platform: 'web',
      });
    } catch (e) { throw new Error('读取收藏夹失败：' + e.message); }
    return {
      playlist: { id: id, title: (data.info && data.info.title) || '收藏夹', trackCount: (data.medias || []).length, editable: !!(await loggedIn()) },
      tracks: cleanVideoList(data.medias),
    };
  }
  if (ref.kind === 'local-pl') {
    const ids = await localPlaylistTracks(ref.rest ? id : id);
    const tracks = [];
    for (const tid of ids) {
      const meta = await providers.trackMeta(tid);
      tracks.push(meta ? {
        id: tid, title: meta.title,
        artists: meta.artist ? [{ name: meta.artist }] : [],
        durationMs: meta.durationMs || undefined,
      } : { id: tid, title: String(tid) });
    }
    const list = await localPlaylists();
    const pl = list.find((x) => x.id === id) || { title: '歌单' };
    return { playlist: { id: id, title: pl.title, editable: true, trackCount: tracks.length }, tracks: tracks };
  }
  if (ref.kind === 'ne-playlist') {
    try {
      const j = await providers.req(providers.NE_BASE + '/api/playlist/detail?id=' + encodeURIComponent(ref.rest), { referer: providers.NE_BASE + '/' });
      const tracks = ((j && j.result && j.result.tracks) || []).map((x) => ({
        id: 'ne:' + x.id, title: x.name,
        artists: artistsOf(x),
          durationMs: durationOf(x),
        coverUrl: (x.al && x.al.picUrl) ? String(x.al.picUrl).replace(/^http:/, 'https:') : undefined,
      }));
      await remember(tracks);
      return { playlist: { id: id, title: (j.result && j.result.name) || '歌单', trackCount: tracks.length }, tracks: tracks };
    } catch (_) {
      return { playlist: { id: id, title: '歌单' }, tracks: [] };
    }
  }
  if (ref.kind === 'mid') {
    const mid = ref.rest;
    const user = await userInfo(mid);
    const data = await userVideos(mid, 1, 50);
    return {
      playlist: { id: 'mid:' + mid, title: (user.name || 'UID ' + mid) + ' 的投稿', coverUrl: user.coverUrl, trackCount: ((data.list && data.list.vlist) || []).length, owner: user.name },
      tracks: cleanVideoList(data.list && data.list.vlist),
    };
  }
  // qq-album / 其它：单曲兜底
  const meta = await providers.trackMeta(id);
  return {
    playlist: { id: id, title: (meta && meta.title) || '歌单' },
    tracks: meta ? [{ id: id, title: meta.title, artists: meta.artist ? [{ name: meta.artist }] : [] }] : [],
  };
}

async function artist({ id }) {
  const ref = parseId(id);
  if (ref.kind === 'mid') {
    const mid = ref.rest;
    const u = await userInfo(mid);
    const vids = await userVideos(mid, 1, 30);
    return { artist: u, albums: [], tracks: cleanVideoList(vids.list && vids.list.vlist).slice(0, 50) };
  }
  if (ref.kind === 'qq-artist') {
    // QQ 原生：艺人热门曲（GetSingerSongList，免登录）
    const meta = await providers.trackMeta(id);
    const name = (meta && meta.title) || '';
    const r = await providers.qqSingerSongs(ref.rest, 0, 30);
    const tracks = r.items.slice(0, 50);
    await remember(tracks);
    if (tracks.length) return { artist: { id: id, name: name }, albums: [], tracks: tracks };
    return { artist: { id: id, name: name || '艺人' }, albums: [], tracks: [] };
  }
  if (ref.kind === 'ne-artist') {
    // 网易原生「热门50首」（/api/artist/{id}，免登录）。失败才落到艺人名搜索。
    const meta = await providers.trackMeta(id);
    const name = (meta && meta.title) || '';
    try {
      const tracks = await providers.neArtistSongs(ref.rest, 50);
      if (tracks.length) {
        await remember(tracks);
        return { artist: { id: id, name: name }, albums: [], tracks: tracks };
      }
    } catch (_) { /* 落到搜索 */ }
    if (name) {
      try {
        const r = await providers.neteaseSearch(name, 'song', 0, 30);
        const tracks = r.items.slice(0, 50);
        await remember(tracks);
        return { artist: { id: id, name: name }, albums: [], tracks: tracks };
      } catch (_) { /* 落到空 */ }
    }
    return { artist: { id: id, name: name || '艺人' }, albums: [], tracks: [] };
  }
  return { artist: { id: id, name: String(id) }, albums: [], tracks: [] };
}

async function artistAlbums({ id, page, pageSize }) {
  const ref = parseId(id);
  if (ref.kind === 'ne-artist') {
    const ps = Math.min(num(pageSize, 30) | 0, 30);
    const r = await providers.neArtistAlbums(ref.rest, (num(page, 0) | 0) * ps, ps);
    return { items: r.items, hasMore: (page + 1) * ps < r.total, total: r.total };
  }
  if (ref.kind === 'qq-artist') {
    const ps = Math.min(num(pageSize, 30) | 0, 30);
    const r = await providers.qqSingerAlbums(ref.rest, (num(page, 0) | 0) * ps, ps);
    return { items: r.items, hasMore: (page + 1) * ps < r.total, total: r.total };
  }
  if (ref.kind === 'mid') {
    const ps = Math.min(num(pageSize, 30) | 0, 30);
    const data = await userVideos(ref.rest, (num(page, 0) | 0) + 1, ps);
    const items = cleanVideoList(data.list && data.list.vlist).map((t) => ({
      id: t.id, title: t.title, artists: t.artists, coverUrl: t.coverUrl, trackCount: 1,
    }));
    return { items, hasMore: items.length >= ps };
  }
  return { items: [], hasMore: false };
}

async function artistSimilar({ id }) {
  const ref = parseId(id);
  try {
    const a = await artist({ id: id });
    const r = await netease(a.artist.name, 'artist', 0, 10);
    return { items: r.items.filter((x) => x.id !== id).slice(0, 10) };
  } catch (_) {
    return { items: [] };
  }
}

async function userInfo(mid) {
  return cached('user:' + mid, 30 * 60 * 1000, async () => {
    let d = null;
    try { d = await bili.request('/x/web-interface/card', { mid: mid, photo: 'false' }); }
    catch (_) { d = null; }
    const card = (d && d.card) || {};
    const out = { id: 'mid:' + mid, name: bili.stripHtml(card.name || 'UID ' + mid) };
    const face = bili.httpsUrl(card.face || '');
    if (face) out.coverUrl = face;
    if (card.sign) out.description = String(card.sign).slice(0, 20000);
    return out;
  });
}

async function userVideos(mid, page, pageSize) {
  return cached('vids:' + mid + ':' + page + ':' + pageSize, 10 * 60 * 1000, async () => {
    const params = { mid: mid, pn: page, ps: pageSize, order: 'pubdate', platform: 'web' };
    let data = null;
    try { data = await bili.requestWbi('/x/space/wbi/arc/search', params, { referer: 'https://space.bilibili.com/' + mid + '/video' }); }
    catch (_) {
      try { data = await bili.request('/x/space/arc/search', params); } catch (_) { data = null; }
    }
    return data || { list: { vlist: [] } };
  });
}

// ── 取流：歌曲 id → B 站视频 → 公开音轨（无会员可用） ─────────────────────
//
// 这是 FuoEvolve「歌词关联到播放源」的落地：ne:/qq: 的曲目本身不能播，
// 用「歌名 + 艺人」去 B 站综合搜索找可播视频，再取 dash.audio[]。
// 命中结果按 (缓存的 storage) 记住，避免每首重复搜。

// 从歌名里剥掉噪音：括号版本后缀、feat、Live、Remastered、书名号等。
// 「My Against Fight (2021 Remastered Version)」→「My Against Fight」
function cleanSongName(raw) {
  let s = bili.stripHtml(raw || '');
  s = s.replace(/[（(【\[].{0,40}?[)）\]】]/g, ' ');
  s = s.replace(/\b(20\d\d|remaster(?:ed)?|version|live|acoustic|demo|feat\.?|ft\.?|cover|mv|pv|full|hq|4k|8k)\b/gi, ' ');
  s = s.replace(/[《》「」『』]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

// 候选视频打分。判据优先级：
//   淘汰明显非"听这首歌"的（长视频/谱/教学/演奏/演讲）
//   > 原唱信号（MV / 字幕组搬运 / 现场 / 主题曲）加分
//   > cover / 翻唱 / 二次创作降权
//   > 时长接近度（注意：原唱 MV 常比录音室版长十几秒，不能只靠时长）
//   > 标题包含核心歌名
function scoreVideo(v, meta) {
  const title = bili.stripHtml(v.title || '');
  const lower = title.toLowerCase();
  const targetMs = Number(meta.durationMs) || 0;
  const ms = Number(v.durationMs) || bili.parseDuration(v.duration);

  // 明显不是"听这首歌"：直接淘汰
  if (ms && ms > 10 * 60000) return -Infinity;
  if (/教学|tutorial|五线谱|六线谱|tab|谱面|鼓谱|贝斯谱|钢琴谱|吉他谱|二胡谱|口琴谱|小提琴谱|古筝谱|笛子谱|谱/.test(lower)) return -Infinity;
  if (/教学|reaction|反应|盘点|合集|混剪|演讲|采访|vlog|直播|开箱|测评|八音盒|卡农版/.test(lower)) return -Infinity;
  if (/指弹|弹唱|独奏|演奏版|钢琴版|吉他版|二胡版|口琴版|小提琴版|古筝版|笛子版|纯音乐版|管弦乐版/.test(lower)) return -Infinity;

  let score = 0;

  // 原唱/搬运信号：MV、字幕组、中日字幕、现场、演唱会、主题曲、修复版
  if (/mv\b|music\s*video|中日字幕|字幕组|搬运|主题曲|片头曲|片尾曲|演唱会|现场版|live版|4k修复|4k.*修复|10亿播放/.test(lower)) score += 120;

  // cover / 翻唱 / 二次创作：降权（时长再像也不是本人）
  if (/cover|翻唱|\bfc\b|ai卡密|ai翻唱|降调|升调|慢摇|加速|减速|人声less|伴奏|\binst|remix|dj版|电音版|歌手20\d\d|我是歌手|蒙面|司凤版|改词|中文填词|空耳/.test(lower)) score -= 90;

  // 时长接近度（次判据）
  if (targetMs && ms) {
    const diff = Math.abs(ms - targetMs);
    if (diff < 3000) score += 180;
    else if (diff < 8000) score += 120;
    else if (diff < 20000) score += 70;
    else if (diff < 40000) score += 20;
    else score -= 100;
  }

  // 标题包含核心歌名
  const song = normTitle(cleanSongName(meta.title));
  const tl = normTitle(title);
  if (song && tl.indexOf(song) >= 0) score += 160;
  else if (song) {
    const words = cleanSongName(meta.title).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    let hit = 0;
    for (const w of words) if (lower.indexOf(w) >= 0) hit++;
    if (words.length) score += Math.round((hit / words.length) * 80);
  }

  // 标题含艺人再加分
  const artist = String(meta.artist || '').toLowerCase();
  if (artist && artist.length >= 2 && lower.indexOf(artist) >= 0) score += 30;

  return score;
}

// 打分排序的 B 站候选 bvid 列表（缓存）。换源的基础：不止取第一个，
// 而是保留整列，播放时逐个试，坏的那个跳过去试下一个。
async function biliCandidates(meta) {
  const core = cleanSongName(meta.title);
  const q = (core + ' ' + (meta.artist || '')).trim();
  const list = await cached('bvfind:' + q, 10 * 60 * 1000, async () => {
    let vids = [];
    try {
      const comp = await bili.comprehensiveSearch(q);
      vids = comp ? comp.tracks : [];
    } catch (_) { vids = []; }
    if (core && core !== q) {
      try {
        const comp2 = await bili.comprehensiveSearch(core);
        const more = comp2 ? comp2.tracks : [];
        const seen = {};
        for (const v of vids) seen[v.id] = 1;
        for (const v of more) if (!seen[v.id]) vids.push(v);
      } catch (_) { /* 保留已有 */ }
    }
    if (!vids.length) {
      try {
        const d = await bili.requestWbi('/x/web-interface/wbi/search/type', {
          search_type: 'video', keyword: q, page: 1, page_size: 20,
        });
        vids = (d.result || []).map((v) => bili.trackFromVideo(v));
      } catch (_) { vids = []; }
    }
    return vids;
  });
  if (!list.length) return [];
  return list.map((v) => ({ v: v, id: String(v.id).replace(/^bv:/, ''), s: scoreVideo(v, meta) }))
    .sort((a, b) => b.s - a.s);
}

// 自动换源用：过滤阈值后的 bvid 列表
async function biliCandidateIds(meta) {
  const scored = await biliCandidates(meta);
  return scored.filter((x) => x.s >= 100).map((x) => x.id);
}

// 手动换源用：候选视频 → 可播放的 Track 列表（radio 返回给宿主展示）。
// id 编码成 via:<bvid>|<原曲目id>：用户点哪条，stream() 就用那条视频，
// 并把「原曲目 → 该 bvid」记成首选（= 手动换源生效并持久）。
function candidateTracks(scored, seedTrackId, meta) {
  const out = [];
  const full = normTitle(cleanSongName(meta.title));
  for (const x of scored.slice(0, 30)) {
    if (x.s === -Infinity) continue; // 明显无关的不展示
    const tl = normTitle(x.v.title);
    // 只有标题真正含完整歌名才算「推荐」，其余都是「备选」——
    // 避免《Fight Club》这类只沾一个词的也被标成匹配。
    const strong = full && tl.indexOf(full) >= 0;
    if (!strong && x.s < 150) continue; // 又弱又不含全名的不展示
    const t = Object.assign({}, x.v);
    t.id = 'via:' + x.id + '|' + seedTrackId;
    t.title = (t.title || x.id) + (strong ? '【推荐源】' : '【备选源】');
    t.artists = [{ name: (t.artists && t.artists[0] && t.artists[0].name) || 'B站' }];
    t.note = 'B站源 · ' + (strong ? '推荐' : '备选');
    t.durationMs = t.durationMs || undefined;
    out.push(t);
  }
  return out;
}

// 从候选里取流：跳过已知坏的，逐个试 playurl，第一个出音频流的返回。
// 这就是「换源」——FuoEvolve resolve() 的「试候选直到能播」在本插件内的落地。
async function pickPlayable(cands, badSet) {
  for (const bvid of cands) {
    if (badSet[bvid]) continue;
    try {
      const payload = await biliStream(bvid);
      return { bvid: bvid, payload: payload };
    } catch (_) {
      badSet[bvid] = 1; // 记进黑名单，下次跳过
    }
  }
  return null;
}

async function biliStream(bvid) {
  let d;
  try { d = await videoDetail(bvid); }
  catch (e) { throw new Error('B 站视频不可用：' + e.message); }
  const cid = d.cid || (d.pages && d.pages[0] && d.pages[0].cid);
  if (!cid) throw new Error('无 cid');
  const data = await bili.request('/x/player/playurl', {
    bvid: bvid, cid: cid, qn: 0, fnver: 0, fnval: 16, fourk: 1,
  });
  return streamFromPlayurl(data);
}

async function readBad(id) {
  try {
    const raw = await fushi.storage.get('bad:' + id);
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}
async function writeBad(id, badSet) {
  try { await fushi.storage.set('bad:' + id, JSON.stringify(badSet)); } catch (_) { /* noop */ }
}

async function stream({ id, quality }) {
  const ref = parseId(id);

  // 手动换源：用户在「以这首起电台」候选列表里点定的 B 站视频。
  // via:<bvid>|<原曲目id> → 播这个 bvid，并把它记成原曲目的首选源。
  if (ref.kind === 'via') {
    const bar = ref.rest.indexOf('|');
    const bvid = bar < 0 ? ref.rest : ref.rest.slice(0, bar);
    const origin = bar < 0 ? '' : ref.rest.slice(bar + 1);
    const payload = await biliStream(bvid);
    if (origin) {
      await fushi.storage.set('bv:' + origin, bvid).catch(() => {});
      await fushi.storage.set('bad:' + origin, JSON.stringify({})).catch(() => {});
      await cacheDownloadUrl(origin, payload);
    }
    return payload;
  }

  // 网易：先试官方直连（需登录，免费歌能拿到），失败/VIP 自动转 B 站。
  if (ref.kind === 'ne' && SOURCE === 'ne') {
    try {
      const direct = await providers.neteaseDirect(ref.rest, quality);
      if (direct) return await cacheDownloadUrl(id, direct);
    } catch (_) { /* 降级 */ }
    return await viaBili(id, quality);
  }
  // QQ：有登录 Cookie 时试官方直连（qqSign + CgiGetVkey），失败/VIP 转 B 站。
  if (ref.kind === 'qq' && SOURCE === 'qq') {
    try {
      const direct = await providers.qqDirect(ref.rest, quality);
      if (direct) return await cacheDownloadUrl(id, direct);
    } catch (_) { /* 降级 */ }
    return await viaBili(id, quality);
  }

  let bvid = '';
  if (ref.kind === 'bv') {
    return await cacheDownloadUrl(id, await biliStream(ref.rest));
  } else if (ref.kind === 'av') {
    const parts = ref.rest.split(':');
    const aid = Number(parts[0]) || 0, cid = Number(parts[1]) || 0;
    ensure(aid && cid, '缺少 avid/cid');
    const data = await bili.request('/x/player/playurl', { avid: aid, cid: cid, qn: 0, fnver: 0, fnval: 16, fourk: 1 });
    return streamFromPlayurl(data);
  } else {
    return await viaBili(id, quality);
  }
}

async function viaBili(id, quality) {
  // resolveMeta：先查 storage（search 时 remember 存的），查不到走本家详情接口兜底。
  // 这样即使没先搜索、或换了插件包，直接播也能拿到歌名/艺人在 B 站找视频。
  const meta = await providers.resolveMeta(id);
  if (!meta || !meta.title) throw new Error('找不到该曲目的元数据（' + id + '）');

  const badSet = await readBad(id);
  const cands = await biliCandidateIds(meta);
  if (!cands.length) throw new Error('B 站没找到《' + meta.title + '》的候选视频');

  // 首选记忆：上次成功播的 bvid 排到最前（但坏过的仍会被跳过）
  const fav = await fushi.storage.get('bv:' + id).catch(() => null);
  if (fav && !badSet[fav]) {
    const i = cands.indexOf(fav);
    if (i > 0) { cands.splice(i, 1); cands.unshift(fav); }
    else if (i < 0) cands.unshift(fav);
  }

  // 先试首选/候选；全失败说明可能都下架了 → 清黑名单再试一轮（换源重试）
  let picked = await pickPlayable(cands, badSet);
  if (!picked) {
    const fresh = {};
    picked = await pickPlayable(cands, fresh);
    if (!picked) {
      // 连试全挂：把失败原因回给用户（宿主会标 trackUnavailable 跳过）
      throw new Error('《' + meta.title + '》在 B 站的 ' + cands.length + ' 个候选都取不到音频流（可能付费/下架）');
    }
    // 清掉旧黑名单（全量重扫）
    await writeBad(id, {});
  } else {
    // 有跳过的坏候选才写回，省一次存储
    if (Object.keys(badSet).length) await writeBad(id, badSet);
  }

  await fushi.storage.set('bv:' + id, picked.bvid).catch(() => {});
  return await cacheDownloadUrl(id, picked.payload);
}

// 把可下载直链记进 storage，供宿主下载中心（fushi_cli dl add <url>）使用。
// B 站流 URL 带签名、短时效，所以也缓存「最近一次可播直链」方便重试。
async function cacheDownloadUrl(id, payload) {
  try {
    await fushi.storage.set('dl:' + id, JSON.stringify({
      url: payload.url, headers: payload.headers || {},
      codec: payload.codec, at: Date.now(),
    }));
  } catch (_) { /* noop */ }
  return payload;
}

function streamFromPlayurl(data) {
  const audios = (data.dash && data.dash.audio) || [];
  if (!audios.length) {
    const durl = data.durl && data.durl[0];
    if (durl && (durl.url || (durl.backup_url || [])[0])) {
      return {
        url: durl.url || durl.backup_url[0],
        headers: Object.assign({}, bili.AUDIO_HEADERS),
        codec: 'mp4',
        trial: { startMs: 0, endMs: Math.min((Number(durl.length) || 0), 30000) },
      };
    }
    throw new Error('该视频没有可用的音频流（可能需要登录或为付费内容）');
  }
  const sorted = audios.slice().sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
  const best = sorted[0];
  const url = best.baseUrl || best.base_url || (best.backupUrl || best.backup_url || [])[0];
  ensure(url, '音频流地址为空');
  const mime = String(best.mimeType || best.mime_type || best.codecs || 'audio/mp4').toLowerCase();
  const codec = mime.indexOf('flac') >= 0 ? 'flac'
    : mime.indexOf('ec-3') >= 0 || mime.indexOf('eac3') >= 0 ? 'eac3'
    : mime.indexOf('opus') >= 0 ? 'opus' : 'm4a';
  const out = { url: url, headers: Object.assign({}, bili.AUDIO_HEADERS), codec: codec };
  const kbps = Math.round((Number(best.bandwidth) || 0) / 1000);
  if (kbps > 0) out.bitrateKbps = kbps;
  if (best.sampleRate || best.sample_rate) out.sampleRate = Number(best.sampleRate || best.sample_rate);
  return out;
}

// ── 歌词：网易云 / QQ 音乐三轨（原文 + 翻译 + 罗马音） ─────────────────────
//
// 移植 FuoEvolve 的 LYRICS_ASSOCIATION_PROVIDER_IDS 与 composeRichLyrics：
// 歌词只从有歌词的源取，再关联到播放源。Fushi 契约的
// { original, translation?, romanization? } 天然就是那三轨。

async function lyrics({ id }) {
  const ref = parseId(id);
  // 手动换源选的 B 站视频：歌词跟着原曲目走。
  // 原曲目是 ne:/qq: 时直接取那家三轨（跨包可用，不必绕关联）。
  if (ref.kind === 'via') {
    const bar = ref.rest.indexOf('|');
    if (bar < 0) return null;
    const origin = ref.rest.slice(bar + 1);
    const oref = parseId(origin);
    if (oref.kind === 'ne' || oref.kind === 'qq') {
      try {
        const hit = await providers.lyricsForId(origin);
        if (hit) return hit;
      } catch (_) { /* 落到关联 */ }
      const om = await providers.trackMeta(origin);
      if (om && om.title) {
        const assoc = await findLyricAssociation(om);
        if (assoc) { try { return await providers.lyricsForId(assoc); } catch (_) { /* null */ } }
      }
      return null;
    }
    return lyrics({ id: origin });
  }
  // 网易云 / QQ 曲目：本包（同来源）直接取本家三轨歌词
  if (ref.kind === 'ne' || ref.kind === 'qq') {
    if (SOURCE === 'ne' || SOURCE === 'qq') {
      try {
        const hit = await providers.lyricsForId(id);
        if (hit) return hit;
      } catch (_) { /* 落到关联 */ }
      return null;
    }
  }
  // 第 6 条：B 站视频 → 识别歌名 → 网易/QQ 搜同曲 → 取那家三轨歌词
  const meta = await providers.trackMeta(id);
  if (meta && meta.title) {
    const assoc = await findLyricAssociation(meta);
    if (assoc) {
      try {
        const hit = await providers.lyricsForId(assoc);
        if (hit) return hit;
      } catch (_) { /* 落到兜底 */ }
    }
  }
  // B 站 CC 字幕 / LRCLIB 兜底
  try { return await lyricSvc.forTrack(id); } catch (_) { return null; }
}

// 候选与目标曲目的匹配分（标题/艺人/时长）。
function matchScore(t, ctx) {
  const n = (x) => String(x || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  let sc = 0;
  const tn = n(t.title), cn = n(ctx.title);
  if (cn && tn === cn) sc += 300;
  else if (cn && tn.indexOf(cn) >= 0) sc += 180;
  const ta = n((t.artists && t.artists[0] && t.artists[0].name) || '');
  if (ctx.artist && ta && (ta.indexOf(n(ctx.artist)) >= 0 || n(ctx.artist).indexOf(ta) >= 0)) sc += 160;
  if (ctx.durationMs && t.durationMs && Math.abs(t.durationMs - ctx.durationMs) < 10000) sc += 60;
  return sc;
}

// 用歌名 + 艺人在网易/QQ 找同曲，返回带三轨歌词的曲目 id。
async function findLyricAssociation(meta) {
  const key = 'assoc:' + (meta.title + '|' + (meta.artist || ''));
  const cachedA = await fushi.storage.get(key).catch(() => null);
  if (cachedA) return cachedA;
  const q = (meta.title + ' ' + (meta.artist || '')).trim();
  let candidates = [];
  try {
    const r = await providers.neteaseSearch(q, 'song', 0, 10);
    candidates = r.items;
  } catch (_) { /* QQ 兜底 */ }
  if (!candidates.length) {
    try {
      const r = await providers.qqSearch(q, 'song', 0, 10);
      candidates = r.items;
    } catch (_) { return null; }
  }
  if (!candidates.length) return null;
  const best = candidates.slice().sort((a, b) => matchScore(b, meta) - matchScore(a, meta))[0];
  if (!best || !best.id) return null;
  await fushi.storage.set(key, best.id).catch(() => {});
  return best.id;
}

// 歌词插件能力：给任意来源的本地曲目搜歌词候选。
async function lyricsSearch(args) {
  const q = String(args.query || '').trim();
  if (!q) return { items: [] };
  let items = [];
  try {
    const r = await providers.neteaseSearch(q, 'song', 0, 20);
    items = r.items.map((t) => ({
      title: t.title,
      artist: (t.artists && t.artists[0] && t.artists[0].name) || '',
      durationMs: t.durationMs || undefined,
      ref: JSON.stringify({ kind: 'ne', id: t.id }),
    }));
  } catch (_) {
    // 网易失败则回退 LRCLIB
    return lyricSvc.search(args);
  }
  if (!items.length) return lyricSvc.search(args);
  return { items: items.slice(0, 20) };
}

async function lyricsFetch({ ref }) {
  let data;
  try { data = typeof ref === 'string' ? JSON.parse(ref) : ref; }
  catch (_) { return null; }
  if (!data) return null;
  if (data.kind === 'ne' || data.kind === 'qq') {
    try {
      const hit = await providers.lyricsForId(data.id);
      if (hit) return hit;
    } catch (_) {
      // 落到 LRCLIB
    }
    return null;
  }
  return lyricSvc.fetch({ ref: ref });
}

// ── 首页推荐 / 榜单 ────────────────────────────────────────────────────────

async function rankingData(ref) {
  if (ref.kind === 'rank') {
    const parts = ref.rest.split(':');
    return bili.request('/x/web-interface/ranking/region', {
      rid: parts[0] || 3,
      day: parts[1] || 3,
    });
  }
  return bili.request('/x/web-interface/index/top/rcmd', { ps: 30, fresh_type: 3 });
}

async function home() {
  const sections = [];
  if (SOURCE === 'ne') {
    try {
      const items = await cached('home:ne-rec', 10 * 60 * 1000, () => providers.neteaseRecommend());
      const tracks = items.slice(0, 30);
      await remember(tracks);
      if (tracks.length) sections.push({ id: 'ne-recommend', title: '飙升 / 新歌', subtitle: '每日更新', kind: 'tracks', items: tracks });
    } catch (_) { /* 忽略 */ }
    try {
      const pls = await cached('home:ne-pl', 30 * 60 * 1000, () => providers.neteaseTopPlaylists());
      if (pls.length) sections.push({ id: 'ne-playlists', title: '精选歌单', kind: 'playlists', items: pls.slice(0, 12) });
    } catch (_) { /* 忽略 */ }
    return { sections: sections };
  }
  if (SOURCE === 'qq') {
    try {
      const pls = await cached('home:qq-top', 30 * 60 * 1000, () => providers.qqTopCharts());
      if (pls.length) sections.push({ id: 'qq-toplists', title: '排行榜', kind: 'playlists', items: pls.slice(0, 12) });
    } catch (_) { /* 忽略 */ }
    return { sections: sections };
  }
  // bili：音乐区榜单 + 热门
  try {
    const d = await bili.request('/x/web-interface/ranking/region', { rid: 3, day: 3 });
    const items = cleanVideoList(d.list).slice(0, 30);
    if (items.length) sections.push({ id: 'rank-music', title: 'B 站音乐排行榜', subtitle: '三日榜 · 音乐区', kind: 'tracks', items: items });
  } catch (_) { /* 忽略 */ }
  try {
    const d = await bili.request('/x/web-interface/popular', { ps: 30, pn: 1 });
    const items = cleanVideoList(d.list).slice(0, 30);
    if (items.length) sections.push({ id: 'popular', title: 'B 站热门', kind: 'tracks', items: items });
  } catch (_) { /* 忽略 */ }
  return { sections: sections };
}

async function loggedIn() {
  const key = SOURCE === 'qq' ? 'qq_cookie' : SOURCE === 'bili' ? 'SESSDATA' : 'ne_cookie';
  try { const c = await fushi.credentials.get(key); return !!c; }
  catch (_) { return false; }
}

async function account() {
  let st = { loggedIn: false };
  if (SOURCE === 'ne') st = await providers.neLoginState();
  else if (SOURCE === 'qq') st = await providers.qqLoginState();
  else st = { loggedIn: await loggedIn() };
  const out = { loggedIn: !!st.loggedIn };
  if (st.name) out.name = st.name;
  out.badge = SOURCE === 'ne' ? '网易云' : SOURCE === 'qq' ? 'QQ音乐' : 'B站';
  return out;
}

async function login(args) {
  const op = args && args.op;
  if (op === 'methods') {
    return {
      methods: SOURCE === 'ne'
        ? [{ id: 'cookie', type: 'form', label: '网易云 Cookie 登录', description: '粘贴 MUSIC_U / __csrf（免费歌官方直连 + 歌单/收藏）' }]
        : SOURCE === 'qq'
        ? [{ id: 'qqcookie', type: 'form', label: 'QQ音乐 Cookie 登录', description: '粘贴 qqmusic_key / wxuin / qm_keyst（QQ 官方直连）' }]
        : [
            { id: 'qr', type: 'qr', label: 'B 站扫码登录', description: 'B 站账号，用于收藏夹/历史' },
            { id: 'settings', type: 'form', label: 'B 站插件设置', description: '搜索结果过滤开关（默认 off=全部保留；on=过滤合集/超长视频）' },
          ],
    };
  }
  if (op === 'logout') {
    await providers.setNeCookie('');
    await providers.setQqCookie('');
    await bili.clearCredentials();
    return null;
  }
  if (op === 'begin') {
    if (args.method === 'qqcookie') {
      return {
        state: 'pending', session: 'qqcookie',
        form: {
          fields: [{ id: 'cookie', label: 'QQ音乐 Cookie', multiline: true, secret: true, placeholder: 'uin=...; qm_keyst=...; qqmusic_key=...' }],
          actions: [{ id: 'submit', label: '保存并登录', primary: true }],
        },
      };
    }
    if (args.method === 'cookie') {
      return {
        state: 'pending', session: 'cookie',
        form: {
          fields: [{ id: 'cookie', label: 'Cookie', multiline: true, secret: true, placeholder: 'MUSIC_U=...; __csrf=...; NMTID=...' }],
          actions: [{ id: 'submit', label: '保存并登录', primary: true }],
        },
      };
    }
    if (args.method === 'settings') {
      const cur = await fushi.storage.get('cfg:bili_filter').catch(() => null);
      return {
        state: 'pending', session: 'settings',
        form: {
          fields: [{
            id: 'bili_filter',
            label: 'B 站搜索过滤开关（填 on 或 off；当前：' + (cur === '1' ? 'on' : 'off') + '）',
            value: cur === '1' ? 'on' : 'off',
            placeholder: 'on / off',
          }],
          actions: [{ id: 'submit', label: '保存设置', primary: true }],
        },
      };
    }
    // B 站二维码（沿用旧逻辑，用于收藏夹）
    const d = await bili.request(bili.PASSPORT + '/x/passport-login/web/qrcode/generate', {}, { absolute: true, raw: true, referer: bili.PASSPORT + '/login' });
    const dd = (d && d.data) || {};
    ensure(dd.url && dd.qrcode_key, '无法获取登录二维码');
    return { state: 'pending', session: dd.qrcode_key, message: '请用 Bilibili 手机 App 扫码', qr: { content: dd.url }, pollMs: 2000 };
  }
  if (op === 'poll') {
    const key = args.session;
    const raw = await fushi.http.request({
      url: bili.PASSPORT + '/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key),
      headers: { Referer: bili.PASSPORT + '/login', 'User-Agent': bili.UA }, responseType: 'text',
    });
    let json = null;
    try { json = JSON.parse(raw.text); } catch (_) { /* noop */ }
    const code = json && json.data && json.data.code;
    if (code === 0) {
      const cookie = (raw.setCookies || []).map((c) => c.split(';')[0]).join('; ');
      if (cookie) await bili.writeCredentialString(cookie);
      return { state: 'done', message: 'B 站登录成功', account: await account() };
    }
    if (code === 86090) return { state: 'pending', session: key, message: '已扫码，请在手机上确认', qr: { scanned: true }, pollMs: 2000 };
    if (code === 86038 || code === 86039) return { state: 'failed', message: '二维码已过期，请重新开始' };
    return { state: 'pending', session: key, message: '等待扫码…', pollMs: 2000 };
  }
  if (op === 'submit' && args.method === 'settings') {
    const v = String((args.inputs && args.inputs.bili_filter) || '').trim().toLowerCase();
    ensure(v === 'on' || v === 'off', '请填 on 或 off');
    await fushi.storage.set('cfg:bili_filter', v === 'off' ? '0' : '1').catch(() => {});
    return { state: 'done', message: '已保存：B 站搜索过滤 = ' + v };
  }
  if (op === 'submit' && args.method === 'cookie') {
    const cookie = args.inputs && args.inputs.cookie;
    ensure(cookie && cookie.indexOf('MUSIC_U') >= 0, 'Cookie 里至少要有 MUSIC_U');
    await providers.setNeCookie(String(cookie).trim());
    const st = await providers.neLoginState();
    if (st.loggedIn) {
      return { state: 'done', message: '登录成功' + (st.name ? '：' + st.name : ''), account: await account() };
    }
    // Cookie 已保存但验证没过：多半是过期/复制不全。不能说谎报"登录成功"。
    return { state: 'failed', message: 'Cookie 已保存，但网易验证未通过——请确认 Cookie 未过期且包含完整 MUSIC_U（重新登录 music.163.com 后再复制）' };
  }
  if (op === 'submit' && args.method === 'qqcookie') {
    const cookie = args.inputs && args.inputs.cookie;
    ensure(cookie && /qm_keyst=/.test(cookie), 'QQ Cookie 里至少要有 qm_keyst');
    await providers.setQqCookie(String(cookie).trim());
    const st = await providers.qqLoginState();
    if (st.loggedIn) return { state: 'done', message: 'QQ 登录成功', account: await account() };
    return { state: 'failed', message: 'Cookie 已保存，但缺少有效登录字段（需 uin/wxuin + qm_keyst，请在 y.qq.com 登录后重新复制）' };
  }
  return { state: 'failed', message: '未知的登录操作' };
}

async function myMid() {
  let mid = '';
  try { mid = (await fushi.credentials.get('DedeUserID')) || ''; } catch (_) { /* noop */ }
  if (mid) return mid;
  const nav = await bili.request('/x/web-interface/nav', {}, { raw: true });
  mid = nav && nav.data && nav.data.mid ? String(nav.data.mid) : '';
  ensure(mid, '未登录或无法获取用户 mid');
  await fushi.credentials.set('DedeUserID', mid);
  return mid;
}

async function myFavoriteFolders() {
  const mid = await myMid();
  const d = await bili.request('/x/v3/fav/folder/created/list-all', { up_mid: mid });
  return (d.list || []).map((f) => ({
    id: 'fav:' + mid + ':' + f.id,
    title: String(f.title || '收藏夹'),
    trackCount: Number(f.media_count) || 0,
    editable: true,
  }));
}

// 插件本地歌单（未登录网易时，宿主的「加入歌单/新建歌单」菜单照样可用）。
// 宿主 MusicPlaylistEditor 调 library()/playlistEdit()，数据落在 fushi.storage。
async function localPlaylists() {
  try {
    const raw = await fushi.storage.get('local_playlists');
    return raw ? JSON.parse(raw) : [];
  } catch (_) { return []; }
}
async function saveLocalPlaylists(list) {
  try { await fushi.storage.set('local_playlists', JSON.stringify(list)); } catch (_) { /* noop */ }
}
async function localPlaylistTracks(pid) {
  try {
    const raw = await fushi.storage.get('local_pl_tracks:' + pid);
    return raw ? JSON.parse(raw) : [];
  } catch (_) { return []; }
}
async function saveLocalPlaylistTracks(pid, ids) {
  try { await fushi.storage.set('local_pl_tracks:' + pid, JSON.stringify(ids)); } catch (_) { /* noop */ }
}

async function library({ page, pageSize }) {
  const p = num(page, 0) | 0, ps = Math.min(num(pageSize, 30) | 0, 30);
  // 本地歌单始终可用（Fushi 宿主的「加入歌单」菜单）
  const local = await localPlaylists();
  let all = local.map((x) => Object.assign({}, x, { editable: true }));
  if (!(await loggedIn())) {
    return { items: all.slice(p * ps, (p + 1) * ps), hasMore: (p + 1) * ps < all.length };
  }
  all = [{ id: 'ne-liked', title: '我喜欢的音乐', editable: false }].concat(all);
  try {
    const st = await providers.neLoginState();
    if (st.loggedIn) {
      // 用户歌单：从 /weapi/user/playlist 拿
      const j = await providers.neWeapi('/weapi/user/playlist', { uid: '', limit: '100', offset: '0', includeVideo: 'true' });
      const pls = (j && j.playlist) || [];
      for (const x of pls) {
        all.push({
          id: 'ne-playlist:' + x.id, title: x.name,
          trackCount: Number(x.trackCount) || undefined,
          coverUrl: x.coverImgUrl ? String(x.coverImgUrl).replace(/^http:/, 'https:') : undefined,
          editable: true,
        });
      }
    }
  } catch (_) { /* 至少给喜欢的入口 */ }
  return { items: all.slice(p * ps, (p + 1) * ps), hasMore: (p + 1) * ps < all.length };
}

async function like({ op, id, liked }) {
  if (!(await loggedIn())) return null;
  if (op === 'list') return { ids: [], playlist: { id: 'ne-liked', title: '我喜欢的音乐' } };
  if (op === 'set') {
    const ref = parseId(id);
    if (ref.kind !== 'ne') return null;
    try { await providers.neFavoriteSong(ref.rest, !!liked); }
    catch (e) { throw new Error('收藏失败：' + e.message); }
    return null;
  }
  return null;
}

async function playlistEdit({ op, name, description, trackIds, playlistId }) {
  // 未登录网易 → 用插件本地歌单（Fushi 宿主菜单照样能加歌单）
  if (!(await loggedIn())) {
    const list = await localPlaylists();
    if (op === 'create') {
      const id = 'local-pl:' + Date.now();
      list.push({ id: id, title: name || '新歌单', trackCount: 0 });
      await saveLocalPlaylists(list);
      await saveLocalPlaylistTracks(id, trackIds || []);
      return { playlist: { id: id, title: name || '新歌单', editable: true } };
    }
    const pid = String(playlistId || '');
    if (op === 'delete') {
      await saveLocalPlaylists(list.filter((x) => x.id !== pid));
      return null;
    }
    if (op === 'add' || op === 'remove') {
      const ids = await localPlaylistTracks(pid);
      let next;
      if (op === 'add') next = ids.concat((trackIds || []).filter((x) => ids.indexOf(x) < 0));
      else next = ids.filter((x) => (trackIds || []).indexOf(x) < 0);
      await saveLocalPlaylistTracks(pid, next);
      return null;
    }
    return null;
  }
  if (op === 'create') {
    const pl = await providers.nePlaylistCreate(name || '新歌单');
    // 建完可顺带加歌
    if (trackIds && trackIds.length) {
      try { await providers.nePlaylistAdd(String(pl.id).replace(/^ne-playlist:/, ''), trackIds); }
      catch (_) { /* 加歌失败不影响创建 */ }
    }
    return { playlist: pl };
  }
  const pid = String(playlistId || '').replace(/^ne-playlist:/, '');
  if (op === 'delete') { await providers.nePlaylistDelete(pid); return null; }
  if (op === 'add') { await providers.nePlaylistAdd(pid, trackIds || []); return null; }
  if (op === 'remove') { await providers.nePlaylistRemove(pid, trackIds || []); return null; }
  return null;
}

async function collect({ op, type, id, on }) {
  if (!(await loggedIn())) throw new Error('需要登录网易云账号');
  const ref = parseId(id);
  try {
    if (type === 'album' && ref.kind === 'ne-album') await providers.neFavoriteAlbum(ref.rest, !!on);
    else if (type === 'playlist' && ref.kind === 'ne-playlist') await providers.neFavoritePlaylist(ref.rest, !!on);
    else if (type === 'artist') { /* 关注艺人：网易 /weapi/artist/sub 需 id，简化跳过 */ return null; }
    else return null;
  } catch (e) { throw new Error('收藏失败：' + e.message); }
  return null;
}

async function radio({ op, seedTrackId, count }) {
  if (op === 'trash') return null;
  const c = Math.min(num(count, 10) | 0, 30);
  if (seedTrackId) {
    // 手动选源入口。宿主把「以这首起电台」发给**这首歌所属的插件包**，
    // 所以候选逻辑必须三家包都会出：B 站包总是；网易/QQ 包在未登录
    // （歌实际靠 B 站兜底播）时也给候选，登录后才走本家相似推荐。
    let seed = String(seedTrackId);
    const sref = parseId(seed);
    if (sref.kind === 'via') {
      // 已选过源的曲目：重新打开候选列表，用原曲目做种子
      const bar = sref.rest.indexOf('|');
      if (bar >= 0) seed = sref.rest.slice(bar + 1);
    }
    const meta = await providers.resolveMeta(seed).catch(() => null);
    let title = (meta && meta.title) || '';
    let artist = (meta && meta.artist) || '';
    if (!title && /^bv:/.test(seed)) {
      const m2 = await lyricSvc.keywordForTrack(seed).catch(() => null);
      if (m2) { title = m2.title; artist = m2.artist || ''; }
    }
    // 候选选源列表总是出（登录与否无关）——这是「手动选 B 站视频」的入口。
    if (title) {
      try {
        const scored = await biliCandidates({
          title: title, artist: artist, durationMs: (meta && meta.durationMs) || 0,
        });
        const tracks = candidateTracks(scored, seed, { title: title, artist: artist });
        if (tracks.length) return { tracks: tracks, title: '选择 B 站源：' + title };
      } catch (_) { /* 无候选 */ }
      return { tracks: [] };
    }
    if (SOURCE !== 'bili') {
      const q = title ? (title + ' ' + artist).trim() : '音乐';
      try {
        const r = SOURCE === 'qq' ? await qq(q, 'song', 0, c) : await netease(q, 'song', 0, c);
        return { tracks: r.items, title: '相似推荐' };
      } catch (_) { return { tracks: [] }; }
    }
    return { tracks: [] };
  }
// 个人电台
  try {
    if (SOURCE === 'ne') {
      const items = await providers.neteaseRecommend();
      return { tracks: items.slice(0, c), title: '个性推荐' };
    }
    if (SOURCE === 'bili') {
      const d = await bili.request('/x/web-interface/popular', { ps: c, pn: 1 });
      return { tracks: cleanVideoList(d.list).slice(0, c), title: 'B 站热门' };
    }
    return { tracks: [] };
  } catch (_) { return { tracks: [] }; }
}

// 按来源裁剪导出：没声明的能力不导出（SDK 会 WARN 多余导出；宿主也不会调）。
const _all = {
  search,
  searchBest,
  album,
  playlist,
  artist,
  artistAlbums,
  artistSimilar,
  stream,
  lyrics,
  lyricsSearch,
  lyricsFetch,
  home,
  library,
  like,
  playlistEdit,
  radio,
  collect,
  account,
  login,
};

// QQ 包：写操作（歌单编辑/收藏/喜欢）未接 QQ 接口，不声明这些能力。
// B 站包：collect（收藏专辑/关注）无对应免费接口，不声明。
const _skip = SOURCE === 'qq'
  ? ['searchBest', 'library', 'like', 'playlistEdit', 'artistSimilar', 'collect']
  : SOURCE === 'bili'
  ? ['collect']
  : [];

module.exports = {};
for (const k of Object.keys(_all)) {
  if (_skip.indexOf(k) < 0) module.exports[k] = _all[k];
}

