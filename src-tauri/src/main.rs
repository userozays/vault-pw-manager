// Vault PW Manager — Rust kabuğu.
// Arayüz yalnız aşağıdaki dar komutları çağırabilir. Dosya erişimi kasa klasörüyle sınırlı,
// ağ çağrısı yok. Dışa/içe aktarma yalnız kullanıcının seçtiği dosyaya, sistem diyaloğuyla.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Arayüzün gördüğü sanal kök (`vault/...`); burada gerçek klasöre çevrilir.
const ROOT: &str = "vault";
const CLIPBOARD_CLEAR: Duration = Duration::from_secs(30);
const MAX_IMPORT_BYTES: u64 = 50 * 1024 * 1024;

type R<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

struct Data {
    dir: PathBuf,
}

impl Data {
    /// `vault/...` göreli yolunu kasa klasörü içindeki mutlak yola çevirir; dışarı çıkan her yolu reddeder.
    fn resolve(&self, rel: &str) -> R<PathBuf> {
        let norm = rel.replace('\\', "/");
        let rest = if norm == ROOT {
            ""
        } else if let Some(r) = norm.strip_prefix("vault/") {
            r
        } else {
            return Err("izin verilmeyen yol".into());
        };
        let mut out = self.dir.clone();
        for part in rest.split('/') {
            match part {
                "" | "." => {}
                ".." => return Err("izin verilmeyen yol".into()),
                p if p.contains(':') || p.contains('\0') => return Err("izin verilmeyen yol".into()),
                p => out.push(p),
            }
        }
        Ok(out)
    }
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

// ---------- dosya işlemleri (yalnız kasa klasörü) ----------

#[derive(Serialize)]
struct Listing {
    files: Vec<String>,
    folders: Vec<String>,
}

#[derive(Serialize)]
struct Stat {
    mtime: f64,
}

#[derive(Serialize)]
struct ScanItem {
    path: String,
    mtime: f64,
}

#[tauri::command]
async fn fs_exists(data: State<'_, Data>, path: String) -> R<bool> {
    Ok(data.resolve(&path)?.exists())
}

#[tauri::command]
async fn fs_read(data: State<'_, Data>, path: String) -> R<String> {
    fs::read_to_string(data.resolve(&path)?).map_err(err)
}

/// Birden çok dosyayı tek çağrıda okur (kilit açılışında yüzlerce IPC turunu önler).
#[tauri::command]
async fn fs_read_many(data: State<'_, Data>, paths: Vec<String>) -> R<Vec<Option<String>>> {
    paths
        .iter()
        .map(|p| Ok(fs::read_to_string(data.resolve(p)?).ok()))
        .collect()
}

#[tauri::command]
async fn fs_write(data: State<'_, Data>, path: String, contents: String) -> R<()> {
    let abs = data.resolve(&path)?;
    let mut tmp = abs.clone().into_os_string();
    tmp.push(format!(".{}.tmp", std::process::id()));
    let tmp = PathBuf::from(tmp);
    {
        let mut f = fs::File::create(&tmp).map_err(err)?;
        f.write_all(contents.as_bytes()).map_err(err)?;
        f.sync_all().map_err(err)?;
    }
    fs::rename(&tmp, &abs).map_err(err) // yarım yazılmış dosya kalmaz
}

#[tauri::command]
async fn fs_remove(data: State<'_, Data>, path: String) -> R<()> {
    match fs::remove_file(data.resolve(&path)?) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}

#[tauri::command]
async fn fs_mkdir(data: State<'_, Data>, path: String) -> R<()> {
    fs::create_dir_all(data.resolve(&path)?).map_err(err)
}

#[tauri::command]
async fn fs_list(data: State<'_, Data>, path: String) -> R<Listing> {
    let abs = data.resolve(&path)?;
    let base = path.replace('\\', "/");
    let mut out = Listing { files: vec![], folders: vec![] };
    for entry in fs::read_dir(abs).map_err(err)? {
        let entry = entry.map_err(err)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = entry.file_type().map_err(err)?;
        if kind.is_dir() {
            out.folders.push(format!("{base}/{name}"));
        } else if kind.is_file() && !name.ends_with(".tmp") {
            out.files.push(format!("{base}/{name}"));
        }
    }
    Ok(out)
}

/// Klasördeki dosyaları değişiklik zamanlarıyla tek çağrıda döner.
#[tauri::command]
async fn fs_scan(data: State<'_, Data>, path: String) -> R<Vec<ScanItem>> {
    let abs = data.resolve(&path)?;
    let base = path.replace('\\', "/");
    let mut out = vec![];
    let entries = match fs::read_dir(abs) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(err(e)),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".tmp") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                out.push(ScanItem { path: format!("{base}/{name}"), mtime: mtime_ms(&meta) });
            }
        }
    }
    Ok(out)
}

#[tauri::command]
async fn fs_stat(data: State<'_, Data>, path: String) -> R<Option<Stat>> {
    Ok(fs::metadata(data.resolve(&path)?).ok().map(|m| Stat { mtime: mtime_ms(&m) }))
}

// ---------- uygulama ----------

#[derive(Serialize)]
struct Info {
    platform: &'static str,
    data: String,
}

