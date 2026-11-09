import { createMeta, open, seal, unlockMeta, type Sealed, type VaultMeta } from "./crypto";

export const BACKUP_EXT = "vpmbackup";
const BACKUP_FORMAT = "vault-pw-manager-backup";

// Her kayıt ayrı bir dosyada durur: iki makine farklı kayıtları değiştirirse git çakışmaz.
// Dosya adı yalnız rastgele kimliği taşır; ad, site, kullanıcı adı dahil her şey şifreli.

export type EntryType = "login" | "note" | "card";

export interface Entry {
  id: string;
  type: EntryType;
  name: string;
  folder: string;
  url: string;
  username: string;
  password: string;
  notes: string;
  card: { holder: string; number: string; expiry: string; cvv: string };
  favorite: boolean;
  created: string;
  updated: string;
}

/** Kasanın dosya erişimi (masaüstünde Rust kabuğu); testte bellek içi sürümü kullanılır. */
export interface FileAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ mtime: number } | null>;
  /** İsteğe bağlı: klasördeki dosyaları değişiklik zamanlarıyla tek çağrıda verir. */
  scan?(path: string): Promise<{ path: string; mtime: number }[]>;
  /** İsteğe bağlı: birden çok dosyayı tek çağrıda okur (okunamayan → null). */
  readMany?(paths: string[]): Promise<(string | null)[]>;
}

interface EntryFile {
  v: 1;
  id: string;
  data: Sealed;
}

/**
 * Şifreli yedek: kasanın tamamı tek dosyada. Kayıtlar diskteki gibi şifreli durur;
 * dosya yalnız yedek alındığı andaki ana parolayla açılır.
 */
export interface Backup {
  format: typeof BACKUP_FORMAT;
  v: 1;
  created: string;
  count: number;
  meta: VaultMeta;
  entries: EntryFile[];
}

/** Metin bir yedek dosyası değilse null; bozuk bir yedekse hata. */
export function parseBackup(text: string): Backup | null {
  let data: Partial<Backup>;
  try {
    data = JSON.parse(text) as Partial<Backup>;
  } catch {
    return null;
  }
  if (!data || data.format !== BACKUP_FORMAT) return null;
  if (data.v !== 1 || !data.meta?.salt || !data.meta.check || !Array.isArray(data.entries)) {
    throw new Error("Yedek dosyası bozuk ya da bu sürümle uyumsuz.");
  }
  return data as Backup;
}

/** Varsayılan kasa klasörü (masaüstünde Rust kabuğu gerçek klasöre çevirir). */
export const DIR = "vault";
const ID_RE = /\/k-([a-f0-9-]{36})\.json$/;

export function blankEntry(type: EntryType = "login"): Entry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    type,
    name: "",
    folder: "",
    url: "",
    username: "",
    password: "",
    notes: "",
    card: { holder: "", number: "", expiry: "", cvv: "" },
    favorite: false,
    created: now,
    updated: now,
  };
}

export class Vault {
  private key: CryptoKey | null = null;
  private entries = new Map<string, Entry>();
  private mtimes = new Map<string, number>();

  private readonly meta: string;

  constructor(
    private fs: FileAdapter,
    private readonly dir: string = DIR,
  ) {
    this.meta = `${dir}/meta.json`;
  }

  private entryPath(id: string): string {
    return `${this.dir}/k-${id}.json`;
  }

  get unlocked(): boolean {
    return this.key !== null;
  }

  async isInitialized(): Promise<boolean> {
    return this.fs.exists(this.meta);
  }

  async create(password: string): Promise<void> {
    if (await this.isInitialized()) throw new Error("Kasa zaten var");
    if (!(await this.fs.exists(this.dir))) await this.fs.mkdir(this.dir);
    const { meta, key } = await createMeta(password);
    await this.fs.write(this.meta, JSON.stringify(meta, null, 2));
    this.key = key;
    this.entries.clear();
    this.mtimes.clear();
  }

