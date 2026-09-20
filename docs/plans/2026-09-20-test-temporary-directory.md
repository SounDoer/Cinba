# 测试临时目录统一清理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `@cinba/test-support`，提供一个无论测试成败都会清理、且在 Windows 上能正确处理
junction 的临时目录 helper，并把 59 个测试文件中的 254 个 `mkdtemp` 调用点全部切换过去。

**Architecture:** 新建 workspace 包 `packages/test-support/`，导出
`temporaryDirectory(prefix, context?)` 与 `removeTemporaryDirectory(path)`。删除算法在递归之前
识别并单独删除 symlink / junction，使 `rm(recursive)` 永不撞上 reparse point。

**Tech Stack:** Node 24、TypeScript（`--experimental-strip-types`）、`node:test`、npm workspaces。

**Spec:** `docs/specs/2026-09-20-test-temporary-directory-design.md`

---

## 背景：为什么需要第 1 步的 junction 测试

本机已稳定复现：对一个内含 Windows junction 的目录执行
`rm(root, { recursive: true, force: true })`，会失败于 `ENOTEMPTY`，并在 NTFS 目录索引中留下一个
**任何用户态工具都无法打开或删除**的条目（`lstat`、`rmdir`、`fsutil`、`cmd rd`、
`CreateFileW` + `FILE_FLAG_OPEN_REPARSE_POINT` 全部返回「找不到文件」）。父目录从此永远删不掉。

所以 Task 1 的 junction 测试不是锦上添花，它是整个改造唯一真正有风险的地方。

---

### Task 1: 新建 `@cinba/test-support` 包骨架

**Files:**
- Create: `packages/test-support/package.json`
- Create: `packages/test-support/tsconfig.json`
- Create: `packages/test-support/tsconfig.test.json`
- Create: `packages/test-support/src/index.ts`

- [ ] **Step 1: 写 `packages/test-support/package.json`**

照抄 `packages/contract/package.json` 的形状：

```json
{
  "name": "@cinba/test-support",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "exports": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.test.json"
  }
}
```

- [ ] **Step 2: 写两个 tsconfig**

