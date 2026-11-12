// Persistent storage for the round list.
// - DATABASE_URL set  -> Postgres (Railway Postgres plugin). Survives redeploys.
// - otherwise         -> JSON file in DATA_DIR (point DATA_DIR at a Railway Volume to persist).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'default-rounds.json'), 'utf-8'));

function sanitize(list) {
  if (!Array.isArray(list)) throw new Error('Rounds must be an array');
  if (list.length > 200) throw new Error('Too many rounds');
  return list.map((r, i) => {
    const name = String(r && r.name || '').trim().slice(0, 140);
    const price = Number(r && r.price);
    if (!name) throw new Error(`Round ${i + 1}: name is required`);
    if (!Number.isFinite(price) || price < 0) throw new Error(`Round ${i + 1}: invalid price`);
    let seconds = Math.round(Number(r.seconds) || 45);
    seconds = Math.min(300, Math.max(10, seconds));
    return {
      id: String(r.id || crypto.randomUUID()),
      name,
      price: Math.round(price * 100) / 100,
      seconds
    };
  });
}

function createFileBackend() {
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const file = path.join(dir, 'rounds.json');
  return {
    kind: `file (${file})`,
    async load() {
      try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
    },
    async save(rounds) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(rounds, null, 2));
      fs.renameSync(tmp, file);
    }
  };
}

function createPgBackend(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(url) ? false : { rejectUnauthorized: false }
  });
  const ready = pool.query('CREATE TABLE IF NOT EXISTS tpir_kv (key TEXT PRIMARY KEY, value JSONB NOT NULL)');
  return {
    kind: 'postgres',
    async load() {
      await ready;
      const r = await pool.query("SELECT value FROM tpir_kv WHERE key = 'rounds'");
      return r.rows[0] ? r.rows[0].value : null;
    },
    async save(rounds) {
      await ready;
      await pool.query(
        "INSERT INTO tpir_kv (key, value) VALUES ('rounds', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [JSON.stringify(rounds)]
      );
    }
  };
}

const backend = process.env.DATABASE_URL ? createPgBackend(process.env.DATABASE_URL) : createFileBackend();
let cache = null;

async function init() {
  const stored = await backend.load();
  if (stored) {
    cache = sanitize(stored);
  } else {
    cache = sanitize(seed);
    await backend.save(cache);
  }
  console.log(`Rounds store: ${backend.kind}, ${cache.length} rounds`);
}

module.exports = {
  init,
  getAll: () => cache,
  async setAll(list) {
    const clean = sanitize(list);
    await backend.save(clean);
    cache = clean;
    return clean;
  },
  kind: () => backend.kind
};
