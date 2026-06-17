#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![select_export_folder, write_export_file])
        .run(tauri::generate_context!())
        .expect("error while running Nexa POS Cashier");
}

#[tauri::command]
fn select_export_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Select export folder")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn write_export_file(directory: String, filename: String, contents: String) -> Result<String, String> {
    let trimmed = directory.trim();
    if trimmed.is_empty() {
        return Err("Export location is empty.".to_string());
    }

    let mut safe_filename = filename.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "-");
    if safe_filename.trim().is_empty() {
        safe_filename = "export.csv".to_string();
    }

    let dir = std::path::PathBuf::from(trimmed);
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;

    let path = dir.join(safe_filename);
    std::fs::write(&path, contents).map_err(|err| err.to_string())?;

    Ok(path.to_string_lossy().to_string())
}
