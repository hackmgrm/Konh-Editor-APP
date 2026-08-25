mod agent;
mod config;
mod themes;
mod vault;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
        .manage(vault::WatchState::default())
        .manage(agent::AgentState::default())
        .manage(themes::ThemeWatch::default())
        .invoke_handler(tauri::generate_handler![
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
            vault::entry_move,
            vault::entry_delete,
            vault::entry_reveal,
            vault::image_read,
            vault::image_write,
            vault::image_delete,
            vault::prefs_write,
            config::config_load,
            config::config_write,
            config::config_remove,
            config::file_save,
            agent::agent_probe,
            agent::agent_models,
            agent::agent_run,
            agent::agent_stop,
            agent::agent_sessions_read,
            agent::agent_sessions_write,
            themes::themes_read,
            themes::themes_guide_write,
            themes::theme_delete,
            window::window_chrome,
        ])
        .setup(|app| {
            // In-app update. Desktop only — see Cargo.toml
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            // Find out where the user's CLIs live before anyone asks. It means
            // starting a login shell, which takes seconds on a machine with a
            // furnished .zshrc — time better spent now, while the window is
            // still being drawn, than at the moment the Agent panel opens
            let handle = app.handle().clone();
            std::thread::spawn(move || agent::warm_path(&handle));
            // Custom themes are files the agent edits while you watch; the
            // watcher is what makes the preview follow along
            themes::start_watch(app.handle());
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
