# fushi-plugins — Fushi 自建插件合集

为 [Fushi](https://github.com/hajisensai/Fushi) 制作的音源插件与视频扩展，源码与成品都在本仓库。

## 目录结构

```
music/               Fushi 音乐插件（.fushiplug，QuickJS 沙箱）
  src/               单一源码树（三个包共用，config.js 区分来源）
  plugins/           v4.2.3 成品三包
  README.md          详细交付说明（三源分包设计、手动换源、登录、过滤开关）
video/               Aniyomi 格式视频扩展（APK）
  repo.json          扩展仓库索引（Fushi「添加仓库」直接可用）
  index.min.json     同内容旧格式
  *.apk              AniCh v14.8 / Bilibili v14.21 成品
  src/               两个扩展的 Kotlin 源码
```

## 音乐插件（网易云 / QQ音乐 / Bilibili 三源分包）

安装：Fushi 设置 › 音乐 › 插件音源 › 从文件安装，依次装 `music/plugins/` 下三个 `.fushiplug`。

- 三家搜索结果各占一个来源 chip，互不挤占
- 免费歌官方直连（需粘贴 Cookie），VIP/失败自动转 B 站音轨（无会员也能听）
- **手动选 B 站视频换源**：曲目菜单「开始电台」→ 候选视频列表 → 点选即持久生效
- 三轨歌词（原文/译文/罗马音）；B 站视频自动关联网易/QQ 歌词
- 签名密钥：公钥 `y95jf9kVdRvwSsEMEuK3Wl5OeJjjDmsWxwp4oBCz438=`（私钥**不随仓库发布**）。
  自行重打包需持有同一把私钥，否则用户覆盖安装会丢登录态；无密钥者请改用自己的新密钥
  并视为全新插件安装

## 视频扩展（AniCh / Bilibili）

添加仓库（Fushi 设置或 CLI）：

```
fushi_cli ext repo add "https://raw.githubusercontent.com/ruegg114514/fushi-plugins/main/video/repo.json" --kind anime
fushi_cli ext repo sync --kind anime
fushi_cli ext install eu.kanade.tachiyomi.animeextension.all.anich --kind anime --trust-signer
fushi_cli ext install eu.kanade.tachiyomi.animeextension.all.bilibili --kind anime --trust-signer
```

（自签名 APK，install 需 `--trust-signer`；指纹 `b20c020a…f3765`，两 APK 同一把 key。）

- **AniCh**：聚合番剧站源（推荐/最新/中文搜索/线路延迟探活）。搜索只吃中文关键词是上游接口限制。
- **Bilibili**：B 站番剧/投稿源，WBI 签名抗 -412 风控。**v14.21 起走 DASH + `Video.audioTracks`**
  （宿主 Fushi 3.3.0 修复 BUG-3986 后，外挂音轨经 `audio-add auto` 正常出声，画质不再封顶 720P）；
  老视频无 DASH 时自动回退合并流。字幕经 SubtitleVttBridge 转 WebVTT。

## 重新构建

- 音乐：`node <SDK>/fushi-plugin.mjs pack <src目录> --key <pem>`（SDK 在 Fushi 仓库 tools/music-plugin-sdk）
- 视频：Kotlin 源码按 Aniyomi 扩展工程结构编译（依赖目录含 build 缓存未全量收录，
  单文件即可编译的改造见 src/ 内 gradle 脚本）

## 许可与免责

- 源码 Apache-2.0（沿用上游扩展仓库许可）
- AniCh 为第三方聚合站接口，内容版权风险自负；仅个人学习用途
- 本仓库与 Fushi 官方无关
