# obsidian-ntfy-sync

[English](README.md) | [简体中文](README_CN.md)

Ntfy Sync 将桌面端 Obsidian 连接到用户配置的 ntfy 服务器。移动应用、浏览器扩展、脚本及其他 ntfy 客户端发布的消息，可通过流式订阅或轮询接收，再依据有序的首条匹配规则路由为 Markdown 笔记。规则可匹配 Topic、标题、消息正文、标签、优先级、URL 和附件元数据；可配置模板则用于控制目标笔记、写入内容、插入模式及附件路径。

插件会在处理前持久化已接收的消息，并通过幂等标记避免重连或历史回放造成重复写入。它支持经过身份验证的公共或自托管 ntfy 服务器、受保护的同源附件下载、持久化恢复、死信重试、脱敏诊断，以及将处理结果可选发布到独立的 ntfy Topic。Ntfy Sync 仅支持桌面端 Obsidian。

## 消息处理流程

![Ntfy Sync 端到端消息处理流程](docs/assets/ntfy-sync-workflow-cn.png)

1. **消息来源** — 移动端、桌面端和 Web 客户端，以及浏览器扩展、CLI、HTTP API、Webhook 和自动化系统通过 HTTPS 发布消息。
2. **ntfy.sh 服务器** — 提供 Topic 发布与订阅、消息缓存和历史回放。
3. **Ntfy Sync 插件** — 通过 NDJSON Stream 或 Poll 订阅消息，持久化已接收的数据，并按首条匹配规则确定路由。
4. **Markdown 队列** — 在 Obsidian Vault 中接收路由后的笔记和附件，并写入幂等标记以避免重复处理。
5. **可选剪藏 Worker** — 监听或消费队列中的链接，拉取远程正文与媒体，并创建或补全剪藏笔记。
6. **Obsidian 知识库** — 通过双向链接和标签组织 Markdown 笔记与本地附件，便于检索、关联和长期沉淀。

## 功能特性

- 原生 NDJSON stream、定时 poll、重叠回放、重连退避，以及 stream 自动降级到 poll。
- 核心模型支持多连接组；支持 Basic/Bearer 读取认证及独立的结果发布认证。
- 带校验和、备份恢复、容量上限、dead letter 和手动重试的 JSON durable inbox。
- 新安装仅提供一条通用 Inbox 规则；用户可在结构化规则编辑器中添加按域名、topic 或 tag 匹配的路由。
- 严格的规则/模板和 Vault 相对路径；强制写入 `ntfy-sync:v1` marker。
- 同源附件下载带 redirect 和字节数限制；跨源附件保留为转义链接。
- 可选 minimal 或含路径的 result outbox、状态栏以及脱敏诊断导出。
- 主题自适应的 **Ntfy Sync** 八态状态图标；鼠标悬停或键盘聚焦时展示脱敏的连接、活动、重试、inbox 和 result-outbox 信息。
- 有序的 **Message distribution rules** 卡片，支持快速启停、添加、编辑、删除、优先级调整、结构化 all-condition 编辑、路径搜索、保存前校验、revision 和 reload 后持久化。
- 插件界面完整支持 English 与简体中文；默认跟随 Obsidian，也可显式选择语言并在 reload 后保持。
- 在 Obsidian 1.13 及以上版本中支持配置搜索，并为 Obsidian 1.12.7 保留相同的设置界面。

## 初始配置

