package eu.kanade.tachiyomi.animeextension.all.bilibili

import androidx.preference.EditTextPreference
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.animesource.ConfigurableAnimeSource
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Track
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import extensions.utils.getPreferencesLazy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.Headers
import okhttp3.Request
import okhttp3.Response
import java.net.URLEncoder
import java.security.MessageDigest

class Bilibili : ConfigurableAnimeSource, AnimeHttpSource() {

    override val name = "Bilibili"
    override val lang = "all"
    override val supportsLatest = true

    override val baseUrl = "https://www.bilibili.com"

    private val prefs by getPreferencesLazy()

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val sessData: String
        get() = prefs.getString(PREF_SESSDATA, "")?.trim().orEmpty()

    private val cookie: String
        get() = if (sessData.isNotEmpty()) "SESSDATA=$sessData" else ""

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .add("User-Agent", UA)
        .add("Referer", "https://www.bilibili.com")
        .add("Origin", "https://www.bilibili.com")

    private fun apiHeaders(): Headers {
        val b = headersBuilder()
        if (cookie.isNotEmpty()) b.add("Cookie", cookie)
        return b.build()
    }

    // ---------------- WBI 签名 ----------------

    private data class WbiKeys(val imgKey: String, val subKey: String)

    @Volatile
    private var wbiCache: WbiKeys? = null

    private fun fetchWbiKeys(): WbiKeys {
        wbiCache?.let { return it }
        val req = GET("https://api.bilibili.com/x/web-interface/nav", apiHeaders())
        val body = client.newCall(req).execute().use { it.body.string() }
        val nav = json.parseToJsonElement(body).jsonObject
        val wbi = nav["data"]!!.jsonObject["wbi_img"]!!.jsonObject
        fun stem(url: String) = url.substringAfterLast('/').substringBefore('.')
        val keys = WbiKeys(
            stem(wbi["img_url"]!!.jsonPrimitive.content),
            stem(wbi["sub_url"]!!.jsonPrimitive.content),
        )
        wbiCache = keys
        return keys
    }

    private fun mixinKey(orig: String): String {
        val sb = StringBuilder()
        for (i in MIXIN_KEY_ENC_TAB) sb.append(orig[i])
        return sb.toString().substring(0, 32)
    }

    private fun md5(s: String): String {
        val d = MessageDigest.getInstance("MD5").digest(s.toByteArray())
        return d.joinToString("") { "%02x".format(it) }
    }

    /** 对参数签名，返回带 w_rid / wts 的查询串。 */
    private fun signedQuery(params: Map<String, String>): String {
        val keys = fetchWbiKeys()
        val mixin = mixinKey(keys.imgKey + keys.subKey)
        val withWts = params.toMutableMap()
        withWts["wts"] = (System.currentTimeMillis() / 1000).toString()
        val filtered = withWts.entries.sortedBy { it.key }.joinToString("&") { (k, v) ->
            "$k=" + URLEncoder.encode(v.replace(Regex("[!'()*]"), ""), "UTF-8")
        }
        val wRid = md5(filtered + mixin)
        return "$filtered&w_rid=$wRid"
    }

    // ---------------- 浏览 ----------------

    override fun popularAnimeRequest(page: Int): Request = GET(
        "https://api.bilibili.com/x/web-interface/popular?ps=20&pn=$page",
        apiHeaders(),
    )

    override fun latestUpdatesRequest(page: Int): Request = GET(
        // dynamic/region 已废弃（返回 -404），改用 newlist
        "https://api.bilibili.com/x/web-interface/newlist?rid=1&ps=20&pn=$page",
        apiHeaders(),
    )

    override fun popularAnimeParse(response: Response): AnimesPage = parseVideoList(response)

    override fun latestUpdatesParse(response: Response): AnimesPage = parseVideoList(response)

