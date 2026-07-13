#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            select_export_folder,
            write_export_file,
            save_print_file,
            print_receipt,
            printer_status,
            cancel_printer_job,
            list_printers
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
fn save_print_file(default_filename: String, contents: String, file_type: String, extension: String) -> Result<Option<String>, String> {
    let safe_extension = extension
        .trim()
        .trim_start_matches('.')
        .chars()
        .filter(|char| char.is_ascii_alphanumeric())
        .collect::<String>();
    let extension = if safe_extension.is_empty() { "pdf".to_string() } else { safe_extension };

    let mut safe_filename = default_filename.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "-");
    if safe_filename.trim().is_empty() {
        safe_filename = format!("print-file.{extension}");
    }
    if !safe_filename.to_lowercase().ends_with(&format!(".{}", extension.to_lowercase())) {
        safe_filename.push('.');
        safe_filename.push_str(&extension);
    }

    let file_label = if file_type.trim().is_empty() {
        "Print file".to_string()
    } else {
        file_type.trim().to_string()
    };

    let Some(path) = rfd::FileDialog::new()
        .set_title("Save print file")
        .set_file_name(&safe_filename)
        .add_filter(&file_label, &[extension.as_str()])
        .save_file()
    else {
        return Ok(None);
    };

    std::fs::write(&path, contents).map_err(|err| err.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
fn print_receipt(
    printer_name: String,
    contents: String,
    copies: Option<u32>,
    open_cash_drawer: Option<bool>,
    document_name: Option<String>,
    before_feed_lines: Option<u32>,
    after_feed_lines: Option<u32>,
) -> Result<PrintReceiptResult, String> {
    let copy_count = copies.unwrap_or(1).clamp(1, 10);
    print_receipt_impl(
        printer_name,
        contents,
        copy_count,
        open_cash_drawer.unwrap_or(false),
        document_name.unwrap_or_else(|| "Nexa POS Receipt".to_string()),
        before_feed_lines.unwrap_or(0).clamp(0, 8),
        after_feed_lines.unwrap_or(0).clamp(0, 8),
    )
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PrintReceiptResult {
    printer_name: String,
    copies: u32,
    cash_drawer_opened: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PrinterStatusResult {
    printer_name: String,
    is_ready: bool,
    status: u32,
    messages: Vec<String>,
    jobs: Vec<PrinterJobInfo>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PrinterJobInfo {
    id: u32,
    document: String,
    status: u32,
    status_text: String,
    position: u32,
}

#[tauri::command]
fn printer_status(printer_name: String) -> Result<PrinterStatusResult, String> {
    printer_status_impl(printer_name)
}

#[tauri::command]
fn cancel_printer_job(printer_name: String, job_id: u32) -> Result<bool, String> {
    cancel_printer_job_impl(printer_name, job_id)
}

#[cfg(windows)]
fn cancel_printer_job_impl(printer_name: String, job_id: u32) -> Result<bool, String> {
    use std::iter::once;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Graphics::Printing::{ClosePrinter, OpenPrinterW, SetJobW, JOB_CONTROL_DELETE};

    let selected_printer = printer_name.trim();
    if selected_printer.is_empty() {
        return Err("A printer name is required to cancel a print job.".to_string());
    }

    let mut printer_name_w: Vec<u16> = selected_printer.encode_utf16().chain(once(0)).collect();
    let mut handle: HANDLE = null_mut();
    let opened = unsafe { OpenPrinterW(printer_name_w.as_mut_ptr(), &mut handle, null()) };
    if opened == 0 {
        return Err(format!("Unable to open printer \"{}\" to cancel the job.", selected_printer));
    }

    let canceled = unsafe { SetJobW(handle, job_id, 0, null_mut(), JOB_CONTROL_DELETE) };
    unsafe { ClosePrinter(handle) };
    if canceled == 0 {
        return Err(format!("Unable to cancel Windows print job {}.", job_id));
    }
    Ok(true)
}

#[cfg(not(windows))]
fn cancel_printer_job_impl(_printer_name: String, _job_id: u32) -> Result<bool, String> {
    Err("Canceling printer jobs is currently supported only on Windows.".to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PrinterInfo {
    name: String,
    is_default: bool,
}

#[tauri::command]
fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    list_printers_impl()
}

#[cfg(windows)]
fn printer_status_impl(printer_name: String) -> Result<PrinterStatusResult, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, EnumJobsW, GetDefaultPrinterW, GetPrinterW, JOB_INFO_1W,
        JOB_STATUS_BLOCKED_DEVQ, JOB_STATUS_ERROR, JOB_STATUS_OFFLINE, JOB_STATUS_PAPEROUT,
        JOB_STATUS_PAUSED, JOB_STATUS_PRINTING, JOB_STATUS_SPOOLING, JOB_STATUS_USER_INTERVENTION,
        OpenPrinterW, PRINTER_INFO_6, PRINTER_STATUS_DOOR_OPEN, PRINTER_STATUS_ERROR,
        PRINTER_STATUS_NOT_AVAILABLE, PRINTER_STATUS_OFFLINE, PRINTER_STATUS_PAPER_JAM,
        PRINTER_STATUS_PAPER_OUT, PRINTER_STATUS_PAPER_PROBLEM, PRINTER_STATUS_PAUSED,
        PRINTER_STATUS_PENDING_DELETION, PRINTER_STATUS_USER_INTERVENTION,
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

    fn ptr_to_string(value: *const u16) -> String {
        if value.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        unsafe {
            while *value.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(value, len))
        }
    }

    fn status_messages(status: u32) -> Vec<String> {
        let checks = [
            (PRINTER_STATUS_PAPER_OUT, "Printer is out of paper."),
            (PRINTER_STATUS_PAPER_PROBLEM, "Printer has a paper problem."),
            (PRINTER_STATUS_PAPER_JAM, "Printer has a paper jam."),
            (PRINTER_STATUS_OFFLINE, "Printer is offline."),
            (PRINTER_STATUS_NOT_AVAILABLE, "Printer is not available."),
            (PRINTER_STATUS_ERROR, "Printer is reporting an error."),
            (PRINTER_STATUS_PAUSED, "Printer is paused."),
            (PRINTER_STATUS_PENDING_DELETION, "Printer is pending deletion."),
            (PRINTER_STATUS_USER_INTERVENTION, "Printer needs user intervention."),
            (PRINTER_STATUS_DOOR_OPEN, "Printer cover/door is open."),
        ];

        checks
            .iter()
            .filter_map(|(flag, message)| (status & *flag != 0).then(|| (*message).to_string()))
            .collect()
    }

    fn job_status_text(status: u32) -> String {
        let mut messages = Vec::new();
        if status & JOB_STATUS_PRINTING != 0 {
            messages.push("printing");
        }
        if status & JOB_STATUS_SPOOLING != 0 {
            messages.push("spooling");
        }
        if status & JOB_STATUS_ERROR != 0 {
            messages.push("error");
        }
        if status & JOB_STATUS_OFFLINE != 0 {
            messages.push("offline");
        }
        if status & JOB_STATUS_PAPEROUT != 0 {
            messages.push("paper out");
        }
        if status & JOB_STATUS_PAUSED != 0 {
            messages.push("paused");
        }
        if status & JOB_STATUS_USER_INTERVENTION != 0 {
            messages.push("needs user");
        }
        if status & JOB_STATUS_BLOCKED_DEVQ != 0 {
            messages.push("blocked");
        }
        if messages.is_empty() {
            "queued".to_string()
        } else {
            messages.join(", ")
        }
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
            "Unable to open printer \"{}\". Check the Windows printer name.",
            selected_printer
        )));
    }

    let result = (|| {
        let mut needed = 0u32;
        unsafe {
            GetPrinterW(handle, 6, null_mut(), 0, &mut needed);
        }
        if needed == 0 {
            return Err(last_error("Unable to read printer status"));
        }

        let mut printer_buffer = vec![0u8; needed as usize];
        let got_printer = unsafe {
            GetPrinterW(handle, 6, printer_buffer.as_mut_ptr(), needed, &mut needed)
        };
        if got_printer == 0 {
            return Err(last_error("Unable to read printer status"));
        }
        let status = unsafe { (*(printer_buffer.as_ptr() as *const PRINTER_INFO_6)).dwStatus };

        let mut jobs_needed = 0u32;
        let mut jobs_returned = 0u32;
        unsafe {
            EnumJobsW(handle, 0, 20, 1, null_mut(), 0, &mut jobs_needed, &mut jobs_returned);
        }

        let mut jobs = Vec::new();
        if jobs_needed > 0 {
            let mut jobs_buffer = vec![0u8; jobs_needed as usize];
            let got_jobs = unsafe {
                EnumJobsW(
                    handle,
                    0,
                    20,
                    1,
                    jobs_buffer.as_mut_ptr(),
                    jobs_needed,
                    &mut jobs_needed,
                    &mut jobs_returned,
                )
            };
            if got_jobs != 0 {
                let entries = jobs_buffer.as_ptr() as *const JOB_INFO_1W;
                for index in 0..jobs_returned as usize {
                    let job = unsafe { *entries.add(index) };
                    jobs.push(PrinterJobInfo {
                        id: job.JobId,
                        document: ptr_to_string(job.pDocument),
                        status: job.Status,
                        status_text: job_status_text(job.Status),
                        position: job.Position,
                    });
                }
            }
        }

        let mut messages = status_messages(status);
        for job in &jobs {
            if job.status & JOB_STATUS_PAPEROUT != 0 && !messages.iter().any(|msg| msg.contains("out of paper")) {
                messages.push("Printer is out of paper.".to_string());
            }
            if job.status & (JOB_STATUS_ERROR | JOB_STATUS_OFFLINE | JOB_STATUS_USER_INTERVENTION | JOB_STATUS_BLOCKED_DEVQ) != 0 {
                messages.push(format!("Print job {} is {}.", job.id, job.status_text));
            }
        }
        messages.sort();
        messages.dedup();

        let blocking_status = PRINTER_STATUS_PAPER_OUT
            | PRINTER_STATUS_PAPER_PROBLEM
            | PRINTER_STATUS_PAPER_JAM
            | PRINTER_STATUS_OFFLINE
            | PRINTER_STATUS_NOT_AVAILABLE
            | PRINTER_STATUS_ERROR
            | PRINTER_STATUS_PAUSED
            | PRINTER_STATUS_PENDING_DELETION
            | PRINTER_STATUS_USER_INTERVENTION
            | PRINTER_STATUS_DOOR_OPEN;
        let blocking_jobs = jobs.iter().any(|job| {
            job.status
                & (JOB_STATUS_PAPEROUT
                    | JOB_STATUS_ERROR
                    | JOB_STATUS_OFFLINE
                    | JOB_STATUS_PAUSED
                    | JOB_STATUS_USER_INTERVENTION
                    | JOB_STATUS_BLOCKED_DEVQ)
                != 0
        });

        Ok(PrinterStatusResult {
            printer_name: selected_printer,
            is_ready: status & blocking_status == 0 && !blocking_jobs,
            status,
            messages,
            jobs,
        })
    })();

    unsafe {
        ClosePrinter(handle);
    }

    result
}

