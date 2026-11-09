// All application logic lives in the TypeScript frontend. The shell only provides the window
// and two plugins: native open/save dialogs and file access (config in the app data folder).

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