    private fun parseVideoList(response: Response): AnimesPage {
        val root = runCatching {
            json.parseToJsonElement(response.body.string()).jsonObject
        }.getOrNull() ?: return AnimesPage(emptyList(), false)

        val code = runCatching { root["code"]?.jsonPrimitive?.int }.getOrNull() ?: -1
        if (code != 0) return AnimesPage(emptyList(), false)

        val data = root.obj("data") ?: return AnimesPage(emptyList(), false)

        // 不同接口字段不同：
        //   popular      → data.list
        //   ranking/v2   → data.list
        //   newlist      → data.archives
        // 用安全访问器逐个试，任何一个类型不对都不抛异常。
        val list = data.arr("list") ?: data.arr("archives") ?: data.arr("result")
            ?: return AnimesPage(emptyList(), false)

        val animes = list.mapNotNull { el ->
            val o = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
            val bvid = o.str("bvid") ?: return@mapNotNull null
            val title = o.str("title") ?: return@mapNotNull null
            SAnime.create().apply {
                this.title = title
                setUrlWithoutDomain("bvid/$bvid")
                o.str("pic")?.let { thumbnail_url = normalizePic(it) }
                description = o.str("desc")
                author = o.obj("owner")?.str("name")
            }
        }
        return AnimesPage(animes, animes.isNotEmpty())
    }

    private fun normalizePic(url: String): String =
        if (url.startsWith("//")) "https:$url" else url

    // ---------------- 详情 ----------------

    private fun bvidOf(anime: SAnime): String =
        anime.url.substringAfter("bvid/").substringBefore("?")

    /** 番剧身份：`ss<season_id>`。非番剧返回 null。 */
    private fun seasonIdOf(anime: SAnime): String? =
        anime.url.takeIf { it.startsWith("ss") }?.removePrefix("ss")?.substringBefore("?")?.takeIf { it.isNotBlank() }

    override fun animeDetailsRequest(anime: SAnime): Request {
        val seasonId = seasonIdOf(anime)
        return if (seasonId != null) {
            GET("https://api.bilibili.com/pgc/view/web/season?season_id=$seasonId", apiHeaders())
        } else {
            GET("https://api.bilibili.com/x/web-interface/view?bvid=${bvidOf(anime)}", apiHeaders())
        }
    }

    override fun animeDetailsParse(response: Response): SAnime {
        val body = response.body.string()
        val root = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull()
            ?: return SAnime.create()
        // 番剧走 pgc/web/season：字段在 result 下，且没有 owner/desc 那套形状。
        root.obj("result")?.let { r ->
            return SAnime.create().apply {
                title = r.str("title").orEmpty()
                description = r.str("evaluate").orEmpty().ifBlank { r.str("subtitle").orEmpty() }
                genre = r.str("season_title").orEmpty()
                r.str("cover")?.let { thumbnail_url = normalizePic(it) }
                // 番剧状态：实测完结的季 status=13（`new_ep.desc` 形如「已完结, 全23话」），
                // 连载中不是 13。只把 13 当完结，其余按未知处理（不猜）。
                status = if (r.str("status") == "13") SAnime.COMPLETED else SAnime.UNKNOWN
            }
        }
        val d = root["data"]?.jsonObject ?: return SAnime.create()
        return SAnime.create().apply {
            title = d.str("title").orEmpty()
            author = d.obj("owner")?.str("name")
            description = d.str("desc")
            genre = d.str("tname")
            d.str("pic")?.let { thumbnail_url = normalizePic(it) }
            status = SAnime.COMPLETED
        }
    }

    // ---------------- 剧集（分P） ----------------

