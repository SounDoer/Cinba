# 仓库公开前安全审计

日期：2026-09-13
状态：通过；仓库已于 2026-09-13 切换为 public

## 1. 范围

本次检查覆盖：

- 当前 Git 索引中的全部跟踪文件；
- 所有本地可达分支和 tag 的完整历史，共 162 个 commit；
- 跟踪文件名、文本内容、remote URL、分支、tag；
- commit 的 author 与 committer 姓名、邮箱元数据。

本次没有改写历史，也没有读取仓库外的 `.cinba`、`.pi`、模型凭据或用户项目。

## 2. 内容检查

对全部可达 commit 批量检查了以下高风险特征：

- PEM private key；
- OpenAI、Anthropic、GitHub、AWS、Google、Tailscale、npm 与 Slack 常见 token 形状；
- JWT；
- URL 内嵌用户名和密码；
- 静态 `apiKey`、`token`、`secret`、`password` 赋值；
- email、Tailscale 域名、IPv4 地址和 Windows 用户目录；
- 疑似高熵长字符串。

没有发现真实 private key、访问 token、密码、JWT、内嵌 URL 凭据、可路由公网 IP、真实
`*.ts.net` 名称或真实用户目录。

命中项经逐条核对后均为：

- 凭据测试中明确命名为 `FAKE_KEY` 的合成值及其历史旧路径；
- E2E 测试中发送给假 provider 的合成 key；
- 设计文档中的示例 key、示例 Tailscale 域名和 CGNAT 地址；
- loopback、通配监听地址、测试地址与 Git revision；
- `package-lock.json` 中 npm 包的完整性哈希；
- Git 测试使用的保留示例邮箱。

这些值没有凭据能力，不构成泄露。若未来任何“测试值”曾复制自真实凭据，仍必须在对应服务端
撤销；从 Git 中删除不能让已经泄露的凭据重新安全。

## 3. Git 身份元数据

全部可达历史只包含一组 author／committer 身份，但它使用自定义姓名和邮箱，而不是 GitHub
`noreply` 地址。仓库公开后，这组身份会随 commit 历史公开。

是否接受属于隐私选择，不是代码安全问题。用户已于 2026-09-13 确认可以公开当前身份，因此本次
不重写历史。

如果将来改变决定，重写历史会改变所有 commit hash，并影响已有 clone、`prod` 分支和文档中引用
的 hash，届时必须另行设计和确认，不能把它当作普通提交处理。

## 4. 预防性加固

根 `.gitignore` 已补充：

```text
.env.*
!.env.example
.cinba/
.pi/
*.key
*.pem
*.p12
*.pfx
```

这能降低以后在仓库目录内误生成并提交运行配置、Pi 数据、环境文件和常见私钥容器的风险。
`.env.example` 仍可提交，但其中只能使用明显的占位值。

## 5. 结论与边界

本轮基于规则的当前文件与全历史审计没有发现需要撤销的秘密，也没有发现必须清除的 VPS 地址。
用户也已接受公开现有 commit 身份。仓库内容可以进入公开流程，本次审计没有剩余阻塞项。

审计完成并加入 README、项目元数据与 MIT License 后，`SounDoer/Cinba` 已切换为 public。GitHub
已正确识别默认分支、README 与 MIT License。

本机未安装 `gitleaks` 或 `trufflehog`，因此本次使用 Git 全历史批量模式匹配与人工复核，而不是
这些工具的规则库。正式切换为公开仓库前，仍应在 GitHub 页面复核仓库可见性、默认分支和可见
分支，并在可用时开启 GitHub secret scanning 作为持续防线。
