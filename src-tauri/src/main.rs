// Vault PW Manager — Rust kabuğu.
// Arayüz yalnız aşağıdaki dar komutları çağırabilir. Dosya erişimi kasa klasörüyle sınırlı,
// ağ çağrısı yok. Dışa/içe aktarma yalnız kullanıcının seçtiği dosyaya, sistem diyaloğuyla.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Arayüzün gördüğü sanal kök (`vault/...`); burada gerçek klasöre çevrilir.
const ROOT: &str = "vault";
/// Varsayılan kasa klasörünün adı (Belgeler altında).
const DIR_NAME: &str = "Vault PW Manager";
const CLIPBOARD_CLEAR: Duration = Duration::from_secs(30);
const MAX_IMPORT_BYTES: u64 = 50 * 1024 * 1024;

type R<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

struct Data {
    /// Kasa klasörü. Ayarlardan değişebilir; değişince arayüz yeniden yüklenir.
    dir: Mutex<PathBuf>,
    /// Varsayılan konum (Belgeler/Vault PW Manager).
    default_dir: PathBuf,
    /// Seçilen konumun yazıldığı dosya (uygulama ayar klasöründe).
    config: Option<PathBuf>,
    /// Kullanıcının sistem diyaloğunda son seçtiği klasör. `set_location` yalnız bunu kabul eder:
    /// arayüz kendi uydurduğu bir yolu kasa klasörü yapamaz.
    picked: Mutex<Option<PathBuf>>,
}

impl Data {
    fn dir(&self) -> PathBuf {
        self.dir.lock().unwrap().clone()
    }

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
        let mut out = self.dir();
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
    Info { platform: std::env::consts::OS, data: data.dir().to_string_lossy().into_owned() }
}

#[tauri::command]
async fn reveal(app: AppHandle, data: State<'_, Data>) -> R<()> {
    let dir = data.dir();
    fs::create_dir_all(&dir).map_err(err)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(err)
}

// ---------- kasa konumu (Ayarlar) ----------

#[derive(Serialize)]
struct Location {
    path: String,
    default: String,
    custom: bool,
}

#[tauri::command]
fn vault_location(data: State<'_, Data>) -> Location {
    let dir = data.dir();
    Location {
        path: dir.to_string_lossy().into_owned(),
        default: data.default_dir.to_string_lossy().into_owned(),
        custom: !same_dir(&dir, &data.default_dir),
    }
}

#[derive(Serialize)]
struct Candidate {
    path: String,
    /// Seçilen klasörde zaten bir kasa var (meta.json).
    has_vault: bool,
    /// Seçilen klasör şu anki kasa klasörü.
    same: bool,
}

/// Klasör seçtirir. Seçilen klasörde kasa yok ama içinde "Vault PW Manager" kasası varsa o alınır.
#[tauri::command]
async fn pick_location(app: AppHandle, data: State<'_, Data>) -> R<Option<Candidate>> {
    let Some(fp) = app.dialog().file().set_title("Kasa klasörünü seç").blocking_pick_folder() else {
        return Ok(None);
    };
    let mut path = fp.into_path().map_err(err)?;
    let nested = path.join(DIR_NAME);
    if !path.join("meta.json").exists() && nested.join("meta.json").exists() {
        path = nested;
    }
    // Yazılışça aynıysa "zaten burada". Bağlantı (junction) üzerinden aynı klasöre çıkan ama başka
    // yazılan bir yol seçilebilir: kasaya doğrudan o yoldan geçilir (taşıma ise set_location'da engellenir).
    let cand = Candidate {
        path: path.to_string_lossy().into_owned(),
        has_vault: path.join("meta.json").exists(),
        same: same_text(&path, &data.dir()),
    };
    *data.picked.lock().unwrap() = Some(path);
    Ok(Some(cand))
}

/// Son seçilen klasöre geçer. `switch`: oradaki kasayı açar, şu anki yerinde kalır.
/// `move`: şu anki kasayı oraya kopyalar, birebir aynı olduğunu denetler, sonra eskisini siler.
#[tauri::command]
async fn set_location(data: State<'_, Data>, mode: String) -> R<()> {
    let target = data.picked.lock().unwrap().take().ok_or("Önce bir klasör seç.")?;
    let current = data.dir();
    if same_text(&target, &current) {
        return Err("Kasa zaten bu klasörde.".into());
    }
    match mode.as_str() {
        "switch" => {
            if !target.join("meta.json").exists() {
                return Err("Bu klasörde kasa yok.".into());
            }
        }
        "move" => {
            // Bağlantı üzerinden aynı klasörse kopyalayıp silmek kasayı yok eder: kesinlikle yapma.
            if same_dir(&target, &current) {
                return Err("Seçilen klasör, bağlantı üzerinden şu anki kasanın kendisi.".into());
            }
            if target.join("meta.json").exists() {
                return Err("Bu klasörde zaten bir kasa var; taşımak yerine ona geçebilirsin.".into());
            }
            if !current.join("meta.json").exists() {
                return Err("Taşınacak bir kasa yok.".into());
            }
            move_vault(&current, &target).map_err(|e| format!("Taşınamadı: {e}"))?;
        }
        _ => return Err("bilinmeyen işlem".into()),
    }
    save_location(&data, &target).map_err(|e| format!("Konum kaydedilemedi: {e}"))?;
    *data.dir.lock().unwrap() = target;
    Ok(())
}

