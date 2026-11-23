# 短剧视频生成项目

成熟桌面版源码、Windows 构建说明和自测报告位于 [desktop](desktop/README.md)。桌面版支持画布 ZIP 导入、生成队列和本地整集拼接。

以下为原有本地网页版说明。
# 短剧视频生成

把短剧创作画布「导出项目」的 ZIP 包读进来，按每镜绑定关系拼好 MiniMax H3 提示词，批量生成视频；文字处理走 DeepSeek，视频生成走 MiniMax H3。

> 这是给画布配套的桌面端出片工具：画布里做剧本、分镜、出图，导出 ZIP 包后在这里生成视频。

## 功能

- **导入导出包**：拖入画布「导出项目」的 ZIP（`project.json`＋`images/`），校验格式名 `duanju-canvas-export`、版本 1；重复导入同一画布整包替换。
- **按绑定拼提示词**：每段自动拼 MiniMax H3 提示词——整体设定＋本段设定＋角色音色＋格位对照＋逐镜台词（逐字）＋结尾状态；参考图带四宫格图、绑定人物的定妆照、场景/道具设定图。
- **均衡拆子段**：超 15 秒的段按画布口径均衡拆（20 秒拆成两个 10 秒：1-2 镜 / 3-4 镜）。
- **DeepSeek 优化提示词**：每段可点「优化」，把拼装稿压成 H3 精简版，台词逐字不动；提示词也能手动编辑，失败时原样保留。
- **MiniMax H3 生成**：参考图模式（V2 接口）异步提交 → 轮询 → 成片自动下载保存，可播放、可下载；模型/分辨率/画幅/带声音可在设置里调。
- **任务可见**：每个子段一个任务，状态（排队中/生成中/已完成/失败）实时可见；失败原因写进任务记录。
- **Key 只存本地**：DeepSeek Key、MiniMax Key 在设置里填，存在本机 `data/settings.json`，界面只显示末 4 位；没 Key 时生成明确拦截。
- **不拼整集**：子段成片不自动拼接成整集文件，各子段单独播放/下载（有意保持的范围）。

## 快速开始（Windows）

需要先装 [Node.js](https://nodejs.org/) 18 或更高版本。

```bat
npm install
npm start
```

然后用浏览器打开 http://127.0.0.1:3000

> 只监听本机（127.0.0.1），不会对外暴露；数据存在程序目录下的 `data/`，不会上传到任何地方。

## 使用流程

1. 在画布里点顶栏「导出项目」，下载 `<画布名>-项目导出.zip`。
2. 在本软件里把 ZIP 拖进来（或点「选择 ZIP 包导入」）。
3. 去「设置」填 DeepSeek Key 和 MiniMax Key，点「测试连接」。
4. 每段检查提示词（可点 DeepSeek 优化、也可手动改），点「生成视频」。
5. 任务跑完后在任务区播放或下载成片。

## 申请 Key

- **DeepSeek**：https://platform.deepseek.com → API Keys → 创建。按量付费，优化提示词每次只花一点。
- **MiniMax**：https://platform.minimax.io → Account Management → API Keys。**H3 须用按量付费（Pay-as-you-go）API**；国际站默认接口地址 `https://api.minimax.io`，中国大陆站可用 `https://api.minimax.cn`（在设置里可改）。

## 导出包格式

```
<画布名>-项目导出.zip
├── project.json            # 格式名 duanju-canvas-export，版本 1
│   ├── 剧本全文、每段整体设定/音色描述/结尾状态卡
│   ├── 每镜台词/时长/景别/运镜/音效
│   └── 人物/场景/道具库、每镜绑定关系（名字和 id 双份）
└── images/
    ├── segment-01-shots-1-4.png   # 四宫格图原图，按段命名
    ├── characters/                # 人物定妆照
    └── assets/                    # 资源设定图
```

## 技术说明

- **技术栈**：Node.js（内置 http 服务＋静态前端，无框架），唯一依赖是 `adm-zip`（解包用）。
- **MiniMax H3（V2 接口）**：创建 `POST /v2/video_generation`，查询 `GET /v2/query/video_generation/{task_id}`。官方约束：首帧（`first_frame`）和参考图（`reference_image`）互斥，不能混用——本项目走参考图模式，四宫格图＋定妆照＋设定图全部以 `reference_image` 提交（≤ 9 张，单张 ≤ 30MB，请求体 ≤ 64MB）。`MiniMax-H3` 支持 768P / 2K，时长 4–15 秒；子段时长不足 4 秒时按 4 秒提交。
- **DeepSeek**：`POST https://api.deepseek.com/chat/completions`，模型 `deepseek-chat`。
- **测试**：`npm test` 会起一个测试服务，导入按导出格式造的测试包，校验导入、提示词拼装、均衡拆段、假 Key 鉴权失败（不花钱、不出片）。

## 常见问题

- **提示「请先在设置里填写 MiniMax Key」**：先去设置填 Key，保存后再点生成。
- **任务失败，错误里有 1004 / 401**：MiniMax 鉴权失败——Key 不正确，或不是按量付费 Key，或接口地址（国际站/大陆站）选错了。
- **任务失败，错误里有 2013**：MiniMax 侧找不到该任务（一般是任务已过期），重新提交即可。
- **DeepSeek 优化失败**：提示词原样保留，不会丢；检查 Key 和余额后重试。
- **导入失败「不是画布导出包」**：确认 ZIP 是画布「导出项目」下下来的，包里有 `project.json`。
- **成片存在哪**：`data/downloads/`，按任务编号存为 `.mp4`，页面里也能直接播放和下载。

## License

MIT
