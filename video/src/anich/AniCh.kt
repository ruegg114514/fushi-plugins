package eu.kanade.tachiyomi.animeextension.all.anich

import androidx.preference.ListPreference
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.animesource.ConfigurableAnimeSource
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import extensions.utils.getPreferencesLazy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Headers
import okhttp3.Request
import okhttp3.Response
import java.util.Base64
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class AniCh : ConfigurableAnimeSource, AnimeHttpSource() {

    override val name = "AniCh"
    override val lang = "all"
    override val supportsLatest = true

    private val preferences by getPreferencesLazy()

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    override val baseUrl: String
        get() = preferences.getString("pref_node", NODES[0]) ?: NODES[0]

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .add("User-Agent", "cx.xs.open Android 1.0.0")
        .add("Accept", "*/*")

    // ---------------- cursor pagination ----------------
    // AniCh 的 skip 是游标（上一页最后一条的 id），不是偏移量。
    // 按「节点+频道」分别记住游标；刷新第一页（skip=0 请求）时重置。

    private val cursors = HashMap<String, Long>()

    private fun channelOf(path: String): String = when {
        path.contains("/recommend") -> "recommend"
        path.contains("/latest") -> "latest"
        path.contains("/list") -> "list"
        else -> "list"
    }

    private fun listRequest(channel: String, page: Int): Request {
        val key = baseUrl + "/" + channel
        val skip = if (page <= 1) {
            cursors.remove(key)
            0L
        } else {
            cursors[key] ?: return GET("$baseUrl/bangumi/$channel?skip=0")
        }
        return GET("$baseUrl/bangumi/$channel?skip=$skip")
    }

    override fun popularAnimeRequest(page: Int): Request = listRequest("recommend", page)

    override fun latestUpdatesRequest(page: Int): Request = listRequest("latest", page)

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response)

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response)

    private fun parseList(response: Response): AnimesPage {
        val channel = channelOf(response.request.url.encodedPath)
        val raw = response.body.bytes()
        if (channel == "recommend") {
            // /bangumi/recommend 是 JSON，且 data[].list 是单引号伪 JSON 字符串：
            // 用正则抽 id/title/image，skip 服务端忽略 → 单页
            val text = String(raw, Charsets.UTF_8)
            val animes = ArrayList<SAnime>()
            val re = Regex("""["']id["']:\s*(\d+),.*?["']title["']:\s*["']([^"']*)["'].*?["']image["']:\s*["']([^"']*)["']""")
            var lastId = 0L
            for (m in re.findAll(text)) {
                val id = m.groupValues[1].toLongOrNull() ?: continue
                val title = m.groupValues[2]
                val image = m.groupValues[3]
                if (title.isBlank()) continue
                lastId = id
                animes.add(
                    SAnime.create().apply {
                        this.title = title
                        setUrlWithoutDomain("id/$id")
                        if (image.isNotBlank()) thumbnail_url = image
                    },
                )
            }
            return AnimesPage(animes, false)
        }
        val body = asProto(raw)
        // latest 的字段号与 list 不同：latest=2:id/7:title/6:image；list=1:id/2:title/7:image
        var lastId = 0L
        val animes = fields(body, 1).mapNotNull { item ->
            val f = decode(item)
            val id: Long
            val title: String
            val image: String
            if (channel == "latest") {
                id = varintField(f, 2)
                title = stringField(f, 7)
                image = stringField(f, 6)
            } else {
                id = varintField(f, 1)
                title = stringField(f, 2)
                image = stringField(f, 7)
            }
            if (id <= 0 || title.isBlank()) return@mapNotNull null
            lastId = id
            SAnime.create().apply {
                this.title = title
                setUrlWithoutDomain("id/$id")
                if (image.isNotBlank()) thumbnail_url = image
            }
        }
        if (animes.isNotEmpty() && lastId > 0) cursors[baseUrl + "/" + channel] = lastId
        return AnimesPage(animes, channel != "recommend" && animes.isNotEmpty())
    }

    // ---------------- details ----------------

    override fun animeDetailsRequest(anime: SAnime): Request {
        val id = anime.url.substringAfter("id/").substringBefore("?")
        return GET("$baseUrl/bangumi/detail/$id")
    }

    override fun animeDetailsParse(response: Response): SAnime {
        return try {
            val j = json.parseToJsonElement(response.body.string()).jsonObject
            SAnime.create().apply {
                title = j["title"]?.jsonPrimitive?.content ?: ""
                description = j["overview"]?.jsonPrimitive?.content
                thumbnail_url = j["image"]?.jsonPrimitive?.content
                status = SAnime.UNKNOWN
                genre = j["genres"]?.jsonArray
                    ?.mapNotNull { it.jsonPrimitive.content }
                    ?.joinToString(", ")
            }
        } catch (_: Exception) {
            SAnime.create()
        }
    }

    override fun episodeListRequest(anime: SAnime): Request {
        val id = anime.url.substringAfter("id/").substringBefore("?")
        return GET("$baseUrl/bangumi/episodes/$id")
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        val code = response.code
        if (code != 200) {
            throw Exception("该作品在当前节点无可用资源（HTTP $code），可换节点或跳过单集条目")
        }
        val body = asProto(response.body.bytes())
        val workId = response.request.url.pathSegments[2]
        val eps = fields(body, 1).map { e ->
            val f = decode(e)
            val title = stringField(f, 8)
            SEpisode.create().apply {
                name = title.ifBlank { "视频" }
                date_upload = -1L
            }
        }
        if (eps.isEmpty()) {
            // 单集条目（电影等）episodes 端点可能 500/空：给一条兜底集
            return listOf(
                SEpisode.create().apply {
                    name = "正片"
                    episode_number = 1F
                    setUrlWithoutDomain("vod/$workId/1")
                },
            )
        }
        return eps.mapIndexed { i, e ->
            e.apply {
                episode_number = (i + 1).toFloat()
                setUrlWithoutDomain("vod/$workId/${i + 1}")
            }
        }
    }

    override fun videoListRequest(episode: SEpisode): Request =
        GET("$baseUrl/${episode.url.substringBefore("?")}")

    override fun videoListParse(response: Response): List<Video> {
        if (response.code != 200) {
            throw Exception("该作品在当前节点无可用资源（HTTP ${response.code}）")
        }
        val body = asProto(response.body.bytes())
        val seen = HashSet<String>()
        val candidates = ArrayList<Triple<String, String, String>>() // url, quality, host
        for (item in fields(body, 1)) {
            val f = decode(item)
            val raw = stringField(f, 1)
            if (raw.isBlank()) continue
            val url = deobfuscateUrl(raw)
            if (!url.startsWith("http")) continue
            val type = stringField(f, 5)
            val caption = stringField(f, 4)
            if (isAdUrl(url)) continue
            if (!seen.add(url)) continue
            val quality = when {
                caption.isNotBlank() && type.isNotBlank() -> "$caption · $type"
                caption.isNotBlank() -> caption
                else -> type.ifBlank { "line" }
            }
            val host = try {
                url.substringAfter("://").substringBefore("/")
            } catch (_: Exception) {
                ""
            }
            candidates.add(Triple(url, quality, host))
        }
        if (candidates.isEmpty()) {
            throw Exception("该集无可用线路（可在源设置里切换节点）")
        }
        // 并发探活：HEAD→GET Range 兜底，2.5s 超时；结果写进清晰度标签，
        // 用户在播放页线路菜单里直接看到「可达/延迟/失败」，并按此排序。
        val probed = probeAll(candidates)
        val videos = probed.map { (c, latencyMs) ->
            val mark = when {
                latencyMs == null -> "✕"
                latencyMs < 0 -> "…"
                latencyMs < 150 -> "⚡${latencyMs}ms"
                latencyMs < 600 -> "${latencyMs}ms"
                else -> "${latencyMs}ms⚠"
            }
            Video(c.first, "${c.second} · ${c.third} · $mark", c.first)
        }
        // 排序：可达优先 → 延迟升序 → 1080P 优先
        return videos.sortedWith(
            compareBy<Video> { it.quality.contains("✕") }
                .thenBy { latencyOf(it.quality) }
                .thenByDescending { it.quality.contains("1080") },
        )
    }

    private fun latencyOf(q: String): Long =
        Regex("(\\d+)ms").find(q)?.groupValues?.get(1)?.toLongOrNull() ?: Long.MAX_VALUE / 2

    private fun probeAll(list: List<Triple<String, String, String>>): List<Pair<Triple<String, String, String>, Long?>> {
        val pool = Executors.newFixedThreadPool(list.size.coerceAtMost(16))
        return try {
            val tasks = list.map { c ->
                Callable<Pair<Triple<String, String, String>, Long?>> {
                    c to probe(c.first)
                }
            }
            val futures = pool.invokeAll(tasks, 4, TimeUnit.SECONDS)
            list.mapIndexed { i, c ->
                try {
                    futures[i].get()
                } catch (_: Exception) {
                    c to -1L // 超时：未知
                }
            }
        } finally {
            pool.shutdownNow()
        }
    }

    private fun probe(url: String): Long? {
        val t0 = System.currentTimeMillis()
        return try {
            val req = Request.Builder().url(url).head().build()
            client.newCall(req).execute().use { resp ->
                if (resp.code in 200..399) {
                    System.currentTimeMillis() - t0
                } else {
                    // 部分 CDN 不让 HEAD，GET 前 1KB 兜底
                    val g = Request.Builder().url(url)
                        .header("Range", "bytes=0-1023").build()
                    client.newCall(g).execute().use { r2 ->
                        if (r2.code in 200..399) System.currentTimeMillis() - t0 else null
                    }
                }
            }
        } catch (_: Exception) {
            null
        }
    }

    // ---------------- search ----------------

    private var lastKeyword = ""

    private var searchMode = "real" // real -> 真 /bangumi/search；list -> 列表过滤回退

    override suspend fun getSearchAnime(
        page: Int,
        query: String,
        filters: AnimeFilterList,
    ): AnimesPage {
        // 每次新搜索（第 1 页 / 关键词变化）都要重新尝试真搜索，
        // 否则一旦降级成 list 就永久降级，后续搜索全部失灵。
        if (page <= 1 || query != lastKeyword) searchMode = "real"
        lastKeyword = query
        if (searchMode == "real") {
            var parsed: AnimesPage? = null
            var ok = false
            try {
                val cursor = if (page <= 1) 0L else cursors[baseUrl + "/search"] ?: 0L
                val kw = java.net.URLEncoder.encode(query, "UTF-8")
                client.newCall(GET("$baseUrl/bangumi/search?keyword=$kw&skip=$cursor")).execute().use { resp ->
                    if (resp.isSuccessful) {
                        parsed = parseSearchResults(resp)
                        ok = true
                    }
                }
            } catch (_: Exception) {
                ok = false
            }
            if (ok) {
                val r = parsed!!
                if (r.animes.isNotEmpty() || page > 1) return r
            }
            searchMode = "list"
        }
        return super.getSearchAnime(page, query, filters)
    }

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request =
        listRequest("list", page)

    override fun searchAnimeParse(response: Response): AnimesPage {
        val page = parseList(response)
        if (lastKeyword.isBlank()) return page
        val hit = page.animes.filter { it.title.contains(lastKeyword, ignoreCase = true) }
        return AnimesPage(hit, page.hasNextPage)
    }

    private fun parseSearchResults(response: Response): AnimesPage {
        val body = asProto(response.body.bytes())
        var lastId = 0L
        val animes = fields(body, 1).mapNotNull { item ->
            val f = decode(item)
            val id = varintField(f, 1)
            val title = stringField(f, 2)
            val image = stringField(f, 7)
            if (id <= 0 || title.isBlank()) return@mapNotNull null
            lastId = id
            SAnime.create().apply {
                this.title = title
                setUrlWithoutDomain("id/$id")
                if (image.isNotBlank()) thumbnail_url = image
            }
        }
        if (animes.isNotEmpty()) cursors[baseUrl + "/search"] = lastId
        return AnimesPage(animes, animes.size >= 10)
    }

    private fun fallbackFilter(response: Response): AnimesPage {
        val page = parseList(response)
        if (lastKeyword.isBlank()) return page
        val hit = page.animes.filter { it.title.contains(lastKeyword, ignoreCase = true) }
        return AnimesPage(hit, page.hasNextPage)
    }

    // ---------------- preferences ----------------

    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        ListPreference(screen.context).apply {
            key = "pref_node"
            title = "API 节点"
            entries = NODES
            entryValues = NODES
            setDefaultValue(NODES[0])
            summary = "换节点可解决握手失败 / 线路失效"
        }.also(screen::addPreference)
    }

    // ---------------- protobuf helpers ----------------

    private fun asProto(body: ByteArray): ByteArray {
        if (body.isNotEmpty() && body[0] == '['.code.toByte()) {
            return try {
                json.parseToJsonElement(String(body)).jsonArray
                    .map { (it.jsonPrimitive.int and 0xFF).toByte() }
                    .toByteArray()
            } catch (_: Exception) {
                body
            }
        }
        return body
    }

    private class Field(val wt: Int, val v: ByteArray)

    private fun decode(buf: ByteArray): Map<Int, List<Field>> {
        val out = HashMap<Int, MutableList<Field>>()
        var pos = 0
        while (pos < buf.size) {
            val (key, p1) = varint(buf, pos)
            pos = p1
            val fn = (key shr 3).toInt()
            val wt = (key and 7).toInt()
            val v: ByteArray
            when (wt) {
                0 -> {
                    val (x, p2) = varint(buf, pos)
                    pos = p2
                    v = longToBytes(x)
                }
                1 -> {
                    if (pos + 8 > buf.size) return out
                    v = buf.copyOfRange(pos, pos + 8)
                    pos += 8
                }
                2 -> {
                    val (ln, p2) = varint(buf, pos)
                    pos = p2
                    val len = ln.toInt()
                    if (len < 0 || pos + len > buf.size) return out
                    v = buf.copyOfRange(pos, pos + len)
                    pos += len
                }
                5 -> {
                    if (pos + 4 > buf.size) return out
                    v = buf.copyOfRange(pos, pos + 4)
                    pos += 4
                }
                else -> return out
            }
            out.getOrPut(fn) { mutableListOf() }.add(Field(wt, v))
        }
        return out
    }

    private fun varint(buf: ByteArray, start: Int): Pair<Long, Int> {
        var res = 0L
        var shift = 0
        var pos = start
        while (true) {
            if (pos >= buf.size) return res to pos
            val b = buf[pos++].toInt() and 0xFF
            res = res or ((b and 0x7F).toLong() shl shift)
            if (b and 0x80 == 0) return res to pos
            shift += 7
            if (shift > 63) return res to pos
        }
    }

    private fun fields(buf: ByteArray, n: Int): List<ByteArray> =
        decode(buf)[n]?.filter { it.wt == 2 }?.map { it.v } ?: emptyList()

    private fun varintField(f: Map<Int, List<Field>>, n: Int): Long =
        f[n]?.firstOrNull()?.let { if (it.wt == 0) bytesToLong(it.v) else 0L } ?: 0L

    private fun stringField(f: Map<Int, List<Field>>, n: Int): String =
        f[n]?.firstOrNull()?.let { String(it.v, Charsets.UTF_8) } ?: ""

    private fun bytesToLong(b: ByteArray): Long {
        var r = 0L
        var s = 0
        for (x in b) {
            r = r or ((x.toLong() and 0x7F) shl s)
            s += 7
        }
        return r
    }

    private fun longToBytes(v: Long): ByteArray {
        val out = ArrayList<Byte>(10)
        var x = v
        while (true) {
            val b = (x and 0x7F).toInt()
            x = x shr 7
            if (x != 0L) {
                out.add((b or 0x80).toByte())
            } else {
                out.add(b.toByte())
                break
            }
        }
        return out.toByteArray()
    }

    private fun deobfuscateUrl(value: String): String {
        for (cand in listOf(value.replace("A0", "0"), value)) {
            try {
                val padded = cand + "=".repeat((4 - cand.length % 4) % 4)
                val text = String(Base64.getDecoder().decode(padded), Charsets.UTF_8).trim()
                if (text.startsWith("http")) return text
            } catch (_: Exception) {
            }
        }
        return value
    }

    private fun isAdUrl(u: String): Boolean = AD_HOSTS.any { u.contains(it) }

    companion object {
        private val NODES = arrayOf(
            "https://anich.sends.eu.org",
            "https://ani.emmmm.eu.org",
        )
        private val AD_HOSTS = listOf(
            "adkwai", "adVideoLp", "ibyteimg", "p19-", ".image",
            "kwai.net", "susercontent", "/feedback/", ".png",
        )
    }
}
