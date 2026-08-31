use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

const MEMO_WINDOW_LABEL: &str = "memo";
const MEMO_WINDOW_WIDTH: f64 = 338.0;
const MEMO_WINDOW_HEIGHT: f64 = 210.0;
const MEMO_WINDOW_MIN_WIDTH: f64 = 260.0;
const MEMO_WINDOW_MIN_HEIGHT: f64 = 150.0;
const MEMO_WINDOW_MAX_WIDTH: f64 = 500.0;
const MEMO_WINDOW_MAX_HEIGHT: f64 = 420.0;
const MEMO_WINDOW_GAP: f64 = 12.0;

/// 告知 WebView2 当前窗口是否处于后台，以便它主动回收可释放的内存。
/// Low 不会暂停 JavaScript，因此隐藏后提醒和定时逻辑仍会继续运行。
#[cfg(target_os = "windows")]
fn set_webview_memory_usage(window: &tauri::WebviewWindow, low: bool) {
    let _ = window.with_webview(move |webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows_core::Interface;

        let level = if low {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        };

        // 较旧的 WebView2 Runtime 可能没有 ICoreWebView2_19；这种情况下保留默认策略。
        let _ = (|| -> windows_core::Result<()> {
            let core_webview = unsafe { webview.controller().CoreWebView2()? };
            let core_webview_19: ICoreWebView2_19 = core_webview.cast()?;
            unsafe { core_webview_19.SetMemoryUsageTargetLevel(level) }
        })();
    });
}

#[cfg(not(target_os = "windows"))]
fn set_webview_memory_usage(_window: &tauri::WebviewWindow, _low: bool) {}

fn hide_window(window: &tauri::WebviewWindow) {
    let _ = window.hide();
    set_webview_memory_usage(window, true);
}

fn show_window(window: &tauri::WebviewWindow, focus: bool) {
    // 先恢复 Normal，再显示，避免首帧仍处于后台内存策略。
    set_webview_memory_usage(window, false);
    let _ = window.unminimize();
    let _ = window.show();
    if focus {
        let _ = window.set_focus();
    }
}

/// 显示或隐藏悬浮窗。
fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            hide_window(&window);
        } else {
            show_window(&window, true);
        }
    }
}

/// 首次打开便签时，将它放在主面板正下方并与主面板右侧对齐。
/// 便签前端会在加载后优先恢复用户上次保存的位置和尺寸，因此这里只提供默认值。
fn clamp_i32(value: i32, min: i32, max: i32) -> i32 {
    let upper = max.max(min);
    value.clamp(min, upper)
}

fn logical_pixels_to_physical(value: f64, scale_factor: f64) -> i32 {
    (value * scale_factor).round() as i32
}

fn memo_default_position(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let main = app.get_webview_window("main")?;
    let position = main.outer_position().ok()?;
    let size = main.outer_size().ok()?;
    let monitor = main
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| main.primary_monitor().ok().flatten())?;
    let scale_factor = monitor.scale_factor();
    let memo_width = logical_pixels_to_physical(MEMO_WINDOW_WIDTH, scale_factor);
    let memo_height = logical_pixels_to_physical(MEMO_WINDOW_HEIGHT, scale_factor);
    let gap = logical_pixels_to_physical(MEMO_WINDOW_GAP, scale_factor);
    let main_width = i32::try_from(size.width).ok()?;
    let main_height = i32::try_from(size.height).ok()?;
    let desired_x = position
        .x
        .saturating_add(main_width)
        .saturating_sub(memo_width);
    let desired_y = position.y.saturating_add(main_height).saturating_add(gap);
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let min_x = monitor_position.x;
    let min_y = monitor_position.y;
    let max_x = min_x
        .saturating_add(i32::try_from(monitor_size.width).unwrap_or(i32::MAX))
        .saturating_sub(memo_width);
    let max_y = min_y
        .saturating_add(i32::try_from(monitor_size.height).unwrap_or(i32::MAX))
        .saturating_sub(memo_height);

    Some(PhysicalPosition::new(
        clamp_i32(desired_x, min_x, max_x),
        clamp_i32(desired_y, min_y, max_y),
    ))
}

/// 按需创建并唤起独立便签窗口。
///
/// 窗口关闭时由便签前端直接销毁 WebView；再次打开才重新创建，
/// 避免隐藏的第二个渲染器长期占用内存。
#[tauri::command]
async fn open_memo_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MEMO_WINDOW_LABEL) {
        show_window(&window, true);
        return Ok(());
    }

    let default_position = memo_default_position(&app);
    let window = WebviewWindowBuilder::new(
        &app,
        MEMO_WINDOW_LABEL,
        WebviewUrl::App("memo.html".into()),
    )
    .title("备忘录")
    .inner_size(MEMO_WINDOW_WIDTH, MEMO_WINDOW_HEIGHT)
    .min_inner_size(MEMO_WINDOW_MIN_WIDTH, MEMO_WINDOW_MIN_HEIGHT)
    .max_inner_size(MEMO_WINDOW_MAX_WIDTH, MEMO_WINDOW_MAX_HEIGHT)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(false)
    .focused(false)
    .general_autofill_enabled(false)
    .browser_extensions_enabled(false)
    .devtools(false)
    .prevent_overflow()
    .build()
    .map_err(|error| error.to_string())?;

    if let Some(position) = default_position {
        window
            .set_position(position)
            .map_err(|error| error.to_string())?;
    }

    show_window(&window, true);

    Ok(())
}

/// 导出数据到用户选择的文件。
#[tauri::command]
async fn export_data(app: AppHandle, json: String) -> Result<bool, String> {
    let file = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name("floating-todo-backup.json")
        .blocking_save_file();
    match file {
        Some(p) => {
            let path = p.into_path().map_err(|e| e.to_string())?;
            std::fs::write(path, json).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 从用户选择的文件导入数据，返回文件内容。
#[tauri::command]
async fn import_data(app: AppHandle) -> Result<Option<String>, String> {
    let file = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    match file {
        Some(p) => {
            let path = p.into_path().map_err(|e| e.to_string())?;
            let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            Ok(Some(content))
        }
        None => Ok(None),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec![]),
            ));
    }

    builder
        .on_window_event(|window, event| {
            let label = window.label();
            if label != "main" && label != MEMO_WINDOW_LABEL {
                return;
            }

            if let WindowEvent::Focused(focused) = event {
                if let Some(webview_window) = window.app_handle().get_webview_window(label) {
                    set_webview_memory_usage(&webview_window, !*focused);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            export_data,
            import_data,
            open_memo_window
        ])
        .setup(|app| {
            // macOS：作为状态栏小组件运行，不占用程序坞。
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // 全局快捷键：CmdOrCtrl+Shift+Space 唤起并聚焦输入框（快速捕获）。
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
                let handle = app.handle().clone();
                let _ = app.global_shortcut().on_shortcut(
                    "CommandOrControl+Shift+Space",
                    move |_app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            if let Some(win) = handle.get_webview_window("main") {
                                show_window(&win, true);
                                let _ = win.emit("quick-capture", ());
                            }
                        }
                    },
                );
            }

            let toggle_item =
                MenuItem::with_id(app, "toggle", "显示/隐藏小组件", true, None::<&str>)?;
            let passthrough_item =
                MenuItem::with_id(app, "passthrough", "切换鼠标穿透", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_item, &passthrough_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("悬浮待办")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_window(app),
                    "passthrough" => {
                        if let Some(win) = app.get_webview_window("main") {
                            show_window(&win, false);
                            let _ = win.emit("toggle-passthrough", ());
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