  /** Parola yanlışsa false. */
  async unlock(password: string): Promise<boolean> {
    const meta = JSON.parse(await this.fs.read(this.meta)) as VaultMeta;
    const key = await unlockMeta(meta, password);
    if (!key) return false;
    this.key = key;
    this.entries.clear();
    this.mtimes.clear();
    await this.refresh();
    return true;
  }

  lock(): void {
    this.key = null;
    this.entries.clear();
    this.mtimes.clear();
  }

  all(): Entry[] {
    return [...this.entries.values()];
  }

  get(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  async save(entry: Entry): Promise<Entry> {
    const key = this.requireKey();
    const saved = { ...entry, updated: new Date().toISOString() };
    const file: EntryFile = { v: 1, id: saved.id, data: await seal(key, saved, saved.id) };
    const path = this.entryPath(saved.id);
    await this.fs.write(path, JSON.stringify(file));
    this.entries.set(saved.id, saved);
    const st = await this.fs.stat(path);
    if (st) this.mtimes.set(path, st.mtime);
    return saved;
  }

  async remove(id: string): Promise<void> {
    this.requireKey();
    const path = this.entryPath(id);
    if (await this.fs.exists(path)) await this.fs.remove(path);
    this.entries.delete(id);
    this.mtimes.delete(path);
  }

  /**
   * Diskteki değişiklikleri (ör. öbür makineden git ile gelenler) okur.
   * Değişen bir şey olduysa true döner. Çözülemeyen dosyalar atlanır ve sayılır.
   */
  async refresh(): Promise<{ changed: boolean; unreadable: number }> {
    const key = this.requireKey();
    if (!(await this.fs.exists(this.dir))) return { changed: false, unreadable: 0 };
    const listing = await this.listWithTimes();
    const present = new Set<string>();
    const stale: { path: string; id: string; mtime: number }[] = [];
    for (const { path, mtime } of listing) {
      const m = ID_RE.exec(path.replace(/\\/g, "/"));
      if (!m) continue;
      present.add(path);
      if (this.mtimes.get(path) !== mtime) stale.push({ path, id: m[1], mtime });
    }
    let changed = false;
    let unreadable = 0;
    const texts = await this.readAll(stale.map((s) => s.path));
    await Promise.all(
      stale.map(async ({ path, id, mtime }, i) => {
        try {
          const text = texts[i];
          if (text === null) throw new Error("okunamadı");
          const file = JSON.parse(text) as EntryFile;
          if (file.id !== id) throw new Error("kimlik uyuşmuyor");
          const entry = await open<Entry>(key, file.data, file.id);
          this.entries.set(entry.id, entry);
          this.mtimes.set(path, mtime);
          changed = true;
        } catch {
          unreadable++;
        }
      }),
    );
    for (const [path] of this.mtimes) {
      if (!present.has(path)) {
        const m = ID_RE.exec(path.replace(/\\/g, "/"));
        if (m) this.entries.delete(m[1]);
        this.mtimes.delete(path);
        changed = true;
      }
    }
    return { changed, unreadable };
  }

  /** Açık kasanın şifreli yedeği (JSON metni). */
  async backup(): Promise<string> {
    const key = this.requireKey();
    const meta = JSON.parse(await this.fs.read(this.meta)) as VaultMeta;
    const entries = await Promise.all(
      this.all().map(async (e): Promise<EntryFile> => ({ v: 1, id: e.id, data: await seal(key, e, e.id) })),
    );
    const backup: Backup = { format: BACKUP_FORMAT, v: 1, created: new Date().toISOString(), count: entries.length, meta, entries };
    return JSON.stringify(backup);
  }

  /**
   * Yedeği çözer. Parola verilmezse açık kasanın anahtarı denenir (aynı kasanın yedeği).
   * Parola yanlışsa null. Çözülemeyen kayıtlar atlanır ve sayılır.
   */
  async openBackup(b: Backup, password?: string): Promise<{ entries: Entry[]; unreadable: number } | null> {
    let key: CryptoKey | null;
    if (password === undefined) {
      key = this.requireKey();
      try {
        await open<string>(key, b.meta.check, "meta");
      } catch {
        return null;
      }
    } else key = await unlockMeta(b.meta, password);
    if (!key) return null;
    const entries: Entry[] = [];
    let unreadable = 0;
    await Promise.all(
      b.entries.map(async (f) => {
        try {
          const e = await open<Entry>(key, f.data, f.id);
          if (e.id !== f.id) throw new Error("kimlik uyuşmuyor");
          entries.push(e);
        } catch {
          unreadable++;
        }
      }),
    );
    return { entries, unreadable };
  }

  private async listWithTimes(): Promise<{ path: string; mtime: number }[]> {
    if (this.fs.scan) return this.fs.scan(this.dir);
    const { files } = await this.fs.list(this.dir);
    return Promise.all(files.map(async (path) => ({ path, mtime: (await this.fs.stat(path))?.mtime ?? 0 })));
  }

  private async readAll(paths: string[]): Promise<(string | null)[]> {
    if (!paths.length) return [];
    if (this.fs.readMany) return this.fs.readMany(paths);
    return Promise.all(paths.map((p) => this.fs.read(p).catch(() => null)));
  }

  private requireKey(): CryptoKey {
    if (!this.key) throw new Error("Kasa kilitli");
    return this.key;
  }
}

// ---- Bitwarden içe aktarma (şifresiz .json dışa aktarımı) ----

interface BwItem {
  type: number;
  name?: string;
  notes?: string | null;
  favorite?: boolean;
  folderId?: string | null;
  login?: { username?: string | null; password?: string | null; uris?: { uri?: string | null }[] | null } | null;
  card?: { cardholderName?: string | null; number?: string | null; expMonth?: string | null; expYear?: string | null; code?: string | null } | null;
  identity?: Record<string, string | null> | null;
}

export function parseBitwarden(text: string): Entry[] {
  const data = JSON.parse(text) as { encrypted?: boolean; folders?: { id: string; name: string }[]; items?: BwItem[] };
  if (data.encrypted) throw new Error("Bu dışa aktarım şifreli. Bitwarden'dan şifresiz .json olarak dışa aktar.");
  if (!Array.isArray(data.items)) throw new Error("Bu bir Bitwarden .json dışa aktarımına benzemiyor.");
  const folders = new Map((data.folders ?? []).map((f) => [f.id, f.name]));
  const out: Entry[] = [];
  for (const item of data.items) {
    const e = blankEntry(item.type === 3 ? "card" : item.type === 1 ? "login" : "note");
    e.name = (item.name ?? "").trim() || "(adsız)";
    e.folder = (item.folderId && folders.get(item.folderId)) || "";
    e.favorite = !!item.favorite;
    e.notes = item.notes ?? "";
    if (item.type === 1 && item.login) {
      e.username = item.login.username ?? "";
      e.password = item.login.password ?? "";
      e.url = item.login.uris?.find((u) => u.uri)?.uri ?? "";
    } else if (item.type === 3 && item.card) {
      const c = item.card;
      const exp = [c.expMonth, c.expYear].filter(Boolean).join("/");
      e.card = { holder: c.cardholderName ?? "", number: c.number ?? "", expiry: exp, cvv: c.code ?? "" };
    } else if (item.type === 4 && item.identity) {
      const lines = Object.entries(item.identity)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`);
      e.notes = [lines.join("\n"), e.notes].filter(Boolean).join("\n\n");
    }
    out.push(e);
  }
  return out;
}

export function sameEntry(a: Entry, b: Entry): boolean {
  return (
    a.type === b.type &&
    a.name.trim().toLowerCase() === b.name.trim().toLowerCase() &&
    a.username === b.username &&
    a.url === b.url
  );
}
