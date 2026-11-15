// Web photo search + price suggestions (Brave Search API) and safe image import.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fc') || l.startsWith('fd') || /^fe[89ab]/.test(l)) return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIp(mapped[1]) : false;
  }
  return true;
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function siteOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Pull £ prices out of a snippet of text -> [{ pence, context }]
function extractPrices(text) {
  const found = [];
  const re = /£\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\b(\d{1,2})p\b/g;
  let m;
  while ((m = re.exec(text))) {
    let pence;
    if (m[3]) pence = Number(m[3]);
    else {
      const pounds = Number(m[1].replace(/,/g, ''));
      const frac = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
      pence = pounds * 100 + frac;
    }
    if (!Number.isFinite(pence) || pence < 1 || pence > 10000000000) continue;
    const start = Math.max(0, m.index - 45);
    found.push({ pence, context: text.slice(start, m.index + m[0].length + 45).trim() });
  }
  return found;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

module.exports = function createWebSearch({ uploadsDir }) {
  const KEY = process.env.BRAVE_API_KEY || '';
  const BASE = (process.env.BRAVE_API_BASE || 'https://api.search.brave.com').replace(/\/$/, '');
  const GAP = Number(process.env.BRAVE_MIN_GAP_MS) || 1100; // free plan: 1 request per second
  const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_FETCH === '1'; // tests only
  const PAGE = 3;
  const okUrl = (u) => (ALLOW_PRIVATE ? /^https?:\/\//i : /^https:\/\//i).test(u || '');

  let lastCall = 0;
  let chain = Promise.resolve();
  function brave(pathname, params) {
    const run = async () => {
      const wait = lastCall + GAP - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      const url = new URL(BASE + pathname);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': KEY },
        signal: AbortSignal.timeout(12000),
      });
      if (res.status === 401 || res.status === 403 || res.status === 422) throw new Error('Search key was rejected - check BRAVE_API_KEY');
      if (res.status === 429) throw new Error('Search limit reached - try again in a moment');
      if (!res.ok) throw new Error('Search failed (' + res.status + ')');
      return res.json();
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  const searchCache = new Map(); // query -> { at, items }
  const tokens = new Map();      // image token -> { full, thumb, at }
  function sweep() {
    const now = Date.now();
    for (const [k, v] of searchCache) if (now - v.at > 10 * 60 * 1000) searchCache.delete(k);
    for (const [k, v] of tokens) if (now - v.at > 30 * 60 * 1000) tokens.delete(k);
  }

  async function imageSearch(query, page) {
    if (!KEY) throw new Error('Photo search is not set up (add BRAVE_API_KEY on the server)');
    sweep();
    const q = String(query || '').trim().slice(0, 120);
    if (!q) throw new Error('Type something to search for');
    const key = q.toLowerCase();
    let entry = searchCache.get(key);
    if (!entry) {
      const data = await brave('/res/v1/images/search', { q, count: 30, safesearch: 'strict', country: 'gb', search_lang: 'en' });
      const seen = new Set();
      const items = [];
      for (const r of data.results || []) {
        const thumb = r.thumbnail && r.thumbnail.src;
        const full = (r.properties && r.properties.url) || '';
        if (!thumb || !okUrl(thumb)) continue;
        if (/\.svg(\?|$)/i.test(full)) continue;
        const dedupe = full || thumb;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        items.push({
          thumb,
          full: okUrl(full) ? full : '',
          title: stripHtml(r.title).slice(0, 100),
          site: r.source || siteOf(r.url),
          pageUrl: /^https?:\/\//i.test(r.url || '') ? r.url : '',
          w: (r.properties && r.properties.width) || 0,
          h: (r.properties && r.properties.height) || 0,
        });
      }
      entry = { at: Date.now(), items };
      searchCache.set(key, entry);
    }
    const pages = Math.max(1, Math.ceil(entry.items.length / PAGE));
    const p = entry.items.length ? ((Number(page) || 0) % pages + pages) % pages : 0;
    const slice = entry.items.slice(p * PAGE, p * PAGE + PAGE).map((it) => {
      const id = crypto.randomBytes(12).toString('hex');
      tokens.set(id, { full: it.full, thumb: it.thumb, at: Date.now() });
      return { id, thumb: it.thumb, title: it.title, site: it.site, pageUrl: it.pageUrl, w: it.w, h: it.h };
    });
    return { items: slice, page: p, pages: entry.items.length ? pages : 0, total: entry.items.length };
  }

  async function assertPublic(host) {
    if (ALLOW_PRIVATE) return;
    if (net.isIP(host)) {
      if (isPrivateIp(host)) throw new Error('Blocked address');
      return;
    }
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Blocked address');
  }

  async function download(url, hops = 0) {
    if (hops > 3) throw new Error('Too many redirects');
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(ALLOW_PRIVATE && u.protocol === 'http:')) throw new Error('Only https images are allowed');
    await assertPublic(u.hostname.replace(/^\[|\]$/g, ''));
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Accept: 'image/*', 'User-Agent': 'Mozilla/5.0 (price-is-right-show)' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      return download(new URL(res.headers.get('location'), u).toString(), hops + 1);
    }
    if (!res.ok) throw new Error('Image download failed (' + res.status + ')');
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!EXT[type]) throw new Error('That is not a JPG, PNG, WebP or GIF');
    const declared = Number(res.headers.get('content-length'));
    if (declared && declared > MAX_IMAGE_BYTES) throw new Error('Image is too large');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) throw new Error('Image is too large');
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), ext: EXT[type] };
  }

  async function imageImport(id) {
    sweep();
    const tok = tokens.get(String(id || ''));
    if (!tok) throw new Error('That result expired - search again');
    let img = null;
    let lastErr = null;
    for (const url of [tok.full, tok.thumb]) {
      if (!url) continue;
      try { img = await download(url); break; } catch (err) { lastErr = err; }
    }
    if (!img) throw lastErr || new Error('Could not download that image');
    const name = crypto.randomUUID() + img.ext;
    fs.writeFileSync(path.join(uploadsDir, name), img.buffer);
    return '/uploads/' + name;
  }

  async function priceSuggest(query) {
    if (!KEY) throw new Error('Price suggestions are not set up (add BRAVE_API_KEY on the server)');
    const q = String(query || '').trim().slice(0, 120);
    if (!q) throw new Error('Enter an item name first');
    const data = await brave('/res/v1/web/search', { q: q + ' price UK', count: 15, country: 'gb', search_lang: 'en', safesearch: 'moderate', extra_snippets: 'true' });
    const items = [];
    const seen = new Set();
    for (const r of (data.web && data.web.results) || []) {
      const text = stripHtml([r.title, r.description, ...(r.extra_snippets || [])].join(' . '));
      const site = siteOf(r.url);
      let taken = 0;
      for (const hit of extractPrices(text)) {
        const key = hit.pence + '|' + site;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ pence: hit.pence, site, url: r.url, context: hit.context });
        if (++taken >= 2) break;
      }
    }
    const typical = items.length >= 3 ? median(items.map((i) => i.pence)) : null;
    // Prefer prices close to the typical one; keeps outliers (delivery fees, multipacks) at the end.
    if (typical) items.sort((a, b) => Math.abs(Math.log(a.pence / typical)) - Math.abs(Math.log(b.pence / typical)));
    return { items: items.slice(0, 6), typical, found: items.length };
  }

  return { enabled: Boolean(KEY), imageSearch, imageImport, priceSuggest };
};
module.exports.extractPrices = extractPrices;
module.exports.isPrivateIp = isPrivateIp;
