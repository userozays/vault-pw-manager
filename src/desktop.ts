import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Vault, type FileAdapter } from "./store";
import { VaultApp, type ThemeMode } from "./ui/app";

// Masaüstü: dosya, pano ve diyaloglar Rust kabuğundaki dar komutlardan geçer.
const fs: FileAdapter = {
  exists: (path) => invoke("fs_exists", { path }),
  read: (path) => invoke("fs_read", { path }),
  readMany: (paths) => invoke("fs_read_many", { paths }),
  write: (path, data) => invoke("fs_write", { path, contents: data }),
  remove: (path) => invoke("fs_remove", { path }),
  mkdir: (path) => invoke("fs_mkdir", { path }),
  list: (path) => invoke("fs_list", { path }),
  scan: (path) => invoke("fs_scan", { path }),
  stat: (path) => invoke("fs_stat", { path }),
};

// Gövde rengi ve pencere teması, uygulamadaki tema ayarını izler ("Sistem" ise bilgisayarı).
const systemLight = matchMedia("(prefers-color-scheme: light)");
let themeMode: ThemeMode = "system";
const paint = () => document.body.classList.toggle("theme-light", themeMode === "light" || (themeMode === "system" && systemLight.matches));
systemLight.addEventListener("change", paint);
paint();

(async () => {
  const info = await invoke<{ platform: string; data: string }>("app_info");
  document.body.classList.add("pw-desktop", `pw-${info.platform}`);
  const app = new VaultApp(document.getElementById("host")!, new Vault(fs), {
    globalKeys: true,
    copy: (text, secret) => invoke("copy_text", { text, secret }),
    saveFile: (name, text) => invoke("export_file", { name, contents: text }),
    pickFile: () => invoke("pick_import"),
    openUrl: (url) => void invoke("open_link", { url }),
    reveal: () => void invoke("reveal"),
    onReady: () => void getCurrentWindow().show(),
    onTheme: (mode) => {
      themeMode = mode;
      paint();
      void getCurrentWindow().setTheme(mode === "system" ? null : mode).catch(() => {});
    },
  });
  await app.start();
})();
