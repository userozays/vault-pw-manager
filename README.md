# Vault PW Manager

Yerel, şifreli parola yöneticisi. Parolalar bilgisayardan çıkmaz; istediğin zaman içe ve dışa aktarabilirsin.
Masaüstü uygulaması Tauri (Rust kabuk + sistem web görünümü) ile çalışır: Mac ve Windows.

## Güvenlik modeli
- Ana parola → PBKDF2-SHA256 (600.000 tur) → AES-256-GCM anahtarı. Anahtar dışa aktarılamaz, yalnız bellekte durur.
- Her kayıt ayrı dosya (`k-<uuid>.json`); ad dahil her alan şifreli, kayıt kimliği ek doğrulanmış veri olarak bağlı.
- Arayüz diske yalnız Rust kabuğundaki dar komutlarla erişir; yollar kasa klasörünün dışına çıkamaz. CSP dış kaynakları engeller, ağ çağrısı yok.
- İşlem yapılmazsa otomatik kilit: varsayılan 15 sn, **Ayarlar**'dan 1, 5 ya da 15 dk seçilebilir. Pencere uykudan dönünce de denetlenir; kilitlenince açık bilgiler DOM'dan silinir.
- Kopyalanan gizli değer 30 sn sonra panodan silinir (pano hâlâ aynı değeri tutuyorsa).

## Veri konumu
`Belgeler/Vault PW Manager/` — yalnız o bilgisayarda. Sol alttaki **Klasörü göster** ile açılır.
İlk açılışta eski Ōkami Kasa kayıtları (`Belgeler/Okami Kasa/Kasa`) varsa buraya **kopyalanır**; eskiler silinmez.

## İçe / dışa aktarma
- **İçe:** Bitwarden (.json), Chrome, Edge, Brave, Safari, Firefox, 1Password, LastPass, KeePass (.csv). Zaten olan kayıtlar atlanır.
- **Dışa:** Bitwarden JSON (her şey) veya CSV (yalnız girişler). Dosya, sistemin kaydet penceresiyle seçtiğin yere yazılır.

## Ayarlar
Sol alttaki **Ayarlar**: görünüm (Sistem / Açık / Koyu) ve otomatik kilit süresi (15 sn / 1 dk / 5 dk / 15 dk). Ayarlar bu bilgisayarda saklanır.

## Kısayollar
`⌘F` ara · `⌘N` yeni kayıt · `⌘S` kaydet · `⌘L` kilitle · `↑ ↓` listede gez · `Esc` vazgeç / aramayı temizle
(Windows'ta `⌘` yerine `Ctrl`.)

## Geliştirme
Gerekenler: Node 20+, Rust (`rustup`), macOS'ta Xcode komut satırı araçları.
```sh
npm install
npm test              # şifreleme, depolama, içe/dışa aktarma testleri
npm run dev           # masaüstü uygulaması, geliştirme modu
npm run preview       # tarayıcı önizlemesi: preview/index.html (?state=lock|setup, &theme=light)
```
Geliştirme modunda gerçek kasaya dokunmamak için: `VPM_DATA=/tmp/deneme-kasa npm run dev`.

## Derleme
```sh
npm run dist   # Mac: src-tauri/target/release/bundle/{macos/*.app,dmg/*.dmg}
```
- Windows kurulum dosyası (`.exe`, NSIS) Windows'ta `npm run dist` ile derlenir.
- Mac: `signingIdentity: "-"` → ad-hoc imza. İnternetten indirilen kopyada ilk açılışta sağ tık → Aç gerekir.
