package eu.kanade.tachiyomi.animeextension.all.bilibili

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * 把 B 站字幕（JSON）转成 WebVTT，并通过一个**本机回环 HTTP 端点**交给宿主。
 *
 * ## 为什么必须这么做
 *
 * Fushi 宿主下载扩展提供的字幕时分两步：
 * 1. `AnimeSourceVideoClient.getRemoteVideoSubtitle` 对一个 URL 做**普通 GET**，把
 *    响应体的**原始字节**直接写盘（不做任何格式转换）；
 * 2. 之后按**文件名扩展名**挑解析器（`subtitleFormatForPath`：只认 `.srt` / `.ass` /
 *    `.ssa` / `.vtt`，未知扩展名一律回落 `.vtt`），解析时不嗅探内容。
 *
 * B 站字幕接口返回的是 JSON（`{body:[{from,to,content}]}`），宿主拿到后会被存成
 * `episode_N.<lang>.vtt` 再按 WebVTT 解析 —— 解析不出任何 cue，表现就是「字幕菜单
 * 里选了没反应 / 没有字幕」。
 *
 * 扩展侧无法拦截宿主那次 GET，唯一能改变「宿主拿到的字节」的办法，就是让这个 URL
 * 由扩展自己提供：先把 JSON 取回、转成 VTT，再由本机端点吐出去。
 *
 * ## 为什么用 ServerSocket 而不是现成的 HTTP 服务端
 *
 * 扩展编译目标是 Android SDK，`com.sun.net.httpserver.HttpServer` 在 Android 上不存在，
 * 编译期就不过；`java.net.ServerSocket` 两代平台都有，一套代码桌面 / Android 通用。
 * 只实现「GET 一个路径 → 回一段文本」这一件事，不引入任何依赖。
 *
 * ## 失败即降级
 *
 * 端口绑不上（受限环境）时 [serve] 返回 null，调用方退回原始字幕 URL —— 与改动前
 * 行为一致，不会比现在更差。
 */
internal object SubtitleVttBridge {

    /** 缓存条目上限。每条只有几 KB，超限整体清空（字幕是「当前集」在用，清掉旧的无妨）。 */
    private const val MAX_ENTRIES = 64

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val entries = ConcurrentHashMap<String, Entry>()
    private val sequence = AtomicInteger(0)

    @Volatile
    private var serverSocket: ServerSocket? = null

    /**
     * 登记一条字幕，返回可供宿主 GET 的 `http://127.0.0.1:<port>/sub/<id>.vtt`。
     *
     * [loader] **惰性**执行：宿主真正来取时才去拉 B 站的 JSON 并转换，避免
     * `getVideoList` 里为每一集预拉三四个字幕文件（取流本来就有网络往返，不该被
     * 字幕拖慢）。转换失败时端点回 404，宿主报「字幕加载失败」，不会把空文件当字幕。
     */
    fun serve(loader: () -> String?): String? {
        val port = ensureServer() ?: return null
        if (entries.size >= MAX_ENTRIES) entries.clear()
        val id = "s${sequence.incrementAndGet()}.vtt"
        entries[id] = Entry(loader)
        return "http://127.0.0.1:$port/sub/$id"
    }

    /** 启动回环服务（幂等），返回监听端口；失败返回 null。 */
    private fun ensureServer(): Int? {
        serverSocket?.let { return it.localPort }
        return synchronized(this) {
            serverSocket?.let { return it.localPort }
            runCatching {
                // 端口 0 = 由内核分配空闲端口；只绑回环，不暴露到局域网。
                val socket = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
                serverSocket = socket
                thread(isDaemon = true, name = "bili-subtitle-vtt") {
                    while (!socket.isClosed) {
                        val client = runCatching { socket.accept() }.getOrNull() ?: break
                        runCatching { handle(client) }
                        runCatching { client.close() }
                    }
                }
                socket.localPort
            }.getOrNull()
        }
    }

