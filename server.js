const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const PIN = process.env.HOST_PIN || '1234';
const AUDIO = new Set(['intro.mp3', 'r1.mp3', 'end.mp3', 'dingding.mp3', 'reveal.mp3', 'scores.mp3']);
const BEDS = ['r1.mp3'];

function dataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return path.join(ROOT, 'data');
}

const DATA = dataDir();
const UPLOADS = path.join(DATA, 'uploads');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const LIVE_FILE = path.join(DATA, 'live.json');
fs.mkdirSync(UPLOADS, { recursive: true });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadSettings() {
  const saved = readJson(SETTINGS_FILE);
  const base = saved || readJson(path.join(ROOT, 'data', 'default.json'));
  return {
    showTitle: String(base.showTitle || "WMROCU'S"),
    showSubtitle: String(base.showSubtitle || 'PRICE IS RIGHT'),
    tagline: String(base.tagline || ''),
    contentPack: Number(base.contentPack) || 0,
    rounds: Array.isArray(base.rounds) ? base.rounds.map(cleanRound) : [],
  };
}

function cleanRound(raw, index) {
  const price = Number(raw.pricePence);
  return {
    id: safeId(raw.id) || crypto.randomUUID(),
    title: String(raw.title || 'Item').slice(0, 160),
    short: String(raw.short || '').slice(0, 24),
    source: String(raw.source || '').slice(0, 80),
    points: Array.isArray(raw.points) ? raw.points.map((item) => String(item).slice(0, 80)).filter(Boolean).slice(0, 8) : [],
    pricePence: Number.isFinite(price) ? Math.max(0, Math.round(price)) : 0,
    image: safeImage(raw.image),
    audio: raw.audio === '' ? '' : AUDIO.has(raw.audio) ? raw.audio : (BEDS[index] || ''),
  };
}

function safeId(id) {
  if (typeof id === 'string' && /^[a-zA-Z0-9-]{4,80}$/.test(id)) return id;
  return '';
}

function safeImage(url) {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('/uploads/') || url.startsWith('/seed/') || url.startsWith('/rounds/')) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return url;
  } catch {
    return '';
  }
  return '';
}

function audioFile() {
  return fs.existsSync(path.join(ROOT, 'r1.mp3')) ? '/audio/r1.mp3' : '';
}

let settings = loadSettings();
let phase = 'title';
let roundIndex = 0;
let bidsIn = false;
let roundEndsAt = 0;
let roundTimedOut = false;
let roundTimer = null;
let players = [];
let sessionCode = '';
let sessionStartedAt = Date.now();
let cueSeq = 0;
let cue = { seq: 0, name: '' };
const hosts = new Set();

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i += 1) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

function loadLive() {
  const live = readJson(LIVE_FILE);
  if (!live) return;
  if (['title', 'guessing', 'revealed', 'podium'].includes(live.phase)) phase = live.phase;
  roundIndex = Number.isInteger(live.roundIndex) ? live.roundIndex : 0;
  bidsIn = Boolean(live.bidsIn);
  roundEndsAt = Number(live.roundEndsAt) || 0;
  roundTimedOut = Boolean(live.roundTimedOut);
  if (typeof live.sessionCode === 'string' && live.sessionCode) sessionCode = live.sessionCode;
  sessionStartedAt = Number(live.sessionStartedAt) || Date.now();
  if (Array.isArray(live.players)) {
    players = live.players.map((p) => ({
      id: safeId(p.id) || crypto.randomUUID(),
      token: typeof p.token === 'string' ? p.token.slice(0, 80) : crypto.randomUUID(),
      name: cleanName(p.name),
      guesses: p.guesses && typeof p.guesses === 'object' ? p.guesses : {},
      sockets: new Set(),
    })).filter((p) => p.name);
  }
  if (roundIndex >= settings.rounds.length) roundIndex = 0;
}

function persistSettings() {
  try {
    writeJson(SETTINGS_FILE, settings);
  } catch (err) {
    console.error('Could not save settings:', err.message);
  }
}

