# 视频扩展源码说明（摘自项目交接文档）

# 三、自建扩展：AniCh（视频源）

## 3.1 是什么

把 [AniCh](https://github.com/Sle2p/AniCh)（7.3k★ 的在线动漫 App）的资源做成了 Aniyomi 格式扩展，
在 Fushi 里直接浏览/搜索/播放。

## 3.2 源码与产物位置

```
D:\无固定用途会话专用文件夹\anich-ext\
├── AniCh.kt                                    # 源码（v14.8，约 500 行）
├── build.gradle
├── AndroidManifest.xml
├── aniyomi-all.anich-v14.8-release.apk         # 成品
├── signingkey.jks                              # 签名密钥（口令 fushi123，别丢）
├── index.min.json / repo.json                  # 本地仓库索引
└── serve.py                                    # 本地仓库服务（端口 8766）
```

## 3.3 技术要点

**接口**（匿名可用，无需登录）：
```
/bangumi/recommend     → 推荐（JSON，注意不是 protobuf）
/bangumi/latest        → 最新
/bangumi/list?skip=N   → 列表（skip 是**游标**＝上页最后一条 id，不是偏移量！）
/bangumi/episodes/{id} → 剧集
/bangumi/detail/{id}   → 详情（JSON）
/vod/{id}/{ep}         → 播放线路（protobuf 数字数组）
```

**protobuf 解码**（响应是 JSON 数字数组包着 protobuf）：
```kotlin
// 1. 如果是 [10,147,2,...] 这种数组，先转成 byte[]
// 2. 按 wire format 解：varint / length-delimited
```

**播放地址混淆**：base64 里插了 `A0`，解码前要 `replace("A0", "0")`。

**广告过滤**（76 条线路里 26 条是垃圾）：
```
adkwai / adVideoLp / ibyteimg / p19- / kwai.net
susercontent / /feedback/ / .png
```

## 3.4 迭代历史（14.1 → 14.8）

| 版本 | 修了什么 |
|---|---|
| 14.1 | 初版，protobuf 解码 + 线路过滤 |
| 14.2 | 修 `animeDetailsRequest` 缺斜杠（`hostid/123` → 404） |
| 14.3 | **游标分页**（第二页 500）+ 广告过滤补漏 + 单集条目人话报错 + **线路探活**（HEAD 测延迟，标签显示 `⚡83ms` / `✕`） |
| 14.4-14.5 | **推荐接口**（`/bangumi/recommend`，服务端从单引号伪 JSON 改成标准 JSON，正则要兼容引号） |
| 14.6-14.8 | **真搜索**（`/bangumi/search`，注意**只吃中文关键词**，英文 500）+ 修 `searchMode` 永久降级 bug |

**搜索的关键发现**：
- `/bangumi/search?keyword=赛马娘` → 200 真结果
- `/bangumi/search?keyword=Frieren` → 500
- 所以：**中文搜番名有效，英文无效**

## 3.5 当前能力

| 功能 | 状态 |
|---|---|
| 热门（推荐流） | ✅ 和 AniCh App 首页一致 |
| 最新 | ✅ |
| 搜索 | ⚠️ 只吃中文关键词 |
| 剧集列表 | ✅ 中文集名 |
| 在线播放 | ✅ 已验证 |
| 线路选择 | ✅ 显示域名+延迟 |

**已知限制**：
- `episodes_total == 1` 的条目（电影/短片）在节点上无资源，会报错
- 节点会变，扩展设置里有「API 节点」下拉可切换

---

# 四、自建扩展：Bilibili（视频源）

## 4.1 源码位置

```
D:\extbuild\sbe\src\all\bilibili\
├── src/eu/kanade/tachiyomi/animeextension/all/bilibili/Bilibili.kt
├── build.gradle
├── AndroidManifest.xml
└── （编译产物）D:\extbuild\repo\apk\aniyomi-all.bilibili-v14.*-release.apk
```

⚠️ **`D:\extbuild\` 是临时目录，随时可能被清理。源码务必先备份。**

## 4.2 WBI 签名（必须，否则 -412 风控）

普通接口 `/x/web-interface/search/type` 会返回 **HTML 风控页**（HTTP 200 但内容是网页）。
必须走 `/x/web-interface/wbi/*` 并签名：

```kotlin
// 1. 拿 keys
GET https://api.bilibili.com/x/web-interface/nav
→ data.wbi_img.img_url / sub_url 取文件名（不含扩展名）

// 2. 折叠出 mixin_key（64 项置换表，取前 32 位）
val MIXIN_KEY_ENC_TAB = intArrayOf(46,47,18,2,53,8,23,32,...)
val mixin = MIXIN_KEY_ENC_TAB.joinToString("") { orig[it] }.take(32)

// 3. 签名
params["wts"] = 当前秒
query = params 按 key 字典序排序，value 过滤 [!'()*] 后 URL encode
w_rid = md5(query + mixin)
```

## 4.3 接口清单

| 用途 | 接口 |
|---|---|
| 热门 | `x/web-interface/popular` |
| 最新 | `x/web-interface/newlist?rid=1`（`dynamic/region` 已废弃返回 -404） |
| 搜索 | `x/web-interface/wbi/search/type`（需签名） |
| 详情/分P | `x/web-interface/view?bvid=` |
| 取流 | `x/player/wbi/playurl`（需签名） |
| 字幕 | `x/player/wbi/v2?bvid=&cid=`（需签名 + SESSDATA） |

## 4.4 关键决策：为什么用合并流而不是 DASH

**B 站 DASH 把音视频拆成两条独立流**。要让播放器出声，需要把音频 URL 传给播放器：

| 途径 | 结果 |
|---|---|
| `Video.audioTracks` | ❌ Fushi 桥接层丢弃（只投影 5 个字段） |
| `Video.mpvArgs = [("--audio-file", url)]` | ❌ 同样被丢弃（且 lib-14 ABI 编译不过，得反射） |
| **`fnval=0` 拿合并流（durl）** | ✅ **有声音**，但画质封顶 720P |

**所以 v14.20 用的是合并流**。这是当前唯一能出声的方案。

## 4.5 字幕（已实现，但传不到 UI）

扩展会调 `x/player/wbi/v2` 拿字幕放进 `Video.subtitleTracks`：
- B 站有 `ai-zh` / `ai-en` / **`ai-ja`**（日语 AI 字幕）三种
- 命中率约 5/8（不是所有视频都有）
- 实测日语字幕 653 条、带精确时间轴

**但 `subtitleTracks` 同样被桥接层丢弃**，UI 里看不到。

**当前可行的替代**：外部脚本拉字幕转 SRT，再 `video sub-import` 导入（已验证可正常显示+点词）。

## 4.6 迭代历史（14.1 → 14.20）

| 版本 | 修了什么 |
|---|---|
| 14.1 | 初版：WBI 签名 + 搜索/详情/分P/取流 |
| 14.2 | 修 `owner` 字段是对象导致的 `JsonObject is not a JsonPrimitive` 崩溃 |
| 14.3 | 修「最新」接口废弃（`dynamic/region` → `newlist`）+ 解析层全容错 |
| 14.4 | 尝试 `audioTracks`（失败，被桥接丢弃） |
| 14.5 | **改用合并流 `fnval=0`，终于有声音** |
| 14.6 | 尝试 `mpvArgs` 反射（失败） |
| 14.7 | 加字幕获取（`subtitleTracks`，失败——同样被丢弃） |
| 14.8-14.18 | 大量诊断日志定位画质问题（走了很多弯路，见 §5.5） |
| 14.19 | 硬编码 SESSDATA 测试（已清除） |
| **14.20** | **回退合并流，当前稳定版** |

---

