// Daily store prices for GroKo from the КЗП „Колко струва“ open data (kolkostruva.bg).
// Reads one daily zip (one CSV per chain), writes a compact feed. Node 20+, stdlib only, needs `unzip`.
// Usage: node groko-prices.mjs <day.zip> <outDir>     (writes <outDir>/groko/prices/v1/{meta.json,prices.json.gz})
//        node groko-prices.mjs --self-test
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';

const SOURCE = 'КЗП „Колко струва“ (kolkostruva.bg)';
const MAX_GZ = 2_000_000;
// Pharmacies, drugstores, perfumes, DIY, shops without groceries (matched on the chain name).
const NOT_GROCERY = /аптек|фарм|pharm|drog|дроге|douglas|дъглас|^дм българия|lilly|gstroy|бурлекс|ds home|емаг|emag|travel free|jumbo/i;
const MAX_CATEGORY = 85; // КЗП codes above 85 are DIY / non-food

// ---- decoding and CSV ----
export function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1251').decode(buf); }
}

function splitLine(line, d) {
  if (!line.includes('"')) return line.split(d);
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (q) return null; // truncated inside a quote
  out.push(cur);
  return out;
}

const FIELDS = [['населено', 'place'], ['обект', 'store'], ['наименование', 'name'], ['код', 'code'],
  ['категор', 'cat'], ['дребно', 'retail'], ['промо', 'promo']];
const num = s => { const v = Number(String(s).trim().replace(',', '.')); return Number.isFinite(v) ? v : NaN; };

// Returns [{store, name, code, cat, retail, promo}] (promo NaN when empty); broken rows are skipped.
export function parseCsv(text) {
  const lines = text.split('\n');
  const head = (lines[0] || '').replace(/\r$/, '');
  const d = [',', ';', '\t'].map(c => [c, head.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const hs = splitLine(head, d) || [];
  const idx = {};
  hs.forEach((h, i) => { const l = h.toLowerCase(); for (const [k, n] of FIELDS) if (idx[n] === undefined && l.includes(k)) { idx[n] = i; break; } });
  let start = 1;
  if (FIELDS.some(([, n]) => idx[n] === undefined)) { // no usable header: assume the documented order
    FIELDS.forEach(([, n], i) => { idx[n] = i; });
    if (!/\d/.test(hs[0] || '')) start = 1; else start = 0;
  }
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line) continue;
    const f = splitLine(line, d);
    if (!f || f.length < 7) continue;
    const retail = num(f[idx.retail]), cat = parseInt(f[idx.cat], 10);
    const name = f[idx.name].trim(), code = f[idx.code].trim();
    if (!name || !code || !(retail > 0) || retail > 10000 || !Number.isInteger(cat)) continue;
    rows.push({ store: f[idx.store], name, code, cat, retail, promo: f[idx.promo].trim() === '' ? NaN : num(f[idx.promo]) });
  }
  return rows;
}

// ---- pack size ----
const UNITS = { г: ['kg', 0.001], гр: ['kg', 0.001], g: ['kg', 0.001], gr: ['kg', 0.001], кг: ['kg', 1], kg: ['kg', 1],
  мл: ['l', 0.001], ml: ['l', 0.001], л: ['l', 1], l: ['l', 1], бр: ['pc', 1], броя: ['pc', 1], pcs: ['pc', 1], pc: ['pc', 1] };
const NUM = '(\\d+(?:[.,]\\d+)?)';
const UNIT = '(кг|kg|гр|gr|г|g|мл|ml|л|l|броя|бр|pcs|pc)(?![\\p{L}\\d])';
const SIZE = new RegExp(`(?<![\\p{L}\\d.])(?:(\\d+)\\s*[xх×*]\\s*)?${NUM}\\s*${UNIT}(?:\\s*[xх×*]\\s*(\\d+)(?!\\d))?`, 'giu');

// "Мляко 1,5 л" -> {q: 1.5, u: 'l'}; null when unknown, approximate ("ок. 750г", "~10кг"), multi-pack ("6 x 330 мл") or bulk (> 10 kg/l).
export function parseSize(name) {
  let best = null;
  for (const m of name.matchAll(SIZE)) {
    const [u, f] = UNITS[m[3].toLowerCase()];
    const before = name.slice(Math.max(0, m.index - 4), m.index).toLowerCase();
    if (/(ок\.?|~)\s*$/.test(before)) continue; // approximate weight
    if (m[1] || m[4]) continue; // multi-pack: the price may be per piece or per pack, so no size
    const q = num(m[2]) * f;
    if (!(q > 0) || q > 10) continue; // bulk / wholesale sizes are not shelf prices
    const r = { q: Math.round(q * 10000) / 10000, u };
    if (u !== 'pc') return r; // weight or volume wins over a piece count
    best ||= r;
  }
  if (!best && /на\s*кг(?!\p{L})/iu.test(name)) return { q: 1, u: 'kg' };
  return best;
}

