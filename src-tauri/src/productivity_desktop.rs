use crate::productivity::{database, read, save};
use base64::Engine;
use rodio::Source;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{sync::Mutex, time::Duration};
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

static SOUND_PLAYING: AtomicBool = AtomicBool::new(false);
static ERRORS: Mutex<Vec<String>> = Mutex::new(Vec::new());
fn report(error: impl ToString) {
    let text = error.to_string();
    log::warn!("效率中心：{text}");
    if let Ok(mut errors) = ERRORS.lock() {
        if errors.last() != Some(&text) {
            errors.push(text);
            if errors.len() > 10 {
                errors.remove(0);
            }
        }
    }
}
#[tauri::command]
pub fn productivity_desktop_status() -> Vec<String> {
    ERRORS.lock().map(|v| v.clone()).unwrap_or_default()
}
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
pub fn show_surface(app: &AppHandle, label: &str) -> Result<(), String> {
    let window = app.get_webview_window(label).ok_or("找不到快捷窗口")?;
    if label == "quickadd" {
        let _ = window.center();
    }
    if label == "reminder" {
        if let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? {
            let scale = monitor.scale_factor();
            let origin = monitor.position();
            let size = monitor.size();
            let settings = read(&database(app)?)?.data.unwrap_or_default()["settings"].clone();
            let corner = settings["popupCorner"].as_str().unwrap_or("bottom-right");
            let x = if corner.ends_with("left") {
                origin.x + (20.0 * scale) as i32
            } else {
                origin.x + size.width as i32 - (420.0 * scale) as i32
            };
            let y = if corner.starts_with("top") {
                origin.y + (45.0 * scale) as i32
            } else {
                origin.y + size.height as i32 - (450.0 * scale) as i32
            };
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }
    window.show().map_err(|e| e.to_string())?;
    if label == "quickadd" {
        window.set_focus().map_err(|e| e.to_string())?;
        let _ = app.emit_to("quickadd", "productivity-focus-input", ());
    }
    Ok(())
}
#[tauri::command]
pub fn productivity_hide_surface(app: AppHandle, label: String) -> Result<(), String> {
    if label != "quickadd" && label != "reminder" {
        return Err("不是快捷窗口".into());
    }
    app.get_webview_window(&label)
        .ok_or("窗口不存在")?
        .hide()
        .map_err(|e| e.to_string())
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn timer_elapsed(timer: &Value, timestamp: i64) -> f64 {
    timer["accumulated"].as_f64().unwrap_or(0.0)
        + timer["startedAt"]
            .as_i64()
            .map(|start| ((timestamp - start).max(0) as f64) / 1000.0)
            .unwrap_or(0.0)
}
fn timer_action(app: &AppHandle, action: &str) -> Result<(), String> {
    let mut db = database(app)?;
    for _ in 0..6 {
        let snapshot = read(&db)?;
        let Some(mut data) = snapshot.data else {
            return Ok(());
        };
        let timestamp = now();
        if action == "focus" && data["timer"].is_null() {
            data["timer"] = json!({"taskId":null,"taskTitle":"","kind":"focus","startedAt":timestamp,"accumulated":0,"target":data["settings"]["focusMinutes"].as_i64().unwrap_or(25)*60,"notified":false,"createdAt":timestamp});
        } else if data["timer"].is_object() {
            let seconds = timer_elapsed(&data["timer"], timestamp);
            if action == "stop" {
                let t = data["timer"].clone();
                if matches!(t["kind"].as_str(), Some("focus" | "stopwatch")) && seconds >= 1.0 {
                    let session = json!({"id":format!("native-{timestamp}-{}", snapshot.revision),"taskId":t["taskId"],"taskTitle":t["taskTitle"],"kind":t["kind"],"startedAt":t["createdAt"],"endedAt":timestamp,"seconds":seconds.floor(),"updatedAt":timestamp});
                    data["sessions"]
                        .as_array_mut()
                        .ok_or("专注数据损坏")?
                        .push(session);
                    if t["kind"] == "focus" && seconds >= t["target"].as_f64().unwrap_or(f64::MAX) {
                        data["focusRound"] = (data["focusRound"].as_i64().unwrap_or(0) + 1).into();
                    }
                }
                data["timer"] = Value::Null;
            } else if data["timer"]["startedAt"].is_null() {
                data["timer"]["startedAt"] = timestamp.into();
            } else {
                data["timer"]["accumulated"] = json!(seconds);
                data["timer"]["startedAt"] = Value::Null;
            }
        } else {
            return Ok(());
        }
        match save(&mut db, snapshot.revision, &data) {
            Ok(s) => {
                let _ = app.emit("productivity-changed", s.revision);
                return Ok(());
            }
            Err(e) if e == "PRODUCTIVITY_CONFLICT" => continue,
            Err(e) => return Err(e),
        }
    }
    Err("计时操作遇到并发修改，请重试".into())
}
/// Mark only due, unacknowledged reminders. No UI timer is required for this scheduler.
pub fn due_notifications(data: &mut Value, timestamp: i64) -> Vec<String> {
    let repeat = data["settings"]["reminderRepeat"].as_i64().unwrap_or(0) * 60_000;
    let mut titles = vec![];
    if let Some(tasks) = data["tasks"].as_array_mut() {
        for task in tasks {
            if task["deletedAt"].as_i64().is_some()
                || task["completedAt"].as_i64().is_some()
                || task["reminderAck"] == true
            {
                continue;
            }
            let Some(at) = task["reminderAt"].as_i64() else {
                continue;
            };
            if at > timestamp {
                continue;
            }
            let previous = task["lastNotified"].as_i64();
            if previous.is_some() && (repeat == 0 || timestamp - previous.unwrap() < repeat) {
                continue;
            }
            titles.push(task["title"].as_str().unwrap_or("待办提醒").to_string());
            task["lastNotified"] = timestamp.into();
            task["reminderCount"] = (task["reminderCount"].as_u64().unwrap_or(0) + 1).into();
        }
    }
    let t = &data["timer"];
    if t.is_object()
        && t["target"].as_f64().unwrap_or(0.0) > 0.0
        && t["notified"] != true
        && t["startedAt"].is_number()
        && timer_elapsed(t, timestamp) >= t["target"].as_f64().unwrap_or(f64::MAX)
    {
        titles.push("本次计时已到预定时间，计时仍在继续".into());
        data["timer"]["notified"] = true.into();
    }
    titles
}
fn tick(app: &AppHandle) -> Result<(), String> {
    let mut db = database(app)?;
    let snapshot = read(&db)?;
    let Some(mut data) = snapshot.data else {
        return Ok(());
    };
    let titles = due_notifications(&mut data, now());
    if let Some(tray) = app.tray_by_id("productivity") {
        if data["timer"].is_object() {
            let t = &data["timer"];
            let seconds = timer_elapsed(t, now());
            let target = t["target"].as_f64().unwrap_or(0.0);
            let value = if target > 0.0 {
                target - seconds
            } else {
                seconds
            };
            let total = value.abs() as i64;
            let title = format!(
                "{}{}:{:02}{}",
                if value < 0.0 { "+" } else { "" },
                total / 60,
                total % 60,
                if t["startedAt"].is_null() { " ⏸" } else { "" }
            );
            let _ = tray.set_title(Some(&title));
            let _ = tray.set_tooltip(Some(format!(
                "空核 · {} · {title}",
                t["taskTitle"].as_str().unwrap_or("专注")
            )));
        } else {
            let _ = tray.set_title(None::<&str>);
            let _ = tray.set_tooltip(Some("空核 · 任务与创作"));
        }
    }
    if titles.is_empty() {
        return Ok(());
    }
    match save(&mut db, snapshot.revision, &data) {
        Ok(s) => {
            let _ = app.emit("productivity-changed", s.revision);
        }
        Err(e) if e == "PRODUCTIVITY_CONFLICT" => return Ok(()),
        Err(e) => return Err(e),
    }
    if data["settings"]["reminderMode"] == "system" {
        for title in &titles {
            let notification = app.notification().builder().title("空核提醒").body(title);
            if let Err(e) = notification.show() {
                report(e);
                show_surface(app, "reminder")?;
            }
        }
    } else {
        show_surface(app, "reminder")?;
    }
    play_sound(&data);
    Ok(())
}
fn play_sound(data: &Value) {
    if data["settings"]["sound"] != true || SOUND_PLAYING.swap(true, Ordering::SeqCst) {
        return;
    }
    let settings = data["settings"].clone();
    let count = data["tasks"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|t| {
                    t["reminderAck"] != true
                        && t["completedAt"].is_null()
                        && t["deletedAt"].is_null()
                })
                .map(|t| t["reminderCount"].as_u64().unwrap_or(1))
                .max()
                .unwrap_or(1)
        })
        .unwrap_or(1);
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let stream =
                rodio::OutputStreamBuilder::open_default_stream().map_err(|e| e.to_string())?;
            let sink = rodio::Sink::connect_new(stream.mixer());
            let base = settings["volume"].as_f64().unwrap_or(0.5) as f32;
            let volume = if settings["ramp"] == true {
                base + (count.saturating_sub(1) as f32) * 0.1
            } else {
                base
            };
            sink.set_volume(volume.clamp(0.0, 1.0));
            let sound = settings["soundData"].as_str().unwrap_or("");
            if sound.is_empty() {
                sink.append(
                    rodio::source::SineWave::new(660.0)
                        .take_duration(Duration::from_millis(180))
                        .amplify(0.2),
                );
                sink.append(
                    rodio::source::SineWave::new(880.0)
                        .take_duration(Duration::from_millis(300))
                        .amplify(0.2),
                );
            } else {
                let encoded = sound.split_once(',').ok_or("提示音数据无效")?.1;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|e| e.to_string())?;
                let source = rodio::Decoder::try_from(std::io::Cursor::new(bytes))
                    .map_err(|e| format!("提示音格式不支持：{e}"))?;
                sink.append(source.take_duration(Duration::from_secs(10)));
            }
            sink.sleep_until_end();
            Ok(())
        })();
        if let Err(e) = result {
            report(e);
        }
        SOUND_PLAYING.store(false, Ordering::SeqCst);
    });
}
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    app.plugin(tauri_plugin_notification::init())?;
    app.plugin(
        tauri_plugin_autostart::Builder::new()
            .args(["--autostart"])
            .build(),
    )?;
    app.plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
    for (label, width, height) in [("quickadd", 660.0, 240.0), ("reminder", 400.0, 400.0)] {
        WebviewWindowBuilder::new(
            app,
            label,
            WebviewUrl::App(format!("index.html?surface={label}").into()),
        )
        .title(if label == "quickadd" {
            "空核 · 快速添加"
        } else {
            "空核 · 提醒"
        })
        .inner_size(width, height)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()?;
    }
    let open = MenuItem::with_id(app, "open", "打开空核", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "添加任务 · Ctrl Alt A", true, None::<&str>)?;
    let focus = MenuItem::with_id(app, "focus", "开始专注 / 暂停 / 继续", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "停止计时并保存", true, None::<&str>)?;
    let reminders = MenuItem::with_id(app, "reminders", "查看待处理提醒", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出空核", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quick, &focus, &stop, &reminders, &quit])?;
    let mut tray = TrayIconBuilder::with_id("productivity")
        .menu(&menu)
        .tooltip("空核 · 任务与创作")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let result = match event.id.as_ref() {
                "open" => {
                    show_main(app);
                    Ok(())
                }
                "quick" => show_surface(app, "quickadd"),
                "reminders" => show_surface(app, "reminder"),
                "focus" => timer_action(app, "focus"),
                "stop" => timer_action(app, "stop"),
                "quit" => {
                    app.exit(0);
                    Ok(())
                }
                _ => Ok(()),
            };
            if let Err(e) = result {
                report(e);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    let main_menu = app.menu().unwrap_or(Menu::default(app)?);
    let capture = MenuItem::with_id(
        app,
        "productivity-capture",
        "快速添加任务",
        true,
        Some("Ctrl+Alt+A"),
    )?;
    let alerts = MenuItem::with_id(app, "productivity-alerts", "待处理提醒", true, None::<&str>)?;
    let submenu = Submenu::with_items(app, "效率", true, &[&capture, &alerts])?;
    main_menu.append(&submenu)?;
    app.set_menu(main_menu)?;
    app.on_menu_event(|app, event| {
        let label = match event.id.as_ref() {
            "productivity-capture" => "quickadd",
            "productivity-alerts" => "reminder",
            _ => return,
        };
        if let Err(e) = show_surface(app, label) {
            report(e);
        }
    });
    if let Err(e) = app
        .global_shortcut()
        .on_shortcut("Ctrl+Alt+A", |app, _, event| {
            if event.state() == ShortcutState::Pressed {
                if let Err(e) = show_surface(app, "quickadd") {
                    report(e);
                }
            }
        })
    {
        report(format!("全局快捷键注册失败：{e}"));
    }
    if std::env::args().any(|arg| arg == "--autostart") {
        if read(&database(app)?)?
            .data
            .map(|d| d["settings"]["startHidden"] == true)
            .unwrap_or(false)
        {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
    }
    let handle = app.clone();
    std::thread::spawn(move || loop {
        if let Err(e) = tick(&handle) {
            report(e);
        }
        std::thread::sleep(Duration::from_secs(1));
    });
    Ok(())
}
pub fn close_to_tray(app: &AppHandle) -> bool {
    read(&match database(app) {
        Ok(db) => db,
        Err(_) => return false,
    })
    .ok()
    .and_then(|s| s.data)
    .map(|d| d["settings"]["closeToTray"] != false)
    .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reminders_respect_snooze_completion_ack_and_repeat() {
        let mut d = json!({"settings":{"reminderRepeat":1},"tasks":[{"title":"due","reminderAt":100,"lastNotified":null},{"title":"later","reminderAt":999999},{"title":"done","reminderAt":1,"completedAt":2},{"title":"ack","reminderAt":1,"reminderAck":true}]});
        assert_eq!(due_notifications(&mut d, 100), vec!["due"]);
        assert!(due_notifications(&mut d, 101).is_empty());
        assert_eq!(due_notifications(&mut d, 60100), vec!["due"]);
        d["settings"]["reminderRepeat"] = 0.into();
        assert!(due_notifications(&mut d, 200000).is_empty());
    }
    #[test]
    fn timer_recovers_wall_time_and_never_autostops() {
        let mut d = json!({"timer":{"kind":"focus","startedAt":1000,"accumulated":2,"target":10,"notified":false},"settings":{}});
        assert_eq!(timer_elapsed(&d["timer"], 10000), 11.0);
        assert_eq!(due_notifications(&mut d, 10000).len(), 1);
        assert!(d["timer"]["startedAt"].is_number());
        assert!(due_notifications(&mut d, 11000).is_empty());
        d["timer"]["startedAt"] = Value::Null;
        assert_eq!(timer_elapsed(&d["timer"], 100000), 2.0);
    }
}
