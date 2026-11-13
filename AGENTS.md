# AGENTS.md — 给接手这个仓库的 AI

这份文件是操作手册，不是介绍。照着它能改代码、跑测试、不踩已知的坑。
面向的是**下一个来改这个仓库的 AI 或人**，不是最终用户（用户文档在 `README.md`）。

- 项目：空核备忘／空核编辑器（KonhEditor），0.4.3
- 栈：React 19 + TypeScript + Vite + Tauri 2 + Rust + SQLite + CodeMirror
- 仓库：https://github.com/hackmgrm/Konh-Editor-APP 分支 `main`

---

## 1. 先记住四条硬边界

改任何东西之前，这四条优先于你的重构冲动。

1. **不许整体覆盖这些文件。** 同步上游（火星编辑器 / 橦云手帐）时只能逐项 diff 移植：
   `src/App.tsx`、`src/markdown.ts`、`src/theme.ts`、`src/publish.ts`、`src/wechat.ts`、`src-tauri/src/agent_api.rs`。
2. **品牌不可替换。** 唯一图标是 `design/logo-candidates/霓虹萌趣圆润机器人图标.png`（深色圆角底 + 橙色机器人 + 紫色面罩 + 白身体 + 橙色双翼）。Dock / Windows / Linux / 侧栏 / 标题栏 / 托盘 / macOS 菜单栏模板图标各自产出，托盘可用单色面罩版，但**不能**用橙色小鸟、火星图标、橦云图标或局部裁切图。
3. **空核域界主题不可丢。** `olive-journal`、front matter 标题、头图、导语、标签、签名卡、`data-no-cover`、文章署名、公众号发布逻辑，都在 `src/theme.ts`、`src/markdown.ts`、`src/gzhTheme.ts` 及其测试里。
4. **同步上游前先核对 HEAD**，不要相信文档里记的版本号：
   ```
   git ls-remote --symref https://github.com/dangzhuotong/tongyun-planner.git HEAD
   git ls-remote --symref https://github.com/whyubel1eve/Mars-Editor-APP.git HEAD
   ```

---

## 2. 常用命令

```bash
npm ci
npm run dev            # 浏览器里跑前端（Tauri 命令不可用，备份面板会显示"只在桌面版可用"）
npm run app            # tauri dev，桌面全功能
npm run build          # tsc -b && vite build —— 类型检查在这里，改完必跑
npm run app:build      # 未签名打包
```

测试（前端）：

```bash
npm run test:publishing     # 32
npm run test:productivity   # 18
npm run test:theme          # 4
npm run test:upstream       # 9
npm run test:gzh            # 11
npx vitest run --exclude '**/._*'                      # 全量，748 通过 / 100 文件
npx vitest run src/tongyun/utils/sync --exclude '**/._*'                # 同步 193
npx vitest run src/tongyun/utils/journalImages.test.ts \
  src/tongyun/data/domainDatabase.test.ts \
  src/tongyun/data/repositories.test.ts src/backupDisabled.test.js
```

Rust（**必须用干净临时 target**，`src-tauri/target` 历史上损坏过会报 `can't find crate for regex_automata`）：

```bash
cd src-tauri
CARGO_TARGET_DIR=/tmp/konh-clean-target /usr/bin/arch -arm64 cargo test --locked
# lib 109 + 集成 tests/planner_backup_restore 11
```

Windows（不装 Windows 也要跑，能抓 95% 的平台问题）：

```bash
cd src-tauri
CARGO_TARGET_DIR=/tmp/konh-win-check cargo check --locked --tests --target x86_64-pc-windows-gnu
# 需要：brew install mingw-w64 && rustup target add x86_64-pc-windows-gnu
```

真 Windows 验证走 GitHub Actions：`.github/workflows/windows.yml`（前端构建 → 五套测试 → vitest → cargo test → NSIS 打包 → 校验产物 >5MB → 上传 artifact）。

---

## 3. 目录地图（只列会改到的）