// ---- aggregation of one chain ----
const med = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const r2 = x => Math.round(x * 100) / 100;

// Returns {products: {code: {n,c,s?,r,m,p,k}}, units: {cat: {kg?: [eur, code], l?: [eur, code]}}}.
export function aggregate(rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.cat > MAX_CATEGORY) continue;
    let e = by.get(r.code);
    if (!e) by.set(r.code, e = { name: r.name, cat: r.cat, rows: [] });
    e.rows.push(r);
  }
  const products = {}, units = {};
  for (const [code, e] of by) {
    const md = med(e.rows.map(r => r.retail));
    const ok = e.rows.filter(r => r.retail <= md * 4 && r.retail >= md / 4);
    if (!ok.length) continue;
    const prices = ok.map(r => r.retail);
    let promo = null;
    for (const r of ok) if (r.promo > 0 && r.promo < r.retail && r.promo >= md / 4 && (promo === null || r.promo < promo)) promo = r.promo;
    const p = { n: e.name, c: e.cat, r: r2(Math.min(...prices)), m: r2(med(prices)), p: promo === null ? null : r2(promo), k: ok.length };
    const size = parseSize(e.name);
    if (size) {
      p.s = `${size.q}${size.u}`;
      if (size.u !== 'pc') {
        const per = r2(p.r / size.q), cell = (units[e.cat] ||= {});
        if (!cell[size.u] || per < cell[size.u][0]) cell[size.u] = [per, code];
      }
    }
    products[code] = p;
  }
  return { products, units };
}

export const chainName = file => file.replace(/\.csv$/i, '').replace(/_(\d+)$/, '');
const eikOf = file => (file.replace(/\.csv$/i, '').match(/_(\d+)$/) || [])[1] || '';
const shortName = n => n.replace(/\s*\([^)]*\)\s*$/, '').trim() || n; // drop the "(legal entity)" suffix

// ---- build ----
function buildFeed(chains, date, dropSingles) {
  const feed = { v: 1, date, chains: {} };
  for (const c of chains) {
    const products = {};
    for (const [code, p] of Object.entries(c.products)) if (!(dropSingles && p.k === 1)) products[code] = p;
    feed.chains[c.eik] = { p: products, u: c.units };
  }
  return feed;
}

