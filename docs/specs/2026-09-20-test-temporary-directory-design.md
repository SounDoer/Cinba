# 测试临时目录统一清理设计

日期：2026-09-20

状态：实施中

## 1. 背景

本机 `%TEMP%` 在 2026-09-08 到 2026-09-20 之间累积了 2455 个 `cinba-*` 目录，约 1.26 GiB，全部
来自反复执行 `npm run check`。其中 `cinba-credentials-test-*` 403 个，`cinba-sync-web-*`、
`cinba-sync-lifecycle-*`、`cinba-sync-server-*`、`cinba-sync-proxy-*`、`cinba-sync-force-*`、
`cinba-sync-status-*`、`cinba-sync-restore-*` 各约 200 个。CI 不会暴露这个问题，因为每次运行都是
全新容器，跑完整体丢弃。

`packages/**` 与 `scripts/**` 下共有 254 个测试侧 `mkdtemp` 调用点，分布在 59 个
`*.test.ts` / `*.e2e.ts` 文件中。现有写法分三类：

```ts
// A：try/finally，成败都删
const root = mkdtempSync(join(tmpdir(), "cinba-x-"));
try { /* ... */ } finally { rmSync(root, { recursive: true, force: true }); }

// B：只在顺利跑完时删——断言一旦失败就泄漏
const root = mkdtempSync(join(tmpdir(), "cinba-x-"));
/* ... */
rmSync(root, { recursive: true, force: true });

// C：完全不删
const root = mkdtempSync(join(tmpdir(), "cinba-x-"));
```

B 和 C 是泄漏的主要来源。

## 2. Windows 上的第二个问题：悬空 junction 无法删除

`%TEMP%` 中有两个目录在任何情况下都删不掉：`cinba-update-handoff-link-50Bjae` 和
`cinba-update-handoff-link-qjXZix`，时间戳均为 2026-09-18 20:06。它们来自
`packages/installer/src/update-handoff.test.ts` 中「handoff storage refuses a symbolic-link
directory」这条测试——它在临时目录里建一个 Windows junction，并让 junction 指向同一棵树里的
另一个目录。

根因已经逐步复现清楚，而且比「递归删除会失败」更具体：

**本机上，一个目标已不存在的 junction（悬空 junction）无法被任何工具删除。**

在一个全新建立的悬空 junction 上（`mklink /J link 一个不存在的路径`）实测：

| 操作 | 结果 |
| --- | --- |
| `readdir(root, { withFileTypes: true })` | 列出该项，`isSymbolicLink() === true` |
| `lstat(link)` | `ENOENT` |
| `fs.rm(link, { force: true })` | 报告成功，但条目仍在 |
| `fs.rmdir(link)` / `fs.unlink(link)` | `ENOENT` |
| `cmd rmdir` / `rd /s /q` / `Remove-Item` / `robocopy /MIR` | 找不到文件 |
| `fsutil reparsepoint query` / `delete`（含 `\\?\` 前缀） | 找不到文件 |
| `mklink /J` 覆盖同名 | 文件已存在 |
| `CreateFileW` + `FILE_FLAG_OPEN_REPARSE_POINT` | `ERROR_FILE_NOT_FOUND` |

父目录从此永远 `ENOTEMPTY`。

于是问题变成：**junction 是怎么变悬空的。** 答案是 `fs.rm(root, { recursive: true, force: true })`
在一棵同时含有 junction 和它的目标的树上，**按它自己的顺序删除，不保证先删 junction**。一旦它先
删掉目标，junction 当场悬空，接下来就再也删不掉了，整个父目录一起卡死。

这个顺序是**竞态**的，不是固定的——同样的 fixture 反复实测，有时成功有时卡住。这正好解释了为什么
`update-handoff.test.ts` 跑了几百次，只留下 2 个残留。

结论对应到设计上只有一句话：**删除任何东西之前，先把整棵树里的 link 全部摘掉。**

### 2.1 已卡死目录的清理办法

不需要 `chkdsk`，也不需要提权或重启。既然问题是目标不存在，**把目标重建出来**，junction 就恢复
可达，随即可以正常删除：

```powershell
# junction 位于 <root>\update-handoff，原本指向 <root>\outside
New-Item -ItemType Directory -Path "<root>\outside"
cmd /c "rmdir `"<root>\update-handoff`""
cmd /c "rd /s /q `"<root>`""
```

本机的 2 个残留目录已按此清理完毕。

## 3. 设计

### 3.1 新包 `packages/test-support/`

```
packages/test-support/
  package.json            # @cinba/test-support，exports: "./src/index.ts"
  tsconfig.json
  tsconfig.test.json
  src/
    index.ts
    temporary-directory.ts
    temporary-directory.test.ts
