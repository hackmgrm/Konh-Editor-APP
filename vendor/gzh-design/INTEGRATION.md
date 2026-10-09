# 产品内置主题

六套原版主题位于排版菜单的「公众号原版」分组。橄榄手记使用
`olive-journal-original`，原来的 `olive-journal` 继续保留为空核域界定制版。

`references/` 保留原始组件库。`src/gzhTemplates.ts` 从其中的 HTML 代码块逐字提取；
`src/gzhTheme.ts` 把 Markdown 结构装配到原始组件模板，预览和所有导出使用同一 HTML。
组件菜单还提供所有原始组件及按主题换色的通用组件，可插入文章后填写内容。

原版字号、行高、字间距和模块边距固定，不应用排版密度缩放。
字体使用原库的系统字体栈及回退顺序，不加载外部字体。

普通 Markdown 的一级标题生成摸鱼绿 / 摸鱼票据 / 橄榄手记封面；
其他主题的开篇引用（或第一段）生成引言卡。二级标题生成编号章节和目录。
`**加粗**`、`==背景高亮==`、`++下划线++` 和 `<u>下划线</u>` 分别对应原库组件。
文末已有作者署名会合并，不重复生成。

文首 Front Matter 支持 `title`、`intro`、`author`、`bio`、`kicker`、`date`、
`subtitle`、`summary`、`tags`，封面可补 `oldTitle`、`highlight`、`coverTitle2`，
票据可补 `issue`、`grade`。未提供的作者、图片与内容不臆造。

AI 排版请求传入当前主题 ID，后端读取完整主题组件库和通用库，按配方选用特殊卡片；
正文保留 Markdown，关键词使用 `++短语++`。API 调用的结果仍通过现有候选预览和采用流程。

更新原库后执行：

```sh
python3 vendor/gzh-design/scripts/sync_templates.py
npm run test:gzh
npm run test:upstream
npm run test:theme
npm run build
cargo test --manifest-path src-tauri/Cargo.toml layout_tests
```

`test:gzh` 验证模板完整性、原版字号、章节结构、嵌套内容、表格、图片、组件插入和署名，
并运行原库 `validate_gzh_html.py`。授权和导入版本见 NOTICE.md 与 LICENSE。
