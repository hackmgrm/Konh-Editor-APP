# 旧的「只备份工作区」原型

`src-tauri/src/workspace_backup.rs` 最初只是一个工作区目录复制原型：它选一个目录，把里面的文件按清单复制走，再原子重命名发布。

这个能力现在已经被 [统一备份](unified-backup.md) 取代。设置页里不再有单独的「工作区备份」入口，`SettingsDialog.tsx` 也不再引用它，`src/backupDisabled.test.js` 会检查这一点。

模块本身留着，因为两部分仍在用它：

- `planner_backup.rs` 通过它搬运附件目录；
- `tests/planner_backup_restore.rs` 用它验证手帐域恢复不会碰同步表。

它自己的 `workspace_backup_export` / `workspace_backup_import` 命令没有注册到 Tauri，所以界面上无法调用。这几个函数现在被标记为 `#![allow(dead_code)]` 并在模块头注明原因。

要备份写作工作区，请用设置页的「统一备份与恢复」——它会同时记录每个文件的 SHA-256、拒绝符号链接与非法路径、在复制前后各扫描一次源目录，并在发布前做双向一致性校验。