    override fun episodeListRequest(anime: SAnime): Request {
        val seasonId = seasonIdOf(anime)
        return if (seasonId != null) {
            GET("https://api.bilibili.com/pgc/view/web/season?season_id=$seasonId", apiHeaders())
        } else {
            GET("https://api.bilibili.com/x/web-interface/view?bvid=${bvidOf(anime)}", apiHeaders())
        }
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        val body = response.body.string()
        val root = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull()
            ?: return emptyList()

        // ---- 番剧分支：pgc/web/season 的 result.episodes ----
        // 每集自带 bvid 与 cid，所以后续取流可以完全复用普通投稿那条路径
        // （x/player/playurl 对番剧的 bvid 同样有效，实测 qn=80 可出 720P 合并流）。
        root.obj("result")?.let { r ->
            val eps = r.arr("episodes") ?: return emptyList()
            return eps.mapIndexedNotNull { i, el ->
                val e = runCatching { el.jsonObject }.getOrNull() ?: return@mapIndexedNotNull null
                val bvid = e.str("bvid") ?: return@mapIndexedNotNull null
                val cid = e["cid"]?.jsonPrimitive?.let { runCatching { it.long }.getOrNull() }
                    ?: return@mapIndexedNotNull null
                // 剧场版 / 特别篇可能没有集号，用 index+1 兜底。
                val epNum = e["title"]?.jsonPrimitive?.let {
                    runCatching { it.contentOrNull?.toFloatOrNull() }.getOrNull()
                } ?: (i + 1).toFloat()
                val longTitle = e.str("long_title").orEmpty()
                SEpisode.create().apply {
                    name = if (longTitle.isNotBlank()) "第${epNum.toInt()}话 $longTitle" else "第${epNum.toInt()}话"
                    episode_number = epNum
                    setUrlWithoutDomain("play/$bvid/$cid")
                    date_upload = (runCatching { e["pub_time"]?.jsonPrimitive?.long }.getOrNull() ?: 0L) * 1000
                }
            }
        }

        // ---- 普通投稿分支：x/web-interface/view 的 data.pages ----
        val d = root["data"]?.jsonObject ?: return emptyList()
        val bvid = d.str("bvid") ?: return emptyList()
        val pages = d["pages"]?.jsonArray ?: return emptyList()

        return pages.mapIndexed { i, el ->
            val p = el.jsonObject
            val cid = p["cid"]?.jsonPrimitive?.long ?: 0L
            val part = p.str("part").orEmpty()
            SEpisode.create().apply {
                name = part.ifBlank { "P${i + 1}" }
                episode_number = (i + 1).toFloat()
                setUrlWithoutDomain("play/$bvid/$cid")
                date_upload = (p["pubdate"]?.jsonPrimitive?.long ?: 0L) * 1000
            }
        }
    }

    // ---------------- 取流 ----------------

    override fun videoListRequest(episode: SEpisode): Request {
        val parts = episode.url.removePrefix("play/").split("/")
        val bvid = parts.getOrNull(0).orEmpty()
        val cid = parts.getOrNull(1).orEmpty()
        // 诊断：确认扩展真的读到了偏好里的 SESSDATA
        android.util.Log.i(
            "BilibiliExt",
            "videoListRequest bvid=$bvid cid=$cid sessLen=${sessData.length} qn=${if (sessData.isNotEmpty()) 80 else 64}",
        )
        // qn=80 (1080P) 需要登录；fnval=16 请求 DASH
        val q = signedQuery(
            mapOf(
                "bvid" to bvid,
                "cid" to cid,
                "qn" to if (sessData.isNotEmpty()) "80" else "64",
                // fnval=0 请求**音视频合并**的 mp4（响应走 durl）。
                //
                // 为什么不用 DASH（fnval=16/4048）：DASH 把音视频拆成两条独立流，
                // 需要宿主把 audioTracks / mpvArgs 传给播放器；Fushi 桌面端的 Video
                // 投影只取五个字段，这两项会在桥接层被丢弃（见 issue #xxx），
                // 结果就是「有画面没声音」。合并流是单 URL 自带音轨，可靠但封顶 720P。
                "fnval" to "0",
                "fourk" to "1",
            ),
        )
        val hdrs = apiHeaders()
        android.util.Log.i(
            "BilibiliExt",
            "playurl headers: cookieLen=${hdrs["Cookie"]?.length ?: 0} " +
                "ua=${hdrs["User-Agent"]?.take(20)} ref=${hdrs["Referer"]}",
        )
        return GET("https://api.bilibili.com/x/player/wbi/playurl?$q", hdrs)
    }