`packages/test-support/tsconfig.json`（与 `packages/installer/tsconfig.json` 一致）：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023"],
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/test-support/tsconfig.test.json`：

```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*.ts"],
  "exclude": []
}
```

- [ ] **Step 3: 写占位 `packages/test-support/src/index.ts`**

```ts
export { removeTemporaryDirectory, temporaryDirectory } from "./temporary-directory.ts";
```

- [ ] **Step 4: 跑 `npm install` 生成 workspace 链接**

Run: `env -u NoDefaultCurrentDirectoryInExePath npm install`
Expected: 成功，`node_modules/@cinba/test-support` 出现（Windows 上是 junction 或 symlink）。

Verify: `node -e "console.log(require('node:fs').existsSync('node_modules/@cinba/test-support'))"`
Expected: `true`

- [ ] **Step 5: 暂不提交**

`src/index.ts` 引用的文件还不存在，等 Task 3 一起提交。

---

### Task 2: 写删除算法的失败测试

**Files:**
- Create: `packages/test-support/src/temporary-directory.test.ts`

- [ ] **Step 1: 写测试**

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeTemporaryDirectory, temporaryDirectory } from "./temporary-directory.ts";

test("a temporary directory is created under the system temporary directory", (t) => {
  const root = temporaryDirectory("cinba-test-support-basic-", t);
  assert.equal(existsSync(root), true);
  assert.equal(root.startsWith(tmpdir()), true);
});

test("the directory registered with a test context is gone once that test ends", async () => {
  let captured = "";
  await test("inner", (t) => {
    captured = temporaryDirectory("cinba-test-support-inner-", t);
    assert.equal(existsSync(captured), true);
  });
  assert.equal(existsSync(captured), false);
});

test("a failing test still has its directory removed", async () => {
  let captured = "";
  await assert.rejects(() =>
    test("inner that fails", (t) => {
      captured = temporaryDirectory("cinba-test-support-failing-", t);
      assert.fail("deliberate failure");
    }),
  );
  assert.equal(existsSync(captured), false);
});

// This is the case that left two undeletable directories in %TEMP%: a plain
// recursive remove walks into the junction, fails with ENOTEMPTY, and corrupts
// the parent's directory index beyond the reach of any user-mode tool.
test("a directory holding a symbolic link or junction is removed completely", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-test-support-link-"));
  const target = join(root, "target");
  await mkdir(target);
  await writeFile(join(target, "file.txt"), "content");
  await symlink(target, join(root, "link"), process.platform === "win32" ? "junction" : "dir");

  await removeTemporaryDirectory(root);

  assert.equal(existsSync(root), false);
});

test("a dangling link, whose target is already gone, is removed too", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-test-support-dangling-"));
  await symlink(
    join(root, "never-created"),
    join(root, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await removeTemporaryDirectory(root);

  assert.equal(existsSync(root), false);
});

test("removing an already-removed directory is not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-test-support-twice-"));
  await removeTemporaryDirectory(root);
  await removeTemporaryDirectory(root);
  assert.equal(existsSync(root), false);
});

test("a deeply nested tree is removed despite long paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-test-support-deep-"));
  let current = root;
  for (let depth = 0; depth < 20; depth += 1) {
    current = join(current, "a-directory-name-long-enough-to-matter");
    await mkdir(current);
  }
  await writeFile(join(current, "leaf.txt"), "content");

  await removeTemporaryDirectory(root);

  assert.equal(existsSync(root), false);
});

test("nothing is left behind in the system temporary directory", async () => {
  const leftovers = (await readdir(tmpdir())).filter((entry) =>
    entry.startsWith("cinba-test-support-"),
  );
  assert.deepEqual(leftovers, []);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `env -u NoDefaultCurrentDirectoryInExePath node --test --experimental-strip-types packages/test-support/src/temporary-directory.test.ts`
Expected: FAIL — `Cannot find module './temporary-directory.ts'`

---

### Task 3: 实现 helper

**Files:**
- Create: `packages/test-support/src/temporary-directory.ts`

- [ ] **Step 1: 写实现**

```ts
import { mkdtempSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/** The part of a `node:test` TestContext this module needs. */
type CleanupRegistry = {
  after(fn: () => void | Promise<void>): void;
};

/**
 * Create a temporary directory and register its removal, so it goes away
 * whether the test passes or fails.
 *
 * Pass the test's context whenever there is one. Omitting it registers a
 * file-level `after` hook instead, which is what module-scope directories need.
 */
export function temporaryDirectory(prefix: string, context?: CleanupRegistry): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const registry = context ?? { after };
  registry.after(() => removeTemporaryDirectory(directory));
  return directory;
}

/**
 * Remove a directory tree, tolerating paths that are already gone.
 *
 * Symbolic links and Windows junctions are removed as links before anything
 * recurses past them. A plain recursive remove that meets a junction fails with
 * ENOTEMPTY on Windows and leaves behind a directory entry that no user-mode
 * tool can open or delete afterwards.
 */
