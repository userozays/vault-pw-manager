import { generatePassword, strength, type GenOptions } from "../crypto";
import { parseImport, toBitwardenJson, toCsv } from "../importers";
import { BACKUP_EXT, Vault, blankEntry, parseBackup, sameEntry, type Backup, type Entry, type EntryType } from "../store";
import { decode, move, reduced, shake, spring, stagger } from "./motion";

export const APP_NAME = "Vault PW Manager";

/** Arayüzün çalıştığı ortamın sağladıkları. Verilmeyenler için tarayıcı API'leri kullanılır. */
export interface Host {
  /** Panoya yazar; `secret` ise 30 sn sonra (pano hâlâ aynıysa) siler. */
  copy?(text: string, secret: boolean): Promise<void>;
  /** Dışa aktarımı kaydeder. Vazgeçilirse false. */
  saveFile?(name: string, text: string, mime: string): Promise<boolean>;
  /** İçe aktarılacak dosyayı seçtirir. Vazgeçilirse null. */
  pickFile?(): Promise<{ name: string; text: string } | null>;
  openUrl?(url: string): void;
  /** Kasa klasörünü dosya yöneticisinde açar (yalnız masaüstü). */
  reveal?(): void;
  /** Kısayollar tüm pencerede mi geçerli (masaüstü) yoksa yalnız arayüz odaktayken mi. */
  globalKeys?: boolean;
  onReady?(): void;
  onLock?(): void;
  onUnlock?(): void;
  /** Tema ayarı değişince (masaüstü: pencere ve gövde de uyar). */
  onTheme?(mode: ThemeMode): void;
}

// ---------- küçük DOM yardımcıları ----------

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | number | EventListener | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

function svg(markup: string): SVGSVGElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = markup.trim();
  return tpl.content.firstElementChild as SVGSVGElement;
}