```

根 `package.json` 的 `"workspaces": ["packages/*"]` 是通配，不需要修改；新增包后跑一次
`npm install` 生成 `node_modules/@cinba/test-support` 链接。`packages/**` 与 `scripts/**` 都能直接
`import { temporaryDirectory } from "@cinba/test-support"`，与 `scripts` 引用 `@cinba/installer`
的既有做法一致。

放进独立包而不是塞进 `@cinba/contract`，是因为 `contract` 是服务端与客户端之间的协议定义，
测试工具不属于它的职责。

### 3.2 对外接口

```ts
/**
 * 建一个临时目录，并登记「测试结束后无论成败都删」。
 * 省略 context 时改用 node:test 的文件级 after()。
 */
export function temporaryDirectory(prefix: string, context?: CleanupRegistry): string;

/** Windows 安全的递归删除，供需要自行掌握时机的少数场景使用。 */
export async function removeTemporaryDirectory(path: string): Promise<void>;
```

`context` 可选有一个确切的依据：`packages/agent/src/credentials.test.ts:10` 必须在模块顶层建目录，
以便在 `import` 被求值之前设好 `PI_CODING_AGENT_DIR`，那里拿不到 `t`。全仓库只此一处，因此这个
可选参数不是预留的灵活性。

前缀继续由调用方传入并保持现有取值，这样万一再出现泄漏，从目录名就能定位到是哪个测试。

### 3.3 删除算法

分两趟，而不是边走边删：

```
removeTemporaryDirectory(path):
  1. removeLinksWithin(path)   // 先把整棵树里的 link 全部摘掉
  2. rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

removeLinksWithin(path):
  1. lstat(path)；ENOENT / ENOTDIR 直接返回
  2. 是 link → rm(path, { force: true })，返回（不跟进去）
  3. 不是目录 → 返回
  4. readdir(path, { withFileTypes: true })
     - 子项是 link → rm(子项, { force: true })
     - 子项是目录 → 递归 removeLinksWithin
```

第 1 趟是整个设计的核心。它必须是**独立的一趟**：如果只在单趟遍历中「遇到 link 就先删」，仍然
无法保证 link 排在它的目标之前——两者可能在树的不同分支里。先摘完所有 link，第 2 趟的
`rm(recursive)` 就不可能再让任何 junction 悬空。

其余细节：

- 路径长度接近 260 时加 `\\?\` 前缀，绕开 Windows 的 MAX_PATH 限制
- `maxRetries` / `retryDelay` 应对 Windows 上杀毒软件或索引服务短暂持有句柄
- `ENOENT` / `ENOTDIR` 一律当作成功，使重复删除、并发删除都安全

## 4. 改造范围

- 59 个 `*.test.ts` / `*.e2e.ts` 文件、254 个调用点全部改用 `temporaryDirectory(...)`
- 原有的 `try { ... } finally { rmSync(...) }` 整块移除，测试体反缩进
- 测试签名按需由 `async () =>` 改为 `async (t) =>`
- 因改造而不再使用的 `mkdtempSync` / `mkdtemp` / `rmSync` / `tmpdir` import 一并清除

**生产代码不动**，这些临时目录有各自的生命周期：

- `packages/installer/src/update-installation.ts`
- `scripts/product-uninstall.ts`
- `scripts/product-update.ts`
- `scripts/verify-bundle-installation.ts`
- `scripts/verify-product-payload.ts`

## 5. 验证

`temporary-directory.test.ts` 覆盖：

1. 清理被登记成 `after` 钩子，而不是在测试体最后一行执行——这正是原来写法 B 泄漏的原因
2. 含 link 的树（link 与目标同级、分处不同分支）能被完整删除
3. link 只被摘掉，不会被跟进去删掉它指向的东西
4. 重复删除不报错
5. 深层嵌套长路径能删掉
6. 收尾断言系统临时目录里没有 `cinba-test-support-*` 残留

需要说明的是，第 2 条无法成为一条严格的回归测试：`rm(recursive)` 的删除顺序是竞态的，同一个
fixture 在朴素实现下有时成功有时卡死。它验证的是结果正确，不是顺序。真正的顺序保证来自 3.3 的
两趟结构本身。

全量验证：

1. 记录 `npm run check` 前后系统临时目录中 `cinba-*` 的数量，必须不增长
2. 收尾扫描：测试文件中 `mkdtemp` 归零，无残留的 `rmSync(..., { recursive: true })`

254 个调用点的机械改造，最可能出的错是多行替换只替掉一半——删了 `try {` 却漏了对应的 `}`，
或反缩进漏行。`format:check` 与 `typecheck` 能拦住绝大部分，另需全量 grep 扫描确认。
