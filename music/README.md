# Fushi 音乐插件 v4.2.3 —— 三源分包（网易云 / QQ音乐 / B站）

> 本文接替《Bilibili音乐插件-交付说明.md》（v3.x 历史）。当前交付以本文与三个
> `*-4.2.3.fushiplug` 为准。

## 版本增量
- **v4.2.3**：B 站搜索过滤**默认改为 off**（全部保留，含合集/精选/超长视频）。
  想要干净结果就在「B 站插件设置」里填 `on` 开启过滤。逻辑翻转：以前"没存过=开"，
  现在"显式存过 on 才开"。
- **v4.2.2**：QQ 全量补 `coverUrl`（`y.gtimg.cn/…/T002R300x300M000<albummid>.jpg`），
  修 QQ 搜索结果无封面。
- **v4.2.1**：手动选源候选列表三家包登录与否都出。
- **v4.2.0**：艺人页走本家原生接口 + B 站过滤开关（见下）。

## v4.2.0 新增（本轮）

1. **艺人页走本家原生接口**（不再借网易搜歌名拿合作曲）：
   - 网易：`/api/artist/{id}` 热门50首 + `/api/artist/albums/{id}` 专辑列表（免登录实测可用）
   - QQ：`GetSingerDetail`(mid→数字id) + `GetSingerSongList` 热门曲 + `fcg_v8_singer_album` 专辑 + `fcg_v8_album_detail_cp?albummid=` 专辑曲目
   - 注：网易"热门50首"头部本来就是官方排序（周杰伦含布拉格广场/屋顶等合作曲），
     这与网易 App 艺人页一致，不是 bug。
2. **B 站搜索过滤开关**：B 站包登录入口多一个「B 站插件设置」表单，
   `bili_filter = on/off`（on=过滤合集/精选/超10分钟视频，off=全部保留），存 storage 持久生效。
   （音乐插件契约没有 preferences 机制，login form 是唯一能收用户输入的通道。）

## 为什么拆成三个包

v3.x 把三家结果塞在**一个插件**里返回。宿主搜索结果页把单个插件的结果当一条
扁平列表展示，网易 30 条永远打头，QQ/B站 被挤到看不见——这就是你看到的
"搜索结果全是网易云"。

宿主 UI 里**唯一按来源分列的机制就是"插件"本身**（搜索页顶部「全部来源」chip
按插件逐个生成，FuoEvolve 的多源分列也是每个源一个 provider）。
所以 v4.0 把同一套代码打成**三个插件包**，每家各占一个 chip、各列各的结果。

## 交付物（D:\ai4fushi\）

| 文件 | 插件 id | 来源 chip 名 |
|---|---|---|
| **`dev.fushi.music.netease-4.2.0.fushiplug`** | dev.fushi.music.netease | 网易云音乐 |
| **`dev.fushi.music.qq-4.2.0.fushiplug`** | dev.fushi.music.qq | QQ音乐 |
| **`dev.fushi.bilibili-4.2.0.fushiplug`** | dev.fushi.bilibili | Bilibili 音乐 |
| `bilibili-plugin-key.pem` | 三包共用签名私钥（公钥一致，覆盖安装不丢登录态） |
| `bilibili-plugin-src/`、`plugins/{netease,qqmusic,bilibili}/` | 源码树（`config.js` 的 SOURCE 区分来源） |

三包 `inspect` 全过；逐文件 sha256 复核 files.json 全部 ALL-OK。

## 安装

1. 三个包都走「设置 › 音乐 › 插件音源 › 从文件安装」。
   B 站包沿用旧 id `dev.fushi.bilibili`，直接覆盖 3.x；网易/QQ 是新装。
   ⚠️ 音乐插件**没有 CLI 安装命令**（`ext` 只有 manga/anime/novel），只能 app 内装。
2. 装好后搜索页顶部「全部来源」chip：`本地` `Bilibili 音乐` `网易云音乐` `QQ音乐`。
   点谁只看谁；「全部来源」下三家按插件分段列出，不再互相挤占。

## 各包能力（v4.2.0）

| | 网易云音乐 | QQ音乐 | Bilibili 音乐 |
|---|---|---|---|
| 歌曲搜索 | ✅ 分页 | ✅ **真分页**（client_search_cp，total 数百） | ✅（综合搜索视频，过滤合集/超长） |
| 专辑/艺人搜索 | ✅ 分页 | ✅（smartbox，仅第一页） | ✅（artist 走 bili_user 组） |
| 歌单搜索 | ✅ | ✅ | ❌（B站无歌单实体，不出该页签） |
| 最佳匹配卡 | ✅ | — | — |
| 三轨歌词 | ✅ 本家直取（原文+译文+罗马音） | ✅ 本家直取 | ✅ 自动关联网易/QQ（跨包按 id 查详情接口） |
| 官方直连播放 | ✅ 免费歌 + 登录 Cookie | ✅ 免费歌 + 登录 Cookie | ✅ 公开音轨（无需会员） |
| 播放不可用时 | 自动转 B 站 | 自动转 B 站 | 候选间自动换源 + **手动选源** |
| 歌单/收藏/喜欢 | ✅ 网易账号；未登录落本地歌单 | ❌ 未声明（QQ 写接口没接，宿主不出菜单项） | 本地歌单 / B 站收藏夹（扫码） |
| 登录 | Cookie(MUSIC_U/__csrf) | Cookie(qm_keyst 等) | 扫码（收藏夹用） |

