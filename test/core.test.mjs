import { test } from "node:test";
import assert from "node:assert/strict";
import { Vault, blankEntry, parseBitwarden, generatePassword, strength, DIR, toCsv, toBitwardenJson, parseCsvExport } from "../dist/core.mjs";

class MemFs {
  constructor() { this.files = new Map(); this.dirs = new Set(); this.t = 0; }
  async exists(p) { return this.files.has(p) || this.dirs.has(p); }
  async read(p) { if (!this.files.has(p)) throw new Error("yok " + p); return this.files.get(p).data; }
  async write(p, data) { this.files.set(p, { data, mtime: ++this.t }); }
  async remove(p) { this.files.delete(p); }
  async mkdir(p) { this.dirs.add(p); }
  async list(p) { return { files: [...this.files.keys()].filter(k => k.startsWith(p + "/")), folders: [] }; }
  async stat(p) { const f = this.files.get(p); return f ? { mtime: f.mtime } : null; }
}

test("kasa oluştur, kaydet, kilitle, aç", async () => {
  const fs = new MemFs(); const v = new Vault(fs);
  assert.equal(await v.isInitialized(), false);
  await v.create("doğru-at-pil-zımba");
  const e = blankEntry(); e.name = "Gmail"; e.username = "ozay@example.com"; e.password = "Çok-Gizli-123!";
  await v.save(e);
  v.lock();
  assert.equal(v.unlocked, false);
  assert.equal(await v.unlock("yanlış"), false);
  assert.equal(await v.unlock("doğru-at-pil-zımba"), true);
  const got = v.all();
  assert.equal(got.length, 1);
  assert.equal(got[0].password, "Çok-Gizli-123!");
});

test("diskte hiçbir düz metin yok", async () => {
  const fs = new MemFs(); const v = new Vault(fs);
  await v.create("ana-parola-örnek");
  const e = blankEntry(); e.name = "Banka Hesabım"; e.username = "12345678901"; e.password = "P@rola-Xyz-987"; e.notes = "gizli not metni";
  await v.save(e);
  const disk = [...fs.files.values()].map(f => f.data).join("\n");
  for (const s of ["Banka Hesabım", "12345678901", "P@rola-Xyz-987", "gizli not metni", "ana-parola-örnek"]) assert.ok(!disk.includes(s), "sızıntı: " + s);
});

test("başka dosyaya kopyalanan şifreli içerik çözülmez", async () => {
  const fs = new MemFs(); const v = new Vault(fs);
  await v.create("pw");
  const a = blankEntry(); a.name = "A"; await v.save(a);
  const b = blankEntry(); b.name = "B"; await v.save(b);
  const pa = `${DIR}/k-${a.id}.json`, pb = `${DIR}/k-${b.id}.json`;
  const fa = JSON.parse(fs.files.get(pa).data);
  fs.write(pb, JSON.stringify({ v: 1, id: b.id, data: fa.data })); // a'nın içeriği b'nin dosyasına
  const v2 = new Vault(fs);
  assert.equal(await v2.unlock("pw"), true);
  const r = await v2.refresh();
  assert.deepEqual(v2.all().map(x => x.name), ["A"]);
});

test("öbür makineden gelen ekleme ve silme yakalanır", async () => {
  const fs = new MemFs(); const mac = new Vault(fs); await mac.create("pw");
  const win = new Vault(fs); assert.equal(await win.unlock("pw"), true);
  const e = blankEntry(); e.name = "Yeni"; await mac.save(e);
  assert.equal((await win.refresh()).changed, true);
  assert.equal(win.all().length, 1);
  await mac.remove(e.id);
  assert.equal((await win.refresh()).changed, true);
  assert.equal(win.all().length, 0);
});

test("Bitwarden içe aktarma eşlemesi", () => {
  const json = JSON.stringify({ encrypted: false, folders: [{ id: "f1", name: "Banka" }], items: [
    { type: 1, name: "Bank", folderId: "f1", login: { username: "u", password: "p", uris: [{ uri: "https://bank.example" }] } },
    { type: 2, name: "Not", notes: "metin" },
    { type: 3, name: "Kart", card: { cardholderName: "Ö", number: "4111", expMonth: "1", expYear: "2030", code: "123" } },
  ]});
  const r = parseBitwarden(json);
  assert.equal(r.length, 3);
  assert.deepEqual([r[0].type, r[0].folder, r[0].url, r[0].password], ["login", "Banka", "https://bank.example", "p"]);
  assert.equal(r[1].type, "note"); assert.equal(r[1].notes, "metin");
  assert.deepEqual(r[2].card, { holder: "Ö", number: "4111", expiry: "1/2030", cvv: "123" });
  assert.throws(() => parseBitwarden(JSON.stringify({ encrypted: true, items: [] })));
});

test("parola üretici ve güç", () => {
  const p = generatePassword({ length: 24, upper: true, digits: true, symbols: true });
  assert.equal(p.length, 24);
  assert.ok(/[A-Z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p));
  assert.ok(strength(p).score >= 3);
  assert.equal(strength("123").score, 0);
});

import { parseCsv, parseImport } from "../dist/core.mjs";

