use tauri::Manager;
mod artifacts;
mod agent;
mod agent_api;
mod config;
mod cloudinary;
mod themes;
mod vault;
mod window;
mod productivity;
#[cfg(desktop)]
mod productivity_desktop;
mod productivity_auth;
mod tongyun;
mod backup;
mod email;
mod webdav_meta;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| productivity_desktop::show_main(app)));
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        // Reading the clipboard, and only from here. The WebView's own
        // navigator.clipboard.readText() works, but WebKit answers it with a
        // "Paste" confirmation the user has to click — so pre-filling a field
        // from the clipboard would cost more clicks than it saves. From this
        // side there is no popup (see src/components/ImportUrlDialog.tsx)
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_http::init())
        // External links: the webview cannot open one itself, so they go out
        // through the OS (see src/external.ts)
        .plugin(tauri_plugin_opener::init())
        // Restarting into the freshly installed binary is what completes an
        // in-app update; the frontend calls it from the update dialog
        .plugin(tauri_plugin_process::init())
        .manage(agent::AgentState::default())
        .manage(vault::WatchState::default())
        .manage(themes::ThemeWatch::default())
        .invoke_handler(tauri::generate_handler![
            productivity::productivity_load,
            productivity::productivity_save,
            productivity_auth::productivity_secret_read,
            productivity_auth::productivity_secret_write,
            productivity_auth::productivity_oauth,
            vault::vault_load,
            vault::vault_tree,
            vault::vault_watch,
            vault::vault_remember,
            vault::vault_recall,
            vault::draft_read,
            vault::draft_write,
            vault::draft_create,
            vault::dir_create,
            vault::entry_rename,
            vault::entry_rename_target,
            vault::entry_move_target,
            vault::entry_move,
            vault::entry_delete,
            vault::entry_reveal,
            vault::image_read,
            vault::image_write,
            vault::image_delete,
            vault::prefs_write,
            artifacts::artifact_save,
            artifacts::artifact_read,
            artifacts::artifact_list,
            artifacts::artifact_delete,
            config::config_load,
            config::config_write,
            config::config_remove,
            config::file_save,
            cloudinary::cloudinary_test,
            cloudinary::cloudinary_upload,
            agent::agent_probe,
            agent::agent_models,
            agent::agent_run,
            agent::agent_stop,
            agent::agent_sessions_read,
            agent::agent_sessions_write,
            agent_api::agent_api_test,
            agent_api::agent_api_models,
            agent_api::agent_api_run,
            agent_api::writing_suggest,
            agent_api::writing_layout,
            agent_api::writing_cover,
            themes::themes_read,
            themes::themes_guide_write,
            themes::theme_delete,
            themes::theme_write,
            window::window_chrome,
            tongyun::save_local_attachment,
            tongyun::delete_local_attachment,
            tongyun::sync_todo_state,
            tongyun::toggle_widget_window,
            tongyun::set_widget_click_through,
            tongyun::notify_micro_break,
            tongyun::webdav_mkcol,
            tongyun::webdav_upload,
            tongyun::webdav_download,
            tongyun::webdav_upload_binary,
            tongyun::webdav_download_binary,
            tongyun::webdav_delete,
            tongyun::tongyun_file_save,
            tongyun::file_save_b64,
            tongyun::file_read,
            tongyun::file_read_b64,
            tongyun::file_delete,
            tongyun::file_list,
            tongyun::fetch_rss,
            tongyun::fetch_image_base64,
            tongyun::ai_proxy,
            email::send_test_email,
            webdav_meta::webdav_stat,
            webdav_meta::webdav_download_meta,
            webdav_meta::webdav_upload_meta,
            backup::local_backup_write,
            backup::local_backup_list,
            backup::local_backup_read,
            backup::local_backup_prune,
            backup::local_backup_dir,
            tongyun::app_quit_ready,
            tongyun::read_pipeline_home_files,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            productivity_desktop::setup(app.handle())?;
            // In-app update. Desktop only — see Cargo.toml
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            // Custom themes are files the agent edits while you watch; the
            // watcher is what makes the preview follow along
            themes::start_watch(app.handle());
            agent::warm_path(app.handle());
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" || window.label() == "widget" {
                    api.prevent_close();
                    let _ = window.hide();
                    if window.label() == "main" {
                        if let Some(widget) = window.app_handle().get_webview_window("widget") {
                            let _ = widget.hide();
                        }
                        use tauri::Emitter;
                        let _ = window.app_handle().emit_to("main", "tongyun-main-hidden", ());
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                productivity_desktop::show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
