import { Vault, blankEntry, type FileAdapter } from "../src/store";
import { VaultApp } from "../src/ui/app";

class MemFs implements FileAdapter {
  files = new Map<string, { data: string; mtime: number }>();
  dirs = new Set<string>();
  t = 0;
  async exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
  async read(p: string) { return this.files.get(p)!.data; }
  async write(p: string, data: string) { this.files.set(p, { data, mtime: ++this.t }); }
  async remove(p: string) { this.files.delete(p); }
  async mkdir(p: string) { this.dirs.add(p); }
  async list(p: string) { return { files: [...this.files.keys()].filter((k) => k.startsWith(p + "/")), folders: [] }; }
  async stat(p: string) { const f = this.files.get(p); return f ? { mtime: f.mtime } : null; }
}

const q = new URLSearchParams(location.search);
if (q.get("theme") === "light") document.body.classList.add("theme-light");
const host = document.getElementById("host")!;
const vault = new Vault(new MemFs());

const demo: [string, string, string, string, string, boolean][] = [
  ["Gmail", "Gmail", "accounts.google.com", "ornek.kisi@gmail.com", "kD8#qL2m!vR7xZ", true],
  ["GitHub", "Diğer", "github.com", "ornekkisi", "Tq9$Wm4@pN8s", false],
  ["Garanti BBVA", "Banka", "garantibbva.com.tr", "", "4n!Kp2Lx", false],
  ["e-Devlet", "EDevlet", "turkiye.gov.tr", "", "Xv7&Rt3Qw", false],
  ["iCloud", "ICloud", "icloud.com", "ornek@icloud.com", "Mb5*Hy8Jk2", true],
  ["Microsoft 365", "Microsoft", "login.microsoftonline.com", "ornek@sirket.com", "Pz4!Vn9Gc", false],
  ["AnyDesk", "Anydesk", "anydesk.com", "ofis-pc", "Lq3$Bw7Ys", false],
  ["Spotify", "Diğer", "spotify.com", "ornek.kisi@gmail.com", "Rt6&Nm2Kx", false],
];

(async () => {
  const mode = q.get("state") ?? "app";
  if (mode !== "setup") {
    await vault.create("örnek ana parola cümlesi");
    for (const [name, folder, url, user, pw, fav] of demo) {
      const e = blankEntry("login");
      Object.assign(e, { name, folder, url, username: user, password: pw, favorite: fav });
      await vault.save(e);
    }
    const n = blankEntry("note"); Object.assign(n, { name: "Wi-Fi ev", folder: "Diğer", notes: "Ağ: ORNEK_AG\nParola: ornek-parola" }); await vault.save(n);
    const c = blankEntry("card"); Object.assign(c, { name: "Kredi kartı", folder: "Kredi Kartları", card: { holder: "ÖRNEK KİŞİ", number: "4111111111111111", expiry: "08/29", cvv: "123" } }); await vault.save(c);
    if (mode === "lock") vault.lock();
  }
  const app = new VaultApp(host, vault, { globalKeys: true });
  (window as any).vaultApp = app;
  await app.start();
  if (q.get("select")) {
    setTimeout(() => (document.querySelectorAll<HTMLElement>(".pw-row")[Number(q.get("select")) - 1])?.click(), 200);
    if (q.get("reveal")) setTimeout(() => (document.querySelector<HTMLElement>(".pw-field .pw-icon-btn[title='Göster']"))?.click(), 500);
  }
  if (q.get("try")) {
    // önce yanlış, sonra doğru parola
    const type = (v: string) => {
      const i = document.querySelector<HTMLInputElement>(".pw-lock-input")!;
      i.value = v;
      i.form!.requestSubmit();
    };
    setTimeout(() => type("yanlis"), 900);
    setTimeout(() => type("örnek ana parola cümlesi"), Number(q.get("try")));
  }
  if (q.get("new")) setTimeout(() => (document.querySelector<HTMLElement>(".pw-add"))?.click(), 200);
})();