能力没声明的项，宿主「⋯」菜单不会出现对应按钮——这是契约行为，不是 bug。

## 手动选 B 站视频（换源）

入口 = 宿主曲目菜单里现成的**「以这首起电台」**（B 站包把它实现成候选选源）：

1. 播放页/列表 ⋯ 菜单点「以这首起电台」→ 列出这首歌的 B 站候选视频
   （【推荐源】= 标题含完整歌名；【备选源】= 弱匹配，注意甄别翻唱/纯音）
2. 点哪条就播哪条，并**持久记为该曲目的首选播放源**
3. 之后直接播这首歌（不点电台）也用你选定的那条
4. 歌词不受影响：`via:` 曲目自动跟随原曲目取网易/QQ 三轨

自动换源（v3.4 引入）仍在：首选视频下架/付费取不到流时自动跳下一个候选，
坏源记黑名单不再重试。

## v4.0.1 相对 v4.0.0 的修复（本轮）

1. **QQ 歌曲搜索升级**：从 smartbox（无分页、只第一页）改为 `client_search_cp`
   （真分页、total 可达数百、带专辑信息）。
2. **QQ artist 实体字段修正**：艺人显示字段是 `name` 不是 `title`，写成 title 会被
   宿主整条丢弃（smoke WARN "missing or empty name"）。已修。
3. **直接播不依赖先搜索**：`viaBili` 从 `trackMeta`（只查 storage）升级为 `resolveMeta`
   （storage 查不到就走网易/QQ 详情接口兜底）。实测 reset 后直接 stream 也能拿到歌名
   转 B 站播放（206）。
4. **验收补严**：三包 `smoke --strict` 退出码全部 = 0（AGENTS.md 的 Done 标准），
   不再只看 OK 行数。

## 登录 bug 修复（v3.5 修，v4 继承）

"输入 Cookie 仍显示未登录"的两个根因都已修：
1. 验证端点 `/weapi/w/nrc/home` 返回空 body → 解析失败误判未登录。
   改用官方 `/api/nuser/account/get`（带 Cookie 明文 GET，实测有效）。
2. `req()` 没把 Cookie 发出去。现在 music.163.com 的请求自动附带。
3. 附带：Cookie 存了但验证不过时，提示从虚假的"登录成功"改为如实报错。

⚠️ 用真 Cookie 的端到端登录我手上没有有效凭证、**还没实测**，请你装好后试一次；
不对的话把「账号」行显示的内容发我。

## 验证记录（2026-11-08，v4.2.0）

```
smoke --strict「周杰伦」：netease exit=0 / qq exit=0 / bili exit=0
网易艺人页 ne-artist:6452 → /api/artist 热门50首 ✅
网易艺人专辑页 → /api/artist/albums（太阳之子 2026…）✅
QQ 艺人页/专辑页/专辑曲目 → 原生接口（晴天/叶惠美 11 首）✅
B站过滤开关：settings 表单 begin 预填当前值 → submit off 生效 →
  搜索重新出现「精选100首」合集（15 条）✅
inspect ×3 → OK
```

## 验证记录（2026-11-08，v4.0.1）

```
smoke --strict「周杰伦」：netease exit=0 / qq exit=0 / bili exit=0，无 WARN/ERROR
QQ song 真分页：page0 发如雪/晴天…带专辑，page1 仍有 5 条 ✅
三家 artist 各出自家：ne-artist / qq-artist / mid ✅
QQ 直接播（reset 后不先搜索）：resolveMeta 兜底 → B站 255kbps 206 ✅
网易直接播：150kbps ✅
QQ lyrics：本家三轨 ✅
inspect ×3 → OK；files.json 逐文件 sha256 全 ALL-OK ✅
```

## 已知边界

- 三包 storage 相互独立：元数据缓存/歌词关联各存各的，跨包靠详情接口兜底（多一次请求）。
- QQ 专辑/艺人仍走 smartbox（无免登录分页接口），只第一页；QQ 写操作未接（不声明能力）。
- B 站 artist 依赖综合搜索 bili_user 组，冷门关键词可能为空。
- 网易/QQ 直连都要登录 Cookie；VIP 内容两家都不给流，自动转 B 站。
- 手动换源候选来自 B 站搜索，冷门歌候选少；【备选源】注意甄别翻唱/纯音。

## 重新构建

源码树 `bilibili-plugin-src/`（SOURCE 无关逻辑）+ 每包 `config.js`（SOURCE: ne|qq|bili）
+ 各自 `manifest.json`（id/name/description/capabilities/searchTypes 有差异）。
构建脚本 `build3.py`（如已清理需按上表重建）。
打包：`node <SDK>/fushi-plugin.mjs pack plugins/<pkg> --key bilibili-plugin-key.pem`，
三包必须用同一把私钥。