#[cfg(not(windows))]
fn printer_status_impl(printer_name: String) -> Result<PrinterStatusResult, String> {
    let selected_printer = if printer_name.trim().is_empty() {
        "default printer".to_string()
    } else {
        printer_name.trim().to_string()
    };

    Ok(PrinterStatusResult {
        printer_name: selected_printer,
        is_ready: true,
        status: 0,
        messages: vec!["Printer status checks are currently supported only on Windows.".to_string()],
        jobs: Vec::new(),
    })
}

#[cfg(windows)]
fn list_printers_impl() -> Result<Vec<PrinterInfo>, String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Graphics::Printing::{
        EnumPrintersW, GetDefaultPrinterW, PRINTER_ENUM_LOCAL, PRINTER_ENUM_CONNECTIONS,
        PRINTER_INFO_4W,
    };

    fn ptr_to_string(value: *const u16) -> String {
        if value.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        unsafe {
            while *value.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(value, len))
        }
    }

    fn default_printer_name() -> String {
        let mut size = 0u32;
        unsafe {
            GetDefaultPrinterW(null_mut(), &mut size);
        }
        if size == 0 {
            return String::new();
        }

        let mut buffer = vec![0u16; size as usize];
        let ok = unsafe { GetDefaultPrinterW(buffer.as_mut_ptr(), &mut size) };
        if ok == 0 {
            return String::new();
        }

        let end = buffer.iter().position(|ch| *ch == 0).unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..end])
    }

    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut needed = 0u32;
    let mut returned = 0u32;
    unsafe {
        EnumPrintersW(flags, null_mut(), 4, null_mut(), 0, &mut needed, &mut returned);
    }
    if needed == 0 {
        return Ok(Vec::new());
    }

    let mut buffer = vec![0u8; needed as usize];
    let ok = unsafe {
        EnumPrintersW(
            flags,
            null_mut(),
            4,
            buffer.as_mut_ptr(),
            needed,
            &mut needed,
            &mut returned,
        )
    };
    if ok == 0 {
        return Err(format!("Unable to list Windows printers: {}", std::io::Error::last_os_error()));
    }

    let default_name = default_printer_name();
    let entries = buffer.as_ptr() as *const PRINTER_INFO_4W;
    let mut printers = Vec::new();
    for index in 0..returned as usize {
        let printer = unsafe { *entries.add(index) };
        let name = ptr_to_string(printer.pPrinterName);
        if name.trim().is_empty() {
            continue;
        }
        printers.push(PrinterInfo {
            is_default: !default_name.is_empty() && name == default_name,
            name,
        });
    }
    printers.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(printers)
}