```
src/
├── KonhShell.tsx                 # 统一外壳：手帐为主界面，写作是一级入口
├── unifiedBackup.ts              # ★ 统一备份的前端 API（导出/校验/三种恢复）
├── App.tsx                       # 写作编辑器（火星编辑器血统，别整体覆盖）
├── theme.ts markdown.ts gzhTheme.ts publish.ts wechat.ts   # 空核定制，别整体覆盖
├── components/
│   ├── WorkspaceBackup.tsx       # 旧的工作区备份 UI，SettingsDialog 未引用它
│   └── SettingsDialog.tsx        # 写作侧设置入口
└── tongyun/
    ├── components/SettingsView.tsx           # ★ 统一设置中心，:262 渲染 UnifiedBackupPanel
    ├── components/sync/UnifiedBackupPanel.tsx # ★ 备份/校验/恢复面板（三 tab）
    ├── components/ai/AISettingsPanel.tsx
    ├── data/domainDatabase.ts     # SQLite schema + queueDomainWrite + guardDatabaseWrites
    ├── data/repositories.ts       # 把完整对象 JSON 塞进各表的 data 列
    ├── utils/maintenanceLock.ts   # ★ 前端维护标记（跨窗口广播）+ withMaintenanceWriteLock
    ├── utils/journalImages.ts     # ★ 日记图片 IndexedDB 读写/导出/原地恢复
    ├── utils/deferredStorage.ts   # localStorage→SQLite 延迟落盘（drainPendingStorage）
    ├── utils/unifiedStorage.ts
    └── utils/sync/engine.ts       # WebDAV 同步，syncEngine.pauseAndDrain()

src-tauri/src/
├── lib.rs              # 命令注册处；:18-19 mod workspace_backup/unified_backup，:46 manage(WriteGate)，:50 manage(UnifiedBackup)
├── unified_backup.rs   # ★ 统一备份的全部 Rust 实现 + 14 个单元测试
├── write_gate.rs       # 原生维护锁（barrier + 租约）
├── backup.rs           # 旧的 daily/conflicts JSON 快照，仍在用，别删
├── workspace_backup.rs # 只被 planner_backup 与集成测试引用，命令已不注册
└── planner_backup.rs   # 旧手帐导出（列白名单没有 data 列），未在 lib.rs 注册
```

数据落在哪：

| 东西 | 位置 |
|---|---|
| 手帐 SQLite | `app_data_dir/tongyun_planner.db` |
| 手帐附件 | `app_data_dir/attachments` |
| 文章素材 | `app_data_dir/article-assets` |
| 自定义主题 | `app_config_dir/themes` |
| 日记图片 | IndexedDB `tongyun_journal_images` / store `images`（**不在** SQLite 里） |
| 回滚点 | `app_data_dir/rollback/<label>-YYYYmmdd-HHMMSS/` |

---

## 4. 统一备份：分层设计

不是"把两个数据库压成一个 zip"。写作数据和手帐数据在归档里各占一块，恢复也各走各的路径。

```
konh-backup/
├── manifest.json              # 版本化清单：每个文件 path/size/sha256
├── README.txt                 # 给用户看的恢复说明（写进归档的）
├── workspace/                 # 用户选的写作工作区，原样复制
├── planner/
│   ├── planner.json           # 7 张手帐表的全列快照（含 data 列）
│   ├── journal-images.json    # 日记图片，base64 内联
│   └── attachments/           # 手帐附件
└── writing/
    ├── article-assets/        # 文章图片等素材
    ├── themes/                # 自定义主题
    └── metadata.json
```

`manifest.json` 形状（`src-tauri/src/unified_backup.rs:74-105`，serde camelCase，`deny_unknown_fields`）：

```json
{
  "format": "konh-unified-backup",
  "formatVersion": 1,
  "createdAt": 1763000000,
  "appVersion": "0.4.3",
  "sections": { "workspace": true, "planner": true, "journalImages": true,
                "writingArtifacts": true, "secrets": false },
  "fileCount": 42,
  "totalSize": 123456,
  "files": [{ "path": "workspace/文章.md", "kind": "file", "size": 123, "sha256": "…64 hex…" }]
}
```

**永不进归档**：WeChat AppSecret、微信 Token、AI API Key、Cloudinary Secret、Jina Key、WebDAV 密码、SMTP 密码、Google OAuth Token、OS Keychain、远程 DSN 密码、`user_prefs`、`sync_outbox`、`sync_state`、`agents`、`task_dispatch`、设备锁与运行时状态。
`sections.secrets` 只允许 `false`；读到 `true` 直接拒绝整个备份。归档**不加密**，所以这条线不能松。

限额（`unified_backup.rs:45-52`）：20 万条目、单文件 1 GiB、总量 8 GiB、深度 64、manifest 256 MiB、单 section 512 MiB、分块 3 MiB。