if (/neil/i.test(settings.showTitle) || /Neil/.test(settings.tagline)) {
  if (/neil/i.test(settings.showTitle)) settings.showTitle = "WMROCU'S";
  settings.tagline = settings.tagline.replace(/Neil/g, 'host');
  persistSettings();
}
if ((settings.contentPack || 0) < 2) {
  const fresh = readJson(path.join(ROOT, 'data', 'default.json'));
  if (fresh && Array.isArray(fresh.rounds)) {
    settings.rounds = fresh.rounds.map(cleanRound);
    settings.contentPack = 2;
    persistSettings();
  }
}

function persistLive() {
  try {
    writeJson(LIVE_FILE, {
      phase,
      roundIndex,
      bidsIn,
      roundEndsAt,
      roundTimedOut,
      sessionCode,
      sessionStartedAt,
      players: players.map((p) => ({
        id: p.id,
        token: p.token,
        name: p.name,
        guesses: p.guesses,
      })),
    });
  } catch (err) {
    console.error('Could not save live state:', err.message);
  }
}

loadLive();
if (!sessionCode || Date.now() - sessionStartedAt >= 60 * 60 * 1000) {
  sessionCode = makeCode();
  sessionStartedAt = Date.now();
  phase = 'title';
  roundIndex = 0;
  bidsIn = false;
  roundEndsAt = 0;
  players = [];
  persistLive();
}

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