如果尚不熟悉 ntfy，可先阅读官方 [ntfy 快速入门文档](https://docs.ntfy.sh/#getting-started)，其中介绍了订阅 topic 和发送第一条消息的方法。

1. 分别创建不可猜测的 input topic 和 result topic。使用自托管 ntfy 时，分别授予满足读写方向的最小 ACL。
2. 打开 **设置 → 第三方插件 → Ntfy Sync**，配置服务器、input topics、transport mode 和读取认证。每个 topic 必须由 1–64 个 ASCII 字母、数字、下划线或短横线组成，与 ntfy 官方格式一致。只有显式的 loopback 测试才允许 HTTP。
3. 可将处理结果发布到独立 Topic，并使用单独的写入凭据；默认启用 minimal 隐私模式和结果缓存。
4. 检查 **Message distribution rules**。规则自上而下匹配；使用箭头调整优先级，或通过标题右侧的 **Add rule** / 编辑配置结构化条件、目标笔记、模板、插入模式、heading 和附件路径。

## 配置界面截图

### 通用配置

配置消息接收、primary ntfy connection、transport mode、认证以及可选的处理结果发布。

![Ntfy Sync 通用配置](docs/assets/ntfy-sync-general-settings-cn.png)

### 规则列表

规则自上而下匹配。每张卡片都提供快速启停、优先级调整、编辑和删除控件。低频修改的插件语言选择位于页面底部，紧邻**应用**按钮的上一行。

![Ntfy Sync 消息分发规则列表](docs/assets/ntfy-sync-rule-list-cn.png)

### 规则配置

- 规则按列表从上到下检查。
- 禁用规则会被跳过；第一个满足全部条件的启用规则生效，随后停止匹配。
- 同一规则内的多个条件是 **AND（且）** 关系。需要 OR（或）时，应创建多条 action 相同的规则。
- 没有条件的规则匹配所有消息，因此 catch-all 规则通常应放在最后。

| 配置项 | 说明 |
| --- | --- |
| **Rule name** | 规则列表中显示的可读名称，不参与匹配。 |
| **Enabled** | 启用或停用规则，不会删除规则。 |
| **Conditions** | 所有条件都必须满足；**Add condition** 添加一个 AND 条件。无条件表示匹配全部消息。 |
| **Note path template** | 以 `.md` 结尾的 Vault 相对路径，例如 `Ntfy Sync/{{messageDate:YYYY-MM}}.md`。不允许绝对路径、`.`/`..`、空路径组件或逃逸 Vault 的路径。 |
| **Content template** | 选择用于渲染消息块的内容模板。插件始终附加强制 `ntfy-sync:v1` marker，以保证幂等写入。 |
| **Insertion mode** | **Append** 写到文末；**Prepend** 写到文首；**After heading** 写到指定 Markdown 章节末尾。 |
| **Heading** | 选择 **After heading** 时必填，按去除首尾空白后的完整 Markdown heading 精确匹配，例如 `### Inbox`。目标笔记中不存在时会先创建该 heading。 |
| **Attachment path template** | 可选的附件下载目标。仅在附件下载已启用且附件通过同源/安全策略时使用；否则在内容中写入附件链接。留空即采用 link-only。 |

#### 条件说明

文本匹配区分大小写，空字符串条件无效。ntfy priority 范围为 `1`（最低）到 `5`（最高）；发布端省略时默认为 `3`。

| 字段 | 可用操作符 | 匹配内容与示例 |
| --- | --- | --- |
| **Topic** | `equals`、`contains`、`starts with` | 原始来源 topic 字符串；只路由一个 topic 时优先使用 `equals`。 |
| **Title** | `equals`、`contains`、`starts with` | 可选的 ntfy title；缺失时为空字符串。 |
| **Message body** | `equals`、`contains`、`starts with` | ntfy 消息正文；执行区分大小写的字面匹配，不支持正则表达式。 |
| **Has tag** | `is` | 消息 tag 数组是否包含一个完整且大小写相同的 tag。`urgent` 不会匹配 `very-urgent`。 |
| **Priority** | `equals`、`is at least` | ntfy 数值优先级；`is at least 4` 匹配 4 和 5。 |
| **Has attachment** | `equals` + Yes/No | ntfy 是否提供了附件描述；不代表附件已经成功下载。 |
| **Has HTTP URL** | `equals` + Yes/No | 按 title、body 的顺序扫描时，是否找到有效的 `http://` 或 `https://` URL；不检查 ntfy click-action URL。 |
| **Attachment MIME type** | `equals`、`starts with` | ntfy 声明的 MIME type，例如 `image/png`；`starts with image/` 匹配所有声明为 image 的类型。搜索框提供常用 MIME 预设和清空按钮，同时仍允许输入自定义值。缺少 MIME type 时不匹配非空值。 |
| **First URL host** | `host equals`、`host or subdomain of` | title/body 中首个 HTTP(S) URL 的 hostname。只填写 `github.com` 这类 host，不含 scheme、port 或 path。host 会做 IDNA 和小写规范化；后者匹配 `github.com`、`docs.github.com`，但不匹配 `evilgithub.com`。 |

操作符的准确含义：

- `equals` 比较完整值；文本字段区分大小写。
- `contains` 对 Topic、Title、Message body 是字面子串匹配。
- `is` 检查消息 tag 数组中的一个完整元素。
- `starts with` 是字面前缀匹配；Attachment MIME type 可用 `image/` 匹配整个类型族。
- `is at least` 是数值 `>=` 比较。
- `host equals` 只匹配规范化后的完整 hostname；`host or subdomain of` 还接受其子域，并保持域名边界。

#### 路径与内容模板变量

Note path、Attachment path 和 Content template 支持下列变量。日期时间按 UTC 渲染；格式支持 `YYYY`、`MM`、`DD`、`HH`（24 小时）、`hh`（12 小时）、`mm`、`ss`、`SSS`，可使用 `-`、`/`、`_`、空格和 `:` 等分隔符。

| 变量 | 值 |
| --- | --- |
| `{{content}}`、`{{content:N}}` | 完整正文或正文前 `N` 个字符。 |
| `{{title}}`、`{{topic}}` | 消息标题和来源 topic。 |
| `{{messageId}}`、`{{sequenceId}}` | ntfy message ID 和可选 sequence ID。 |
| `{{priority}}` | 1–5 的优先级。 |
| `{{tags}}`、`{{tag:[N]}}` | 逗号分隔的 tags，或从 0 开始的第 `N` 个 tag。 |
| `{{url1}}`、`{{url1:host}}` | title/body 中首个 HTTP(S) URL 及其规范化 hostname。 |
| `{{attachment:name}}`、`{{attachment:type}}` | ntfy 声明的附件名和 MIME type。 |
| `{{messageDate:FORMAT}}`、`{{messageTime:FORMAT}}` | 按指定格式渲染的 ntfy 发布时间。 |
| `{{receivedDate:FORMAT}}` | 按指定格式渲染的本地接收时间。 |
| `{{file:path}}`、`{{file:link}}`、`{{file:embed}}` | 已下载附件的路径、wikilink 和 embed；适合内容模板，没有附件目标时为空。 |

只使用上述变量。设置校验会在规则保存或启用前拒绝不支持的变量。动态路径组件会被清理，但最终结果仍必须是合法的 Vault 相对路径。

示例顺序：

1. **GitHub links**：`First URL host` / `host or subdomain of` / `github.com` → `Clippings/GitHub.md`。
2. **High priority**：`Priority` / `is at least` / `4` → `Ntfy Sync/Urgent.md`。
3. **Inbox fallback**：无条件 → `Ntfy Sync/Inbox.md`。

按此顺序，priority 5 的 GitHub 消息仍由 **GitHub links** 处理，因为 first-match 会在 **High priority** 之前停止。

![Ntfy Sync 消息分发规则编辑器](docs/assets/ntfy-sync-rule-editor-cn.png)

## 状态图标与悬浮信息

状态栏气泡可区分 **关闭**、**仅监控**、**空闲**、**连接中**、**已连接**、**轮询中**、 **重试中** 和 **错误** 八种状态。连接中和轮询中使用轻微动画；操作系统启用 reduced motion 时自动关闭动画。

双击图标可直接打开 **设置 → Ntfy Sync**；键盘用户聚焦图标后可按 Enter 或空格打开。鼠标悬停或键盘聚焦图标会显示详细状态摘要。浮层使用 Obsidian 亮色/暗色主题变量，不采用固定纯黑背景；各行 label 左对齐、对应信息右对齐；不显示服务器 URL、topic 名称、credential、消息正文或原始错误内容。

![Ntfy Sync 已连接状态悬浮窗](docs/assets/ntfy-sync-status-tooltip.png)

| 悬浮窗行 | 具体含义 |
| --- | --- |
| `Ntfy Sync — Connected` | 根据插件开关、writer 身份和全部连接状态计算出的总体状态。还可能显示 Off、Monitor only、Idle、Connecting、Polling、Retrying 或 Error。 |
| `Receiving: enabled` | 插件设置中是否启用了消息接收和处理。 |
| `Writer: this device` | 当前设备是否负责写入 Vault；`another device` 表示仅监控。 |
| `Connections: 1 · 1 connected` | connection runner 总数，以及各运行状态的数量分布。 |
| `Subscriptions: 1` | 所有 connection 配置的输入订阅总数；不会显示 topic 名称。 |
| `Last connected: just now` | 最近一次成功建立连接距当前的相对时间。 |
| `Last message: just now` | 最近一次收到事件距当前的相对时间；不会显示消息内容。 |
| `Reconnect attempts: 0` | 所有活动 connection runner 的重连次数总和。 |
| `Last fault: <code>` | 仅在存在 transport fault 时显示；只提供稳定 fault code，不显示原始错误、URL 或 credential。 |
| `Inbox: 4 total · 0 pending · 0 dead letter` | Durable inbox 总数、未完成数量及 dead-letter 数量。 |
| `Result outbox: 0 pending` | 等待发布的结果数量；结果发布失败不会回滚已经提交的 Vault 写入。 |

## 运行时命令

- **Ntfy Sync: Reconnect** — 停止当前 transport，并根据已校验设置重新创建连接。
- **Ntfy Sync: Retry dead-letter messages** — 重新排队失败消息，不清除既有错误历史。
- **Ntfy Sync: Export redacted diagnostics** — 在 `Obsidian/ntfy/` 下生成不含正文、credential 和 topic 的诊断摘要。

## 恢复与回滚

运行状态保存在插件目录旁的 `state-v1.json`，包含校验和及上一份 snapshot 备份。主文件损坏时会隔离并从备份恢复；如果主文件和备份都损坏，插件会停止，而不是静默重建并重新处理全部消息。诊断时应保留损坏文件，并在手工恢复前使用脱敏诊断导出命令。

回滚时先禁用 **Ntfy Sync**，确认状态变为 off。禁用会终止 stream 和 poll timer，但不会删除已经写入的笔记或附件。只有 ntfy 输入停止后，才能为对应路由启用其他 ingress；除非下游流程本身具备幂等性，否则禁止两个 transport 同时写入同一队列。

## 环境要求与构建

- 桌面端 Obsidian 1.12.7 或更高版本。
- 开发环境 Node.js 22 或更高版本（`.nvmrc` 使用 Node 22）。

```sh
npm ci
npm run verify
```

可安装文件为 `main.js`、`manifest.json` 和 `styles.css`。安装到隔离测试 Vault：

```sh
npm run build
npm run install:test-vault
```

将 `OBSIDIAN_NTFY_TEST_VAULT` 设置为目录名中包含 `test` 的隔离 Vault；`install:test-vault` 会拒绝其他目标。只有完成下述部署检查后，才应手工安装到生产 Vault。

## 自动化验收

| 命令 | 验收范围 |
| --- | --- |
| `npm run verify` | 格式、lint、类型检查、单元/契约/集成测试、覆盖率、敏感信息扫描、构建、可复现性及发布包检查。 |
| `npm run test:ui` | 将构建安装到隔离测试 Vault，操作规则编辑器，验证持久化与重新加载，并恢复原设置。 |
| `npm run test:acceptance` | 执行 UI gate 及 stream、poll 场景，覆盖重连、附件、重复写入防护、结果隐私、回滚和清理。 |

验收报告写入已忽略的 `.artifacts/` 目录。

## 安全与已知限制

- 凭据存储在 Obsidian `data.json` 中，本地文件系统和 Vault Sync 权限构成安全边界。
- 幂等标记可实现 Vault 的 effective-once 写入，但不保证分布式 exactly-once；早于 ntfy 服务器缓存的消息无法恢复。
- 插件不执行 ntfy action，不同步远端 delete/clear 事件，也不支持移动端后台运行。
- 生产使用前应验证系统休眠/唤醒，以及部署环境的 TLS、CORS、代理和缓存配置。详见 [SECURITY.md](SECURITY.md)。

## 许可证与来源

项目采用 `AGPL-3.0-only` 许可证，受 Obsidian Telegram Sync 启发，并独立实现，未复制或改造其源码。