function main(zip, outDir) {
  const date = (basename(zip).match(/\d{4}-\d{2}-\d{2}/) || [new Date().toISOString().slice(0, 10)])[0];
  const tmp = mkdtempSync(join(tmpdir(), 'kzp-'));
  const chains = [], dropped = [], cats = {};
  try {
    execFileSync('unzip', ['-q', '-o', zip, '-d', tmp], { stdio: 'inherit' });
    for (const f of readdirSync(tmp).filter(x => /\.csv$/i.test(x)).sort()) {
      const full = chainName(f);
      if (NOT_GROCERY.test(full)) { dropped.push(full); continue; }
      const rows = parseCsv(decode(readFileSync(join(tmp, f))));
      const { products, units } = aggregate(rows);
      const n = Object.keys(products).length;
      if (!n) { dropped.push(full + ' (no grocery rows)'); continue; }
      for (const p of Object.values(products)) cats[p.c] = null;
      const stores = new Set(rows.map(r => r.store)).size;
      chains.push({ name: shortName(full), eik: eikOf(f), stores, products, units, rows: rows.length });
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  if (!chains.length) throw new Error('no chains parsed');

  let dropSingles = false, gz = gzipSync(JSON.stringify(buildFeed(chains, date, false)), { level: 9 });
  if (gz.length > MAX_GZ) { dropSingles = true; gz = gzipSync(JSON.stringify(buildFeed(chains, date, true)), { level: 9 }); }
  const feed = buildFeed(chains, date, dropSingles);
  const meta = {
    date, generated: new Date().toISOString(), source: SOURCE,
    chains: chains.map(c => ({ name: c.name, eik: c.eik, stores: c.stores, products: Object.keys(feed.chains[c.eik].p).length })),
    categories: Object.fromEntries(Object.keys(cats).sort((a, b) => a - b).map(k => [k, null])),
  };
  const dir = join(outDir, 'groko', 'prices', 'v1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prices.json.gz'), gz);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');

  const all = chains.flatMap(c => Object.entries(feed.chains[c.eik].p).map(([code, p]) => `${c.name} | ${code} | ${JSON.stringify(p)}`));
  const sample = Array.from({ length: Math.min(20, all.length) }, () => all.splice(Math.floor(Math.random() * all.length), 1)[0]);
  writeFileSync(join(outDir, 'sample.txt'), sample.join('\n') + '\n');

  console.log(`date ${date}; gz ${gz.length} bytes; dropSingles=${dropSingles}; dropped chains: ${dropped.join('; ')}`);
  for (const c of meta.chains) console.log(`${c.name} (${c.eik}): stores ${c.stores}, products ${c.products}, csv rows ${chains.find(x => x.eik === c.eik).rows}`);
}

// ---- self test ----
function selfTest() {
  const H = 'Населено място,Търговски обект,Наименование на продукта,Код на продукта,Категория,Цена на дребно,Цена в промоция\n';
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(H + '1,"Sofia, A",Мляко 1,5 л,..\n', 'utf8')]);
  assert.equal(decode(bom).charCodeAt(0), 0x41d); // BOM stripped, first char is "Н"
  const cp = Buffer.from(new Uint8Array([0xcd, 0xe0, 0xe8, 0xec])); // "Наим" in cp1251, invalid utf-8
  assert.equal(decode(cp), 'Наим');

  // ';' + quoted commas, promo 0, promo >= retail, truncated rows, bad price
  const semi = H.replace(/,/g, ';') +
    '1;"Shop, 1";Прясно мляко 1,5 л;A1;6;"1,50";0\n' +
    '1;Shop 2;Прясно мляко 1,5 л;A1;6;1.60;1.20\n' +
    '1;Shop 3;Прясно мляко 1,5 л;A1;6;1.40;1.40\n' +
    '1;Shop 4;Прясно мляко 1,5 л;A1;6;99.00;\n' + // outlier (>4x median)
    '1;Shop 5;Прясно мляко 1,5 л;A1;6\n' + // truncated
    '1;"Shop 6;Прясно мляко 1,5 л;A1;6;1.5;\n' + // open quote
    '1;Shop 7;Сирене;B1;9;abc;\n' + // bad price
    '1;Shop 8;Бои;D1;90;5.00;\n'; // DIY category
  let rows = parseCsv(semi);
  assert.equal(rows.length, 5);
  assert.ok(Number.isNaN(rows[0].promo) === false && rows[0].promo === 0);
  let a = aggregate(rows).products;
  assert.deepEqual(Object.keys(a), ['A1']);
  assert.equal(a.A1.r, 1.4); assert.equal(a.A1.m, 1.5); assert.equal(a.A1.k, 3);
  assert.equal(a.A1.p, 1.2); // promo 0 and promo == retail ignored, 1.2 < 1.6 kept
  assert.equal(a.A1.s, '1.5l');

  const tab = H.replace(/,/g, '\t') + '1\tShop\tХляб 500 г\tH1\t1\t1,10\t\n1\tShop 2\tХляб 500 г\tH1\t1\t1,30\t\n';
  rows = parseCsv(tab);
  assert.equal(rows.length, 2);
  a = aggregate(rows);
  assert.equal(a.products.H1.s, '0.5kg');
  assert.deepEqual(a.units[1].kg, [2.2, 'H1']); // 1.10 / 0.5

  // header-less substring match with reordered columns
  rows = parseCsv('Цена на дребно,Цена в промоция,Категория,Код на продукта,Наименование на продукта,Търговски обект,Населено място\n2.5,,5,Z,Яйца 10 бр,S,1\n');
  assert.equal(rows[0].name, 'Яйца 10 бр'); assert.equal(rows[0].retail, 2.5);

  // pack sizes
  const t = (n, q, u) => { const s = parseSize(n); assert.deepEqual(s && [s.q, s.u], q === null ? null : [q, u], n); };
  t('Мляко 1,5 л', 1.5, 'l'); t('Сирене 500 г', 0.5, 'kg'); t('450 ГР. СЕЛСКИ ХЛЯБ', 0.45, 'kg');
  t('Бира 6 x 330 мл', null); t('Вода 1.5L x6', null); t('бисквити,2x225g', null); t('~10КГ МОРКОВ', null); t('Сол 1кг х10бр', null); t('Кайма 70-30 кг.', null);
  t('Krina Боб, 1кг-плик', 1, 'kg'); t('Яйца 10 бр. L', 10, 'pc'); t('Домати на кг', 1, 'kg');
  t('Свинско месо, ок.750г-атм', null); t('Кисело мляко 2,9%', null); t('Хляб Добруджа', null);
  t('Нектар 1л 12 бр', 1, 'l'); t('Колбас 100 грама', null);

  console.log('self-test ok');
}

if (process.argv[2] === '--self-test') selfTest();
else if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const [zip, out] = process.argv.slice(2);
  if (!zip || !out) throw new Error('usage: groko-prices.mjs <day.zip> <outDir> | --self-test');
  main(zip, out);
}