function pinOk(pin) {
  const got = Buffer.from(String(pin || ''));
  const want = Buffer.from(PIN);
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

function revealedThrough() {
  if (phase === 'title') return 0;
  if (phase === 'podium') return settings.rounds.length;
  if (phase === 'revealed') return roundIndex + 1;
  return roundIndex;
}

function pushCue(name) {
  cueSeq += 1;
  cue = { seq: cueSeq, name };
}

function awardsFor(round) {
  const price = round.pricePence;
  const played = [];
  players.forEach((p) => {
    const guess = p.guesses[round.id];
    if (guess == null) return;
    played.push({ id: p.id, guess: Number(guess), offset: Math.abs(Number(guess) - price) });
  });
  const eligible = played
    .filter((item) => item.guess <= price)
    .sort((a, b) => a.offset - b.offset);
  const map = {};
  players.forEach((p) => {
    map[p.id] = p.guesses[round.id] == null ? null : 0;
  });
  if (!eligible.length) return map;
  const first = eligible[0].offset;
  const next = eligible.find((item) => item.offset !== first);
  const second = next ? next.offset : null;
  eligible.forEach((item) => {
    if (item.offset === first) map[item.id] = 3;
    else if (second != null && item.offset === second) map[item.id] = 2;
    else map[item.id] = 1;
  });
  return map;
}

function scoresFor(player, count) {
  const list = [];
  for (let i = 0; i < settings.rounds.length; i += 1) {
    if (i >= count) {
      list.push(null);
      continue;
    }
    list.push(awardsFor(settings.rounds[i])[player.id]);
  }
  return list;
}

function hostLabel() {
  const title = String(settings.showTitle || '').trim();
  return title || "the host's";
}

function fillTitle(text) {
  return String(text || '').replaceAll('{host}', hostLabel());
}

function publicState() {
  const n = revealedThrough();
  const round = settings.rounds[roundIndex] || null;
  const showCurrentPrice = phase === 'revealed' || phase === 'podium';
  const visibleUntil = phase === 'podium'
    ? settings.rounds.length
    : phase === 'title'
      ? 0
      : roundIndex + 1;
  return {
    phase,
    roundIndex,
    roundCount: settings.rounds.length,
    bidsIn,
    roundEndsAt: phase === 'guessing' && !bidsIn ? roundEndsAt : 0,
    timedOut: phase === 'guessing' && bidsIn && roundTimedOut,
    roundMs: 60000,
    sessionCode,
    cue,
    showTitle: settings.showTitle,
    showSubtitle: settings.showSubtitle,
    tagline: settings.tagline,
    startAudio: audioFile(),
    nextAudio: phase === 'revealed' && settings.rounds[roundIndex + 1] ? audioFile() : '',
    revealedCount: n,
    round: round && visibleUntil > 0 ? {
      id: round.id,
      title: fillTitle(round.title),
      short: round.short,
      source: round.source,
      points: round.points || [],
      image: round.image,
      audio: audioFile(),
      pricePence: showCurrentPrice ? round.pricePence : undefined,
    } : null,
    rounds: settings.rounds.slice(0, visibleUntil).map((item, i) => ({
      id: item.id,
      title: fillTitle(item.title),
      short: item.short || fillTitle(item.title),
      pricePence: i < n ? item.pricePence : undefined,
    })),
    players: players.map((p) => {
      const scores = scoresFor(p, n);
      const playedScores = scores.filter((x) => x != null);
      const currentGuess = round ? p.guesses[round.id] : null;
      return {
        id: p.id,
        name: p.name,
        connected: p.sockets.size > 0,
        submitted: Boolean(round) && currentGuess != null && (phase === 'guessing' || phase === 'revealed'),
        scores,
        total: playedScores.reduce((sum, x) => sum + x, 0),
        played: playedScores.length,
        guessPence: currentGuess != null ? Number(currentGuess) : null,
      };
    }),
  };
}

function youView(player) {
  const round = settings.rounds[roundIndex] || null;
  const guess = round ? player.guesses[round.id] : null;
  const n = revealedThrough();
  const scores = scoresFor(player, n);
  const played = scores.filter((x) => x != null);
  return {
    id: player.id,
    name: player.name,
    guessPence: guess == null ? null : Number(guess),
    submitted: guess != null,
    locked: bidsIn || phase !== 'guessing',
    roundPoints: phase === 'revealed' ? scores[roundIndex] : null,
    total: played.reduce((sum, x) => sum + x, 0),
    played: played.length,
  };
}

function broadcast() {
  io.emit('state', publicState());
  for (const player of players) {
    for (const sid of player.sockets) {
      io.to(sid).emit('you', youView(player));
    }
  }
}

function playerBySocket(socket) {
  return players.find((p) => p.sockets.has(socket.id));
}

function checkAllIn() {
  if (phase !== 'guessing' || bidsIn) return;
  if (!players.length) return;
  const round = settings.rounds[roundIndex];
  if (!round) return;
  if (players.every((p) => p.guesses[round.id] != null)) {
    bidsIn = true;
    pushCue('ding');
  }
}

function hostSettings() {
  return {
    showTitle: settings.showTitle,
    showSubtitle: settings.showSubtitle,
    tagline: settings.tagline,
    beds: BEDS.filter((name) => fs.existsSync(path.join(ROOT, name))),
    rounds: settings.rounds.map((round, i) => ({
      id: round.id,
      title: round.title,
      short: round.short,
      source: round.source,
      points: round.points || [],
      pricePence: round.pricePence,
      image: round.image,
      audio: round.audio || `r${i + 1}.mp3`,
    })),
  };
}

function applySettings(payload) {
  const rounds = Array.isArray(payload.rounds) ? payload.rounds.map(cleanRound) : [];
  if (!rounds.length) return 'Add at least one round';
  const ids = new Set();
  for (const round of rounds) {
    if (ids.has(round.id)) round.id = crypto.randomUUID();
    ids.add(round.id);
    if (!round.title.trim()) return 'Every round needs a name';
    if (round.pricePence > 10000000000) return 'Price is too large';
  }
  settings = {
    showTitle: String(payload.showTitle || "WMROCU'S").slice(0, 32),
    showSubtitle: String(payload.showSubtitle || 'PRICE IS RIGHT').slice(0, 32),
    tagline: String(payload.tagline || '').slice(0, 140),
    contentPack: 2,
    rounds,
  };
  if (roundIndex >= settings.rounds.length) {
    roundIndex = 0;
    phase = 'title';
    bidsIn = false;
  }
  persistSettings();
  return '';
}

function lanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '';
}

function playUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '') + '/play?code=' + sessionCode;
  const host = req.get('host') || `localhost:${PORT}`;
  if (/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) {
    const ip = lanIP();
    if (ip) {
      const port = host.includes(':') ? host.split(':').pop() : String(PORT);
      return `http://${ip}:${port}/play?code=${sessionCode}`;
    }
  }
  return `${req.protocol}://${host}/play?code=${sessionCode}`;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
      cb(null, crypto.randomUUID() + safeExt);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  },
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/play', (req, res) => res.sendFile(path.join(PUBLIC, 'play.html')));

app.get('/join.json', (req, res) => res.json({ url: playUrl(req) }));

app.get('/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(playUrl(req), {
    type: 'svg',
    margin: 1,
    color: { dark: '#1a0336', light: '#ffffff' },
  });
  res.type('image/svg+xml').send(svg);
});

app.get('/audio/:name', (req, res) => {
  if (!AUDIO.has(req.params.name)) return res.status(404).end();
  const file = path.join(ROOT, req.params.name);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

app.use('/uploads', express.static(UPLOADS));
app.use(express.static(PUBLIC));

app.post('/api/upload', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Could not take that image' });
    if (!req.file) return res.status(400).json({ error: 'Use a JPG, PNG, or WebP' });
    res.json({ url: '/uploads/' + req.file.filename });
  });
});

const server = http.createServer(app);
const io = new Server(server);

function requireHost() {
  return true;
}

function clearRoundTimer() {
  if (roundTimer) clearTimeout(roundTimer);
  roundTimer = null;
}

function expireRound() {
  roundTimer = null;
  if (phase !== 'guessing' || bidsIn) return;
  bidsIn = true;
  roundTimedOut = true;
  pushCue('timeup');
  broadcast();
  persistLive();
}

function startRoundClock() {
  clearRoundTimer();
  roundTimedOut = false;
  roundEndsAt = Date.now() + 60000;
  roundTimer = setTimeout(expireRound, 60000);
}

function wipeSession(announce) {
  clearRoundTimer();
  roundEndsAt = 0;
  phase = 'title';
  roundIndex = 0;
  bidsIn = false;
  players = [];
  sessionCode = makeCode();
  sessionStartedAt = Date.now();
  pushCue('wipe');
  persistLive();
  if (announce) broadcast();
}

function resumeRoundClock() {
  clearRoundTimer();
  if (phase !== 'guessing' || bidsIn) return;
  const left = roundEndsAt - Date.now();
  if (left <= 0) {
    expireRound();
    return;
  }
  roundTimer = setTimeout(expireRound, left);
}

