# 生活管家 · 本地助手

> 执行合一 · 思维建设与管理的电脑本地助手。当前首个功能：**反思打卡**。

自己设定「板块」和「条目」，每天勾选打卡，并查看统计反思趋势。文章数据和复盘图片全部保存在**本地电脑**，不上传到外部服务。

## 功能一览（知行合一 · 三模块）

- **重要时间点**：用日程和日历管理单次、每天、每周或每月事件；“备忘事件”会按日期集中展示今天之后的非重复安排，并可直接编辑、删除或跳转到当天日程。
- **原则打卡（行）**：先建立原则，再每日打卡。
  - 今日打卡：按原则分组勾选每日条目，支持补记过去日期。
  - 原则管理：自由增删改原则、条目和子节点，支持排序、重命名。
  - 今日打卡：子节点会汇总父条目的完成情况；未完成的条目可按日期记录原因。
  - 统计回顾：连续全勤天数、近 30 天完成率、可点击的近 60 天日历热力图、当天完成明细和未完成原因时间线。
- **所思（知 + 省）**：思考与反思合并为一个模块，以记录列表为入口。
  - 自由思考：同一天可建立多篇独立文章；每篇包含标题、一个自定义类别和正文，并自动保存。
  - 每日复盘：与自由思考一样按独立文章书写，支持同一天多篇、标题、类别、正文和自动保存；不使用固定问题，与每日反思分开。
  - 复盘插图：点击“插入图片”、粘贴截图或拖入图片，在光标处形成图文排版；图片可加说明、点击放大、查看原尺寸。支持 PNG、JPG、WebP、GIF，单张不超过 10 MB / 4000 万像素，每篇最多 20 张。
  - 只含图片的复盘也会保存；历史列表展示缩略图与图片数量，搜索包含图片说明。上传失败可重试或取消，未处理前不会切换到其他文章。
  - 标题可以手动填写；留空时会使用正文首个非空行。类别支持快捷新建、重命名和删除，删除类别不会删除文章。
  - 点击“所思”默认显示全部历史记录，可按“全部 / 自由思考 / 每日复盘 / 每日反思”、类别筛选并搜索标题、正文和类别；页面顶部小按钮用于新建思考、新建复盘和写每日反思。
  - 自由思考与每日复盘共用类别，使用单篇、全宽编辑页，不并排显示“当天篇目”；切换文章或新建下一篇时，先返回记录列表。桌面和手机使用相同流程。
  - 点击记录进入独立的大幅阅读页，阅读时隐藏列表与筛选栏；返回列表保留筛选条件与滚动位置。三种记录均支持。
  - 反思：反思框架完全由你定义（可增删、重命名、排序），每天按框架逐项填写，自动保存。
- **计划**：自行创建多个计划，每个计划 = 名称 + 描述 + 笔记（自动保存），支持排序、重命名、删除。

## 快速开始（Windows）

1. 双击 `生活管家.lnk` 快捷方式（或双击 `start.bat`）。
2. 等待浏览器自动打开 `http://127.0.0.1:4000`（或手动访问）。
3. 在「原则管理」里先创建原则与条目，然后回到「今天」开始使用。
4. 关闭命令行窗口即停止服务。

如果生活管家已经在运行，再次双击快捷方式会直接跳转到浏览器，不会重复启动服务。

## 手动启动

