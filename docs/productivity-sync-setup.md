# 效率中心账号服务部署

本地功能无需服务器。以下配置仅用于自己的账号同步和 Google 日历，不连接 Todofy 服务。

1. 创建自己的 Supabase 项目，在 SQL 编辑器执行 `supabase/migrations/202609110001_productivity.sql`。表启用 RLS，用户只能访问自己的任务、标签、日记、专注和完成记录；独立日程、计时器和设备设置不上传。
2. 部署 `konh-delete-account` 与 `konh-google-token` 两个 Edge Functions。服务角色密钥只在服务端读取，绝不能填写进桌面端。
3. 在 Supabase Auth 启用邮箱登录，按需要配置邮件验证及 SMTP。
4. 在 Google Cloud 创建 Web OAuth 客户端，启用 Calendar API；授权回调填写 Supabase Google Provider 页面给出的 `/auth/v1/callback` 地址。Google 客户端 ID 与 secret 填入 Supabase Provider 设置。
5. Supabase Auth 的 Redirect URLs 加入 `http://127.0.0.1:42819/callback`。桌面登录使用 PKCE 与仅监听本机的 42819 端口；窗口等候 180 秒。
6. Edge Functions 环境变量设置 `GOOGLE_CLIENT_ID` 与 `GOOGLE_CLIENT_SECRET`，和上述 Google Provider 一致。Google OAuth 同意屏幕需允许 `https://www.googleapis.com/auth/calendar.app.created` 范围；测试阶段将使用者加入测试用户。
7. 桌面版「设置 → 账号与同步」填写项目 HTTPS URL 和 publishable key（或 anon key），登录后选择载入云端或复制本机数据。使用 Google 日历时额外点击授权并启用推送。

会话和 Google refresh token 存在操作系统密钥存储（macOS Keychain / Windows Credential Manager / Linux Secret Service）。浏览器开发预览只保留内存会话，不代替桌面凭据验收。

同步采用逐记录修改时间合并，删除保留 tombstone。网络失败不清空本地数据；定期只上传发生变化的记录，并分页拉取云端记录核对。不同设备时钟应保持系统自动校时。记录内同时修改以最终修改时间决定保留版本。

Google 只推送任务到应用创建的独立日历；独立日程不推送。日期任务为全天，带时间任务使用明确时区偏移；重复任务完成后移动同一个日历事件。关闭推送停止后续请求，不删除已有日历。

真实联网验收需用部署后的项目进行：邮箱注册/验证/登录、Google 登录、两设备互改与删除传播、退出/切换账号、令牌过期刷新、Calendar 创建/更新/删除、注销账号后的数据清理。未部署时不能声称这些外部服务已验证。