/// Kasa dosyaları (k-*.json, folders.json, meta.json); yarım kalmış .tmp dosyaları hariç.
fn vault_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)?
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .collect();
    // meta.json en son kopyalanır: yarıda kalırsa yeni klasör kasa gibi görünmez.
    files.sort_by_key(|p| p.file_name().map(|n| n == "meta.json").unwrap_or(false));
    Ok(files)
}

fn move_vault(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    let files = vault_files(from)?;
    for f in &files {
        let dest = to.join(f.file_name().unwrap());
        fs::copy(f, &dest)?;
        if fs::read(f)? != fs::read(&dest)? {
            return Err(io::Error::new(io::ErrorKind::Other, "kopya doğrulanamadı"));
        }
    }
    // Kopya tamam; eskiler silinir. meta.json önce: yarıda kalırsa eski klasör kasa gibi görünmez.
    for f in files.iter().rev() {
        fs::remove_file(f)?;
    }
    let _ = fs::remove_dir(from); // boşsa (ya da bağlantıysa) klasörü de kaldır
    Ok(())
}

fn save_location(data: &Data, dir: &Path) -> io::Result<()> {
    let Some(cfg) = &data.config else {
        return Err(io::Error::new(io::ErrorKind::Other, "ayar klasörü yok"));
    };
    if same_dir(dir, &data.default_dir) {
        return match fs::remove_file(cfg) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    if let Some(parent) = cfg.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(cfg, dir.to_string_lossy().as_bytes())
}

/// İki yol aynı klasör mü (bağlantılar çözülerek; çözülemezse yazılışa bakılır).
fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => same_text(a, b),
    }
}

/// Yazılışça aynı yol mu (büyük/küçük harf, ayırıcı ve sondaki ayırıcı önemsiz).
fn same_text(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vpm-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn tasima_kopyalar_dogrular_eskiyi_siler() {
        let root = temp("move");
        let from = root.join("eski");
        let to = root.join("yeni").join("Kasa");
        fs::create_dir_all(&from).unwrap();
        fs::write(from.join("meta.json"), "{\"salt\":1}").unwrap();
        fs::write(from.join("k-1.json"), "sifreli-1").unwrap();
        fs::write(from.join("folders.json"), "sifreli-f").unwrap();
        fs::write(from.join("k-2.json.123.tmp"), "yarim").unwrap();
        move_vault(&from, &to).unwrap();
        assert_eq!(fs::read_to_string(to.join("meta.json")).unwrap(), "{\"salt\":1}");
        assert_eq!(fs::read_to_string(to.join("k-1.json")).unwrap(), "sifreli-1");
        assert_eq!(fs::read_to_string(to.join("folders.json")).unwrap(), "sifreli-f");
        assert!(!to.join("k-2.json.123.tmp").exists(), "yarım dosya taşınmaz");
        assert!(!from.join("meta.json").exists() && !from.join("k-1.json").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn yol_karsilastirma() {
        assert!(same_text(Path::new("C:\\A\\Kasa\\"), Path::new("c:/a/kasa")));
        assert!(!same_text(Path::new("C:\\A\\Kasa"), Path::new("C:\\A\\Kasa2")));
        let d = temp("same");
        assert!(same_dir(&d, &d.join(".")));
        let _ = fs::remove_dir_all(&d);
    }

    /// Belgeler/Vault PW Manager başka bir klasöre bağlantıysa (junction) ikisi aynı klasör sayılmalı:
    /// yoksa "taşı" dosyaları kendi üzerine kopyalayıp silerdi.
    #[cfg(windows)]
    #[test]
    fn baglanti_ayni_klasor_sayilir() {
        let root = temp("junction");
        let real = root.join("gercek");
        let link = root.join("baglanti");
        fs::create_dir_all(&real).unwrap();
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "junction oluşturulamadı");
        assert!(same_dir(&link, &real));
        assert!(!same_text(&link, &real));
        let _ = fs::remove_dir(&link);
        let _ = fs::remove_dir_all(&root);
    }
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
        .add_filter("Parola dışa aktarımı ya da yedek", &["json", "csv", "vpmbackup"])
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

/// Kasa klasörü: Ayarlar'dan seçilen konum (location.txt) ya da Belgeler/Vault PW Manager.
fn data_dir(app: &tauri::App) -> Data {
    let docs = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Documents")))
        .expect("Belgeler klasörü bulunamadı");
    let default_dir = docs.join(DIR_NAME);
    let config = app.path().app_config_dir().ok().map(|d| d.join("location.txt"));
    let new = |dir: PathBuf, config: Option<PathBuf>| Data { dir: Mutex::new(dir), default_dir: default_dir.clone(), config, picked: Mutex::new(None) };
    if cfg!(debug_assertions) {
        if let Ok(d) = std::env::var("VPM_DATA") {
            return new(d.into(), None); // test: gerçek kasaya ve ayara dokunma
        }
    }
    let chosen = config
        .as_ref()
        .and_then(|c| fs::read_to_string(c).ok())
        .map(|s| PathBuf::from(s.trim()))
        .filter(|p| p.is_absolute());
    let dir = chosen.unwrap_or_else(|| {
        migrate(&docs, &default_dir);
        default_dir.clone()
    });
    new(dir, config)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fs_exists, fs_read, fs_read_many, fs_write, fs_remove, fs_mkdir, fs_list, fs_scan, fs_stat,
            app_info, reveal, open_link, copy_text, export_file, pick_import,
            vault_location, pick_location, set_location
        ])
        .setup(|app| {
            let data = data_dir(app);
            fs::create_dir_all(data.dir())?;
            app.manage(data);

            #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
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
