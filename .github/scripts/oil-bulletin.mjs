// Weekly fuel prices for Bulgaria from the EU Weekly Oil Bulletin (European Commission).
// Reproduction is authorised provided the source is acknowledged. No dependencies, no secrets.
// Usage: node oil-bulletin.mjs <out.json> [local.xlsx]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const URL_HISTORY = 'https://energy.ec.europa.eu/document/download/906e60ca-8b6a-44e7-8589-652854d2fd3f_en?filename=Weekly_Oil_Bulletin_Prices_History_maticni_4web.xlsx';
const [out, local] = process.argv.slice(2);
if (!out) throw new Error('usage: oil-bulletin.mjs <out.json> [local.xlsx]');

const buf = local ? readFileSync(local) : Buffer.from(await (await fetch(URL_HISTORY)).arrayBuffer());

// Minimal zip reader (central directory + raw deflate).
function unzip(b) {
  const files = {};
  const e = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = b.readUInt16LE(e + 10);
  let p = b.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20);
    const nl = b.readUInt16LE(p + 28), el = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32);
    const lho = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nl);
    const ds = lho + 30 + b.readUInt16LE(lho + 26) + b.readUInt16LE(lho + 28);
    const raw = b.subarray(ds, ds + csize);
    files[name] = () => (method === 0 ? raw : inflateRawSync(raw)).toString('utf8');
    p += 46 + nl + el + cl;
  }
  return files;
}
const z = unzip(buf);
const unxml = s => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const shared = [...z['xl/sharedStrings.xml']().matchAll(/<si>([\s\S]*?)<\/si>/g)]
  .map(m => unxml([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(x => x[1]).join('')));

// The first sheet is "Prices with taxes".
const wb = z['xl/workbook.xml']();
const first = wb.match(/<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/);
if (!/with taxes/i.test(first[1])) throw new Error('first sheet is not "Prices with taxes": ' + first[1]);
const rel = z['xl/_rels/workbook.xml.rels']().match(new RegExp('<Relationship [^>]*Id="' + first[2] + '"[^>]*>'))[0];
const target = rel.match(/Target="([^"]*)"/)[1].replace(/^\/?(xl\/)?/, 'xl/');
const sheet = z[target]();

const cells = row => {
  const m = {};
  for (const c of row.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const v = (c[3] || '').match(/<v>([^<]*)<\/v>/);
    if (v) m[c[1]] = /t="s"/.test(c[2]) ? shared[+v[1]] : v[1];
  }
  return m;
};
const rows = [...sheet.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)].map(r => cells(r[1]));
const head = rows[0];
const col = name => Object.keys(head).find(k => head[k] === name);
const cP = col('BG_price_with_tax_euro95'), cD = col('BG_price_with_tax_diesel'), cL = col('BG_price_with_tax_LPG');
if (!cP || !cD || !cL) throw new Error('Bulgaria columns not found');
// Row 3 holds the unit; it must be 1000 l for all three.
const unit = rows[2];
for (const c of [cP, cD, cL]) if (!/1000\s*l/i.test(unit[c] || '')) throw new Error('unexpected unit ' + unit[c]);

// Newest rows first; take the first row with all three Bulgarian prices.
for (const r of rows.slice(3)) {
  const serial = Number(r.A);
  const p = Number(r[cP]), d = Number(r[cD]), l = Number(r[cL]);
  if (!(serial > 40000) || !(p > 0) || !(d > 0) || !(l > 0)) continue;
  const week = new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
  const eur = x => Math.round(x) / 1000; // EUR per 1000 L -> EUR per L, to 0.001
  const json = JSON.stringify({ week, source: 'EU Weekly Oil Bulletin', eurPerL: { PETROL: eur(p), DIESEL: eur(d), LPG: eur(l) } }) + '\n';
  const old = existsSync(out) ? readFileSync(out, 'utf8') : '';
  if (old !== json) writeFileSync(out, json);
  console.log(json.trim());
  process.exit(0);
}
throw new Error('no Bulgarian row found');