    /**
     * 拉取该视频的字幕轨。
     *
     * B 站的 AI 字幕走 `x/player/wbi/v2`（需 WBI 签名 + SESSDATA），返回的
     * `subtitle_url` 是协议相对地址（`//aisubtitle.hdslb.com/...`），要补 `https:`。
     * 字幕本身是 JSON：`{ body: [{from, to, content}, ...] }`，from/to 为秒。
     *
     * 失败一律返回空列表：拿不到字幕不该阻断播放。
     */
    private fun fetchSubtitleTracks(bvid: String, cid: String): List<Track> {
        if (bvid.isEmpty() || cid.isEmpty()) return emptyList()
        return runCatching {
            val q = signedQuery(mapOf("bvid" to bvid, "cid" to cid))
            val req = GET("https://api.bilibili.com/x/player/wbi/v2?$q", apiHeaders())
            val body = client.newCall(req).execute().use { it.body.string() }
            val root = json.parseToJsonElement(body).jsonObject
            val subs = root["data"]?.jsonObject
                ?.get("subtitle")?.jsonObject
                ?.get("subtitles")?.jsonArray
                ?: return emptyList()
            subs.mapNotNull { el ->
                val t = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
                val raw = t.str("subtitle_url")?.takeIf { it.isNotBlank() }
                    ?: return@mapNotNull null
                val url = if (raw.startsWith("//")) "https:$raw" else raw
                val lang = t.str("lan").orEmpty()
                val label = t.str("lan_doc").orEmpty().ifBlank { lang }
                // B 站给的是 JSON（{body:[{from,to,content}]}），而 Fushi 宿主是
                // 「原样 GET 下来写盘 → 按扩展名选解析器（srt/ass/ssa/vtt）、不嗅探
                // 内容」。直接交 JSON 地址会被存成 .vtt 再按 WebVTT 解析，得到零条
                // cue —— 表现为字幕菜单里有轨、选中后什么都不显示。
                //
                // 所以先交给本机回环端点：宿主来取时，扩展自己拉 JSON、转成 VTT 再
                // 吐出去。端点起不来（受限环境）就退回原始地址，至少不比以前差。
                val bridged = runCatching {
                    SubtitleVttBridge.serve {
                        client.newCall(GET(url, apiHeaders())).execute().use { resp ->
                            if (!resp.isSuccessful) {
                                null
                            } else SubtitleVttBridge.biliJsonToVtt(resp.body.string())
                        }
                    }
                }.getOrNull()
                Track(bridged ?: url, label)
            }
        }.getOrDefault(emptyList())
    }

