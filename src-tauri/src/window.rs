//! Native window chrome — the parts of the frame CSS cannot reach.
//!
//! macOS needs nothing here: the window is borderless and the app's own
//! toolbar *is* the title bar. Windows keeps a system title bar above that
//! toolbar, and it is painted by the OS — against this warm paper canvas the
//! default caption reads as a foreign grey strip pasted on top of the app.
//!
//! Windows 11 exposes the caption colours through DWM, so the shell tells us
//! which colours the current appearance is using and we hand them straight
//! over. Windows 10 never implemented these attributes and answers with an
//! error, which is why failure here is silent: the title bar keeps the system
//! look and nothing else in the app is affected.

/// `#rrggbb` → COLORREF, which orders its bytes the other way round (0x00bbggrr).
#[cfg_attr(not(windows), allow(dead_code))]
fn colorref(hex: &str) -> Option<u32> {
    let h = hex.strip_prefix('#').unwrap_or(hex);
    if h.len() != 6 {
        return None;
    }
    let r = u32::from_str_radix(&h[0..2], 16).ok()?;
    let g = u32::from_str_radix(&h[2..4], 16).ok()?;
    let b = u32::from_str_radix(&h[4..6], 16).ok()?;
    Some((b << 16) | (g << 8) | r)
}

#[cfg(windows)]
mod dwm {
    /// DWMWA_BORDER_COLOR / DWMWA_CAPTION_COLOR / DWMWA_TEXT_COLOR
    pub const BORDER: u32 = 34;
    pub const CAPTION: u32 = 35;
    pub const TEXT: u32 = 36;

    #[link(name = "dwmapi")]
    extern "system" {
        pub fn DwmSetWindowAttribute(hwnd: isize, attr: u32, value: *const u32, size: u32) -> i32;
    }
}

/// Paint the system title bar in the appearance's own colours.
///
/// Called whenever the resolved appearance changes, so switching to dark takes
/// the title bar with it instead of leaving a light strip behind.
#[tauri::command]
pub fn window_chrome(window: tauri::WebviewWindow, caption: String, text: String) {
    #[cfg(windows)]
    {
        let Ok(handle) = window.hwnd() else { return };
        let hwnd = handle.0 as isize;
        if let Some(color) = colorref(&caption) {
            // The 1px frame around the window is its own attribute; left at the
            // system colour it outlines the caption we just repainted.
            unsafe {
                dwm::DwmSetWindowAttribute(hwnd, dwm::CAPTION, &color, 4);
                dwm::DwmSetWindowAttribute(hwnd, dwm::BORDER, &color, 4);
            }
        }
        if let Some(color) = colorref(&text) {
            unsafe {
                dwm::DwmSetWindowAttribute(hwnd, dwm::TEXT, &color, 4);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, caption, text);
    }
}

#[cfg(test)]
mod tests {
    use super::colorref;

    #[test]
    fn 颜色按_colorref_的字节序反过来放() {
        // #d97757 → 0x005777d9
        assert_eq!(colorref("#d97757"), Some(0x005777d9));
        assert_eq!(colorref("d97757"), Some(0x005777d9));
        assert_eq!(colorref("#000000"), Some(0));
        assert_eq!(colorref("#ffffff"), Some(0x00ffffff));
    }

    #[test]
    fn 认不出来的颜色不糊弄() {
        assert_eq!(colorref("#fff"), None);
        assert_eq!(colorref(""), None);
        assert_eq!(colorref("#zzzzzz"), None);
    }
}
