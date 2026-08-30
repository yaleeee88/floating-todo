use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_dialog::DialogExt;

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
        .invoke_handler(tauri::generate_handler![export_data, import_data])
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
