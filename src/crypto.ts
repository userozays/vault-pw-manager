// Şifreleme: ana parola → PBKDF2-SHA256 → AES-256-GCM anahtarı.
// Anahtar dışa aktarılamaz (extractable: false) ve yalnız bellekte durur.

export const KDF_ITERATIONS = 600_000;
const CHECK_PLAINTEXT = "okami-kasa-v1"; // eski kasalar açılabilsin diye değişmez

export interface Sealed {
  iv: string;
  ct: string;
}

export interface VaultMeta {
  v: 1;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number };
  salt: string;
  check: Sealed;
  created: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// `bind` kayıt kimliğini ek doğrulanmış veri olarak bağlar: bir kaydın şifreli
// içeriği başka bir dosyaya kopyalanırsa çözülmez.
export async function seal(key: CryptoKey, value: unknown, bind: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(bind) },
    key,
    enc.encode(JSON.stringify(value)),
  );
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function open<T>(key: CryptoKey, sealed: Sealed, bind: string): Promise<T> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(sealed.iv), additionalData: enc.encode(bind) },
    key,
    fromB64(sealed.ct),
  );
  return JSON.parse(dec.decode(pt)) as T;
}

export async function createMeta(password: string): Promise<{ meta: VaultMeta; key: CryptoKey }> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, KDF_ITERATIONS);
  const check = await seal(key, CHECK_PLAINTEXT, "meta");
  const meta: VaultMeta = {
    v: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS },
    salt: toB64(salt),
    check,
    created: new Date().toISOString(),
  };
  return { meta, key };
}

/** Parola yanlışsa null döner. */
export async function unlockMeta(meta: VaultMeta, password: string): Promise<CryptoKey | null> {
  const key = await deriveKey(password, fromB64(meta.salt), meta.kdf.iterations);
  try {
    const value = await open<string>(key, meta.check, "meta");
    return value === CHECK_PLAINTEXT ? key : null;
  } catch {
    return null;
  }
}

// ---- Parola üretici ve güç ölçer ----

const SETS = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%^&*-_=+?",
};

export interface GenOptions {
  length: number;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
}

function randomIndex(max: number): number {
  // Modulo yanlılığını önlemek için reddetme örneklemesi.
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
}

export function generatePassword(opts: GenOptions): string {
  const pools = [SETS.lower];
  if (opts.upper) pools.push(SETS.upper);
  if (opts.digits) pools.push(SETS.digits);
  if (opts.symbols) pools.push(SETS.symbols);
  const all = pools.join("");
  const chars = pools.map((p) => p[randomIndex(p.length)]);
  while (chars.length < opts.length) chars.push(all[randomIndex(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.slice(0, opts.length).join("");
}

/** 0–4 arası kaba güç puanı ve tahmini entropi (bit). */
export function strength(password: string): { score: 0 | 1 | 2 | 3 | 4; bits: number } {
  if (!password) return { score: 0, bits: 0 };
  let pool = 0;
  if (/[a-zçğıöşü]/.test(password)) pool += 26;
  if (/[A-ZÇĞİÖŞÜ]/.test(password)) pool += 26;
  if (/\d/.test(password)) pool += 10;
  if (/[^A-Za-z0-9çğıöşüÇĞİÖŞÜ]/.test(password)) pool += 20;
  const unique = new Set(password).size;
  const bits = Math.round(Math.log2(Math.max(pool, 2)) * Math.min(password.length, unique * 2));
  const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return { score, bits };
}
