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
  /** Klasör listesi (boş klasörler dahil); eski yedeklerde yok. */
  folders?: Sealed;
}

/** Klasör listesi tek bir şifreli dosyada durur; kayıtların klasör alanı ayrıca kendi dosyasında. */
interface FoldersFile {
  v: 1;
  data: Sealed;
}
const FOLDERS_BIND = "folders";

const folderKey = (name: string) => name.trim().toLocaleLowerCase("tr");
/** İki klasör adı aynı klasör mü (büyük/küçük harf ve baştaki/sondaki boşluk önemsiz). */
export const sameFolder = (a: string, b: string) => !!a.trim() && folderKey(a) === folderKey(b);
const sortFolders = (names: Iterable<string>) => [...names].sort((a, b) => a.localeCompare(b, "tr"));

/** Klasör adını temizler; boşsa ya da çok uzunsa hata. "/" ve "\" içe aktarımda alt klasör ayırıcısı olduğu için yasak. */
export function checkFolderName(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("Klasör adı boş olamaz.");
  if (clean.length > 60) throw new Error("Klasör adı en fazla 60 karakter olabilir.");
  if (/[\\/]/.test(clean)) throw new Error('Klasör adında "/" ya da "\\" kullanılamaz.');
  return clean;
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
  /** Kullanıcının açtığı klasörler; kayıtlardaki klasör adları buna ayrıca eklenir. */
  private folderList: string[] = [];

  private readonly meta: string;
  private readonly foldersPath: string;

  constructor(
    private fs: FileAdapter,
    private readonly dir: string = DIR,
  ) {
    this.meta = `${dir}/meta.json`;
    this.foldersPath = `${dir}/folders.json`;
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
    this.folderList = [];
  }

  /** Parola yanlışsa false. */
  async unlock(password: string): Promise<boolean> {
    const meta = JSON.parse(await this.fs.read(this.meta)) as VaultMeta;
    const key = await unlockMeta(meta, password);
    if (!key) return false;
    this.key = key;
    this.entries.clear();
    this.mtimes.clear();
    this.folderList = [];
    await this.refresh();
    return true;
  }

  lock(): void {
    this.key = null;
    this.entries.clear();
    this.mtimes.clear();
    this.folderList = [];
  }

  all(): Entry[] {
    return [...this.entries.values()];
  }

  get(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  async save(entry: Entry): Promise<Entry> {
    const key = this.requireKey();
    const prev = this.entries.get(entry.id);
    const saved = { ...entry, updated: new Date().toISOString() };
    const file: EntryFile = { v: 1, id: saved.id, data: await seal(key, saved, saved.id) };
    const path = this.entryPath(saved.id);
    await this.fs.write(path, JSON.stringify(file));
    this.entries.set(saved.id, saved);
    const st = await this.fs.stat(path);
    if (st) this.mtimes.set(path, st.mtime);
    // Kullanılan klasörler listeye yazılır: son kaydı taşınan klasör, silinene kadar boş olarak kalır.
    const missing = [prev?.folder ?? "", saved.folder].filter((f) => f.trim() && !this.folderList.some((x) => sameFolder(x, f)));
    if (missing.length) await this.saveFolders([...this.folderList, ...missing]);
    return saved;
  }

  async remove(id: string): Promise<void> {
    this.requireKey();
    const path = this.entryPath(id);
    if (await this.fs.exists(path)) await this.fs.remove(path);
    this.entries.delete(id);
    this.mtimes.delete(path);
  }

  // ---- klasörler ----

  /** Tüm klasörler: açılmış (boş olanlar dahil) ve kayıtlarda geçenler, alfabetik. */
  folders(): string[] {
    const byKey = new Map<string, string>();
    for (const f of this.folderList) byKey.set(folderKey(f), f);
    for (const e of this.entries.values()) if (e.folder && !byKey.has(folderKey(e.folder))) byKey.set(folderKey(e.folder), e.folder);
    return sortFolders(byKey.values());
  }

  /** Aynı adda (büyük/küçük harf farkı gözetmeden) klasör varsa onun yazılışı. */
  findFolder(name: string): string | undefined {
    const k = folderKey(name);
    return this.folders().find((f) => folderKey(f) === k);
  }

  async addFolder(name: string): Promise<string> {
    const clean = checkFolderName(name);
    if (this.findFolder(clean)) throw new Error(`"${clean}" adında bir klasör zaten var.`);
    await this.saveFolders([...this.folderList, clean]);
    return clean;
  }

  /** Klasörü ve içindeki kayıtları yeni ada taşır. Aynı adda başka klasör varsa hata. */
  async renameFolder(from: string, to: string): Promise<number> {
    const clean = checkFolderName(to);
    const existing = this.findFolder(clean);
    if (existing && folderKey(existing) !== folderKey(from)) throw new Error(`"${existing}" adında bir klasör zaten var.`);
    const moved = this.all().filter((e) => sameFolder(e.folder, from));
    for (const e of moved) await this.save({ ...e, folder: clean });
    await this.saveFolders([...this.folderList.filter((f) => !sameFolder(f, from)), clean]);
    return moved.length;
  }

  /** Klasörü siler; içindeki kayıtlar silinmez, klasörsüz kalır. Taşınan kayıt sayısını döner. */
  async deleteFolder(name: string): Promise<number> {
    const moved = this.all().filter((e) => sameFolder(e.folder, name));
    for (const e of moved) await this.save({ ...e, folder: "" });
    await this.saveFolders(this.folderList.filter((f) => !sameFolder(f, name)));
    return moved.length;
  }

  /** Listeye eksik klasörleri ekler (ör. yedekten geri yüklerken). */
  async mergeFolders(names: string[]): Promise<void> {
    const missing = names.map((n) => n.trim()).filter((n) => n && !this.findFolder(n));
    if (missing.length) await this.saveFolders([...this.folderList, ...missing]);
  }

  private async saveFolders(list: string[]): Promise<void> {
    const key = this.requireKey();
    const seen = new Set<string>();
    const clean = list.filter((f) => f && !seen.has(folderKey(f)) && seen.add(folderKey(f)));
    const file: FoldersFile = { v: 1, data: await seal(key, sortFolders(clean), FOLDERS_BIND) };
    if (!(await this.fs.exists(this.dir))) await this.fs.mkdir(this.dir);
    await this.fs.write(this.foldersPath, JSON.stringify(file));
    this.folderList = sortFolders(clean);
    const st = await this.fs.stat(this.foldersPath);
    if (st) this.mtimes.set(this.foldersPath, st.mtime);
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
    let foldersSeen = false;
    let changed = false;
    for (const { path, mtime } of listing) {
      if (path.replace(/\\/g, "/").endsWith("/folders.json")) {
        foldersSeen = true;
        if (this.mtimes.get(this.foldersPath) !== mtime && (await this.loadFolders(path))) {
          this.mtimes.set(this.foldersPath, mtime);
          changed = true;
        }
        continue;
      }
      const m = ID_RE.exec(path.replace(/\\/g, "/"));
      if (!m) continue;
      present.add(path);
      if (this.mtimes.get(path) !== mtime) stale.push({ path, id: m[1], mtime });
    }
    if (!foldersSeen && this.mtimes.has(this.foldersPath)) {
      this.mtimes.delete(this.foldersPath);
      this.folderList = [];
      changed = true;
    }
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
      if (path === this.foldersPath) continue;
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
    const folders = await seal(key, this.folders(), FOLDERS_BIND);
    const backup: Backup = { format: BACKUP_FORMAT, v: 1, created: new Date().toISOString(), count: entries.length, meta, entries, folders };
    return JSON.stringify(backup);
  }

  /**
   * Yedeği çözer. Parola verilmezse açık kasanın anahtarı denenir (aynı kasanın yedeği).
   * Parola yanlışsa null. Çözülemeyen kayıtlar atlanır ve sayılır.
   */
  async openBackup(b: Backup, password?: string): Promise<{ entries: Entry[]; folders: string[]; unreadable: number } | null> {
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
    let folders: string[] = [];
    if (b.folders) {
      try {
        const list = await open<unknown>(key, b.folders, FOLDERS_BIND);
        if (Array.isArray(list)) folders = list.filter((f): f is string => typeof f === "string");
      } catch {
        /* klasör listesi çözülemezse kayıtlardaki klasör adları yine gelir */
      }
    }
    return { entries, folders, unreadable };
  }

  /** folders.json'u okur; çözülemezse eski listeyi korur ve false döner. */
  private async loadFolders(path: string): Promise<boolean> {
    try {
      const file = JSON.parse(await this.fs.read(path)) as FoldersFile;
      const list = await open<unknown>(this.requireKey(), file.data, FOLDERS_BIND);
      if (!Array.isArray(list)) return false;
      this.folderList = sortFolders(list.filter((f): f is string => typeof f === "string" && !!f.trim()));
      return true;
    } catch {
      return false;
    }
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

export interface ImportPlan {
  /** Kasada olmayan, eklenecek kayıtlar. */
  fresh: Entry[];
  /** Kasada olan ve klasörsüz duran kayıtlar: dosyadaki klasöre alınacak. */
  refile: { entry: Entry; folder: string }[];
  /** Kasada olan, değişmeyecek kayıtlar (klasörü aynı ya da kullanıcı başka klasöre koymuş). */
  unchanged: number;
}

/**
 * İçe aktarılan kayıtları kasadakilerle karşılaştırır. Kasada olan kayıt tekrar eklenmez;
 * klasörsüzse dosyadaki klasöre alınır. Kullanıcının başka bir klasöre koyduğu kayda dokunulmaz.
 * `resolveFolder`: "oyun" gibi bir adı var olan "Oyun" klasörüne eşler.
 */
export function planImport(existing: Entry[], incoming: Entry[], resolveFolder: (name: string) => string = (n) => n.trim()): ImportPlan {
  const plan: ImportPlan = { fresh: [], refile: [], unchanged: 0 };
  const queued = new Set<string>();
  for (const n of incoming) {
    const folder = n.folder.trim() ? resolveFolder(n.folder) : "";
    const match = existing.find((e) => sameEntry(e, n));
    if (!match) {
      plan.fresh.push({ ...n, folder });
    } else if (folder && !match.folder.trim() && !queued.has(match.id)) {
      plan.refile.push({ entry: match, folder });
      queued.add(match.id);
    } else {
      plan.unchanged++;
    }
  }
  return plan;
}