const ICONS = {
  copy: `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg>`,
  check: `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7"/></svg>`,
  eye: `<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24"><path d="M3.5 3.5l17 17"/><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.8M6.4 6.9C3.9 8.6 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 4-.9"/><path d="M10 10a2.8 2.8 0 0 0 4 4"/></svg>`,
  plus: `<svg viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></svg>`,
  lock: `<svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7"/></svg>`,
  star: `<svg viewBox="0 0 24 24"><path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/></svg>`,
  dice: `<svg viewBox="0 0 24 24"><path d="M20 11.5A8 8 0 1 0 17.7 17"/><path d="M20.5 6.5v5h-5"/></svg>`,
  upload: `<svg viewBox="0 0 24 24"><path d="M12 15V4.5M7.5 9L12 4.5 16.5 9"/><path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15"/></svg>`,
  download: `<svg viewBox="0 0 24 24"><path d="M12 4.5V15M7.5 10.5L12 15l4.5-4.5"/><path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15"/></svg>`,
  back: `<svg viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6"/></svg>`,
  link: `<svg viewBox="0 0 24 24"><path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M17 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V8.5A1.5 1.5 0 0 1 6.5 7H11"/></svg>`,
  search: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M19.5 19.5l-4-4"/></svg>`,
  edit: `<svg viewBox="0 0 24 24"><path d="M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10z"/><path d="M13.5 6.5l4 4"/></svg>`,
  trash: `<svg viewBox="0 0 24 24"><path d="M4.5 7h15M10 7V5h4v2M6.5 7l.8 11.2A1.5 1.5 0 0 0 8.8 19.5h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7"/></svg>`,
  folder: `<svg viewBox="0 0 24 24"><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/></svg>`,
  all: `<svg viewBox="0 0 24 24"><rect x="4.5" y="4.5" width="6" height="6" rx="1.5"/><rect x="13.5" y="4.5" width="6" height="6" rx="1.5"/><rect x="4.5" y="13.5" width="6" height="6" rx="1.5"/><rect x="13.5" y="13.5" width="6" height="6" rx="1.5"/></svg>`,
  open: `<svg viewBox="0 0 24 24"><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v1"/><path d="M3.5 7.5v10A1.5 1.5 0 0 0 5 19h12.6a1.5 1.5 0 0 0 1.4-1l2-6a1 1 0 0 0-1-1.3H8.3a1.5 1.5 0 0 0-1.4 1L4 19"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  sliders: `<svg viewBox="0 0 24 24"><path d="M4.5 7.5h9M18.5 7.5h1M4.5 16.5h3M11.5 16.5h8"/><circle cx="16" cy="7.5" r="2.2"/><circle cx="9.5" cy="16.5" r="2.2"/></svg>`,
} as const;
const icon = (name: keyof typeof ICONS) => svg(ICONS[name]);

/** Kilit simgesi: halka (shackle) ayrı çizilir, açılırken yukarı kalkar. */
function lockGlyph(): SVGSVGElement {
  return svg(`
    <svg class="pw-glyph" viewBox="0 0 48 48" aria-hidden="true">
      <path class="pw-glyph-shackle" d="M16 22v-6.5a8 8 0 0 1 16 0V22"/>
      <rect class="pw-glyph-body" x="9.5" y="21" width="29" height="21" rx="6.5"/>
      <circle class="pw-glyph-hole" cx="24" cy="30" r="2.6"/>
      <rect class="pw-glyph-hole" x="22.8" y="30.5" width="2.4" height="5.5" rx="1.2"/>
    </svg>`);
}

function hueOf(text: string): number {
  let x = 0;
  for (const ch of text) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return [12, 28, 42, 150, 188, 210, 232, 265, 300, 335][x % 10];
}

function hostOf(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const initial = (e: Entry) => (e.name.trim()[0] ?? "?").toUpperCase();
const avatar = (e: Entry, cls = "") => h("span", { class: `pw-avatar ${cls}`, style: `--h:${hueOf(e.name)}` }, initial(e));

const TYPE_LABEL: Record<EntryType, string> = { login: "Giriş", note: "Güvenli not", card: "Kart" };
const CLIPBOARD_MS = 30 * 1000;

// ---------- ayarlar (gizli değil; kilit ekranında da gerektiği için şifresiz saklanır) ----------

export type ThemeMode = "system" | "light" | "dark";
interface Settings {
  theme: ThemeMode;
  lockMs: number;
  /** Son şifreli yedeğin zamanı (ISO). */
  lastBackup: string | null;
}
const THEMES: readonly (readonly [ThemeMode, string])[] = [
  ["system", "Sistem"],
  ["light", "Açık"],
  ["dark", "Koyu"],
];
const LOCK_CHOICES: readonly (readonly [number, string])[] = [
  [15_000, "15 sn"],
  [60_000, "1 dk"],
  [300_000, "5 dk"],
  [900_000, "15 dk"],
];
const SETTINGS_KEY = "vault-pw-manager.settings";
const DEFAULT_SETTINGS: Settings = { theme: "system", lockMs: 15_000, lastBackup: null };

function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>;
    return {
      theme: THEMES.some(([t]) => t === s.theme) ? s.theme! : DEFAULT_SETTINGS.theme,
      lockMs: LOCK_CHOICES.some(([ms]) => ms === s.lockMs) ? s.lockMs! : DEFAULT_SETTINGS.lockMs,
      lastBackup: typeof s.lastBackup === "string" && !isNaN(Date.parse(s.lastBackup)) ? s.lastBackup : null,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* depolama kapalıysa ayar yalnız bu oturumda geçerli */
  }
}
const STRENGTH = ["Çok zayıf", "Zayıf", "İdare eder", "Güçlü", "Çok güçlü"];

// ---------- tarayıcı varsayılanları (önizleme) ----------

const browserHost: Required<Pick<Host, "copy" | "saveFile" | "pickFile" | "openUrl">> = {
  async copy(text, secret) {
    await navigator.clipboard.writeText(text);
    if (!secret) return;
    window.setTimeout(async () => {
      try {
        if ((await navigator.clipboard.readText()) === text) await navigator.clipboard.writeText("");
      } catch {
        /* okuma izni yoksa sessizce geç */
      }
    }, CLIPBOARD_MS);
  },
  async saveFile(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    h("a", { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  },
  pickFile() {
    return new Promise((resolve) => {
      const input = h("input", { type: "file", accept: `.json,.csv,.${BACKUP_EXT},application/json,text/csv` }) as HTMLInputElement;
      input.addEventListener("change", async () => {
        const f = input.files?.[0];
        resolve(f ? { name: f.name, text: await f.text() } : null);
      });
      input.addEventListener("cancel", () => resolve(null));
      input.click();
    });
  },
  openUrl(url) {
    window.open(url, "_blank", "noopener,noreferrer");
  },
};

// ---------- uygulama ----------

type View = { mode: "empty" } | { mode: "show"; id: string } | { mode: "edit"; draft: Entry; isNew: boolean };

export class VaultApp {
  private root: HTMLElement;
  private stage: HTMLElement;
  private toasts: HTMLElement;
  private io: Host & typeof browserHost;
  private filter: { folder: string | null; favorites: boolean; query: string } = { folder: null, favorites: false, query: "" };
  private view: View = { mode: "empty" };
  private gen: GenOptions = { length: 20, upper: true, digits: true, symbols: true };
  private settings = loadSettings();
  private lastActive = Date.now();
  private lastRefresh = 0;
  private ticker = 0;
  private locking = false;
  private dirty = false;
  private warnedUnreadable = false;
  private cleanup: (() => void)[] = [];
  private els: {
    app?: HTMLElement;
    nav?: HTMLElement;
    navPill?: HTMLElement;
    brandCount?: HTMLElement;
    list?: HTMLElement;
    listPill?: HTMLElement;
    detail?: HTMLElement;
    search?: HTMLInputElement;
    form?: HTMLFormElement;
  } = {};

  constructor(
    mount: HTMLElement,
    private vault: Vault,
    host: Host = {},
  ) {
    this.io = { ...browserHost, ...host };
    this.stage = h("div", { class: "pw-stage" });
    this.toasts = h("div", { class: "pw-toasts", "aria-live": "polite" });
    this.root = h("div", { class: "pw-root" }, this.stage, this.toasts);
    mount.replaceChildren(this.root);
    this.applyTheme(false);

    // Kısa kilit sürelerinde (15 sn) fareyi oynatmak ve kaydırmak da işlem sayılır.
    const activity = () => (this.lastActive = Date.now());
    const keys = (e: Event) => this.onKey(e as KeyboardEvent);
    const wake = () => this.wake();
    const keyTarget: EventTarget = host.globalKeys ? document : this.root;
    for (const ev of ["pointerdown", "pointermove", "keydown", "wheel"]) this.root.addEventListener(ev, activity, { capture: true, passive: true });
    keyTarget.addEventListener("keydown", keys);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    this.cleanup.push(() => {
      keyTarget.removeEventListener("keydown", keys);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    });
  }

  async start(): Promise<void> {
    if (this.vault.unlocked) this.showApp(false);
    else await this.showLock((await this.vault.isInitialized()) ? "unlock" : "setup", "enter");
    setTimeout(() => this.io.onReady?.(), 0);
  }

  destroy(): void {
    clearInterval(this.ticker);
    for (const fn of this.cleanup) fn();
    this.root.remove();
  }

  /** Dışarıdan (komut, başka bir sekme) kilitlendiğinde. */
  async lockedExternally(): Promise<void> {
    if (this.els.app?.isConnected) await this.coverWithLock();
  }

  async lock(): Promise<void> {
    if (this.locking || !this.vault.unlocked) return;
    this.locking = true;
    this.vault.lock();
    this.io.onLock?.();
    try {
      await this.coverWithLock();
    } finally {
      this.locking = false;
    }
  }

  // ---------- kilit ekranı ----------

  /**
   * enter: ilk açılış girişi · cover: açık uygulamanın üstüne kapanır, sonra uygulama DOM'dan silinir.
   */
  private async showLock(kind: "setup" | "unlock", mode: "enter" | "cover"): Promise<void> {
    if (mode === "enter") this.stage.replaceChildren();
    const glyph = lockGlyph();
    const shackle = glyph.querySelector(".pw-glyph-shackle")!;
    // Göster/gizle: bir alandaki göz düğmesi tüm parola alanlarını birlikte açar ya da kapatır.
    const inputs: HTMLInputElement[] = [];
    const eyes: HTMLButtonElement[] = [];
    let shown = false;
    const toggleShown = () => {
      shown = !shown;
      for (const i of inputs) i.type = shown ? "text" : "password";
      for (const e of eyes) {
        e.replaceChildren(icon(shown ? "eyeOff" : "eye"));
        e.title = shown ? "Parolayı gizle" : "Parolayı göster";
        e.setAttribute("aria-label", e.title);
        e.setAttribute("aria-pressed", String(shown));
        move(e.firstElementChild!, { scale: [0.7, 1], opacity: [0.4, 1] }, spring(0.3, 0.3));
      }
    };
    const field = (placeholder: string, submit: boolean) => {
      const input = h("input", { class: "pw-lock-input", type: "password", placeholder, autocomplete: "off", spellcheck: "false", "aria-label": placeholder }) as HTMLInputElement;
      const eye = h("button", { class: "pw-lock-eye", type: "button", title: "Parolayı göster", "aria-label": "Parolayı göster", "aria-pressed": "false" }, icon("eye"));
      eye.addEventListener("pointerdown", (ev) => ev.preventDefault()); // imleç alanda kalsın
      eye.addEventListener("click", () => {
        toggleShown();
        input.focus();
      });
      inputs.push(input);
      eyes.push(eye);
      const go = submit ? h("button", { class: "pw-lock-go", type: "submit", "aria-label": kind === "setup" ? "Kasayı oluştur" : "Kilidi aç" }, icon("arrow")) : null;
      return { input, go, wrap: h("div", { class: `pw-lock-field${go ? "" : " no-go"}` }, input, eye, go) };
    };
    const pw = field("Ana parola", kind === "unlock");
    const pw2 = kind === "setup" ? field("Ana parola (tekrar)", true) : null;
    const go = (pw2 ?? pw).go!;
    const meter = h("div", { class: "pw-meter" }, h("i"), h("i"), h("i"), h("i"));
    const meterLabel = h("span", { class: "pw-meter-label" });
    const msg = h("div", { class: "pw-lock-msg", role: "alert" });

    const form = h(
      "form",
      { class: "pw-lock-form", autocomplete: "off" },
      pw.wrap,
      pw2?.wrap,
      pw2 ? h("div", { class: "pw-meter-row" }, meter, meterLabel) : null,
      msg,
    );
    const lockEl = h(
      "section",
      { class: "pw-lock", "data-tauri-drag-region": true },
      h(
        "div",
        { class: "pw-lock-inner" },
        glyph,
        h("h1", { class: "pw-lock-title" }, kind === "setup" ? "Kasanı oluştur" : APP_NAME),
        h("p", { class: "pw-lock-sub" }, kind === "setup" ? "Kayıtların bu parolayla, yalnız bu bilgisayarda şifrelenir. Parola hiçbir yerde saklanmaz; unutursan kurtarılamaz." : "Kilitli"),
        form,
      ),
    );

    if (kind === "setup") {
      pw.input.addEventListener("input", () => {
        const { score } = strength(pw.input.value);
        meter.dataset.score = pw.input.value ? String(score) : "";
        meterLabel.textContent = pw.input.value ? STRENGTH[score] : "";
      });
    }

    const busy = (on: boolean) => {
      go.disabled = on;
      go.classList.toggle("is-busy", on);
    };

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      msg.textContent = "";
      if (!pw.input.value) return void shake(form);
      if (kind === "setup") {
        if (strength(pw.input.value).score < 2) {
          msg.textContent = "Daha uzun bir parola seç; birkaç kelimelik bir cümle iyi olur.";
          return void shake(form);
        }
        if (pw.input.value !== pw2!.input.value) {
          msg.textContent = "İki parola aynı değil.";
          return void shake(form);
        }
      }
      busy(true);
      try {
        const ok = kind === "setup" ? (await this.vault.create(pw.input.value), true) : await this.vault.unlock(pw.input.value);
        if (!ok) {
          busy(false);
          msg.textContent = "Parola yanlış.";
          pw.input.select();
          await Promise.all([shake(form), move(glyph, { rotate: [0, -8, 6, -3, 0] }, { duration: 0.45 })]);
          return;
        }
        pw.input.value = "";
        if (pw2) pw2.input.value = "";
        await this.revealApp(lockEl, shackle);
      } catch (err) {
        busy(false);
        msg.textContent = `Bir sorun oldu: ${(err as Error).message}`;
      }
    });

    if (mode === "cover") {
      // Uygulamanın üstüne bulanıklaşarak kapanır; halka açık başlar ve kapanır.
      this.closeModals();
      this.stage.append(lockEl);
      move(shackle, { y: -6 }, { duration: 0 });
      await move(lockEl, { opacity: [0, 1], filter: ["blur(10px)", "blur(0px)"], scale: [1.03, 1] }, { duration: 0.32, ease: [0.2, 0, 0, 1] });
      this.els.app?.remove(); // açık kalan bilgiler DOM'dan silinir
      this.els = {};
      this.view = { mode: "empty" };
      this.dirty = false;
      clearInterval(this.ticker);
      move(shackle, { y: [-6, 0] }, spring(0.45, 0.5));
    } else {
      this.stage.append(lockEl);
      const parts = lockEl.querySelectorAll(".pw-lock-title, .pw-lock-sub, .pw-lock-form > *");
      move(glyph, { opacity: [0, 1], scale: [0.8, 1] }, spring(0.35, 0.6));
      move(shackle, { y: [-7, 0] }, { ...spring(0.5, 0.7), delay: 0.12 });
      move(parts, { opacity: [0, 1], y: [10, 0] }, { ...spring(0.15, 0.55), delay: stagger(0.05, { startDelay: 0.08 }) });
    }
    setTimeout(() => pw.input.focus(), reduced() ? 0 : 120);
  }

  /** Halka kalkar, kilit ekranı bulanıklaşıp çözülür, uygulama altından belirir. */
  private async revealApp(lockEl: HTMLElement, shackle: Element): Promise<void> {
    await move(shackle, { y: [0, -7] }, spring(0.4, 0.38));
    this.showApp(true, lockEl);
    await move(lockEl, { opacity: [1, 0], scale: [1, 1.04], filter: ["blur(0px)", "blur(12px)"] }, { duration: 0.36, ease: [0.4, 0, 0.2, 1] });
    lockEl.remove();
    this.io.onUnlock?.();
  }

  private coverWithLock(): Promise<void> {
    return this.showLock("unlock", "cover");
  }

  // ---------- ana görünüm ----------

  private showApp(animate: boolean, under?: HTMLElement): void {
    this.els.app?.remove();
    const search = h("input", { class: "pw-search", type: "search", placeholder: "Ara", spellcheck: "false", "aria-label": "Ara" }) as HTMLInputElement;
    search.value = this.filter.query;
    search.addEventListener("input", () => {
      this.filter.query = search.value;
      this.renderList(false);
    });
    const nav = h("div", { class: "pw-nav" });
    const navPill = h("div", { class: "pw-pill" });
    const brandCount = h("span", { class: "pw-brand-count" });
    const list = h("div", { class: "pw-list", role: "listbox", "aria-label": "Kayıtlar", tabindex: "-1" });
    const listPill = h("div", { class: "pw-pill pw-pill-row" });
    const detail = h("section", { class: "pw-detail" });

    const sideAction = (ico: keyof typeof ICONS, label: string, onclick: () => void, cls = "") =>
      h("button", { class: `pw-side-action ${cls}`, title: label, onclick }, icon(ico), h("span", {}, label));

    const side = h(
      "nav",
      { class: "pw-side" },
      h("div", { class: "pw-bar", "data-tauri-drag-region": true }),
      h("div", { class: "pw-brand" }, h("span", { class: "pw-brand-name" }, "Vault"), brandCount),
      nav,
      h("div", { class: "pw-grow" }),
      h(
        "div",
        { class: "pw-side-actions" },
        sideAction("upload", "İçe aktar", () => void this.importFile()),
        sideAction("download", "Dışa aktar", () => void this.exportVault()),
        this.io.reveal ? sideAction("open", "Klasörü göster", () => this.io.reveal!()) : null,
        sideAction("sliders", "Ayarlar", () => void this.openSettings()),
        sideAction("lock", "Kilitle", () => void this.lock(), "pw-side-lock"),
      ),
    );
    const col = h(
      "div",
      { class: "pw-col" },
      h(
        "div",
        { class: "pw-bar pw-col-head", "data-tauri-drag-region": true },
        h("label", { class: "pw-search-wrap" }, icon("search"), search),
        h("button", { class: "pw-icon-btn pw-add", title: "Yeni kayıt (⌘N)", "aria-label": "Yeni kayıt", onclick: () => void this.startNew() }, icon("plus")),
      ),
      list,
    );
    const app = h("div", { class: "pw-app" }, side, col, detail);
    this.els = { app, nav, navPill, brandCount, list, listPill, detail, search };
    if (under) this.stage.insertBefore(app, under);
    else this.stage.append(app);

    this.renderSidebar(false);
    this.renderList(animate);
    this.renderDetail(false);
    this.lastActive = Date.now();
    this.lastRefresh = Date.now();
    clearInterval(this.ticker);
    this.ticker = window.setInterval(() => this.tick(), 1000);
    if (animate) {
      move(app, { opacity: [0, 1], scale: [0.985, 1] }, { duration: 0.45, ease: [0.2, 0, 0, 1], delay: 0.05 });
      move(nav.querySelectorAll(".pw-nav-item, .pw-nav-head"), { opacity: [0, 1], x: [-8, 0] }, { ...spring(0.15, 0.5), delay: stagger(0.03, { startDelay: 0.15 }) });
    }
  }

  // ---------- zamanlayıcılar ----------

  private tick(): void {
    if (!this.vault.unlocked) return;
    if (Date.now() - this.lastActive > this.settings.lockMs) return void this.lock();
    if (Date.now() - this.lastRefresh > 60_000) void this.pullChanges();
  }

  /** Pencere yeniden görününce: süre dolduysa hemen kilitle, değilse diski yeniden oku. */
  private wake(): void {
    if (document.visibilityState === "hidden" || !this.vault.unlocked) return;
    if (Date.now() - this.lastActive > this.settings.lockMs) return void this.lock();
    void this.pullChanges();
  }

  private async pullChanges(): Promise<void> {
    if (!this.vault.unlocked || !this.els.app) return;
    this.lastRefresh = Date.now();
    const { changed, unreadable } = await this.vault.refresh();
    if (unreadable && !this.warnedUnreadable) {
      this.warnedUnreadable = true;
      this.toast(`${unreadable} kayıt okunamadı. Farklı bir ana parolayla oluşturulmuş olabilir.`, "warn");
    }
    if (!changed || !this.els.app) return;
    if (this.view.mode === "show" && !this.vault.get(this.view.id)) this.view = { mode: "empty" };
    this.renderSidebar(false);
    this.renderList(false);
    if (this.view.mode !== "edit") this.renderDetail(false);
  }

  // ---------- kenar çubuğu ----------

  private folders(): [string, number][] {
    const counts = new Map<string, number>();
    for (const e of this.vault.all()) if (e.folder) counts.set(e.folder, (counts.get(e.folder) ?? 0) + 1);
    return [...counts].sort((a, b) => a[0].localeCompare(b[0], "tr"));
  }

  private renderSidebar(animatePill: boolean): void {
    const { nav, navPill, brandCount } = this.els;
    if (!nav || !navPill || !brandCount) return;
    const all = this.vault.all();
    brandCount.textContent = String(all.length);
    let active: HTMLElement | null = null;
    const item = (label: string, count: number, on: boolean, pick: () => void, ico: keyof typeof ICONS) => {
      const el = h(
        "button",
        { class: `pw-nav-item${on ? " is-on" : ""}`, title: label, onclick: pick },
        icon(ico),
        h("span", { class: "pw-nav-label" }, label),
        h("span", { class: "pw-count" }, String(count)),
      );
      if (on) active = el;
      return el;
    };
    const pick = (folder: string | null, favorites = false) => () => {
      this.filter.folder = folder;
      this.filter.favorites = favorites;
      this.renderSidebar(true);
      this.renderList(true);
    };
    const folders = this.folders();
    const kids: HTMLElement[] = [
      navPill,
      item("Tümü", all.length, !this.filter.folder && !this.filter.favorites, pick(null), "all"),
      item("Favoriler", all.filter((e) => e.favorite).length, this.filter.favorites, pick(null, true), "star"),
    ];
    if (folders.length) kids.push(h("div", { class: "pw-nav-head" }, "Klasörler"));
    kids.push(...folders.map(([f, n]) => item(f, n, this.filter.folder === f, pick(f), "folder")));
    nav.replaceChildren(...kids);
    this.slidePill(navPill, active, animatePill);
  }

  /** Seçim vurgusu: tek bir arka plan öğesi seçili satıra kayar. */
  private slidePill(pill: HTMLElement, target: HTMLElement | null, animate: boolean): void {
    if (!target) {
      pill.dataset.on = "";
      move(pill, { opacity: 0 }, { duration: animate ? 0.15 : 0 });
      return;
    }
    const to = { y: target.offsetTop, height: target.offsetHeight };
    const wasHidden = !pill.dataset.on;
    pill.dataset.on = "1";
    if (!animate || wasHidden) {
      move(pill, to, { duration: 0 });
      move(pill, { opacity: [wasHidden && animate ? 0 : 1, 1] }, { duration: animate ? 0.18 : 0 });
    } else {
      move(pill, { ...to, opacity: 1 }, spring(0.12, 0.38));
    }
  }

  // ---------- liste ----------

  private visible(): Entry[] {
    const q = this.filter.query.trim().toLocaleLowerCase("tr");
    return this.vault
      .all()
      .filter((e) => (this.filter.favorites ? e.favorite : true))
      .filter((e) => (this.filter.folder ? e.folder === this.filter.folder : true))
      .filter((e) => !q || [e.name, e.username, hostOf(e.url), e.folder].some((s) => s.toLocaleLowerCase("tr").includes(q)))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name, "tr"));
  }

  private selectedId(): string | null {
    return this.view.mode === "show" ? this.view.id : this.view.mode === "edit" && !this.view.isNew ? this.view.draft.id : null;
  }

  private renderList(animate: boolean): void {
    const { list, listPill } = this.els;
    if (!list || !listPill) return;
    const entries = this.visible();
    if (!entries.length) {
      const empty = this.vault.all().length === 0;
      listPill.dataset.on = "";
      list.replaceChildren(
        h(
          "div",
          { class: "pw-empty" },
          h("div", { class: "pw-empty-title" }, empty ? "Kasa boş" : "Sonuç yok"),
          h("div", { class: "pw-empty-sub" }, empty ? "+ ile ilk kaydını ekle ya da başka bir yöneticiden içe aktar." : "Aramayı ya da filtreyi değiştir."),
        ),
      );
      if (animate) move(list.firstElementChild!, { opacity: [0, 1], y: [6, 0] }, spring(0.15, 0.4));
      return;
    }
    const selected = this.selectedId();
    let active: HTMLElement | null = null;
    const rows = entries.map((e) => {
      const sub = e.type === "login" ? e.username || hostOf(e.url) : e.type === "card" ? (e.card.number ? `•••• ${e.card.number.slice(-4)}` : "Kart") : "Güvenli not";
      const row = h(
        "button",
        { class: `pw-row${selected === e.id ? " is-on" : ""}`, role: "option", "data-id": e.id, "aria-selected": selected === e.id ? "true" : "false", onclick: () => void this.select(e.id) },
        avatar(e),
        h("span", { class: "pw-row-text" }, h("span", { class: "pw-row-name" }, e.name || "(adsız)"), sub ? h("span", { class: "pw-row-sub" }, sub) : null),
        e.favorite ? h("span", { class: "pw-row-star" }, icon("star")) : null,
      );
      if (selected === e.id) active = row;
      return row;
    });
    list.replaceChildren(listPill, ...rows);
    this.slidePill(listPill, active, false);
    if (animate) move(rows.slice(0, 16), { opacity: [0, 1], y: [8, 0] }, { ...spring(0.12, 0.45), delay: stagger(0.022) });
  }

  private markSelected(id: string | null): void {
    const { list, listPill } = this.els;
    if (!list || !listPill) return;
    let active: HTMLElement | null = null;
    for (const row of list.querySelectorAll<HTMLElement>(".pw-row")) {
      const on = row.dataset.id === id;
      row.classList.toggle("is-on", on);
      row.setAttribute("aria-selected", String(on));
      if (on) active = row;
    }
    this.slidePill(listPill, active, true);
    (active as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  }

  private async select(id: string): Promise<void> {
    if (this.selectedId() === id && this.view.mode === "show") return;
    if (!(await this.confirmDiscard())) return;
    this.view = { mode: "show", id };
    this.markSelected(id);
    this.renderDetail(true);
  }

  private async startNew(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const draft = blankEntry("login");
    if (this.filter.folder) draft.folder = this.filter.folder;
    this.view = { mode: "edit", draft, isNew: true };
    this.markSelected(null);
    this.renderDetail(true);
  }

  private async confirmDiscard(): Promise<boolean> {
    if (this.view.mode !== "edit" || !this.dirty) return true;
    const ok = await this.ask("Değişiklikler kaydedilmedi", "Bu kayıttaki değişiklikler silinsin mi?", "Sil ve devam et", true);
    if (ok) this.dirty = false;
    return ok;
  }

  // ---------- detay ----------

  private renderDetail(animate: boolean): void {
    const pane = this.els.detail;
    if (!pane) return;
    this.els.app?.classList.toggle("has-detail", this.view.mode !== "empty");
    this.els.form = undefined;
    let content: HTMLElement;
    if (this.view.mode === "empty") {
      content = h("div", { class: "pw-detail-empty" }, h("div", { class: "pw-bar", "data-tauri-drag-region": true }), h("div", { class: "pw-detail-empty-text" }, "Bir kayıt seç"));
    } else if (this.view.mode === "show") {
      const e = this.vault.get(this.view.id);
      if (!e) {
        this.view = { mode: "empty" };
        return this.renderDetail(animate);
      }
      content = this.showEntry(e);
    } else {
      content = this.editEntry(this.view.draft, this.view.isNew);
    }
    pane.replaceChildren(content);
    if (animate) {
      move(content, { opacity: [0, 1] }, { duration: 0.18 });
      move(content.querySelectorAll(".pw-head, .pw-seg, .pw-card > *, .pw-foot"), { opacity: [0, 1], y: [8, 0] }, { ...spring(0.12, 0.45), delay: stagger(0.025) });
    }
  }

  private detailBar(...right: Child[]): HTMLElement {
    const back = h("button", { class: "pw-icon-btn pw-back", title: "Listeye dön", "aria-label": "Listeye dön", onclick: () => void this.backToList() }, icon("back"));
    return h("div", { class: "pw-bar pw-detail-bar", "data-tauri-drag-region": true }, back, h("div", { class: "pw-grow", "data-tauri-drag-region": true }), ...right);
  }

  private async backToList(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.view = { mode: "empty" };
    this.markSelected(null);
    this.renderDetail(true);
  }

  private showEntry(e: Entry): HTMLElement {
    const star = h("button", { class: `pw-icon-btn pw-star${e.favorite ? " is-on" : ""}`, title: e.favorite ? "Favorilerden çıkar" : "Favorilere ekle" }, icon("star"));
    star.addEventListener("click", async () => {
      const saved = await this.vault.save({ ...e, favorite: !e.favorite });
      e.favorite = saved.favorite;
      star.classList.toggle("is-on", saved.favorite);
      star.title = saved.favorite ? "Favorilerden çıkar" : "Favorilere ekle";
      move(star, { scale: [1, 1.3, 1], rotate: [0, saved.favorite ? 72 : -36, 0] }, { duration: 0.45, ease: "easeOut" });
      this.renderSidebar(false);
      this.renderList(false);
    });
    const edit = h("button", { class: "pw-btn", onclick: () => this.edit(e) }, icon("edit"), h("span", {}, "Düzenle"));
    const del = this.deleteButton(e);

    const fields: HTMLElement[] = [];
    if (e.type === "login") {
      if (e.username) fields.push(this.field("Kullanıcı adı", e.username, {}));
      if (e.password) fields.push(this.field("Parola", e.password, { secret: true, mono: true }));
      if (e.url) fields.push(this.field("Site", e.url, { link: e.url }));
    } else if (e.type === "card") {
      if (e.card.holder) fields.push(this.field("Kart sahibi", e.card.holder, {}));
      if (e.card.number) fields.push(this.field("Kart numarası", e.card.number.replace(/(\d{4})(?=\d)/g, "$1 "), { secret: true, mono: true, copyValue: e.card.number }));
      if (e.card.expiry) fields.push(this.field("Son kullanma", e.card.expiry, { mono: true }));
      if (e.card.cvv) fields.push(this.field("CVV", e.card.cvv, { secret: true, mono: true }));
    }
    if (e.notes) fields.push(this.field(e.type === "note" ? "Not" : "Notlar", e.notes, { secret: e.type === "note", multiline: true }));

    return h(
      "div",
      { class: "pw-detail-inner" },
      this.detailBar(star, del, edit),
      h(
        "div",
        { class: "pw-detail-scroll" },
        h(
          "header",
          { class: "pw-head" },
          avatar(e, "pw-avatar-lg"),
          h("div", { class: "pw-head-text" }, h("h2", {}, e.name || "(adsız)"), h("div", { class: "pw-head-meta" }, [TYPE_LABEL[e.type], e.folder].filter(Boolean).join(" · "))),
        ),
        h("div", { class: "pw-card" }, ...(fields.length ? fields : [h("div", { class: "pw-card-empty" }, "Bu kayıtta bilgi yok.")])),
        h("div", { class: "pw-foot" }, `Son değişiklik ${new Date(e.updated).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" })}`),
      ),
    );
  }

  private edit(e: Entry): void {
    this.view = { mode: "edit", draft: structuredClone(e), isNew: false };
    this.dirty = false;
    this.renderDetail(true);
  }

  /** İki adımlı silme: ilk basış onay ister, 3 sn içinde ikinci basış siler. */
  private deleteButton(e: Entry): HTMLElement {
    const label = h("span", { class: "pw-del-label" }, "Silinsin mi?");
    const del = h("button", { class: "pw-icon-btn pw-del", title: "Sil", "aria-label": "Sil" }, icon("trash"), label);
    let armed = 0;
    del.addEventListener("click", async () => {
      if (!armed) {
        del.classList.add("is-armed");
        armed = window.setTimeout(() => {
          armed = 0;
          del.classList.remove("is-armed");
        }, 3000);
        return;
      }
      clearTimeout(armed);
      const row = this.els.list?.querySelector<HTMLElement>(`.pw-row[data-id="${e.id}"]`);
      if (row) {
        this.els.listPill && move(this.els.listPill, { opacity: 0 }, { duration: 0.12 });
        await move(row, { opacity: 0, x: -12 }, { duration: 0.18 });
        await move(row, { height: 0, paddingTop: 0, paddingBottom: 0 }, { duration: 0.2, ease: [0.4, 0, 0.2, 1] });
      }
      await this.vault.remove(e.id);
      this.view = { mode: "empty" };
      this.renderSidebar(false);
      this.renderList(false);
      this.renderDetail(true);
      this.toast(`"${e.name}" silindi`);
    });
    return del;
  }

  private field(label: string, value: string, o: { secret?: boolean; mono?: boolean; multiline?: boolean; link?: string; copyValue?: string }): HTMLElement {
    const masked = o.multiline ? "••••••  ••••  ••••••••" : "•".repeat(Math.min(Math.max(value.length, 8), 16));
    const text = h("div", { class: `pw-value${o.mono ? " is-mono" : ""}${o.multiline ? " is-multi" : ""}${o.secret ? " is-secret" : ""}` }, o.secret ? masked : value);
    const labelEl = h("span", { class: "pw-label-text" }, label);
    const tools = h("div", { class: "pw-tools" });
    let shown = false;
    if (o.secret) {
      const eye = h("button", { class: "pw-icon-btn", title: "Göster", "aria-label": "Göster" }, icon("eye"));
      eye.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        shown = !shown;
        eye.replaceChildren(icon(shown ? "eyeOff" : "eye"));
        eye.title = shown ? "Gizle" : "Göster";
        text.classList.toggle("is-shown", shown);
        if (shown) await decode(text, value, Math.min(520, 160 + value.length * 18));
        else text.textContent = masked;
      });
      tools.append(eye);
    }
    if (o.link) {
      const href = o.link.includes("://") ? o.link : `https://${o.link}`;
      tools.append(h("button", { class: "pw-icon-btn", title: "Siteyi aç", "aria-label": "Siteyi aç", onclick: (ev: Event) => (ev.stopPropagation(), this.io.openUrl(href)) }, icon("link")));
    }
    const copyIco = h("span", { class: "pw-copy-ico" }, icon("copy"));
    tools.append(copyIco);
    const row = h(
      "div",
      { class: "pw-field", role: "button", tabindex: "0", title: "Kopyala" },
      h("div", { class: "pw-label" }, labelEl),
      h("div", { class: "pw-field-body" }, text, tools),
    );
    const doCopy = () => void this.copy(o.copyValue ?? value, label, !!o.secret, row, labelEl, copyIco);
    row.addEventListener("click", doCopy);
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        doCopy();
      }
    });
    return row;
  }

  private async copy(value: string, label: string, secret: boolean, row: HTMLElement, labelEl: HTMLElement, ico: HTMLElement): Promise<void> {
    try {
      await this.io.copy(value, secret);
    } catch {
      return void this.toast("Panoya kopyalanamadı", "warn");
    }
    row.classList.add("is-copied");
    labelEl.textContent = "Kopyalandı";
    ico.replaceChildren(icon("check"));
    move(ico, { scale: [0.6, 1.15, 1] }, { duration: 0.32 });
    setTimeout(() => {
      row.classList.remove("is-copied");
      labelEl.textContent = label;
      ico.replaceChildren(icon("copy"));
    }, 1400);
    if (secret) this.toast(`${label} kopyalandı · 30 sn sonra panodan silinecek`, "clip");
  }

  // ---------- düzenleme ----------

  private editEntry(d: Entry, isNew: boolean): HTMLElement {
    const touch = () => (this.dirty = true);
    const input = (label: string, value: string, set: (v: string) => void, o: { type?: string; mono?: boolean; list?: string; placeholder?: string; area?: boolean } = {}) => {
      const el = o.area
        ? (h("textarea", { class: "pw-input pw-textarea", rows: 3, spellcheck: "false", placeholder: o.placeholder }) as HTMLTextAreaElement)
        : (h("input", { class: `pw-input${o.mono ? " is-mono" : ""}`, type: o.type ?? "text", spellcheck: "false", autocomplete: "off", list: o.list, placeholder: o.placeholder }) as HTMLInputElement);
      el.value = value;
      el.addEventListener("input", () => (set(el.value), touch()));
      return { el, wrap: h("label", { class: "pw-field pw-field-edit" }, h("span", { class: "pw-label" }, label), el) };
    };

    const segBtns = (["login", "note", "card"] as EntryType[]).map((t) =>
      h("button", { class: `pw-seg-btn${d.type === t ? " is-on" : ""}`, type: "button", "data-t": t, onclick: () => ((d.type = t), this.renderDetail(false)) }, TYPE_LABEL[t]),
    );
    const segPill = h("div", { class: "pw-seg-pill" });
    const seg = isNew ? h("div", { class: "pw-seg", role: "tablist" }, segPill, ...segBtns) : null;

    const folderList = `pw-folders-${d.id}`;
    const datalist = h("datalist", { id: folderList }, ...this.folders().map(([f]) => h("option", { value: f })));
    const name = input("Ad", d.name, (v) => (d.name = v), { placeholder: "ör. Gmail" });
    const parts: HTMLElement[] = [name.wrap];

    if (d.type === "login") {
      parts.push(input("Kullanıcı adı", d.username, (v) => (d.username = v), { placeholder: "e-posta ya da kullanıcı adı" }).wrap);
      parts.push(this.passwordEditor(d, touch));
      parts.push(input("Site", d.url, (v) => (d.url = v), { placeholder: "ör. accounts.google.com" }).wrap);
    } else if (d.type === "card") {
      parts.push(input("Kart sahibi", d.card.holder, (v) => (d.card.holder = v)).wrap);
      parts.push(input("Kart numarası", d.card.number, (v) => (d.card.number = v.replace(/\s+/g, "")), { mono: true }).wrap);
      parts.push(
        h(
          "div",
          { class: "pw-field-row" },
          input("Son kullanma", d.card.expiry, (v) => (d.card.expiry = v), { mono: true, placeholder: "AA/YY" }).wrap,
          input("CVV", d.card.cvv, (v) => (d.card.cvv = v), { mono: true, type: "password" }).wrap,
        ),
      );
    }
    parts.push(input("Klasör", d.folder, (v) => (d.folder = v), { list: folderList, placeholder: "ör. Banka" }).wrap);
    parts.push(input(d.type === "note" ? "Not" : "Notlar", d.notes, (v) => (d.notes = v), { area: true }).wrap);

    const cancel = h("button", { class: "pw-btn pw-btn-ghost", type: "button", onclick: () => void this.cancelEdit(d, isNew) }, "Vazgeç");
    const save = h("button", { class: "pw-btn pw-btn-primary", type: "submit" }, "Kaydet");

    const form = h(
      "form",
      { class: "pw-detail-inner pw-edit" },
      this.detailBar(cancel, save),
      h(
        "div",
        { class: "pw-detail-scroll" },
        h("header", { class: "pw-head" }, h("div", { class: "pw-head-text" }, h("h2", {}, isNew ? "Yeni kayıt" : "Düzenle"), h("div", { class: "pw-head-meta" }, "Kaydedince şifrelenir"))),
        seg,
        datalist,
        h("div", { class: "pw-card" }, ...parts),
      ),
    ) as HTMLFormElement;
    this.els.form = form;

    if (seg) {
      requestAnimationFrame(() => {
        const on = segBtns.find((b) => b.classList.contains("is-on"))!;
        move(segPill, { x: on.offsetLeft, width: on.offsetWidth }, { duration: 0 });
      });
      for (const b of segBtns) {
        b.addEventListener("click", () => {
          // yeni görünüm çizilmeden önce hap kayar
          move(segPill, { x: b.offsetLeft, width: b.offsetWidth }, spring(0.12, 0.35));
        });
      }
    }

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!d.name.trim()) {
        shake(name.wrap);
        name.el.focus();
        return;
      }
      save.setAttribute("disabled", "");
      const saved = await this.vault.save({ ...d, name: d.name.trim(), folder: d.folder.trim() });
      this.dirty = false;
      this.view = { mode: "show", id: saved.id };
      this.renderSidebar(false);
      this.renderList(false);
      this.markSelected(saved.id);
      this.renderDetail(true);
      const row = this.els.list?.querySelector<HTMLElement>(`.pw-row[data-id="${saved.id}"]`);
      if (row && isNew) move(row, { opacity: [0, 1], x: [-10, 0] }, spring(0.2, 0.5));
      this.toast(isNew ? `"${saved.name}" eklendi` : "Kaydedildi");
    });
    form.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        void this.cancelEdit(d, isNew);
      }
    });
    setTimeout(() => name.el.focus(), 60);
    return form;
  }

  private async cancelEdit(d: Entry, isNew: boolean): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.dirty = false;
    this.view = isNew ? { mode: "empty" } : { mode: "show", id: d.id };
    this.renderDetail(true);
  }

  private passwordEditor(d: Entry, touch: () => void): HTMLElement {
    const field = h("input", { class: "pw-input is-mono", type: "password", spellcheck: "false", autocomplete: "new-password", "aria-label": "Parola" }) as HTMLInputElement;
    field.value = d.password;
    const meter = h("div", { class: "pw-meter pw-meter-sm" }, h("i"), h("i"), h("i"), h("i"));
    const upd = () => {
      d.password = field.value;
      meter.dataset.score = field.value ? String(strength(field.value).score) : "";
    };
    field.addEventListener("input", () => (upd(), touch()));
    upd();
    const eye = h("button", { class: "pw-icon-btn", type: "button", title: "Göster", "aria-label": "Göster" }, icon("eye"));
    eye.addEventListener("click", () => {
      const show = field.type === "password";
      field.type = show ? "text" : "password";
      eye.replaceChildren(icon(show ? "eyeOff" : "eye"));
    });

    const len = h("input", { type: "range", min: 8, max: 48, value: this.gen.length, class: "pw-range", "aria-label": "Uzunluk" }) as HTMLInputElement;
    const lenOut = h("span", { class: "pw-range-out" }, String(this.gen.length));
    const chip = (key: "upper" | "digits" | "symbols", label: string) => {
      const b = h("button", { type: "button", class: `pw-chip${this.gen[key] ? " is-on" : ""}` }, label);
      b.addEventListener("click", () => {
        this.gen[key] = !this.gen[key];
        b.classList.toggle("is-on", this.gen[key]);
        void roll();
      });
      return b;
    };
    const dice = h("button", { class: "pw-icon-btn pw-dice", type: "button", title: "Parola üret", "aria-label": "Parola üret" }, icon("dice"));
    let rolling = 0;
    const roll = async () => {
      this.gen.length = Number(len.value);
      lenOut.textContent = len.value;
      const pw = generatePassword(this.gen);
      field.type = "text";
      eye.replaceChildren(icon("eyeOff"));
      move(dice, { rotate: [0, 360] }, { duration: 0.5, ease: [0.3, 0, 0.2, 1] });
      const id = ++rolling;
      const tmp = h("span");
      const t = setInterval(() => id === rolling && (field.value = tmp.textContent ?? ""), 16);
      await decode(tmp, pw, 300);
      clearInterval(t);
      if (id !== rolling) return;
      field.value = pw;
      upd();
      touch();
    };
    dice.addEventListener("click", () => {
      if (gen.hidden) openGen();
      void roll();
    });
    len.addEventListener("input", () => void roll());

    const gen = h(
      "div",
      { class: "pw-gen" },
      h("div", { class: "pw-gen-row" }, h("span", { class: "pw-gen-label" }, "Uzunluk"), len, lenOut),
      h("div", { class: "pw-gen-row" }, chip("upper", "ABC"), chip("digits", "123"), chip("symbols", "#$%")),
    );
    gen.hidden = true;
    const openGen = () => {
      gen.hidden = false;
      move(gen, { opacity: [0, 1], height: [0, gen.scrollHeight] }, { duration: 0.26, ease: [0.2, 0, 0, 1] }).then(() => (gen.style.height = ""));
    };

    return h(
      "div",
      { class: "pw-field pw-field-edit" },
      h("span", { class: "pw-label" }, "Parola"),
      h("div", { class: "pw-pw-row" }, field, eye, dice),
      meter,
      gen,
    );
  }

  // ---------- içe / dışa aktarma ----------

  private async importFile(): Promise<void> {
    let picked: { name: string; text: string } | null;
    try {
      picked = await this.io.pickFile();
    } catch (err) {
      return void this.toast((err as Error).message, "warn");
    }
    if (!picked) return;
    let backup: Backup | null;
    try {
      backup = parseBackup(picked.text);
    } catch (err) {
      return void this.toast((err as Error).message, "warn");
    }
    if (backup) return this.restoreBackup(backup, picked.name);
    let incoming: Entry[];
    let format: string;
    try {
      ({ entries: incoming, format } = parseImport(picked.name, picked.text));
    } catch (err) {
      return void this.toast((err as Error).message, "warn");
    }
    if (!incoming.length) return void this.toast("Dosyada içe aktarılacak kayıt bulunamadı", "warn");
    const existing = this.vault.all();
    const fresh = incoming.filter((n) => !existing.some((e) => sameEntry(e, n)));
    if (!fresh.length) return void this.toast("Dosyadaki kayıtların hepsi kasada zaten var");
    const skipped = incoming.length - fresh.length;
    const ok = await this.ask(
      `${fresh.length} kayıt içe aktarılsın mı?`,
      `${format} dosyası: ${picked.name}${skipped ? `. ${skipped} kayıt zaten var, atlanacak.` : "."}`,
      "İçe aktar",
    );
    if (!ok) return;
    for (const e of fresh) await this.vault.save(e);
    this.renderSidebar(false);
    this.renderList(true);
    this.toast(`${fresh.length} kayıt şifrelenip eklendi. Dışa aktarım dosyasını artık silebilirsin.`);
  }

  private async exportVault(): Promise<void> {
    const all = this.vault.all();
    const logins = all.filter((e) => e.type === "login");
    if (!all.length) return void this.toast("Dışa aktarılacak kayıt yok", "warn");
    const formats = [
      { label: "Şifreli yedek", desc: `${all.length} kaydın hepsi, ana parolanla şifreli. USB'de ya da bulutta güvenle saklanır. Geri yüklemek için: İçe aktar.`, count: all.length, ext: BACKUP_EXT, type: "application/json", make: () => "" },
      { label: "Bitwarden JSON", desc: `${all.length} kaydın hepsi: notlar, kartlar, klasörler. Bitwarden, Proton Pass, KeePassXC ve bu uygulama geri alır.`, count: all.length, ext: "json", type: "application/json", make: () => toBitwardenJson(all) },
      { label: "CSV", desc: `${logins.length} giriş kaydı. Tarayıcılar ve çoğu parola yöneticisi alır; notlar ve kartlar girmez.`, count: logins.length, ext: "csv", type: "text/csv;charset=utf-8", make: () => toCsv(logins) },
    ].filter((f) => f.count);
    const pick = await this.modal<(typeof formats)[number]>((done) => [
      h("h2", {}, "Dışa aktar"),
      h("p", { class: "pw-muted" }, "Yedek için şifreli yedeği seç. Diğer iki biçimde parolalar açık metin olarak durur; başka bir uygulamaya taşıdıktan sonra dosyayı sil."),
      h("div", { class: "pw-options" }, ...formats.map((f) => h("button", { class: "pw-option", onclick: () => done(f) }, h("strong", {}, f.label), h("span", {}, f.desc)))),
      h("div", { class: "pw-modal-actions" }, h("button", { class: "pw-btn pw-btn-ghost", onclick: () => done(null) }, "Vazgeç")),
    ]);
    if (!pick) return;
    if (pick.ext === BACKUP_EXT) return void (await this.backupVault());
    const name = `vault-pw-manager-${new Date().toISOString().slice(0, 10)}.${pick.ext}`;
    try {
      if (!(await this.io.saveFile(name, pick.make(), pick.type))) return;
    } catch (err) {
      return void this.toast(`Kaydedilemedi: ${(err as Error).message}`, "warn");
    }
    this.toast(`${pick.count} kayıt dışa aktarıldı. İşin bitince dosyayı sil.`);
  }

  // ---------- şifreli yedek ----------

  /** Yedeği kaydeder. Başarılıysa true. */
  private async backupVault(): Promise<boolean> {
    const count = this.vault.all().length;
    if (!count) return void this.toast("Yedeklenecek kayıt yok", "warn"), false;
    const name = `vault-pw-manager-yedek-${new Date().toISOString().slice(0, 10)}.${BACKUP_EXT}`;
    try {
      if (!(await this.io.saveFile(name, await this.vault.backup(), "application/json"))) return false;
    } catch (err) {
      return void this.toast(`Yedek kaydedilemedi: ${(err as Error).message}`, "warn"), false;
    }
    this.settings.lastBackup = new Date().toISOString();
    saveSettings(this.settings);
    this.toast(`${count} kayıt şifreli olarak yedeklendi`);
    return true;
  }

  private async restoreBackup(backup: Backup, fileName: string): Promise<void> {
    // Aynı kasanın yedeğiyse parola sorulmaz; başka bir parolayla alınmışsa o parola istenir.
    const opened = (await this.vault.openBackup(backup)) ?? (await this.askBackupPassword(backup));
    if (!opened) return;
    const existing = this.vault.all();
    const fresh = opened.entries.filter((n) => !existing.some((e) => e.id === n.id || sameEntry(e, n)));
    const lost = opened.unreadable ? ` ${opened.unreadable} kayıt çözülemedi.` : "";
    if (!fresh.length) return void this.toast(`Yedekteki kayıtların hepsi kasada zaten var.${lost}`, lost ? "warn" : "info");
    const skipped = opened.entries.length - fresh.length;
    const ok = await this.ask(
      `${fresh.length} kayıt geri yüklensin mi?`,
      `${fileName} · ${new Date(backup.created).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" })} tarihli yedek.${skipped ? ` ${skipped} kayıt zaten var, atlanacak.` : ""}${lost} Kasadaki mevcut kayıtlara dokunulmaz.`,
      "Geri yükle",
    );
    if (!ok) return;
    for (const e of fresh) await this.vault.save(e);
    this.renderSidebar(false);
    this.renderList(true);
    this.toast(`${fresh.length} kayıt yedekten geri yüklendi`);
  }

  private askBackupPassword(backup: Backup): Promise<{ entries: Entry[]; unreadable: number } | null> {
    return this.modal((done) => {
      const input = h("input", { class: "pw-input", type: "password", placeholder: "Yedeğin ana parolası", autocomplete: "off", spellcheck: "false", "aria-label": "Yedeğin ana parolası" }) as HTMLInputElement;
      const note = h("p", { class: "pw-muted pw-modal-note" }, "Bu yedek farklı bir ana parolayla alınmış. Yedeği aldığın andaki parolayı gir.");
      const go = h("button", { class: "pw-btn pw-btn-primary", type: "submit" }, "Aç") as HTMLButtonElement;
      const form = h(
        "form",
        { class: "pw-modal-form" },
        input,
        h("div", { class: "pw-modal-actions" }, h("button", { class: "pw-btn pw-btn-ghost", type: "button", onclick: () => done(null) }, "Vazgeç"), go),
      );
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (!input.value || go.disabled) return;
        go.disabled = true;
        go.textContent = "Açılıyor…";
        const r = await this.vault.openBackup(backup, input.value);
        if (r) {
          input.value = "";
          return done(r);
        }
        go.disabled = false;
        go.textContent = "Aç";
        note.textContent = "Parola yanlış. Tekrar dene.";
        note.classList.add("is-warn");
        input.select();
        shake(form);
      });
      setTimeout(() => input.focus(), 40);
      return [h("h2", {}, "Yedeğin parolası"), note, form];
    });
  }

  // ---------- pencereler ----------

  private modal<T>(build: (done: (v: T | null) => void) => Child[]): Promise<T | null> {
    return new Promise((resolve) => {
      const card = h("div", { class: "pw-modal-card", role: "dialog", "aria-modal": "true" });
      const veil = h("div", { class: "pw-modal" }, card);
      let closed = false;
      const done = async (v: T | null) => {
        if (closed) return;
        closed = true;
        await Promise.all([move(card, { opacity: 0, scale: 0.97, y: 6 }, { duration: 0.16 }), move(veil, { opacity: 0 }, { duration: 0.18 })]);
        veil.remove();
        resolve(v);
      };
      for (const kid of build(done)) if (kid) card.append(kid);
      veil.addEventListener("pointerdown", (ev) => ev.target === veil && void done(null));
      veil.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          void done(null);
        }
      });
      this.root.append(veil);
      move(veil, { opacity: [0, 1] }, { duration: 0.18 });
      move(card, { opacity: [0, 1], scale: [0.96, 1], y: [10, 0] }, spring(0.2, 0.42));
      setTimeout(() => card.querySelector<HTMLElement>(".pw-btn-primary, .pw-option, button")?.focus(), 30);
    });
  }

  private async ask(title: string, text: string, okLabel: string, danger = false): Promise<boolean> {
    const r = await this.modal<true>((done) => [
      h("h2", {}, title),
      h("p", { class: "pw-muted" }, text),
      h(
        "div",
        { class: "pw-modal-actions" },
        h("button", { class: "pw-btn pw-btn-ghost", onclick: () => done(null) }, "Vazgeç"),
        h("button", { class: `pw-btn pw-btn-primary${danger ? " is-danger" : ""}`, onclick: () => done(true) }, okLabel),
      ),
    ]);
    return r === true;
  }

  // ---------- ayarlar ----------

  private async openSettings(): Promise<void> {
    const row = (title: string, sub: string, control: HTMLElement) =>
      h("div", { class: "pw-set-row" }, h("div", { class: "pw-set-text" }, h("strong", {}, title), h("span", {}, sub)), control);
    await this.modal<true>((done) => [
      h("h2", {}, "Ayarlar"),
      h(
        "div",
        { class: "pw-set" },
        row(
          "Görünüm",
          "Açık, koyu ya da bilgisayarınla aynı.",
          this.segmented(THEMES, this.settings.theme, (theme) => {
            this.settings.theme = theme;
            saveSettings(this.settings);
            this.applyTheme(true);
          }),
        ),
        row(
          "Otomatik kilit",
          "Bu süre boyunca hiçbir işlem yapılmazsa kasa kilitlenir.",
          this.segmented(LOCK_CHOICES, this.settings.lockMs, (lockMs) => {
            this.settings.lockMs = lockMs;
            saveSettings(this.settings);
            this.lastActive = Date.now();
          }),
        ),
        this.backupRow(row),
      ),
      h("div", { class: "pw-modal-actions" }, h("button", { class: "pw-btn pw-btn-primary", onclick: () => done(true) }, "Tamam")),
    ]);
  }

  private backupRow(row: (title: string, sub: string, control: HTMLElement) => HTMLElement): HTMLElement {
    const when = () => {
      const t = this.settings.lastBackup;
      if (!t) return "Henüz yedek alınmadı. Kayıtların yalnız bu bilgisayarda.";
      const days = Math.floor((Date.now() - Date.parse(t)) / 86_400_000);
      const date = new Date(t).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
      return `Son yedek: ${date}${days > 0 ? ` (${days} gün önce)` : " (bugün)"}.`;
    };
    const btn = h("button", { class: "pw-btn pw-set-btn", type: "button" }, icon("download"), "Şifreli yedek al") as HTMLButtonElement;
    const r = row("Yedek", when(), btn);
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      if (await this.backupVault()) {
        const sub = r.querySelector(".pw-set-text span");
        if (sub) sub.textContent = when();
      }
      btn.disabled = false;
    });
    return r;
  }

  /** Seçili öğenin arkasındaki hap, seçim değişince yeni seçeneğe kayar. */
  private segmented<T extends string | number>(opts: readonly (readonly [T, string])[], value: T, onChange: (v: T) => void): HTMLElement {
    const pill = h("div", { class: "pw-seg-pill" });
    const btns = opts.map(([v, label]) => {
      const b = h("button", { class: `pw-seg-btn${v === value ? " is-on" : ""}`, type: "button", role: "radio", "aria-checked": String(v === value) }, label);
      b.addEventListener("click", () => {
        if (b.classList.contains("is-on")) return;
        for (const x of btns) {
          x.classList.toggle("is-on", x === b);
          x.setAttribute("aria-checked", String(x === b));
        }
        move(pill, { x: b.offsetLeft, width: b.offsetWidth }, spring(0.12, 0.35));
        onChange(v);
      });
      return b;
    });
    requestAnimationFrame(() => {
      const on = btns.find((b) => b.classList.contains("is-on"));
      if (on) move(pill, { x: on.offsetLeft, width: on.offsetWidth }, { duration: 0 });
    });
    return h("div", { class: "pw-seg", role: "radiogroup" }, pill, ...btns);
  }

  /** Tema geçişi: destekleyen ortamda (View Transitions) yumuşak bir çapraz geçişle. */
  private applyTheme(animate: boolean): void {
    const t = this.settings.theme;
    const apply = () => {
      this.root.classList.toggle("is-light", t === "light");
      this.root.classList.toggle("is-dark", t === "dark");
      this.io.onTheme?.(t);
    };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (animate && doc.startViewTransition && !reduced()) doc.startViewTransition(apply);
    else apply();
  }

  private closeModals(): void {
    for (const m of this.root.querySelectorAll(".pw-modal")) m.remove();
  }

  // ---------- kısayollar ----------

  private onKey(e: KeyboardEvent): void {
    if (!this.vault.unlocked || !this.els.app || this.root.querySelector(".pw-modal")) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const active = document.activeElement;
    const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    const search = this.els.search!;
    if (mod && k === "f") {
      e.preventDefault();
      search.focus();
      search.select();
    } else if (mod && k === "n") {
      e.preventDefault();
      void this.startNew();
    } else if (mod && k === "l") {
      e.preventDefault();
      void this.lock();
    } else if (mod && k === "s" && this.els.form) {
      e.preventDefault();
      this.els.form.requestSubmit();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && (!typing || active === search) && this.view.mode !== "edit") {
      e.preventDefault();
      const ids = [...this.els.list!.querySelectorAll<HTMLElement>(".pw-row")].map((r) => r.dataset.id!);
      if (!ids.length) return;
      const i = ids.indexOf(this.selectedId() ?? "");
      const next = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1)))];
      void this.select(next);
    } else if (e.key === "Escape" && active === search && search.value) {
      search.value = "";
      this.filter.query = "";
      this.renderList(false);
    }
  }

  // ---------- bildirim ----------

  toast(text: string, kind: "info" | "warn" | "clip" = "info"): void {
    const ring = kind === "clip" ? svg(`<svg class="pw-toast-ring" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" pathLength="1"/></svg>`) : null;
    const el = h("div", { class: `pw-toast is-${kind}` }, ring, h("span", {}, text));
    for (const old of [...this.toasts.children].slice(0, -2)) old.remove(); // en fazla 3 bildirim
    this.toasts.append(el);
    move(el, { opacity: [0, 1], y: [12, 0], scale: [0.96, 1] }, spring(0.25, 0.4));
    if (ring) move(ring.querySelector("circle")!, { strokeDashoffset: [0, 1] }, { duration: CLIPBOARD_MS / 1000, ease: "linear" });
    const life = kind === "clip" ? 4000 : kind === "warn" ? 6000 : 2600;
    setTimeout(async () => {
      if (!el.isConnected) return;
      await move(el, { opacity: 0, y: 6, scale: 0.98 }, { duration: 0.2 });
      el.remove();
    }, life);
  }
}
