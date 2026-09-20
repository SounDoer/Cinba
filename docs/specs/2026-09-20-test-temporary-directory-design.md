# 测试临时目录统一清理设计

日期：2026-09-20

状态：设计已确认，待实施

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

## 2. Windows 上的第二个问题：junction 造成不可删除的目录

`%TEMP%` 中有两个目录在任何情况下都删不掉：`cinba-update-handoff-link-50Bjae` 和
`cinba-update-handoff-link-qjXZix`，时间戳均为 2026-09-18 20:06。它们来自
`packages/installer/src/update-handoff.test.ts` 中「handoff storage refuses a symbolic-link
directory」这条测试——它在临时目录里建一个 Windows junction。

根因已经稳定复现：**递归删除一个内含 junction 的目录，在本机必然失败并留下损坏的目录项。**

```
rm(root, { recursive: true, force: true })   // root 内有 junction
  → ENOTEMPTY: directory not empty, rmdir '...'
```

失败后留下的那个 junction 条目处于 NTFS 目录索引与文件记录不一致的状态：

| 操作 | 结果 |
| --- | --- |
| `readdir(root, { withFileTypes: true })` | 列出该项，`Directory, ReparsePoint`，target 为空 |
| `lstat(link)` / `rmdir(link)` | `ENOENT` |
| `fsutil reparsepoint query/delete` | 找不到文件 |
| `cmd rd` / `Remove-Item` / `robocopy /MIR` | 找不到文件 |
| `mklink /J` 覆盖同名 | 文件已存在 |
| `CreateFileW` + `FILE_FLAG_OPEN_REPARSE_POINT` | `ERROR_FILE_NOT_FOUND` |

即目录索引里记着这一项，但它指向的文件记录已不存在。用户态没有任何办法修复，只能由管理员权限
下的 `chkdsk C: /f` 处理（C 盘是系统盘，会安排到下次重启执行）。

反过来，**先单独删掉 junction、再删父目录**这条路径是干净的，已验证：

```ts
await rm(linkPath, { force: true });          // 非递归，单独处理 junction
await rm(root, { recursive: true, force: true });   // 此时 root 内已无 reparse point
```

`update-handoff.test.ts` 在 commit `b97fdf3`（test(installer): remove handoff junction
explicitly）已经改成了这个写法，所以它现在不再产生新的损坏目录；但共享 helper 必须把这条规则
固化下来，否则任何新测试都可能再踩一次。

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
export function temporaryDirectory(prefix: string, context?: TestContext): string;

/** Windows 安全的递归删除，供需要自行掌握时机的少数场景使用。 */
export async function removeTemporaryDirectory(path: string): Promise<void>;
```

`context` 可选有一个确切的依据：`packages/agent/src/credentials.test.ts:10` 必须在模块顶层建目录，
以便在 `import` 被求值之前设好 `PI_CODING_AGENT_DIR`，那里拿不到 `t`。全仓库只此一处，因此这个
可选参数不是预留的灵活性。

前缀继续由调用方传入并保持现有取值，这样万一再出现泄漏，从目录名就能定位到是哪个测试。

### 3.3 删除算法

```
remove(path):
  1. lstat(path)；ENOENT 直接返回
  2. 是 symlink 或 junction → rm(path, { force: true })，不递归，返回
  3. 是目录 → readdir(path, { withFileTypes: true })，对每个子项递归 remove
  4. rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  5. 路径长度接近 260 时使用 \\?\ 前缀
  6. 全程吞掉 ENOENT
```

第 2 步是整个设计的核心：靠 `dirent.isSymbolicLink()` 在递归**之前**识别出 reparse point 并单独
删除，使 `rm(recursive)` 永远不会撞上 junction。第 4 步的 `maxRetries` 用于应对 Windows 上杀毒
软件或索引服务短暂持有句柄。

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

1. `temporary-directory.test.ts` 必须包含一条 junction 用例：在临时目录内建 junction，调用
   `removeTemporaryDirectory`，断言父目录确实消失。这条测试在算法修复前会失败。
2. 记录 `npm run check` 前后系统临时目录中 `cinba-*` 的数量，必须不增长。
3. 收尾扫描：测试文件中 `mkdtemp` 归零，无残留的 `rmSync(..., { recursive: true })`。

254 个调用点的机械改造，最可能出的错是多行替换只替掉一半——删了 `try {` 却漏了对应的 `}`，
或反缩进漏行。`format:check` 与 `typecheck` 能拦住绝大部分，另需全量 grep 扫描确认。

## 6. 遗留事项

`%TEMP%` 中 4 个损坏目录（09-18 留下的 2 个，加上本次复现根因时产生的
`repro-b-fMn735`、`repro-c-ZiX7k8`）需要管理员权限下执行 `chkdsk C: /f` 清理，会安排到下次重启。
这不属于代码改动范围，由使用者自行决定何时执行。