    /** 处理一次最小可用的 HTTP/1.1 请求：读请求行与头，按路径回 VTT 或 404。 */
    private fun handle(client: Socket) {
        client.soTimeout = 15_000
        val reader = client.getInputStream().bufferedReader()
        val requestLine = reader.readLine() ?: return
        // 读掉请求头直到空行（这段内容不需要，但不读完会让对端认为请求未结束）。
        while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
        }
        val path = requestLine.split(' ').getOrNull(1)?.substringBefore('?') ?: "/"
        val id = path.substringAfterLast('/')
        val body = entries[id]?.resolve()
        val out = client.getOutputStream()
        if (body == null) {
            out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
        } else {
            val bytes = body.toByteArray(Charsets.UTF_8)
            out.write(
                (
                    "HTTP/1.1 200 OK\r\n" +
                        "Content-Type: text/vtt; charset=utf-8\r\n" +
                        "Content-Length: ${bytes.size}\r\n" +
                        "Connection: close\r\n\r\n"
                    ).toByteArray(),
            )
            out.write(bytes)
        }
        out.flush()
    }

    /** 一条字幕：惰性求值 + 只求一次（失败也不重复打网络）。 */
    private class Entry(private val loader: () -> String?) {
        @Volatile
        private var value: String? = null

        @Volatile
        private var failed = false

        fun resolve(): String? {
            value?.let { return it }
            if (failed) return null
            synchronized(this) {
                value?.let { return it }
                if (failed) return null
                val vtt = runCatching { loader() }.getOrNull()
                if (vtt == null) {
                    failed = true
                    return null
                }
                value = vtt
                return vtt
            }
        }
    }

    /**
     * B 站字幕 JSON → WebVTT。
     *
     * 输入形如 `{"body":[{"from":0.1,"to":1.78,"content":"本文"}]}`（`from` / `to` 为秒）。
     * 输出带 `WEBVTT` 头与 `HH:MM:SS.mmm --> HH:MM:SS.mmm` 时轴。
     *
     * 没有任何有效 cue 时返回 null（宁可报「加载失败」，也不交一份空字幕给播放页，
     * 否则用户会看到一个「成功但永远不显示」的轨）。
     *
     * 纯函数、不碰网络与文件，便于单测。
     */
    fun biliJsonToVtt(raw: String): String? {
        val root = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return null
        val body = root["body"] as? JsonArray ?: return null
        val builder = StringBuilder("WEBVTT\n\n")
        val headerLength = builder.length
        body.forEach { element ->
            val item = runCatching { element.jsonObject }.getOrNull() ?: return@forEach
            val from = runCatching { item["from"]!!.jsonPrimitive.double }.getOrNull() ?: return@forEach
            val to = runCatching { item["to"]!!.jsonPrimitive.double }.getOrNull() ?: return@forEach
            val content = runCatching { item["content"]!!.jsonPrimitive.contentOrNull }
                .getOrNull()
                .orEmpty()
            if (content.isBlank()) return@forEach
            builder.append(timestamp(from))
            builder.append(" --> ")
            builder.append(timestamp(to))
            builder.append('\n')
            builder.append(cleanCueText(content))
            builder.append("\n\n")
        }
        return if (builder.length == headerLength) null else builder.toString()
    }

    /**
     * 清掉 B 站字幕正文里偶尔混入的 `<c.xxx>` / `<b>` 这类标记再转义。
     *
     * 顺序不能反：先剥标记、后转义 `&`，否则剥剩下的 `&` 会被二次转义。
     * 剥成纯文本是刻意的 —— 这个应用对字幕要「点词」，标签只会干扰分词。
     */
    private fun cleanCueText(text: String): String = text
        .replace(Regex("<[^>]{1,60}>"), "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\r", "")

    /** 秒 → `HH:MM:SS.mmm`（WebVTT 要求小时段也必须有）。 */
    private fun timestamp(seconds: Double): String {
        val totalMillis = if (seconds <= 0.0) 0L else (seconds * 1000).toLong()
        val hours = totalMillis / 3_600_000
        val minutes = (totalMillis % 3_600_000) / 60_000
        val secs = (totalMillis % 60_000) / 1000
        val millis = totalMillis % 1000
        return buildString {
            append(hours.toString().padStart(2, '0')).append(':')
            append(minutes.toString().padStart(2, '0')).append(':')
            append(secs.toString().padStart(2, '0')).append('.')
            append(millis.toString().padStart(3, '0'))
        }
    }
}