    override fun videoListParse(response: Response): List<Video> {
        val bodyText = response.body.string()
        android.util.Log.i("BilibiliExt", "RAWBODY len=${bodyText.length} head=${bodyText.take(120)}")
        val root = runCatching {
            json.parseToJsonElement(bodyText).jsonObject
        }.getOrNull() ?: return emptyList()

        // 决定性证据：response.request 是 OkHttp 真正发出去的那份请求。
        // 如果这里的 Cookie 是 null，说明 header 在发送前就被抹掉了（不是我们没设）。
        android.util.Log.i(
            "BilibiliExt",
            "SENT headers=" + response.request.headers.names().sorted().joinToString(",") { n ->
                val v = response.request.header(n).orEmpty()
                if (n.equals("Cookie", true)) "$n(${v.length})" else if (n.equals("User-Agent", true)) "UA=[$v]" else "$n=$v"
            },
        )

        val code = root["code"]?.jsonPrimitive?.int ?: -1
        if (code != 0) {
            val msg = root.str("message").orEmpty()
            throw Exception(
                when (code) {
                    -101 -> "需要登录：请在扩展设置里填写 SESSDATA"
                    -403 -> "无权限访问该视频（可能需要大会员）"
                    -404 -> "视频不存在或已删除"
                    -412 -> "触发风控，请稍后重试"
                    else -> "取流失败（$code）：$msg"
                },
            )
        }

        val data = root["data"]?.jsonObject ?: return emptyList()
        val videos = ArrayList<Video>()

        // 字幕在 playurl 响应里没有，要单独请求一次。
        //
        // 目标 bvid/cid **必须从本次响应的 request URL 里解析**，不能用成员变量：
        // Fushi 会并发取多集的流，成员变量会被别的请求覆盖，导致解析出错误的
        // 视频信息（实测表现为 dash raw 出现别的视频的分辨率）。
        val reqUrl = response.request.url
        val subs = fetchSubtitleTracks(
            reqUrl.queryParameter("bvid").orEmpty(),
            reqUrl.queryParameter("cid").orEmpty(),
        )

        // 音频轨：多条不同码率，取带宽最高的一条。
        val audioUrl = data.obj("dash")?.arr("audio")
            ?.mapNotNull { el ->
                val a = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
                val u = a.str("baseUrl") ?: a.str("base_url") ?: return@mapNotNull null
                val bw = runCatching { a["bandwidth"]?.jsonPrimitive?.long }.getOrNull() ?: 0L
                bw to u
            }
            ?.maxByOrNull { it.first }
            ?.second

        // 合并流（durl）：音视频已合并在一个 mp4 里，播放器直接就能出声。
        data.arr("durl")?.forEachIndexed { i, el ->
            val o = runCatching { el.jsonObject }.getOrNull() ?: return@forEachIndexed
            val u = o.str("url") ?: return@forEachIndexed
            val qn = runCatching { data["quality"]?.jsonPrimitive?.int }.getOrNull() ?: 0
            val size = runCatching { o["size"]?.jsonPrimitive?.long }.getOrNull() ?: 0L
            val mb = if (size > 0) " · ${size / 1024 / 1024}MB" else ""
            videos.add(
                Video(
                    url = u,
                    quality = "${qualityLabel(qn)} · P${i + 1}$mb",
                    videoUrl = u,
                    headers = headers,
                    subtitleTracks = subs,
                    audioTracks = emptyList(),
                ),
            )
        }

        // 兜底：极少数老视频只给 DASH（无音轨，至少能看画面）
        if (videos.isEmpty()) {
            data.obj("dash")?.arr("video")?.forEach { el ->
                val v = runCatching { el.jsonObject }.getOrNull() ?: return@forEach
                val url = v.str("baseUrl") ?: v.str("base_url") ?: return@forEach
                val h = runCatching { v["height"]?.jsonPrimitive?.int }.getOrNull() ?: 0
                val codecs = v.str("codecs").orEmpty()
                videos.add(
                    Video(url, "${h}P · ${codecs.take(4)} · 无音频", url, headers, subs, emptyList()),
                )
            }
        }

        if (videos.isEmpty()) throw Exception("该视频没有可用流（可能需要大会员或已下架）")
        return videos.sortedByDescending {
            Regex("(\\d+)P").find(it.quality)?.groupValues?.get(1)?.toIntOrNull() ?: 0
        }
    }

    // ---------------- 搜索 ----------------

    /**
     * 合并搜索：番剧（PGC）+ 普通投稿（BV）。
     *
     * 为什么要自己实现而不是改 `searchAnimeRequest` 的 `search_type`：B 站把内容分成
     * 两套体系，搜索接口用 `search_type` 区分：
     *  - `video`         → 普通投稿（UP 主上传，只有 bvid）
     *  - `media_bangumi` → 番剧 / 国创 / 电影等 PGC（只有 season_id，**没有 bvid**）
     *
     * 只把 `video` 换成 `media_bangumi` 会让普通投稿全部消失，且番剧结果没有 bvid
     * 会被现有解析器整条丢掉（`?: return@mapNotNull null`）。所以这里两次请求合并。
     *
     * 注意事项：
     * - 两项要**分别**容错：番剧接口在部分关键词上会 500 / 返回空，不该把已拿到的
     *   投稿结果一起丢掉。
     * - 番剧结果排前面（用户搜番名时多数想要正片），并标上「番剧」前缀以便区分。
     * - 分页只对投稿有意义（番剧接口单页就能返回全部命中），第 2 页起不再重复请求
     *   番剧，否则会出现同一部番剧在每页都出现一次。
     */
    override suspend fun getSearchAnime(
        page: Int,
        query: String,
        filters: AnimeFilterList,
    ): AnimesPage {
        val bangumi = if (page <= 1) {
            runCatching { searchBangumi(query) }.getOrDefault(emptyList())
        } else {
            emptyList()
        }
        val videos = runCatching { searchVideos(page, query) }.getOrDefault(emptyList())
        val merged = bangumi + videos
        // 还有更多只由投稿侧决定：番剧已在第 1 页全部给出，投稿满页才认为可翻页。
        return AnimesPage(merged, videos.isNotEmpty())
    }