路径校验 `validate_rel_path`：拒绝空段、绝对路径、前导反斜杠、任何 `\`、每段都要过 `workspace_backup::component`（Windows 保留名 `CON`/`NUL`/`COM1`…、尾随空格或点、控制字符、`/:"<>|?*`）、深度 >64。manifest 里重复路径、仅大小写不同的路径，一律拒绝。

---

## 5. Rust 命令契约（9 个，全在 `unified_backup.rs`）

全部 `#[tauri::command]`，参数 snake_case（前端传 camelCase），返回 `Result<T, String>`，错误是字符串（多数以 `E_` 开头）。

```rust
unified_backup_begin(window: WebviewWindow, state, gate, destination: String) -> Result<String, String>
// 拿原生 barrier + 建 staging，返回 token。目标已存在 → "E_BACKUP_EXISTS"。

unified_backup_put_journal_images(state, token: String, chunk_index: u64, base64: String) -> Result<u64, String>
// 顺序必须从 0 递增，否则 "E_BACKUP_CHUNK_ORDER"；返回累计字节。上限 MAX_SECTION_BYTES。

unified_backup_abort(state, gate, token: String) -> Result<(), String>
// 删 staging、放 barrier。任何失败路径都必须调。

unified_backup_finish(app, state, gate, token: String, workspace: Option<String>) -> Result<ExportResult, String>
// 组装 planner/attachments/writing + 写 manifest + 原子发布。返回 { path, manifest }。

unified_backup_inspect(backup: String) -> Result<InspectResult, String>
// 只读。返回 { path, format…, sections, fileCount, totalSize, problems: Vec<String>, ok: bool }。

unified_backup_read_file(backup: String, path: String, offset: u64, limit: u64) -> Result<ReadChunk, String>
// → { base64, size, eof, nextOffset }，按 offset 循环拼。

unified_backup_restore_workspace(backup, destination: String, policy: String) -> Result<RestoreResult, String>
// policy = "new-only" | "keep-current"。默认恢复到新目录，绝不覆盖原工作区。

unified_backup_restore_planner(app, backup: String) -> Result<RestoreResult, String>
// 原地恢复。**自己不取 gate**（调用方必须先持 barrier），内部：校验 → 回滚点 → 附件 DirSwap → 单事务整表替换。

unified_backup_restore_writing(app, gate, backup: String) -> Result<RestoreResult, String>
// 换 article-assets 与 themes 两个目录，首行 gate.write()。
```

`RestoreResult` = `{ target, files, rows, rollbackDir, conflicts }`。`rows` 是手帐写入行数，纯文件恢复时为 0。

错误码：`E_BACKUP_EXISTS` `E_BACKUP_STATE` `E_BACKUP_TOKEN` `E_BACKUP_CHUNK` `E_BACKUP_CHUNK_ORDER` `E_BACKUP_SIZE` `E_BACKUP_PATH` `E_BACKUP_POLICY`，锁相关 `E_GATE_BUSY` `E_GATE_LEASE` `E_GATE_POISONED` `E_GATE_EXHAUSTED` `E_WRITE_PAUSED`。前端 `UnifiedBackupPanel.describeError` 负责翻成人话——加新错误码时**同时**改那里。

---

## 6. 前端 API（`src/unifiedBackup.ts`）

```ts
isUnifiedBackupAvailable(): boolean          // 是否在 Tauri 里（浏览器 false）
runUnifiedExport({ destination, workspace? }): Promise<ExportSummary>
  // = ExportResult + { journalImages: number, workspace: string | null }
inspectUnifiedBackup(backup: string): Promise<InspectResult>
readBackupFile(backup: string, path: string): Promise<Uint8Array>
restorePlannerFromBackup({ backup, onCommitted? }): Promise<{ images, rows, rollbackDir }>
restoreWorkspaceFromBackup({ backup, destination, policy? }): Promise<RestoreResult>
restoreWritingAssetsFromBackup(backup: string): Promise<RestoreResult>
defaultRestoreDirectory(parent: string, now?: Date): string   // Konh恢复-YYYYMMDD-HHmm
formatBackupSize(bytes: number): string
```

日记图片（`src/tongyun/utils/journalImages.ts`）：

```ts
exportJournalImages(): Promise<JournalImageBackup>            // { version:1, images:[{id,type,size,base64,file?}] }
decodeJournalImageBackup(backup): Array<{ id: string; blob: Blob }>   // 纯校验+解码，不写库
restoreJournalImagesInPlace(backup): Promise<number>           // 原地：单事务 clear + put，再逐条核对数量与字节
restoreJournalImagesIsolated(backup, databaseName): Promise<number>   // 只允许新库名
```

