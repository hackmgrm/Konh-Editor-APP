//! Desktop integration for the TongYun workspace. Legacy productivity data is left untouched.
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    app.plugin(tauri_plugin_autostart::Builder::new().args(["--autostart"]).build())?;
    let open = MenuItem::with_id(app, "open", "打开空核", true, None::<&str>)?;
    let widget = MenuItem::with_id(app, "tongyun-widget", "显示/隐藏挂件", true, None::<&str>)?;
    let lock = MenuItem::with_id(app, "tongyun-lock", "锁定/解锁挂件", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出空核", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &widget, &lock, &quit])?;
    let mut tray = TrayIconBuilder::with_id("tongyun")
        .menu(&menu)
        .tooltip("空核 · 橦云手帐")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "tongyun-widget" => { let _ = crate::tongyun::toggle_widget_window(app.clone()); }
            "tongyun-lock" => {
                let _ = app.emit("todo-sync-event", crate::tongyun::TodoSyncPayload {
                    task_id: "widget_lock".into(), action: "toggle_lock_from_tray".into(),
                    source_window: Some("tray".into()), title: None, description: None,
                    notes: None, category: None, due_date: None, due_time: None, timestamp: 0,
                });
            }
            "quit" => crate::tongyun::request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    #[cfg(target_os = "macos")]
    {
        let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
        tray = tray.icon(icon).icon_as_template(true);
    }
    #[cfg(target_os = "windows")]
    {
        let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-windows.png"))?;
        tray = tray.icon(icon);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
    tray.build(app)?;
    Ok(())
}
