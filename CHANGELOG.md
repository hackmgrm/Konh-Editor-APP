# 更新记录

## 2026-08-28 · 空核编辑器定制版

### 品牌升级

- 应用英文名由 Mars Editor 改为 KonhEditor，中文名改为“空核编辑器”。
- 预览、长图导出和品牌署名统一为“空核域界”。
- npm、Rust、Tauri 产品名与应用标识同步更新。
- README、主题说明、设置页和窗口标题同步更新品牌文案。

### 内置主题

- 从 `isjiamu/gzh-design-skill` 适配 5 套主题：摸鱼绿、红白色系、石墨极简、留白禅意、摸鱼票据。
- 从 `Kianzzz/zhouxing-paiban-wx` 适配 5 套主题：石墨档案、绿白清简、墨蓝刊读、雾紫叙事、沙金手记。
- 内置主题总数扩展至 23 套。
- 原“橄榄手记”改为“空核域界”品牌定制主题；内部 ID 保留 `olive-journal`，兼容旧草稿设置。

### 空核域界品牌版式

- 支持 Markdown 顶部 front-matter 自动生成品牌头图、导语卡、摘要标签和文末签名卡。
- 修复右侧预览遗漏 front-matter 头图、显示“未命名文章”的问题。
- 品牌头图启用时隐藏预览器的默认文章头，避免标题和日期重复。
- 旧稿中的 `author: 空运新视角` 自动迁移显示为“空核域界”，其他明确署名保持不变。

### 图标

- 新增空核域界品牌图标：以空心核心、交汇航线和向上航向表达航空货运、跨界连接与新视角。
- 同步替换 macOS、Windows、iOS、Android 和网页 favicon 图标资源。

### 验证

- `npm run build` 通过。
- `cargo check --manifest-path src-tauri/Cargo.toml` 通过。
- Tauri macOS Apple Silicon `.app` 与 `.dmg` 打包通过（未签名）。