    /** 番剧搜索（PGC）。返回项的 url 用 `ss<season_id>`，详情 / 剧集按前缀分流。 */
    private fun searchBangumi(query: String): List<SAnime> {
        val q = signedQuery(
            mapOf(
                "search_type" to "media_bangumi",
                "keyword" to query,
                "page" to "1",
            ),
        )
        val root = json.parseToJsonElement(
            client.newCall(GET("https://api.bilibili.com/x/web-interface/wbi/search/type?$q", apiHeaders()))
                .execute().use { it.body.string() },
        ).jsonObject
        val items = root.obj("data")?.arr("result") ?: return emptyList()
        return items.mapNotNull { el ->
            val o = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
            val seasonId = o["season_id"]?.jsonPrimitive?.let { runCatching { it.long }.getOrNull() }
                ?: return@mapNotNull null
            val rawTitle = o.str("title")?.replace(Regex("<[^>]+>"), "")?.trim()
                ?: return@mapNotNull null
            SAnime.create().apply {
                title = "【番剧】$rawTitle"
                setUrlWithoutDomain("ss$seasonId")
                o.str("cover")?.let { thumbnail_url = normalizePic(it) }
                description = o.str("desc")
                genre = o.str("styles")
                o.str("org_title")?.takeIf { it.isNotBlank() }?.let { author = it }
            }
        }
    }

    /** 普通投稿搜索（BV），逻辑与原 `searchAnimeParse` 一致。 */
    private fun searchVideos(page: Int, query: String): List<SAnime> {
        val q = signedQuery(
            mapOf(
                "search_type" to "video",
                "keyword" to query,
                "page" to page.toString(),
            ),
        )
        val root = json.parseToJsonElement(
            client.newCall(GET("https://api.bilibili.com/x/web-interface/wbi/search/type?$q", apiHeaders()))
                .execute().use { it.body.string() },
        ).jsonObject
        val code = root["code"]?.jsonPrimitive?.int ?: -1
        if (code != 0) {
            val msg = root.str("message").orEmpty()
            throw Exception(
                when (code) {
                    -412 -> "搜索触发风控，请稍后重试或配置 SESSDATA"
                    else -> "搜索失败（$code）：$msg"
                },
            )
        }
        val result = root.obj("data")?.arr("result") ?: return emptyList()
        return result.mapNotNull { el ->
            val o = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
            val bvid = o.str("bvid") ?: return@mapNotNull null
            val title = o.str("title")?.replace(Regex("<[^>]+>"), "") ?: return@mapNotNull null
            SAnime.create().apply {
                this.title = title
                setUrlWithoutDomain("bvid/$bvid")
                o.str("pic")?.let { thumbnail_url = normalizePic(it) }
                author = o.str("author")
                description = o.str("description")
            }
        }
    }

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val q = signedQuery(
            mapOf(
                "search_type" to "video",
                "keyword" to query,
                "page" to page.toString(),
            ),
        )
        return GET("https://api.bilibili.com/x/web-interface/wbi/search/type?$q", apiHeaders())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val root = runCatching {
            json.parseToJsonElement(response.body.string()).jsonObject
        }.getOrNull() ?: return AnimesPage(emptyList(), false)

        val code = root["code"]?.jsonPrimitive?.int ?: -1
        if (code != 0) {
            val msg = root.str("message").orEmpty()
            throw Exception(
                when (code) {
                    -412 -> "搜索触发风控，请稍后重试或配置 SESSDATA"
                    else -> "搜索失败（$code）：$msg"
                },
            )
        }

