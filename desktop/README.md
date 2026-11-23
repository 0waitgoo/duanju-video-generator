# 短剧成片工作室

Windows 10/11 x64 桌面软件。把短剧创作画布导出的项目 ZIP 转成一集带字幕的 MP4。安装包含 Electron 和 FFmpeg。

## 安装和使用

1. 双击 `Duanju-Studio-Setup-1.0.0.exe`，完成安装后打开桌面或开始菜单中的「短剧成片工作室」。安装包未签名，Windows 可能显示未知发布者。
2. 在「设置」中保存两个 Key。MiniMax H3 需要按量付费 Key，站点要与 Key 一致。测试连接只验证鉴权，不提交生成任务。
3. 拖入画布「导出项目」产生的 ZIP，或点「导入 ZIP」。在时间线查看分镜、绑定和一致性检查。可选本地配乐。
4. 点「一键生成整集」，核对预计子段数、提交时长和分辨率，确认提交。整集成片窗口可预览并「保存整集 MP4」。

[申请 MiniMax Key](https://platform.minimax.io) · [申请 DeepSeek Key](https://platform.deepseek.com)

## 生成与恢复

- 识别 `duanju-canvas-export` v1。导入保留原始台词，字幕和提示词均来自原文。导入重复画布会替换该画布之前的项目素材与成果。
- 20 秒四镜段按前后各两镜拆段。遇到只有一镜、或拆分后无法同时满足每子段至少两镜且不超过 15 秒的情况，工作室会提示回画布调整。少于 4 秒的可用子段按 4 秒提交，拼接时按分镜时长裁切。
- 四宫格、定妆照和设定图走 MiniMax H3 V2 参考图模式。支持 PNG、JPEG、WEBP 包内素材。示例包的 1×1 图片供导入和本地流程验证。正式生成时，MiniMax 要求参考图边长 256–5760 像素，宽高比 0.4–2.5。 [MiniMax H3 视频生成指南](https://platform.minimax.io/docs/guides/video-generation)
- 提示词工作台允许逐镜精简画面与运镜。台词由画布数据附入，手动编辑与 DeepSeek 都不能改写台词字段。默认保留交接规范的 `deepseek-chat`，该模型名已被服务商停用。使用优化时，可在设置切换为 `deepseek-flash`。优化是可选步骤，直接生成可用原始提示词。 [DeepSeek 停用公告](https://api-docs.deepseek.com/news/news260424/) · [现行模型](https://api-docs.deepseek.com/quick_start/pricing/)
- 关闭窗口会退出工作室。本地保存队列、提交参数与远端任务 ID，重新打开时恢复查询和下载。提交后未收到 ID 时，队列会要求核对 MiniMax 记录。可输入已有任务 ID 恢复查询，或确认重新提交。
- 默认 9:16、768P、并发 2、关闭 H3 原生声音。转场可选短叠化或直接切换。分镜音效由本地合成音类按字段关键词匹配，背景配乐使用选中的本地文件。软件没有配音入口。
- FFmpeg 对子段做统一画幅、编码和时间轴，烧录字幕，并混入选定音轨。合成失败可重新拼接。已经生成的子段可以预览或单独保存。
- 项目、音频、下载和队列记录均存在 Windows 用户数据目录下。Key 由 Windows DPAPI 加密，只向对应服务商鉴权，设置界面显示已保存 Key 的末 4 位。点生成时会把所用提示词和参考图发给 MiniMax。点 DeepSeek 优化时会把画面和运镜说明发给 DeepSeek。合成、混音、字幕和预览在本地执行。桌面应用不开放 HTTP 端口。

## 常见问题

| 提示 | 处理 |
| --- | --- |
| 1004 / HTTP 401 | 鉴权失败。检查 Key、站点和按量付费权限，保存后可恢复队列。 |
| 查询任务返回 2013 或任务已过期 | 远端任务不存在或过期。单独重试对应子段。 |
| 提交结果待核对 | 先检查 MiniMax 任务记录。有 ID 就输入后继续查询，确认没有原任务时可重新提交。 |
| 缺参考图 / 超过 9 张 / 单图超过 30 MB / 请求超过 64 MB | 根据一致性检查和任务提示调整画布素材，再重新导出。 |
| DeepSeek 提示词优化不可用 | 保留原提示词，检查模型和 Key。可在设置切换到现行 Flash 模型。 |
| 网络或磁盘空间不足 | 检查网络或清理空间。查询、下载失败后可重试原任务，合成可单独重跑。 |

## 从源码构建

运行安装后的软件不需要 Node.js。以下命令仅供构建和复测，在 Windows x64、Node.js 24 环境执行。

```powershell
npm.cmd ci
pwsh -NoProfile -File build/prepare-ffmpeg.ps1
npm.cmd start
npm.cmd run dist
```

安装包输出到 `release/`。FFmpeg 准备脚本下载固定版本并验证 SHA-256；已有归档时可传 `-Archive <路径>`。安装包内含 Gyan FFmpeg 8.1.2 Full Build 的执行文件与许可证。 [FFmpeg 构建与源码入口](https://www.gyan.dev/ffmpeg/builds/) · [FFmpeg 8.1.2 源码](https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz)

复测交接包时，把 `DUANJU_HANDOFF` 环境变量设为解压后含 `示例包`、`分镜`、`剧本` 的目录，运行 `npm.cmd test`。可设置 `DUANJU_TEST_MP4` 为测试成片的完整输出路径。原始交接素材随用户交接包提供。


