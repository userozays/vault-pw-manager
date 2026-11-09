import { blankEntry, parseBitwarden, type Entry } from "./store";

// Tarayıcıların ve parola yöneticilerinin CSV dışa aktarımları: sütun adları farklı, içerik aynı.
// Başlıklar eş anlamlılarla eşlenir; tanınmayan sütunlar yok sayılır.

/** RFC 4180: tırnaklı alanlar, "" kaçışı, alan içinde satır sonu, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

const COLUMNS: Record<string, string[]> = {
  name: ["name", "title", "account", "account name", "item name"],
  url: ["url", "login_uri", "website", "web site", "uri", "login url", "address"],
  username: ["username", "login_username", "login name", "user", "user name", "email", "e-mail", "login"],
  password: ["password", "login_password", "pass"],
  notes: ["notes", "note", "extra", "comments", "comment"],
  folder: ["folder", "grouping", "group", "category"],
  favorite: ["favorite", "fav", "favourite"],
  totp: ["totp", "otpauth", "login_totp", "otp", "one-time password"],
  type: ["type"],
};

function hostName(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export interface ImportResult {
  format: string;
  entries: Entry[];
}

function detectFormat(headers: string[]): string {
  const h = headers.join(",");
  if (h.includes("login_uri") || h.includes("login_password")) return "Bitwarden CSV";
  if (h.includes("httprealm") || h.includes("formactionorigin")) return "Firefox";
  if (h.includes("grouping") && h.includes("extra")) return "LastPass";
  if (h.includes("otpauth") && h.includes("archived")) return "1Password";
  if (h.includes("otpauth")) return "Safari / Parolalar";
  if (h.includes("group") && h.includes("title")) return "KeePass";
  if (h.startsWith("name,url,username,password")) return "Chrome / Edge / Brave";
  return "CSV";
}

export function parseCsvExport(text: string): ImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("CSV dosyasında kayıt bulunamadı.");
  const headers = rows[0].map((x) => x.trim().toLowerCase());
  const col: Partial<Record<keyof typeof COLUMNS, number>> = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    const idx = headers.findIndex((hd) => names.includes(hd));
    if (idx >= 0) col[key as keyof typeof COLUMNS] = idx;
  }
  if (col.password === undefined && col.username === undefined) {
    throw new Error("Bu CSV bir parola dışa aktarımına benzemiyor (parola veya kullanıcı adı sütunu yok).");
  }
  const get = (r: string[], k: keyof typeof COLUMNS) => (col[k] === undefined ? "" : (r[col[k]!] ?? "").trim());
  const entries: Entry[] = [];
  for (const r of rows.slice(1)) {
    const url = get(r, "url");
    const username = get(r, "username");
    const password = r[col.password ?? -1] ?? ""; // parolada baştaki/sondaki boşluk korunur
    const isNote = get(r, "type").toLowerCase() === "note" || (!url && !username && !password);
    const e = blankEntry(isNote ? "note" : "login");
    e.url = url;
    e.username = username;
    e.password = password;
    e.name = get(r, "name") || (url ? hostName(url) : username) || "(adsız)";
    e.folder = get(r, "folder").split(/[\\/]/).pop() ?? "";
    e.favorite = ["1", "true", "yes", "evet"].includes(get(r, "favorite").toLowerCase());
    const totp = get(r, "totp");
    e.notes = [get(r, "notes"), totp ? `TOTP: ${totp}` : ""].filter(Boolean).join("\n\n");
    if (!e.url && !e.username && !e.password && !e.notes) continue;
    entries.push(e);
  }
  return { format: detectFormat(headers), entries };
}

/** Dosya içeriğine bakıp doğru içe aktarıcıyı seçer. */
export function parseImport(fileName: string, text: string): ImportResult {
  const trimmed = text.trimStart().replace(/^﻿/, "");
  if (fileName.toLowerCase().endsWith(".json") || trimmed.startsWith("{")) {
    return { format: "Bitwarden", entries: parseBitwarden(trimmed) };
  }
  return parseCsvExport(text);
}

// ---- CSV dışa aktarma ----

const csvField = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Giriş kayıtlarını name,url,username,password sütunlu CSV'ye çevirir (Chrome/Bitwarden içe aktarır). */
export function toCsv(entries: Entry[]): string {
  const rows = entries.filter((e) => e.type === "login").map((e) => [e.name, e.url, e.username, e.password]);
  return [["name", "url", "username", "password"], ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** Bitwarden'ın şifresiz .json biçimi: tüm kayıtlar, klasörler, notlar ve kartlarla (parseBitwarden'ın tersi). */
export function toBitwardenJson(entries: Entry[]): string {
  const names = [...new Set(entries.map((e) => e.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, "tr"));
  const folders = names.map((name) => ({ id: crypto.randomUUID(), name }));
  const folderId = new Map(folders.map((f) => [f.name, f.id]));
  const items = entries.map((e) => {
    const base = {
      id: e.id,
      folderId: folderId.get(e.folder) ?? null,
      type: e.type === "login" ? 1 : e.type === "card" ? 3 : 2,
      name: e.name,
      notes: e.notes || null,
      favorite: e.favorite,
      creationDate: e.created,
      revisionDate: e.updated,
    };
    if (e.type === "login") return { ...base, login: { username: e.username || null, password: e.password || null, totp: null, uris: e.url ? [{ match: null, uri: e.url }] : [] } };
    if (e.type === "card") {
      const [expMonth = "", expYear = ""] = e.card.expiry.split("/").map((x) => x.trim());
      return { ...base, card: { cardholderName: e.card.holder || null, brand: null, number: e.card.number || null, expMonth: expMonth || null, expYear: expYear || null, code: e.card.cvv || null } };
    }
    return { ...base, secureNote: { type: 0 } };
  });
  return JSON.stringify({ encrypted: false, folders, items }, null, 2);
}