#[cfg(not(windows))]
fn list_printers_impl() -> Result<Vec<PrinterInfo>, String> {
    Ok(Vec::new())
}

#[cfg(windows)]
fn print_receipt_impl(
    printer_name: String,
    contents: String,
    copies: u32,
    open_cash_drawer: bool,
    document_name: String,
    before_feed_lines: u32,
    after_feed_lines: u32,
) -> Result<PrintReceiptResult, String> {
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

    fn append_code128_barcode(bytes: &mut Vec<u8>, value: &str, append_newline: bool) {
        let barcode: String = value
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
            .collect();
        if barcode.is_empty() || barcode.len() > 64 {
            return;
        }

        bytes.extend_from_slice(&[0x1b, 0x61, 0x01]); // Center align barcode.
        bytes.extend_from_slice(&[0x1d, 0x48, 0x02]); // HRI below barcode.
        bytes.extend_from_slice(&[0x1d, 0x68, 0x50]); // Barcode height.
        bytes.extend_from_slice(&[0x1d, 0x77, 0x02]); // Barcode width.
        bytes.extend_from_slice(&[0x1d, 0x6b, 0x49, (barcode.len() + 2) as u8, b'{', b'B']);
        bytes.extend_from_slice(barcode.as_bytes());
        if append_newline {
            bytes.push(b'\n');
        }
        bytes.extend_from_slice(&[0x1b, 0x61, 0x00]); // Restore left alignment.
    }

    fn append_receipt_contents(bytes: &mut Vec<u8>, contents: &str) {
        for line in contents.split('\n') {
            let trimmed = line.trim();
            if let Some(value) = trimmed
                .strip_prefix("{{BARCODE:")
                .and_then(|value| value.strip_suffix("}}"))
            {
                append_code128_barcode(bytes, value, true);
            } else {
                bytes.extend_from_slice(line.as_bytes());
                bytes.push(b'\n');
            }
        }
    }

    fn escpos_bytes(
        contents: &str,
        open_cash_drawer: bool,
        before_feed_lines: u32,
        after_feed_lines: u32,
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&[0x1b, 0x40]); // ESC @, initialize printer.
        if open_cash_drawer {
            bytes.extend_from_slice(&[0x1b, 0x70, 0x00, 0x19, 0xfa]); // ESC p, kick drawer pin 2.
        }
        if contents.trim().is_empty() {
            return bytes;
        }
        if before_feed_lines > 0 {
            bytes.extend_from_slice(&[0x1b, 0x64, before_feed_lines as u8]); // Feed configured lines before receipt.
        }
        append_receipt_contents(&mut bytes, contents);
        let feed_lines = if after_feed_lines > 0 { after_feed_lines as u8 } else { 1 };
        bytes.extend_from_slice(&[0x1b, 0x64, feed_lines]); // Ensure receipt paper advances after the last line.
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

    let bytes = escpos_bytes(&contents, open_cash_drawer, before_feed_lines, after_feed_lines);
    let document_label = if document_name.trim().is_empty() {
        "Nexa POS Receipt".to_string()
    } else {
        document_name.trim().to_string()
    };
    let mut document_name = wide_null(&document_label);
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
        cash_drawer_opened: open_cash_drawer,
    })
}

#[cfg(not(windows))]
fn print_receipt_impl(
    printer_name: String,
    _contents: String,
    copies: u32,
    _open_cash_drawer: bool,
    _document_name: String,
    _before_feed_lines: u32,
    _after_feed_lines: u32,
) -> Result<PrintReceiptResult, String> {
    let selected_printer = if printer_name.trim().is_empty() {
        "default printer".to_string()
    } else {
        printer_name.trim().to_string()
    };

    Err(format!(
        "Raw receipt printing to {selected_printer} is currently supported only on Windows. Requested {copies} copy/copies."
    ))
}
