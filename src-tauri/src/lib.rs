// All application logic lives in the TypeScript frontend. The shell only provides the window
// and its plugins: native open/save dialogs, file access (config in the app data folder) and,
// on desktop, signed over-the-air updates with a restart into the new version.

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            #[cfg(not(desktop))]
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