#[tauri::command]
fn app_info(data: State<'_, Data>) -> Info {
    Info { platform: std::env::consts::OS, data: data.dir.to_string_lossy().into_owned() }
}

#[tauri::command]
async fn reveal(app: AppHandle, data: State<'_, Data>) -> R<()> {
    fs::create_dir_all(&data.dir).map_err(err)?;
    app.opener()
        .open_path(data.dir.to_string_lossy(), None::<&str>)
        .map_err(err)
}

/// Yalnız http(s) bağlantıları varsayılan tarayıcıda açılır.
#[tauri::command]
fn open_link(app: AppHandle, url: String) -> R<()> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("yalnız http(s) bağlantıları açılabilir".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

/// Panoya yazar. Gizli değerler 30 sn sonra, pano hâlâ aynı değeri tutuyorsa silinir.
#[tauri::command]
async fn copy_text(text: String, secret: bool) -> R<()> {
    arboard::Clipboard::new().and_then(|mut c| c.set_text(text.clone())).map_err(err)?;
    if secret {
        std::thread::spawn(move || {
            std::thread::sleep(CLIPBOARD_CLEAR);
            if let Ok(mut c) = arboard::Clipboard::new() {
                if c.get_text().map(|t| t == text).unwrap_or(false) {
                    let _ = c.clear();
                }
            }
        });
    }
    Ok(())
}

/// Dışa aktarımı kullanıcının seçtiği yere yazar. Vazgeçilirse false.
#[tauri::command]
async fn export_file(app: AppHandle, name: String, contents: String) -> R<bool> {
    let ext = Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("txt")
        .to_string();
    let picked = app
        .dialog()
        .file()
        .set_file_name(&name)
        .add_filter(ext.to_uppercase(), &[ext.as_str()])
        .blocking_save_file();
    let Some(fp) = picked else { return Ok(false) };
    fs::write(fp.into_path().map_err(err)?, contents).map_err(err)?;
    Ok(true)
}

#[derive(Serialize)]
struct Picked {
    name: String,
    text: String,
}

/// İçe aktarılacak dosyayı sistem diyaloğuyla seçtirir ve okur.
#[tauri::command]
async fn pick_import(app: AppHandle) -> R<Option<Picked>> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Parola dışa aktarımı", &["json", "csv"])
        .blocking_pick_file();
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(err)?;
    if fs::metadata(&path).map_err(err)?.len() > MAX_IMPORT_BYTES {
        return Err("Dosya çok büyük.".into());
    }
    let text = String::from_utf8_lossy(&fs::read(&path).map_err(err)?).into_owned();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Some(Picked { name, text }))
}

// ---------- kasa konumu ----------

fn copy_flat(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    let mut files: Vec<_> = fs::read_dir(from)?
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .collect();
    // meta.json en son: kopya yarıda kalırsa yeni kasa "var" görünmez, bir sonraki açılışta tekrar denenir.
    files.sort_by_key(|e| e.file_name() == "meta.json");
    for e in files {
        fs::copy(e.path(), to.join(e.file_name()))?;
    }
    Ok(())
}

/// Eski Ōkami Kasa kayıtları varsa yeni klasöre kopyalanır (eskiler silinmez).
fn migrate(docs: &Path, dir: &Path) {
    if dir.join("meta.json").exists() {
        return;
    }
    let old = [
        docs.join("Okami Kasa").join("Kasa"),
        docs.join("Ōkami").join("vault").join(".okami").join("kasa"),
    ];
    if let Some(src) = old.iter().find(|p| p.join("meta.json").exists()) {
        let _ = copy_flat(src, dir);
    }
}

fn data_dir(app: &tauri::App) -> PathBuf {
    if cfg!(debug_assertions) {
        if let Ok(d) = std::env::var("VPM_DATA") {
            return d.into(); // test: gerçek kasaya dokunma
        }
    }
    let docs = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Documents")))
        .expect("Belgeler klasörü bulunamadı");
    let dir = docs.join("Vault PW Manager");
    migrate(&docs, &dir);
    dir
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fs_exists, fs_read, fs_read_many, fs_write, fs_remove, fs_mkdir, fs_list, fs_scan, fs_stat,
            app_info, reveal, open_link, copy_text, export_file, pick_import
        ])
        .setup(|app| {
            let dir = data_dir(app);
            fs::create_dir_all(&dir)?;
            app.manage(Data { dir });

            let mut win = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Vault PW Manager")
                .inner_size(1080.0, 700.0)
                .min_inner_size(720.0, 480.0)
                .visible(false) // arayüz ilk karesini çizince kendisi gösterir; beyaz parlama olmaz
                .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"));
            #[cfg(target_os = "macos")]
            {
                win = win
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(18.0, 22.0));
            }
            let win = win.build()?;
            // Yalnız geliştirme derlemesi: uçtan uca test betiği çalıştırılabilir (sürüm derlemesinde yok).
            #[cfg(debug_assertions)]
            if let Ok(script) = std::env::var("VPM_TEST_JS") {
                let w = win.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1200));
                    let _ = w.eval(&script);
                });
            }
            // Yedek: arayüz bir sebeple kendini göstermezse.
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500));
                let _ = win.show();
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("uygulama başlatılamadı");
}