        val data = root["data"]?.jsonObject ?: return AnimesPage(emptyList(), false)
        val result = data["result"]?.jsonArray ?: return AnimesPage(emptyList(), false)

        val animes = result.mapNotNull { el ->
            val o = el.jsonObject
            val bvid = o.str("bvid") ?: return@mapNotNull null
            val title = o.str("title")?.replace(Regex("<[^>]+>"), "") ?: return@mapNotNull null
            SAnime.create().apply {
                this.title = title
                setUrlWithoutDomain("bvid/$bvid")
                o.str("pic")?.let { thumbnail_url = normalizePic(it) }
                author = o.str("author")
                description = o.str("description")
            }
        }
        val numPages = data["numPages"]?.jsonPrimitive?.int ?: 1
        return AnimesPage(animes, animes.isNotEmpty() && numPages > 0)
    }

    // ---------------- 偏好 ----------------

    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        EditTextPreference(screen.context).apply {
            key = PREF_SESSDATA
            title = "SESSDATA（登录 Cookie）"
            summary = "填了才能看 1080P / AI 字幕。浏览器登录 B站后从 DevTools 的 Cookie 里复制"
            setDefaultValue("")
        }.also(screen::addPreference)
    }

    companion object {
        private const val PREF_SESSDATA = "pref_sessdata"

        private const val UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

        private val MIXIN_KEY_ENC_TAB = intArrayOf(
            46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
            27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
            37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
            22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
        )
    }
}

/**
 * 取字符串字段。字段可能是字符串、数字，也可能是对象/数组——
 * 后两种一律返回 null，绝不抛异常。
 *
 * 之前直接 `this[key]?.jsonPrimitive` 在字段是对象时会抛
 * "Element class JsonObject is not a JsonPrimitive"，整个列表解析崩掉。
 */
/** B 站 qn 码 → 可读画质。 */
/**
 * 通过反射给 Video 设置 mpvArgs。
 *
 * 编译期链接的是 lib-14 ABI（构造器只有 6 个参数，没有 mpvArgs），但 Fushi
 * 宿主运行的是 lib-16 的 Video 类，它带 `mpvArgs: List<Pair<String,String>>`。
 * 直接调 lib-16 的构造器编译不过，所以编译用 lib-14、运行期用反射补字段。
 *
 * 音频为什么要走 mpvArgs：B 站 DASH 音视频分离，而 Fushi 桌面端的桥接只投影
 * 五字段（videoTitle/resolution/bitrate/preferred/headers），audioTracks 会被
 * 丢掉。libmpv 的 `--audio-file=<url>` 能把外挂音轨和视频合并播放。
 *
 * 反射失败（宿主不是 lib-16）时静默跳过——视频照常播，只是没声音，不抛异常
 * 打断整条取流链路。
 */
@Suppress("UNCHECKED_CAST")
private fun attachMpvArgs(video: Any, args: List<Pair<String, String>>) {
    if (args.isEmpty()) return
    runCatching {
        val f = video.javaClass.getDeclaredField("mpvArgs")
        f.isAccessible = true
        f.set(video, args)
    }
}

private fun qualityLabel(qn: Int): String = when (qn) {
    127 -> "8K"
    126 -> "杜比视界"
    125 -> "HDR"
    120 -> "4K"
    116 -> "1080P60"
    112 -> "1080P+"
    80 -> "1080P"
    74 -> "720P60"
    64 -> "720P"
    32 -> "480P"
    16 -> "360P"
    else -> "qn=$qn"
}

private fun JsonObject.str(key: String): String? {
    val el = this[key] ?: return null
    return runCatching { el.jsonPrimitive.contentOrNull }.getOrNull()
}

/** 取对象字段，类型不对时返回 null 而不是抛异常。 */
private fun JsonObject.obj(key: String): JsonObject? {
    val el = this[key] ?: return null
    return runCatching { el.jsonObject }.getOrNull()
}

/** 取数组字段，类型不对时返回 null。 */
private fun JsonObject.arr(key: String): kotlinx.serialization.json.JsonArray? {
    val el = this[key] ?: return null
    return runCatching { el.jsonArray }.getOrNull()
}