---

## 7. 双锁协议：改这块之前先读完

手帐的 SQL 写入**从 webview 直接发到 SQLite**，绕过 Rust 锁。所以只有两层一起才拦得住：

- **A. 前端维护标记** `src/tongyun/utils/maintenanceLock.ts` —— `konh:maintenance` 事件广播到所有窗口，`guardDatabaseWrites` 把每个 `Database.execute` 包成 `withMaintenanceWriteLock`，标记在 → 抛 `MaintenanceWritePaused`（`isMaintenanceError` 认这个 name）。只读 `select` 不受影响。标记带 TTL（默认 30 分钟）且窗口销毁自动释放，崩了不会永久锁死。
- **B. 原生锁** `src-tauri/src/write_gate.rs` —— `gate.write()` 在 barrier 期间返回 `E_WRITE_PAUSED`；`gate.acquire(owner)` 返回 token，`release(owner, token)` 校验归属。

**不可交换的顺序**（每一条都是修过的真 bug，别改回去）：

```
导出： drainPendingStorage() → beginMaintenance() → unified_backup_begin（内含 acquire）→ 分块传图 → finish → finally: 释放标记 + 重试 localStorage 镜像
恢复： pauseAndDrain() → drainPendingStorage() → beginMaintenance() → write_gate_acquire → waitForMaintenanceWrites() → 恢复 → finally: release(token) → releaseMaintenance() → 未提交才 resumeSync()
```

为什么必须是这个顺序：

1. `drainPendingStorage()` **在标记之前**。它走 SQLite，标记一升必然被自己拒绝，恢复会硬失败。
2. `beginMaintenance` **在 acquire 之前**。标记可能被另一个窗口占着（它在恢复），抢跑拿到的 barrier 会没人释放 → 全应用只读。
3. **所有** `invoke` 都放进 `try`，`token` 用 `let token: string | null = null`。最容易发生的是 `E_BACKUP_EXISTS`（目标文件夹已存在），在 `try` 外的 `begin` 抛出去，标记就挂满 TTL。
4. 恢复成功后**不要** `resumeSync()`。窗口 600 ms 后 `location.reload()`，重载时 pauseCount 归零自然解除；提早就绪会让紧接着的一次拉取覆盖刚恢复的表。
5. `initMaintenanceBridge()` 在模块加载时就订阅（幂等）。只在 `beginMaintenance` 里订阅的话，那个"从没发起过备份、正在写"的窗口永远收不到广播 —— 而它正是要拦的窗口。

细节：维护期被挡下的写**不要**推进 `domainWriteErrors`（`if (!isMaintenanceError(error)) domainWriteErrors.push(error)`），否则下一次 `drainDomainWrites()` 会抛不相干的 AggregateError。

---

## 8. 手帐 schema 事实（改备份就会碰到）

`src/tongyun/data/domainDatabase.ts`，DB 名 `sqlite:tongyun_planner.db`。备份的 7 张表（`PLANNER_TABLES`）：
`tasks`、`journal_entries`、`pomodoro_logs`、`habits`、`sticky_notes`、`countdowns`、`timeblocks`。

**没有 FOREIGN KEY，也没有 TRIGGER。** `tasks` / `journal_entries` / `sticky_notes` / `countdowns` / `timeblocks` 都有 `data TEXT` 列，`repositories.ts` 把完整对象 `JSON.stringify` 进去（如 `:113`、`:357`、`:547`、`:599`）。所以导出必须**全列**，漏了 `data` 就等于丢字段——旧的 `planner_backup.rs` 正是因为列白名单没有 `data` 而不可用于正式恢复。

导出走 `read_planner_bytes()`：只读打开、`BEGIN…COMMIT` 快照（所以 WAL 里未 checkpoint 的行也在，有专门测试 `export_reads_rows_that_only_live_in_the_wal`），blob 列直接报错而不是静默丢。
导入走 `apply_planner()`：`PRAGMA table_info` 取列名、`DELETE FROM` 整表、逐行 INSERT，全在一个 `Immediate` 事务里。

---

## 9. 我要改 X，该动哪里

