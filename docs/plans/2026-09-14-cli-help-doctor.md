# CLI help 与只读诊断

## 目标

在统一产品入口 `scripts/cinba.ts` 增加两项基础能力：

- `cinba help`、`cinba --help`、`cinba -h`：显示当前真实可用的产品命令。
- `cinba doctor [project]`：以稳定、可测试的输出检查当前运行环境，但不修改任何状态。

## Doctor 检查范围

1. Node.js 是否满足仓库要求的 24+。
2. CLI 所在 checkout 是否包含产品入口、TUI 与 server 的关键文件。
3. 默认或显式指定的项目路径是否是可访问目录。
4. 当前有效 Core：
   - 未设置 `CINBA_SERVER` 时，通过 `core-manager` 只读检查本机共享 Core；stopped 是正常信息，
     因为客户端会按需启动它。
   - 设置 `CINBA_SERVER` 时，通过 `core-client` 探测该地址对应的 `/healthz`；不可达视为失败。

每项结果分为 `PASS`、`INFO`、`FAIL`。仅出现 `FAIL` 时命令使用非零退出码，方便以后被安装器或
支持脚本调用。诊断不自动修复，不创建目录，也不启动或停止 Core。

## 结构

诊断实现放入独立的 `scripts/doctor.ts`，避免产品命令解析重新膨胀。`scripts/cinba.ts` 只解析命令、
调用诊断并决定退出码。检查依赖可注入，以单元测试覆盖本机、远程、失败和输出格式。

## 验证

- CLI 单元测试覆盖 help 别名、doctor 参数与原有项目简写的兼容。
- Doctor 单元测试覆盖正常、提示和失败结果。
- 真实运行 `cinba help` 与 `cinba doctor`。
- push 前运行完整 `npm run check`。

本次不改变 Core 生命周期，不安装依赖，不部署 VPS，也不修改 prod、Caddy 或 Tailscale。
