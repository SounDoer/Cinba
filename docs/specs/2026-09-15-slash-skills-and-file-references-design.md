# Slash skills 与文件引用设计

日期：2026-09-15  
状态：已确认

## 1. 目标

Cinba 的 Web、Desktop 与 TUI 提供一致的 `/` 补全：保留 Cinba 自己的命令，并展示当前
Pi 会话实际加载的 skills。用户选择 `/skill:name` 后，Cinba 把完整输入原样交给 Pi，让 Pi
完成 skill 展开；Cinba 不解析 `SKILL.md`，也不复制 Pi 的资源发现规则。

同一套输入候选框为后续 `@` 文件引用预留结构，但本阶段不实现文件附件。

## 2. 范围

第一版显示：

- Cinba 静态命令；
- Pi `get_commands` 返回且 `source === "skill"` 的命令。

第一版不显示：

- prompt templates；
- extension commands，包括内部桥接命令 `/cinba-edit-message`；
- Pi 自己只在交互式 TUI 中成立的内置命令；
- `@` 文件引用和真正的附件。

协议仍保留 Pi 返回的 skill 来源范围，供界面区分 `user`、`project` 与显式路径；不把服务器绝对路径
发给客户端。

## 3. 两类命令，两条执行路径

Cinba 命令由共享目录定义，各前端用自己的界面动作执行。例如 Web 的 `/model` 打开模型选择器，
TUI 的 `/model` 打开终端选择列表。Pi skill 命令不在客户端展开，而是连同参数原样发送：

```text
/skill:tdd fix the reconnect bug
```

Skill 名保留 Pi 的 `/skill:name` 形式，不增加 `/name` 别名。这样来源明确，也不会和 Cinba 的
`/model`、`/new` 等保留名冲突。

未知 slash 输入不交给模型，客户端显示 `no such command`。`/help` 展示当前合并目录。

## 4. 运行中语义

第一版只在会话空闲时执行 slash command。Cinba 命令不是模型消息，Pi skill 虽能进入 steer 或
follow-up，但把三种语义同时开放会让相同输入因来源不同而表现不同。运行中提交 slash input 时保留
草稿，并提示等待当前工作结束。普通文字继续沿用现有 steer / follow-up 规则。

## 5. Skill 目录与发现

Pi 是发现结果的唯一真相来源。Cinba 调用 `get_commands`，过滤 `source === "skill"`，不自行扫描
以下目录：

```text
~/.agents/skills                         跨 agent 的用户级共享 skills
<cwd>/.agents/skills                     跨 agent 的项目级 skills
<PI_CODING_AGENT_DIR>/skills             Cinba/Pi 用户级 skills
<cwd>/.pi/skills                         Cinba/Pi 项目级 skills
```

项目级 `.agents/skills` 可来自 cwd 或其祖先目录；具体胜出顺序、名称碰撞和 skill 校验均由 Pi
负责。即使 skill 设置 `disable-model-invocation: true`，它仍可作为 `/skill:name` 显式调用并应出现
在菜单中。

## 6. 项目信任

项目级 skills、settings、extensions、prompts、themes 和 system prompt 能改变 agent 行为，甚至
执行代码。Pi 在 RPC 启动阶段没有可用的交互式 TUI；若目录需要信任但没有已保存决定，Pi 默认不
加载项目资源。因此 Cinba 必须在启动该目录的 Pi 进程前完成信任判断。

Core 检查 Pi 的 trust store。没有需要信任的资源，或已有祖先目录决定时，直接继续；否则向发起
打开操作的客户端发送定向请求，列出 cwd 和检测到的资源类别。第一版提供：

- `Trust`：保存允许决定；
- `Do not trust`：保存拒绝决定。

决定属于 Core 所在机器，客户端只收集选择，不能直接读写 trust 文件。信任的是目录范围，不只是
眼前列出的 skill；界面必须说明以后加入该目录的其他 Pi 项目资源也会继承决定。

Core 用明确的 `--approve` 或 `--no-approve` 启动 Pi，避免启动前检查与 Pi 自己再次判断之间产生
不同结果。全局 `~/.agents/skills` 与 `<PI_CODING_AGENT_DIR>/skills` 是用户级资源，不触发项目
询问。

## 7. 生命周期

会话创建、从磁盘打开或进程恢复时，先完成 trust gate，再启动 Pi。Pi 就绪后读取一次
`get_commands`，把 skills 保存为该 live session 的状态；Core 在打开会话时紧跟 snapshot 发送
`skill_listing`，因此客户端不需要主动查询。

第一版不监听 skill 文件变化。新建或修改 skill 后重开会话即可；将来接入 Pi resource reload 时
再刷新目录。

`get_commands` 失败不阻断会话：Cinba 命令仍可用，skills 为空，并产生一次可见 notice。

## 8. 客户端交互

输入 `/` 打开菜单，继续输入时按命令名前缀过滤；上、下与 Tab 改变选择，Enter 执行当前选择。
菜单按 Cinba、Skills 的顺序排列，skill 只显示 `user`、`project` 或 `path`，不显示服务器绝对路径。

Web 与 TUI 共用 contract 中的目录、匹配和排序函数，但各自绘制界面并执行 Cinba UI 动作。
Desktop 继续复用 Web。

## 9. `@` 文件引用的后续边界

后续让 `/` 和 `@` 共用候选交互模型，但不共用数据来源：

```text
/  ← Cinba 静态目录 + Pi get_commands
@  ← Core 在当前 session cwd 内搜索文件
```

第一版 `@` 只插入经过 Core 校验的相对路径，由模型按需调用 `read`；不自动内联内容。真正的文本
快照、图片、PDF、大小限制和远程上传属于单独的附件设计。