export async function removeTemporaryDirectory(path: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(longPath(path));
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }

  if (entry.isSymbolicLink()) {
    await removeLink(path);
    return;
  }

  if (entry.isDirectory()) {
    let children;
    try {
      children = await readdir(longPath(path), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
    for (const child of children) {
      const childPath = join(path, child.name);
      if (child.isSymbolicLink()) {
        await removeLink(childPath);
      } else if (child.isDirectory()) {
        await removeTemporaryDirectory(childPath);
      }
    }
  }

  await rm(longPath(path), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}

/**
 * Remove one link without following it. `rm` without `recursive` unlinks a
 * symbolic link or junction rather than touching whatever it points at.
 */
async function removeLink(path: string): Promise<void> {
  try {
    await rm(longPath(path), { force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

/** Windows refuses paths past 260 characters unless they carry this prefix. */
function longPath(path: string): string {
  if (process.platform !== "win32" || path.startsWith("\\\\?\\") || path.length < 240) {
    return path;
  }
  return `\\\\?\\${path}`;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
```

- [ ] **Step 2: 运行测试，确认通过**

Run: `env -u NoDefaultCurrentDirectoryInExePath node --test --experimental-strip-types packages/test-support/src/temporary-directory.test.ts`
Expected: PASS，全部用例通过。

- [ ] **Step 3: 确认 junction 用例真的在防守**

临时把 `removeTemporaryDirectory` 改成只有一行 `await rm(path, { recursive: true, force: true })`，
重跑测试，确认 junction 那条失败；然后改回来。

注意：这一步会在 `%TEMP%` 留下一个删不掉的目录（这正是它要证明的事）。确认完立刻改回。

- [ ] **Step 4: typecheck**

Run: `env -u NoDefaultCurrentDirectoryInExePath npm run typecheck --workspace @cinba/test-support`
Expected: 无输出，退出码 0。

- [ ] **Step 5: 提交**

```bash
git add packages/test-support package-lock.json
git commit -m "feat(test-support): add a temporary directory helper that always cleans up"
```

---

### Task 4: 迁移 `packages/installer`（22 个文件）

**Files:**
- Modify: `packages/installer/src/*.test.ts`、`packages/installer/src/services/*.test.ts`

- [ ] **Step 1: 逐文件改写**

对每个 `mkdtemp` 调用点：

```ts
// 前
test("...", async () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-installer-x-"));
  try {
    /* 测试体 */
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 后
test("...", async (t) => {
  const root = temporaryDirectory("cinba-installer-x-", t);
  /* 测试体，反缩进一层 */
});
```

`await mkdtemp(...)` 写法同理，`temporaryDirectory` 是同步的，去掉 `await`。

顶部加 `import { temporaryDirectory } from "@cinba/test-support";`，并删除因此不再使用的
`mkdtemp` / `mkdtempSync` / `rmSync` / `rm` / `tmpdir` import——注意这些名字可能还有别的用途，
删之前确认文件内再无引用。

`packages/installer/src/update-handoff.test.ts:134` 那条 junction 测试一并改造：helper 现在自己
会正确删 junction，原本的 `await rm(linkPath, { force: true })` 可以去掉。

- [ ] **Step 2: 扫描确认改干净**

Run: `grep -rn "mkdtemp" packages/installer --include=*.test.ts`
Expected: 无输出。

Run: `grep -rn "rmSync\|rm(" packages/installer --include=*.test.ts | grep -i "recursive"`
Expected: 无输出（或只剩确实在测试被测代码删除行为的调用）。

- [ ] **Step 3: 跑该包的测试**

Run: `env -u NoDefaultCurrentDirectoryInExePath node --test --experimental-strip-types "packages/installer/src/**/*.test.ts"`
Expected: 全部通过。

- [ ] **Step 4: typecheck + 格式化**

Run: `env -u NoDefaultCurrentDirectoryInExePath npm run typecheck --workspace @cinba/installer`
Run: `env -u NoDefaultCurrentDirectoryInExePath npx prettier --write "packages/installer/src/**/*.ts"`
Expected: 均成功。

- [ ] **Step 5: 提交**

```bash
git add packages/installer
git commit -m "test(installer): clean up temporary directories through the shared helper"
```

---

### Task 5: 迁移 `packages/server`（12 个文件）

**Files:**
- Modify: `packages/server/src/*.test.ts`、`packages/server/src/sync/*.test.ts`、
  `packages/server/src/*.e2e.ts`

- [ ] **Step 1: 按 Task 4 Step 1 的同一套改写规则逐文件处理**

注意 `*.e2e.ts` 文件同样要改（`web-tools.e2e.ts`、`credentials.e2e.ts`）。

- [ ] **Step 2: 扫描**

Run: `grep -rn "mkdtemp" packages/server --include=*.test.ts --include=*.e2e.ts`
Expected: 无输出。

- [ ] **Step 3: 跑测试**

Run: `env -u NoDefaultCurrentDirectoryInExePath node --test --experimental-strip-types "packages/server/src/**/*.test.ts"`
Expected: 全部通过。

- [ ] **Step 4: typecheck + 格式化**

Run: `env -u NoDefaultCurrentDirectoryInExePath npm run typecheck --workspace @cinba/server`
Run: `env -u NoDefaultCurrentDirectoryInExePath npx prettier --write "packages/server/src/**/*.ts"`

- [ ] **Step 5: 提交**

```bash
git add packages/server
git commit -m "test(server): clean up temporary directories through the shared helper"
```

---

### Task 6: 迁移 `packages/sync-server`（9 个文件）

**Files:**
- Modify: `packages/sync-server/src/*.test.ts`、`packages/sync-server/src/routes/*.test.ts`、
  `packages/sync-server/src/services/*.test.ts`、`packages/sync-server/src/store/*.test.ts`、
  `packages/sync-server/src/multi-core.e2e.ts`

这里是泄漏量最大的一块：`cinba-sync-web-*`、`cinba-sync-server-*`、`cinba-sync-proxy-*`、
`cinba-sync-lifecycle-*`、`cinba-sync-restore-*`、`cinba-sync-force-*`、`cinba-sync-status-*`
各约 200 个。

- [ ] **Step 1: 按同一套规则逐文件处理**

- [ ] **Step 2: 扫描**

Run: `grep -rn "mkdtemp" packages/sync-server --include=*.test.ts --include=*.e2e.ts`
Expected: 无输出。

- [ ] **Step 3: 跑测试**

Run: `env -u NoDefaultCurrentDirectoryInExePath node --test --experimental-strip-types "packages/sync-server/src/**/*.test.ts"`
Expected: 全部通过。

- [ ] **Step 4: typecheck + 格式化**

Run: `env -u NoDefaultCurrentDirectoryInExePath npm run typecheck --workspace @cinba/sync-server`
Run: `env -u NoDefaultCurrentDirectoryInExePath npx prettier --write "packages/sync-server/src/**/*.ts"`

- [ ] **Step 5: 提交**

```bash
git add packages/sync-server
git commit -m "test(sync-server): clean up temporary directories through the shared helper"
```

---

### Task 7: 迁移其余包（agent、core-manager、desktop、extensions、product-runtime）

**Files:**
- Modify: `packages/agent/src/credentials.test.ts`、`packages/agent/src/project-trust.test.ts`、
  `packages/agent/src/session-edit.e2e.ts`
- Modify: `packages/core-manager/src/core-manager.test.ts`、`packages/core-manager/src/start-lock.test.ts`
- Modify: `packages/desktop/src/profile-store.test.ts`
- Modify: `packages/extensions/src/web-tools/credentials.test.ts`、
  `packages/extensions/src/web-tools/configuration.test.ts`
- Modify: `packages/product-runtime/src/sync-control.test.ts`、
  `packages/product-runtime/src/managed-services.test.ts`

- [ ] **Step 1: 处理模块顶层那一处特例**

`packages/agent/src/credentials.test.ts:10` 必须在 `import` 被求值之前设好环境变量，拿不到 `t`：

```ts
// 前
const agentDir = mkdtempSync(join(tmpdir(), "cinba-credentials-test-")).replace(/\\/g, "/");
process.env.PI_CODING_AGENT_DIR = agentDir;

// 后
const agentDir = temporaryDirectory("cinba-credentials-test-").replace(/\\/g, "/");
process.env.PI_CODING_AGENT_DIR = agentDir;
```

省略第二个参数时 helper 用文件级 `after()` 登记清理。

同时删掉该文件第一条测试里原有的 `t.after(() => rmSync(agentDir, ...))`——现在 helper 负责了，
而且原来那个写法有个隐患：第一条测试结束就把目录删了，后面几条测试仍在用它。

- [ ] **Step 2: 其余文件按同一套规则处理**

- [ ] **Step 3: 扫描**

Run: `grep -rn "mkdtemp" packages --include=*.test.ts --include=*.e2e.ts`
Expected: 无输出。

- [ ] **Step 4: typecheck + 格式化**

Run: `env -u NoDefaultCurrentDirectoryInExePath npm run typecheck`
Run: `env -u NoDefaultCurrentDirectoryInExePath npx prettier --write "packages/**/*.ts"`

- [ ] **Step 5: 提交**

```bash
git add packages
git commit -m "test(repo): clean up temporary directories through the shared helper"
```

---

### Task 8: 迁移 `scripts/`（6 个文件）

**Files:**
- Modify: `scripts/product-update-handoff.test.ts`、`scripts/product-uninstall-helper.test.ts`、
  `scripts/windows-launcher.test.ts`、`scripts/windows-helper-cleanup.test.ts`、
  `scripts/macos-launcher.test.ts`、`scripts/assemble-release.test.ts`

`scripts/**` 已经在引用 `@cinba/installer`，所以同样可以直接
`import { temporaryDirectory } from "@cinba/test-support";`。

- [ ] **Step 1: 按同一套规则逐文件处理**

- [ ] **Step 2: 确认生产脚本没被误改**

Run: `grep -rn "mkdtemp" scripts --include=*.ts | grep -v test`
Expected: 只剩这四处
`scripts/product-uninstall.ts`、`scripts/product-update.ts`、
`scripts/verify-bundle-installation.ts`、`scripts/verify-product-payload.ts`

Run: `grep -rn "mkdtemp" packages/installer/src/update-installation.ts`
Expected: 仍有 2 处，未被改动。

- [ ] **Step 3: 跑测试 + typecheck + 格式化**

Run: `env -u NoDefaultCurrentDirectoryInExePath node --test --experimental-strip-types "scripts/**/*.test.ts"`
Run: `env -u NoDefaultCurrentDirectoryInExePath npx tsc -p tsconfig.scripts.json`
Run: `env -u NoDefaultCurrentDirectoryInExePath npx prettier --write "scripts/**/*.ts"`

- [ ] **Step 4: 提交**

```bash
git add scripts
git commit -m "test(repo): clean up script temporary directories through the shared helper"
```

---

### Task 9: 全量验证

- [ ] **Step 1: 记录改造前后的目录数**

改造后先数一次基线：

```bash
ls "$TEMP" | grep -c '^cinba-'
```

- [ ] **Step 2: 跑完整的 merge gate**

Run: `env -u NoDefaultCurrentDirectoryInExePath npm run check`
Expected: format:check、lint、typecheck、test、test:e2e、build 全部通过。

- [ ] **Step 3: 再数一次**

```bash
ls "$TEMP" | grep -c '^cinba-'
```

Expected: 与 Step 1 的数字**相同**。任何增长都说明还有遗漏的调用点。

- [ ] **Step 4: 收尾扫描**

Run: `grep -rn "mkdtemp" packages scripts --include=*.test.ts --include=*.e2e.ts`
Expected: 无输出。

Run: `grep -rn "tmpdir()" packages scripts --include=*.test.ts --include=*.e2e.ts`
Expected: 只剩 `packages/test-support/src/temporary-directory.test.ts` 自身的用例。

- [ ] **Step 5: 若数字有增长，定位漏网之鱼**

跑之前记下时间戳，跑完后按 mtime 找出新目录，目录名前缀直接指向源文件：

```bash
find "$TEMP" -maxdepth 1 -name 'cinba-*' -newermt '-10 minutes'
```

---

### Task 10: 记录 Windows junction 这个坑

**Files:**
- Modify: `AGENTS.md`（Known pitfalls 一节）

`AGENTS.md` 的 Known pitfalls 目前写着「Nothing recorded yet」，准入标准是：代码看不出来、
自动化抓不住、踩错代价高。这一条三条全中。

- [ ] **Step 1: 替换 Known pitfalls 一节**

```markdown
## Known pitfalls

**A recursive remove that meets a Windows junction corrupts the directory.** On Windows,
`fs.rm(path, { recursive: true, force: true })` over a directory containing a junction fails with
`ENOTEMPTY` and leaves a directory entry that no user-mode tool can open or delete — `lstat`,
`rmdir`, `fsutil reparsepoint`, `rd`, and `CreateFileW` with `FILE_FLAG_OPEN_REPARSE_POINT` all
report the file as missing. The parent then cannot be removed at all; only an elevated
`chkdsk C: /f` clears it. Tests take their temporary directories from
`temporaryDirectory()` in `@cinba/test-support`, which removes links before recursing.
```

- [ ] **Step 2: 提交**

```bash
git add AGENTS.md
git commit -m "docs(repo): record the Windows junction removal pitfall"
```

---

## 自查

**Spec 覆盖：** 新包（Task 1）、接口（Task 3）、删除算法（Task 3）、模块顶层特例（Task 7
Step 1）、59 个文件的迁移（Task 4–8）、生产代码不动（Task 8 Step 2 显式验证）、junction 回归测试
（Task 2）、前后计数验证（Task 9）、遗留的 chkdsk 事项（在 spec 第 6 节，不属于代码改动）。

**类型一致性：** `temporaryDirectory(prefix: string, context?: CleanupRegistry): string` 与
`removeTemporaryDirectory(path: string): Promise<void>` 在 Task 2 的测试、Task 3 的实现、
Task 4–8 的调用中签名一致。

**已知风险：** 254 个点的机械改造最容易出的错是多行替换只替一半（删了 `try {` 漏了 `}`、
反缩进漏行）。每个 Task 的 Step 2 扫描 + Step 4 的 typecheck/prettier 就是为了挡住它。