io.on('connection', (socket) => {
  socket.emit('state', publicState());

  socket.on('player:join', ({ token, name, code }) => {
    const clean = cleanName(name);
    if (!clean) return socket.emit('join:err', 'Enter a name');
    if (String(code || '').toUpperCase() !== sessionCode) {
      return socket.emit('join:err', 'Scan the code on the screen');
    }
    if (typeof token !== 'string' || token.length < 8 || token.length > 80) {
      return socket.emit('join:err', 'Join again');
    }
    let player = players.find((p) => p.token === token);
    if (!player) {
      if (players.length >= 40) return socket.emit('join:err', 'The show is full');
      player = { id: crypto.randomUUID(), token, name: clean, guesses: {}, sockets: new Set() };
      players.push(player);
    } else {
      player.name = clean;
    }
    player.sockets.add(socket.id);
    socket.emit('joined', { name: player.name });
    checkAllIn();
    broadcast();
    persistLive();
  });

  socket.on('player:guess', ({ pence }) => {
    const player = playerBySocket(socket);
    if (!player) return;
    if (phase !== 'guessing' || bidsIn) return socket.emit('guess:err', 'Bids are locked');
    const round = settings.rounds[roundIndex];
    if (!round) return;
    const n = Number(pence);
    if (!Number.isInteger(n) || n < 0 || n > 10000000000) return socket.emit('guess:err', 'Enter a price');
    player.guesses[round.id] = n;
    checkAllIn();
    broadcast();
    persistLive();
  });

  socket.on('host:name', ({ name }) => {
    const clean = cleanName(name);
    if (!clean) return;
    const owned = /s$/i.test(clean) ? clean + "'" : clean + "'s";
    settings.showTitle = owned.slice(0, 32);
    settings.tagline = 'All prices are correct according to ' + clean + ' so deal with it....';
    persistSettings();
    broadcast();
  });

  socket.on('host:auth', ({ pin }) => {
    if (!pinOk(pin)) return socket.emit('host:no');
    const token = crypto.randomUUID();
    hosts.add(token);
    socket.emit('host:ok', { token });
  });

  socket.on('host:settings', ({ token }) => {
    if (!requireHost(socket, token)) return;
    socket.emit('host:settings', hostSettings());
  });

  socket.on('host:save', ({ token, settings: next }) => {
    if (!requireHost(socket, token)) return;
    const err = applySettings(next || {});
    if (err) return socket.emit('host:err', err);
    broadcast();
    socket.emit('host:saved');
    socket.emit('host:settings', hostSettings());
  });

  socket.on('host:start', ({ token }) => {
    if (!requireHost(socket, token)) return;
    if (!settings.rounds.length) return socket.emit('host:err', 'Add a round first');
    if (phase !== 'title' && phase !== 'podium') return;
    phase = 'guessing';
    roundIndex = 0;
    bidsIn = false;
    for (const player of players) player.guesses = {};
    pushCue('start');
    startRoundClock();
    broadcast();
    persistLive();
  });

  socket.on('host:lock', ({ token }) => {
    if (!requireHost(socket, token)) return;
    if (phase !== 'guessing' || bidsIn) return;
    clearRoundTimer();
    bidsIn = true;
    pushCue('ding');
    broadcast();
    persistLive();
  });

  socket.on('host:reveal', ({ token }) => {
    if (!requireHost(socket, token)) return;
    if (phase !== 'guessing') return;
    clearRoundTimer();
    phase = 'revealed';
    pushCue('reveal');
    broadcast();
    persistLive();
  });

  socket.on('host:next', ({ token }) => {
    if (!requireHost(socket, token)) return;
    if (phase === 'podium') {
      clearRoundTimer();
      roundEndsAt = 0;
      phase = 'title';
      roundIndex = 0;
      bidsIn = false;
      for (const player of players) player.guesses = {};
      pushCue('title');
      broadcast();
      persistLive();
      return;
    }
    if (phase !== 'revealed') return;
    if (roundIndex + 1 >= settings.rounds.length) {
      clearRoundTimer();
      roundEndsAt = 0;
      phase = 'podium';
      pushCue('end');
    } else {
      roundIndex += 1;
      phase = 'guessing';
      bidsIn = false;
      pushCue('round');
      startRoundClock();
    }
    broadcast();
    persistLive();
  });

  socket.on('host:refresh', () => {
    wipeSession(true);
  });

  socket.on('host:reset', ({ token }) => {
    if (!requireHost(socket, token)) return;
    clearRoundTimer();
    roundEndsAt = 0;
    phase = 'title';
    roundIndex = 0;
    bidsIn = false;
    for (const player of players) player.guesses = {};
    pushCue('title');
    broadcast();
    persistLive();
  });

  socket.on('host:remove', ({ token, id }) => {
    if (!requireHost(socket, token)) return;
    players = players.filter((p) => p.id !== id);
    checkAllIn();
    broadcast();
    persistLive();
  });

  socket.on('disconnect', () => {
    const player = playerBySocket(socket);
    if (!player) return;
    player.sockets.delete(socket.id);
    broadcast();
  });
});

resumeRoundClock();
setInterval(() => {
  if (Date.now() - sessionStartedAt >= 60 * 60 * 1000) wipeSession(true);
}, 15000);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Show on http://localhost:${PORT}`);
  console.log(`Data: ${DATA}`);
});
