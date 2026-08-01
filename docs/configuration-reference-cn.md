# Ntfy Sync 配置参考

[English](configuration-reference.md) | [简体中文](configuration-reference-cn.md)

本文档记录规则求值、条件操作符、动作字段、路径约束和模板变量。安装方法与精简的产品介绍请参阅[中文 README](../README_CN.md)。

## 规则求值

- 规则按列表从上到下检查。
- 禁用规则会被跳过；第一个满足全部条件的启用规则生效，随后停止匹配。
- 同一规则内的多个条件是 **AND（且）** 关系。需要 OR（或）时，应创建多条 action 相同的规则。
- 没有条件的规则匹配所有消息，因此 catch-all 规则通常应放在最后。

## 规则字段

| 配置项 | 说明 |
| --- | --- |
| **Rule name** | 规则列表中显示的可读名称，不参与匹配。 |
| **Enabled** | 启用或停用规则，不会删除规则。 |
| **Conditions** | 所有条件都必须满足；**Add condition** 添加另一个 AND 条件。无条件表示匹配全部消息。 |
| **Note path template** | 以 `.md` 结尾的 Vault 相对路径，例如 `Ntfy Sync/{{messageDate:YYYY-MM}}.md`。不允许绝对路径、`.`/`..`、空路径组件或逃逸 Vault 的路径。 |
| **Content template** | 选择用于渲染消息块的内容模板。插件始终附加强制 `ntfy-sync:v1` marker，以保证幂等写入。 |
| **Insertion mode** | **Append** 写到文末；**Prepend** 写到文首；**After heading** 写到指定 Markdown 章节末尾。 |
| **Heading** | 选择 **After heading** 时必填，按去除首尾空白后的完整 Markdown heading 精确匹配，例如 `### Inbox`。目标笔记中不存在时会先创建该 heading。 |
| **Attachment path template** | 可选的附件下载目标。仅在附件下载已启用且附件通过同源/安全策略时使用；否则在内容中写入附件链接。留空即采用 link-only。 |

## 条件说明

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

## 路径与内容模板变量

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

## 顺序示例

1. **GitHub links**：`First URL host` / `host or subdomain of` / `github.com` → `Clippings/GitHub.md`。
2. **High priority**：`Priority` / `is at least` / `4` → `Ntfy Sync/Urgent.md`。
3. **Inbox fallback**：无条件 → `Ntfy Sync/Inbox.md`。

按此顺序，priority 5 的 GitHub 消息仍由 **GitHub links** 处理，因为 first-match 会在 **High priority** 之前停止。

![Ntfy Sync 消息分发规则编辑器](assets/ntfy-sync-rule-editor-cn.png)