**加一张表进备份**：`PLANNER_TABLES` 加表名 → `unified_backup.rs` 的测试 seed 里建表插行 → 跑 `export_archives_both_sides_and_restores_the_workspace`。`apply_planner` 用 PRAGMA 动态取列，不用改列清单。

**加一类数据（新 section）**：`Sections` 加 bool → `Manifest` 的 `sections` 序列化自动带上 → `export_into()` 写目录 → `scan_stage` 已在遍历，manifest 自动收录 → 恢复命令里加 `manifest.sections.<x>` 校验 → 前端 `BackupSections` 类型 → `UnifiedBackupPanel` 的 SECTIONS 文案 → `docs/unified-backup.md`。

**改面板 UI**：只动 `UnifiedBackupPanel.tsx`。它靠 placeholder 定位输入框，测试（`UnifiedBackupPanel.test.tsx`）也按 placeholder 取元素 —— 改 placeholder 就要同步改测试。

**加错误码**：Rust 抛 `E_XXX` → `describeError` 加映射 → `backupDisabled.test.js` 里那组守卫断言会检查命令存在，不影响。

**碰同步**：`src/tongyun/utils/sync/engine.ts` 的 `pauseAndDrain()` 返回 resume 函数，纯内存计数，不碰 write_gate。同步的合并规则测试在 `src/tongyun/utils/sync/`（193 个），改之前先跑一遍。

---

## 10. 平台坑（都实际踩过）

- **CRLF**：Windows 检出是 CRLF。任何"读源码/读 vendor 文档再比对字符串"的测试都要先 `.replace(/\r\n/g, "\n")`，不要放宽正则。已修：`gzhTheme.test.ts`、`unifiedIntegration.test.ts`。
- **Python 输出编码**：Windows 子进程 stdout 是 cp1252，`vendor/gzh-design/scripts/validate_gzh_html.py` 打印 emoji 会 `UnicodeEncodeError`。spawn 时必须 `env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }`。
- **Windows 不能重命名"仍有打开句柄的目录"**：`workspace_backup::export` 写完 manifest 必须先 `drop(file)` 再 `publish()`，否则 `os error 5 Access is denied`（macOS 上不会暴露）。
- **macOS `._*` 资源叉**：会让 vitest 解析失败、让 git 报 `non-monotonic index .git/objects/pack/._pack-*.idx`。跑测试加 `--exclude '**/._*'`，这个 git 报错是噪音可忽略。
- **`node --test` 风格的文件不能被 vitest 收集**：`npx vitest run` 全量会有一批 "No test suite found"，那是给 `node --experimental-strip-types --test` 跑的，不是失败。
- **git push 的 "main -> main" 在 stderr**：`2>/dev/null` 会 grep 不到，别据此判断失败；用 `git log --oneline -1 origin/main` 确认。

---

## 11. 现状与未验证的边界

已完成并验证（本地全绿 + Windows Actions 15 步全 success）：统一备份/校验/三种恢复、日记图片原地恢复与逐条核对、手帐单事务整表恢复 + 回滚点、写作新目录恢复 + 冲突改名、双锁、外部文件变更导致备份失败、凭据不进归档、WAL 行可导出、NSIS 打包产物含图标。

**没验证过、不要声称已验证**：真实坚果云账号的往返同步、Windows 真机安装与桌面验收。文档（README / `docs/unified-backup.md`）里写明了这个边界，别把它删掉。

已知既有不一致：`src/tongyun/utils/__tests__/releaseCheck.test.ts` 断言 `.github/workflows/release.yml` 由 `tags: ['v*']` 触发，而该工作流现在是纯 `workflow_dispatch` + tag 输入。测试或工作流其中之一需要对齐。

---

## 12. 提交之前

```bash
npm run build                     # 类型错误必须清零
npx vitest run --exclude '**/._*'
cd src-tauri && CARGO_TARGET_DIR=/tmp/konh-clean-target cargo test --locked
```

提交时：

- 不提交 `._*`、`test-builds/`、`dist/`、`node_modules/`、`src-tauri/target/`、`.env*`。
- commit message 要写**为什么**，不只是改了什么（先例：`fix: keep the maintenance marker inside the try block`）。
- 提交信息末尾加 `Assisted-by: Cindy (https://cindy.app)`。
- 不强推、不覆盖别人新提交、不建 Release（除非明确要求）。
- 推完用 `.github/workflows/windows.yml` 的 run 结果确认 Windows 侧没退步；`/tmp/watch_ci.sh <short-sha>` 可以在本机轮询并拉失败日志。