test("CSV ayrıştırıcı: tırnak, kaçış, satır içi satır sonu, BOM", () => {
  const rows = parseCsv('﻿a,b,c\r\n"x, y","he said ""hi""","çok\nsatır"\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["x, y", 'he said "hi"', "çok\nsatır"]]);
});

test("Chrome / Safari / Firefox / LastPass / KeePass CSV eşlemesi", () => {
  const chrome = parseImport("Chrome Passwords.csv", "name,url,username,password,note\nGitHub,https://github.com/login,ozay,p1,not\n");
  assert.equal(chrome.format, "Chrome / Edge / Brave");
  assert.deepEqual([chrome.entries[0].name, chrome.entries[0].url, chrome.entries[0].username, chrome.entries[0].password, chrome.entries[0].notes], ["GitHub", "https://github.com/login", "ozay", "p1", "not"]);

  const safari = parseImport("Passwords.csv", "Title,URL,Username,Password,Notes,OTPAuth\nGmail,https://accounts.google.com,a@b.c,p2,,otpauth://totp/x?secret=ABC\n");
  assert.equal(safari.format, "Safari / Parolalar");
  assert.match(safari.entries[0].notes, /TOTP: otpauth/);

  const ff = parseImport("logins.csv", '"url","username","password","httpRealm","formActionOrigin","guid"\n"https://www.x.com","u","p3","","",""\n');
  assert.equal(ff.format, "Firefox");
  assert.equal(ff.entries[0].name, "x.com");

  const lp = parseImport("lastpass.csv", "url,username,password,totp,extra,name,grouping,fav\nhttps://a.com,u,p4,,ek,A,İş\\Sunucu,1\n");
  assert.equal(lp.format, "LastPass");
  assert.deepEqual([lp.entries[0].folder, lp.entries[0].favorite, lp.entries[0].notes], ["Sunucu", true, "ek"]);

  const kp = parseImport("keepass.csv", '"Group","Title","Username","Password","URL","Notes"\n"Root/Banka","Enpara","u","p5","https://enpara.com",""\n');
  assert.equal(kp.format, "KeePass");
  assert.deepEqual([kp.entries[0].folder, kp.entries[0].name], ["Banka", "Enpara"]);
});

test("parolası olmayan CSV reddedilir, JSON Bitwarden'a gider", () => {
  assert.throws(() => parseImport("x.csv", "isim,yaş\nAli,3\n"));
  const bw = parseImport("bw.json", JSON.stringify({ encrypted: false, folders: [], items: [{ type: 1, name: "A", login: { username: "u", password: "p" } }] }));
  assert.equal(bw.format, "Bitwarden");
  assert.equal(bw.entries.length, 1);
});

test("CSV dışa aktarım yalnız girişleri yazar ve geri okunur", () => {
  const a = blankEntry("login"); a.name = "Gmail, kişisel"; a.url = "https://accounts.google.com"; a.username = "ozay"; a.password = 'a"b,c\nd';
  const n = blankEntry("note"); n.name = "Not";
  const csv = toCsv([a, n]);
  assert.ok(csv.startsWith("name,url,username,password\r\n"));
  const back = parseCsvExport(csv).entries;
  assert.equal(back.length, 1);
  assert.deepEqual([back[0].name, back[0].url, back[0].username, back[0].password], [a.name, a.url, a.username, a.password]);
});

test("Bitwarden JSON dışa aktarımı geri okunur: giriş, not, kart, klasör", () => {
  const a = blankEntry("login"); a.name = "Gmail"; a.folder = "Google"; a.url = "https://accounts.google.com"; a.username = "ozay"; a.password = "Çok-Gizli-1!"; a.favorite = true;
  const n = blankEntry("note"); n.name = "e-Devlet"; n.folder = "Devlet & Okul"; n.notes = "TC: 123\nşifre: x";
  const c = blankEntry("card"); c.name = "Garanti Kredi Kartı"; c.folder = "Banka"; c.card = { holder: "ÖZAY", number: "4111111111111111", expiry: "08/2029", cvv: "123" };
  const back = parseBitwarden(toBitwardenJson([a, n, c]));
  const pick = (e) => ({ type: e.type, name: e.name, folder: e.folder, url: e.url, username: e.username, password: e.password, notes: e.notes, card: e.card, favorite: e.favorite });
  assert.deepEqual(back.map(pick), [a, n, c].map(pick));
});

test("toplu okuma (scan + readMany) varsa tek çağrıyla açılır", async () => {
  const fs = new MemFs();
  const calls = { scan: 0, readMany: 0, read: 0, stat: 0 };
  const read = fs.read.bind(fs), stat = fs.stat.bind(fs);
  fs.read = (p) => (calls.read++, read(p));
  fs.stat = (p) => (calls.stat++, stat(p));
  fs.scan = async (dir) => (calls.scan++, [...fs.files].filter(([k]) => k.startsWith(dir + "/")).map(([path, f]) => ({ path, mtime: f.mtime })));
  fs.readMany = async (paths) => (calls.readMany++, paths.map((p) => fs.files.get(p)?.data ?? null));
  const v = new Vault(fs);
  await v.create("doğru-at-pil-zımba");
  for (let i = 0; i < 5; i++) { const e = blankEntry(); e.name = `K${i}`; await v.save(e); }
  v.lock();
  Object.assign(calls, { scan: 0, readMany: 0, read: 0, stat: 0 });
  assert.equal(await v.unlock("doğru-at-pil-zımba"), true);
  assert.equal(v.all().length, 5);
  assert.deepEqual(calls, { scan: 1, readMany: 1, read: 1, stat: 0 }); // read: yalnız meta.json
});