需要已安装 [Node.js](https://nodejs.org/)（≥ 16，零第三方依赖）：

```bash
node server.js            # 启动并自动打开浏览器
node server.js --no-open  # 启动但不打开浏览器
node server.js --port 8080 # 指定端口
```

## 数据存储

- 数据文件：`data/data.json`（自动创建）。
- 该文件为纯 JSON 文本，可直接用文本编辑器查看、备份、迁移。
- 当前数据版本为 v10；旧版按日期保存的 `thinkEntries` 自动迁移为 `thoughtEntries`，v6 文章补上 `kind: "free"`，v7 复盘保留原文，迁移前自动生成备份，旧文章 ID、标题和正文不变。v9 为原则条目补充启用日期，v10 为条目补充子节点列表和未完成原因存储；已有条目从最早保留的打卡日期起参与统计，以后新建节点只从创建当天参与统计。
- `thoughtEntries: [{ id, kind, date, title, text, categoryId, createdAt, updatedAt }]`，`kind` 为 `free`（自由思考）或 `review`（每日复盘）。类别仍存放在 `thoughtCategories`，`categoryId: null` 表示未分类。
- 每日复盘可附带 `blocks` 数组，按顺序保存 `{ id, type: "text", text }` 或 `{ id, type: "image", imageId, caption }`；`text` 是文字块原样连接后的纯文本，兼容搜索与旧数据。
- 图片原文件位于 `data/review-images/`，文章仅保存图片引用。移除图片或删除复盘不会销毁本地原图，以便恢复；未完成插入的上传文件也可能保留在此目录，不自动清理。
- 每日反思继续使用 `reflectFrameworks` 和 `reflectEntries`，不改变原有问答结构。旧服务运行中升级时，请重启服务并刷新页面后使用每日复盘。
- 文件损坏时服务会自动备份为 `data.json.bak-<时间戳>` 并重建。
- 请定期备份**整个 `data/` 文件夹**，同时包含 `data.json` 和 `review-images/`；只复制 JSON 会缺少图片。
- 在“原则管理”页可以创建和恢复本机备份。备份位于 `data/backups/`，每份均包含 `data.json` 与 `review-images/`；恢复前会自动保存当前数据。

## 目录结构

```
生活管家/
├── server.js        # 本地服务（静态托管 + JSON 存储 + REST API）
├── package.json     # 项目说明与启动脚本（无依赖）
├── start.bat        # Windows 一键启动
├── README.md
├── data/
│   ├── data.json    # 数据文件（自动生成）
│   └── review-images/ # 复盘原图（首次插图时生成）
└── public/
    ├── index.html   # 页面结构
    ├── style.css    # 样式
    ├── review-editor.js # 图文编辑与图片查看器
    └── app.js       # 前端逻辑
```

## API 接口（供后续扩展）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 获取全部板块与打卡记录 |
| GET | `/api/backups` | 列出本机完整备份 |
| POST | `/api/backups` | 创建包含 JSON 与复盘图片的本机备份 |
| POST | `/api/backups/:id/restore` | 恢复一份本机备份；恢复前自动备份当前数据 |
| POST | `/api/sections` | 新建板块 `{ name }` |
| PATCH | `/api/sections/:id` | 重命名板块 `{ name }` |
| DELETE | `/api/sections/:id` | 删除板块 |
| POST | `/api/sections/reorder` | 板块排序 `{ orderedIds }` |
| POST | `/api/sections/:id/items` | 新建条目 `{ name }` |
| PATCH | `/api/sections/:id/items/:itemId` | 重命名条目 `{ name }` |
| DELETE | `/api/sections/:id/items/:itemId` | 删除条目 |
| POST | `/api/sections/:id/items/reorder` | 条目排序 `{ orderedIds }` |
| POST | `/api/checkin` | 打卡 `{ date, itemId, done }` |
| POST | `/api/thoughts` | 新建文章 `{ date, kind?, title?, text?, categoryId?, blocks? }`，`kind` 为 `free`（默认）或 `review`；`blocks` 仅用于复盘 |
| PATCH | `/api/thoughts/:id` | 更新文章 `{ title?, text?, categoryId?, blocks? }`；如传入 `kind` 必须与原类型相同。已有图片时修改正文必须提交完整 `blocks`，防止旧编辑器覆盖图片 |
| POST | `/api/review-images` | 原始图片二进制请求体，`Content-Type` 必须匹配支持的图片类型；返回 `{ image: { id, url, size } }` |
| GET / HEAD | `/api/review-images/:id` | 读取本机图片；只接受服务器生成的文件标识，不支持外链或任意路径 |
| DELETE | `/api/thoughts/:id` | 删除单篇思考或复盘，不影响同日其他记录 |
| POST | `/api/thought-categories` | 新建类别 `{ name }` |
| PATCH | `/api/thought-categories/:id` | 重命名类别 `{ name }` |
| DELETE | `/api/thought-categories/:id` | 删除类别，相关文章转入“未分类” |
| POST | `/api/think` | 旧版兼容入口 `{ date, text }`，仅维护对应的兼容文章 |
| POST | `/api/reflect/frameworks` | 新建反思框架 `{ name }` |
| PATCH | `/api/reflect/frameworks/:id` | 重命名框架 `{ name }` |
| DELETE | `/api/reflect/frameworks/:id` | 删除框架（联动清理内容） |
| POST | `/api/reflect/frameworks/reorder` | 框架排序 `{ orderedIds }` |
| POST | `/api/reflect` | 保存每日反思 `{ date, entries }` |
| POST | `/api/plans` | 新建计划 `{ name }` |
| PATCH | `/api/plans/:id` | 更新名称/描述 `{ name?, description? }` |
| POST | `/api/plans/:id/note` | 保存计划笔记 `{ note }` |
| POST | `/api/plans/reorder` | 计划排序 `{ orderedIds }` |
| DELETE | `/api/plans/:id` | 删除计划 |
