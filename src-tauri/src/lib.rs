#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            select_export_folder,
            write_export_file,
            print_receipt
        ])
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

#[tauri::command]
fn print_receipt(printer_name: String, contents: String, copies: Option<u32>) -> Result<PrintReceiptResult, String> {
    let copy_count = copies.unwrap_or(1).clamp(1, 10);
    print_receipt_impl(printer_name, contents, copy_count)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PrintReceiptResult {
    printer_name: String,
    copies: u32,
}

#[cfg(windows)]
fn print_receipt_impl(printer_name: String, contents: String, copies: u32) -> Result<PrintReceiptResult, String> {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, DOC_INFO_1W, EndDocPrinter, EndPagePrinter, GetDefaultPrinterW, OpenPrinterW,
        StartDocPrinterW, StartPagePrinter, WritePrinter,
    };

    fn wide_null(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_error(prefix: &str) -> String {
        format!("{prefix}: {}", std::io::Error::last_os_error())
    }

    fn default_printer_name() -> Result<String, String> {
        let mut size = 0u32;
        unsafe {
            GetDefaultPrinterW(null_mut(), &mut size);
        }
        if size == 0 {
            return Err("No default Windows printer is configured.".to_string());
        }

        let mut buffer = vec![0u16; size as usize];
        let ok = unsafe { GetDefaultPrinterW(buffer.as_mut_ptr(), &mut size) };
        if ok == 0 {
            return Err(last_error("Unable to read the default Windows printer"));
        }

        let end = buffer.iter().position(|ch| *ch == 0).unwrap_or(buffer.len());
        Ok(String::from_utf16_lossy(&buffer[..end]))
    }

    fn append_code128_barcode(bytes: &mut Vec<u8>, value: &str) {
        let barcode: String = value
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
            .collect();
        if barcode.is_empty() || barcode.len() > 64 {
            return;
        }

        bytes.extend_from_slice(&[0x1d, 0x48, 0x02]); // HRI below barcode.
        bytes.extend_from_slice(&[0x1d, 0x68, 0x50]); // Barcode height.
        bytes.extend_from_slice(&[0x1d, 0x77, 0x02]); // Barcode width.
        bytes.extend_from_slice(&[0x1d, 0x6b, 0x49, (barcode.len() + 2) as u8, b'{', b'B']);
        bytes.extend_from_slice(barcode.as_bytes());
        bytes.push(b'\n');
    }

    fn append_receipt_contents(bytes: &mut Vec<u8>, contents: &str) {
        for line in contents.lines() {
            let trimmed = line.trim();
            if let Some(value) = trimmed
                .strip_prefix("{{BARCODE:")
                .and_then(|value| value.strip_suffix("}}"))
            {
                append_code128_barcode(bytes, value);
            } else {
                bytes.extend_from_slice(line.as_bytes());
                bytes.push(b'\n');
            }
        }
    }

    fn escpos_bytes(contents: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&[0x1b, 0x40]); // ESC @, initialize printer.
        append_receipt_contents(&mut bytes, contents);
        bytes.extend_from_slice(&[0x1b, 0x64, 0x04]); // Feed four lines.
        bytes.extend_from_slice(&[0x1d, 0x56, 0x42, 0x00]); // Partial cut; ignored by non-cutter models.
        bytes
    }

    let selected_printer = if printer_name.trim().is_empty() {
        default_printer_name()?
    } else {
        printer_name.trim().to_string()
    };

    let mut printer_name_w = wide_null(&selected_printer);
    let mut handle: HANDLE = null_mut();
    let opened = unsafe { OpenPrinterW(printer_name_w.as_mut_ptr(), &mut handle, null()) };
    if opened == 0 || handle.is_null() {
        return Err(last_error(&format!(
            "Unable to open printer \"{}\". Check the Windows printer name or VITE_RECEIPT_PRINTER_NAME",
            selected_printer
        )));
    }

    let bytes = escpos_bytes(&contents);
    let mut document_name = wide_null("Nexa POS Receipt");
    let mut datatype = wide_null("RAW");
    let doc_info = DOC_INFO_1W {
        pDocName: document_name.as_mut_ptr(),
        pOutputFile: null_mut(),
        pDatatype: datatype.as_mut_ptr(),
    };

    let result = (|| {
        for _ in 0..copies {
            let doc_id = unsafe { StartDocPrinterW(handle, 1, &doc_info) };
            if doc_id == 0 {
                return Err(last_error("Unable to start receipt print job"));
            }

            let page_started = unsafe { StartPagePrinter(handle) };
            if page_started == 0 {
                unsafe {
                    EndDocPrinter(handle);
                }
                return Err(last_error("Unable to start receipt page"));
            }

            let mut written = 0u32;
            let wrote = unsafe {
                WritePrinter(
                    handle,
                    bytes.as_ptr() as *const c_void,
                    bytes.len() as u32,
                    &mut written,
                )
            };

            unsafe {
                EndPagePrinter(handle);
                EndDocPrinter(handle);
            }

            if wrote == 0 || written != bytes.len() as u32 {
                return Err(last_error("Unable to write receipt data to the printer"));
            }
        }

        Ok(())
    })();

    unsafe {
        ClosePrinter(handle);
    }

    result.map(|_| PrintReceiptResult {
        printer_name: selected_printer,
        copies,
    })
}

#[cfg(not(windows))]
fn print_receipt_impl(printer_name: String, _contents: String, copies: u32) -> Result<PrintReceiptResult, String> {
    let selected_printer = if printer_name.trim().is_empty() {
        "default printer".to_string()
    } else {
        printer_name.trim().to_string()
    };

    Err(format!(
        "Raw receipt printing to {selected_printer} is currently supported only on Windows. Requested {copies} copy/copies."
    ))
}
