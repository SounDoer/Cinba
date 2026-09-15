# Slash skills 实施计划

日期：2026-09-15

1. 在 agent 层包装 Pi `get_commands`，只向上提供校验后的 skill 名、说明和范围。
2. 在 contract 中加入 `SkillCommand`、匹配合并逻辑及 trust 请求/回复协议。
3. 在 Core 启动 Pi 前接入持久化 project trust gate，并为 create/open/default/recovery 保持同一规则。
4. live session 在启动时读取 skills，并在打开会话时向客户端发送当前 skill 目录。
5. core-client 暴露 trust 回复与 skill listing。
6. TUI 把现有静态菜单改成合并菜单，按来源分流执行。
7. Web/Desktop 增加同样的 `/` 补全和 Cinba 命令入口。
8. 将 `skills/cinba-prod` 移到 `.agents/skills/cinba-prod`。
9. 补齐 agent、contract、server、core-client、Web 与 TUI 测试，最后运行 `npm run check`。
