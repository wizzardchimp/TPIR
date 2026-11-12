const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', credentials: true },
  transports: ['polling', 'websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  cookie: false
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || '';

const store = require('./store');
const crypto = require('crypto');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (!ADMIN_TOKEN) {
  console.warn('WARNING: ADMIN_TOKEN is not set - anyone can host games and edit rounds. Set it in Railway variables.');
}

function tokenOk(token) {
  if (!ADMIN_TOKEN) return true;
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (tokenOk(req.get('x-admin-token'))) return next();
  res.status(401).json({ error: 'Invalid host password' });
}

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.send('ok'));

// Host auth check (host page uses this to show the password prompt)
app.post('/api/auth', requireAdmin, (req, res) => res.json({ ok: true, open: !ADMIN_TOKEN }));

// Rounds live in cloud storage. Prices are only served to authenticated hosts.
app.get('/api/rounds', requireAdmin, (req, res) => res.json(store.getAll()));
app.put('/api/rounds', requireAdmin, async (req, res) => {
  try {
    const rounds = await store.setAll(req.body);
    io.to('hosts').emit('rounds-updated', rounds);
    res.json(rounds);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const sessions = new Map();

function getLocalURL() {
  if (PUBLIC_URL) return PUBLIC_URL;
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return `http://${iface.address}:${PORT}`;
      }
    }
  }
  return `http://localhost:${PORT}`;
}

function generateCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (sessions.has(code));
  return code;
}

function getPlayerList(session) {
  return Object.values(session.players)
    .filter(p => !p.kicked)
    .map(p => ({
      name: p.name,
      connected: p.connected,
      joinedAt: p.joinedAt,
      guessed: session.phase === 'playing' && p.guesses[session.currentRound] !== undefined
    }));
}

function emitGuessCount(session) {
  const active = Object.values(session.players).filter(p => !p.kicked);
  const submitted = active.filter(p => p.guesses[session.currentRound] !== undefined).length;
  io.to(`host:${session.code}`).emit('guess-count', {
    submitted,
    total: active.length,
    players: getPlayerList(session)
  });
}

// Drop abandoned sessions after 12h of inactivity
setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [code, s] of sessions) {
    if (s.lastActivity < cutoff) {
      if (s.timerInterval) clearInterval(s.timerInterval);
      sessions.delete(code);
    }
  }
}, 30 * 60 * 1000).unref();

function calculateRoundResults(session, roundIndex) {
  const round = session.rounds[roundIndex];
  if (!round) return { rankings: [], points: {} };

  const price = round.price;
  const players = Object.values(session.players).filter(p => !p.kicked);

  const entries = [];
  for (const p of players) {
    const guess = p.guesses[roundIndex];
    if (guess !== undefined) {
      entries.push({
        name: p.name,
        guess: guess.value,
        submittedAt: guess.submittedAt,
        diff: parseFloat((price - guess.value).toFixed(2))
      });
    }
  }

  if (entries.length === 0) return { rankings: [], points: {} };

  const allOver = entries.every(e => e.diff < 0);

  if (allOver) {
    entries.sort((a, b) => a.submittedAt - b.submittedAt);
    const points = {};
    points[entries[0].name] = 1;
    return {
      rankings: entries.map(e => ({
        ...e,
        rank: points[e.name] ? 1 : null,
        points: points[e.name] || 0
      })),
      points
    };
  }

  const valid = entries.filter(e => e.diff >= 0);
  valid.sort((a, b) => {
    if (a.diff !== b.diff) return a.diff - b.diff;
    return a.submittedAt - b.submittedAt;
  });

  const pointValues = [5, 3, 2, 1];
  const points = {};

  const rankings = entries.map(e => {
    if (e.diff < 0) {
      return { ...e, rank: null, points: 0 };
    }
    const rankIndex = valid.findIndex(v => v.name === e.name);
    const rank = rankIndex + 1;
    const pts = rankIndex < 4 ? pointValues[rankIndex] : 0;
    if (pts > 0) points[e.name] = pts;
    return { ...e, rank, points: pts };
  });

  rankings.sort((a, b) => {
    if (a.diff >= 0 && b.diff < 0) return -1;
    if (a.diff < 0 && b.diff >= 0) return 1;
    if (a.diff >= 0 && b.diff >= 0) return a.rank - b.rank;
    if (a.diff < 0 && b.diff < 0) return a.submittedAt - b.submittedAt;
    return 0;
  });

  return { rankings, points };
}

io.engine.on('connection_error', (err) => {
  console.error('Socket.io engine error:', err.code, err.message, err.context);
});

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);
  let hostCode = null;          // set only for the authenticated host socket
  let currentSessionCode = null; // set only for player sockets
  let currentPlayerName = null;

  async function makeQr(code) {
    const baseUrl = PUBLIC_URL || getLocalURL();
    const qrUrl = `${baseUrl}/join.html?code=${code}`;
    const qrSvg = await QRCode.toString(qrUrl, { type: 'svg', margin: 1, width: 256, color: { dark: '#d4a843', light: '#0a1628' } });
    return { qrSvg, qrUrl };
  }

  function newSession(rounds) {
    const code = generateCode();
    return {
      code,
      hostKey: crypto.randomBytes(16).toString('hex'),
      rounds,
      currentRound: -1,
      phase: 'setup',
      players: {},
      timer: null,
      timerInterval: null,
      totalScores: {},
      lastActivity: Date.now()
    };
  }

  // Hosts listen for live round-list changes from the cloud store
  socket.on('host-subscribe', ({ token }) => {
    if (tokenOk(token)) socket.join('hosts');
  });

  socket.on('create-session', async ({ token, roundIds }, callback) => {
    try {
      if (!tokenOk(token)) return callback({ error: 'Invalid host password' });
      // Rounds always come from the cloud store, never from the client.
      const all = store.getAll();
      const rounds = Array.isArray(roundIds)
        ? roundIds.map(id => all.find(r => r.id === id)).filter(Boolean).map(r => ({ ...r }))
        : all.map(r => ({ ...r }));
      if (rounds.length === 0) return callback({ error: 'Select at least one round' });

      const session = newSession(rounds);
      sessions.set(session.code, session);
      hostCode = session.code;
      socket.join(`host:${session.code}`);
      socket.join('hosts');

      callback({ code: session.code, hostKey: session.hostKey, ...(await makeQr(session.code)) });
    } catch (err) {
      console.error('create-session error:', err);
      callback({ error: err.message });
    }
  });

  // Host refreshed the page / lost connection: take the session back
  socket.on('host-rejoin', async ({ code, hostKey }, callback) => {
    const session = sessions.get(code);
    if (!session || session.hostKey !== hostKey) return callback({ error: 'Session not found' });
    hostCode = code;
    socket.join(`host:${code}`);
    socket.join('hosts');
    session.lastActivity = Date.now();
    const round = session.rounds[session.currentRound];
    callback({
      code,
      ...(await makeQr(code)),
      phase: session.phase,
      players: getPlayerList(session),
      totalRounds: session.rounds.length,
      currentRound: session.currentRound,
      roundName: round ? round.name : null,
      roundPrice: round && session.phase === 'results' ? round.price : null,
      remaining: session.timer ? Math.max(0, Math.ceil((session.timer.endAt - Date.now()) / 1000)) : null,
      totalScores: session.totalScores
    });
  });

  socket.on('start-game', () => {
    if (!hostCode) return;
    const session = sessions.get(hostCode);
    if (!session || Object.keys(session.players).length === 0) return;

    session.phase = 'lobby';
    session.currentRound = 0;
    const playerNames = Object.keys(session.players);
    for (const name of playerNames) {
      session.totalScores[name] = 0;
    }

    io.to(`host:${hostCode}`).emit('game-started', {
      players: getPlayerList(session),
      totalRounds: session.rounds.length
    });
    io.to(`player:${hostCode}`).emit('game-started', {
      totalRounds: session.rounds.length
    });
  });

  socket.on('start-round', () => {
    if (!hostCode) return;
    const session = sessions.get(hostCode);
    if (!session) return;

    const roundIndex = session.currentRound;
    const round = session.rounds[roundIndex];
    if (!round) return;

    session.phase = 'playing';
    session.lastActivity = Date.now();

    if (session.timerInterval) {
      clearInterval(session.timerInterval);
      session.timerInterval = null;
    }

    const seconds = round.seconds || 45;
    const endAt = Date.now() + seconds * 1000;
    session.timer = { endAt };

    io.to(`host:${hostCode}`).emit('timer-started', {
      roundIndex,
      roundName: round.name,
      roundPrice: round.price,
      seconds,
      roundNumber: roundIndex + 1,
      totalRounds: session.rounds.length
    });
    io.to(`player:${hostCode}`).emit('timer-started', {
      roundIndex,
      roundName: round.name,
      seconds,
      roundNumber: roundIndex + 1,
      totalRounds: session.rounds.length
    });

    emitGuessCount(session);

    session.timerInterval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((session.timer.endAt - Date.now()) / 1000));

      io.to(`host:${hostCode}`).emit('timer-tick', { remaining });
      io.to(`player:${hostCode}`).emit('timer-tick', { remaining });

      if (remaining <= 0) {
        clearInterval(session.timerInterval);
        session.timerInterval = null;
        io.to(`host:${hostCode}`).emit('time-up');
        io.to(`player:${hostCode}`).emit('time-up');
      }
    }, 1000);
  });

  socket.on('show-results', () => {
    if (!hostCode) return;
    const session = sessions.get(hostCode);
    if (!session) return;

    if (session.timerInterval) {
      clearInterval(session.timerInterval);
      session.timerInterval = null;
    }

    const { rankings, points } = calculateRoundResults(session, session.currentRound);

    for (const [name, pts] of Object.entries(points)) {
      if (session.totalScores[name] !== undefined) {
        session.totalScores[name] += pts;
      }
    }

    session.phase = 'results';
    const round = session.rounds[session.currentRound];

    io.to(`host:${hostCode}`).emit('round-results', {
      roundIndex: session.currentRound,
      roundName: round.name,
      roundPrice: round.price,
      rankings,
      totalScores: session.totalScores
    });
    io.to(`player:${hostCode}`).emit('round-results', {
      roundIndex: session.currentRound,
      roundName: round.name,
      roundPrice: round.price,
      rankings,
      totalScores: session.totalScores
    });
  });

  socket.on('next-round', () => {
    if (!hostCode) return;
    const session = sessions.get(hostCode);
    if (!session) return;

    session.currentRound++;

    if (session.currentRound >= session.rounds.length) {
      session.phase = 'finished';
      io.to(`host:${hostCode}`).emit('game-finished', {
        totalScores: session.totalScores
      });
      io.to(`player:${hostCode}`).emit('game-finished', {
        totalScores: session.totalScores
      });
    } else {
      session.phase = 'lobby';
      const round = session.rounds[session.currentRound];
      io.to(`host:${hostCode}`).emit('round-ready', {
        roundNumber: session.currentRound + 1,
        roundName: round.name,
        totalRounds: session.rounds.length
      });
      io.to(`player:${hostCode}`).emit('round-ready', {
        roundNumber: session.currentRound + 1,
        totalRounds: session.rounds.length
      });
    }
  });

  socket.on('kick-player', ({ name }) => {
    if (!hostCode) return;
    const session = sessions.get(hostCode);
    if (!session) return;

    const player = session.players[name];
    if (player) {
      player.kicked = true;
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (playerSocket) {
        playerSocket.emit('you-were-kicked');
        playerSocket.leave(`player:${hostCode}`);
      }
      io.to(`host:${hostCode}`).emit('player-joined', {
        players: getPlayerList(session)
      });
    }
  });

  socket.on('reset-session', async (callback) => {
    try {
      if (!hostCode) return callback({ error: 'No session' });
      const oldCode = hostCode;
      const session = sessions.get(oldCode);
      if (!session) return callback({ error: 'Session not found' });

      if (session.timerInterval) {
        clearInterval(session.timerInterval);
        session.timerInterval = null;
      }

      const newSess = newSession(session.rounds);
      const newCode = newSess.code;
      sessions.delete(oldCode);
      sessions.set(newCode, newSess);
      hostCode = newCode;

      socket.leave(`host:${oldCode}`);
      socket.join(`host:${newCode}`);

      io.to(`player:${oldCode}`).emit('session-reset');

      const { qrSvg, qrUrl } = await makeQr(newCode);

      callback({ code: newCode, hostKey: newSess.hostKey, qrSvg, qrUrl });
    } catch (err) {
      console.error('reset-session error:', err);
      callback({ error: err.message });
    }
  });

  socket.on('join-session', ({ code, name }, callback) => {
    const session = sessions.get(code);
    if (!session) {
      callback({ success: false, reason: 'Session not found' });
      return;
    }

    const trimmedName = String(name || '').trim().slice(0, 24);
    if (!trimmedName) {
      callback({ success: false, reason: 'Name is required' });
      return;
    }

    if (session.players[trimmedName]) {
      const existing = session.players[trimmedName];
      if (existing.connected && !existing.kicked && io.sockets.sockets.has(existing.socketId)) {
        callback({ success: false, reason: 'Name already taken' });
        return;
      }
      if (existing.kicked) {
        callback({ success: false, reason: 'You have been kicked from this session' });
        return;
      }
      existing.socketId = socket.id;
      existing.connected = true;
      currentPlayerName = trimmedName;
      currentSessionCode = code;
      socket.join(`player:${code}`);

      const hasGuessed = existing.guesses[session.currentRound] !== undefined;

      const timerRemaining = session.timer
        ? Math.max(0, Math.ceil((session.timer.endAt - Date.now()) / 1000))
        : null;

      callback({
        success: true,
        name: trimmedName,
        sessionCode: code,
        phase: session.phase,
        currentRound: session.currentRound,
        totalRounds: session.rounds.length,
        currentRoundName: session.currentRound >= 0 ? session.rounds[session.currentRound].name : null,
        hasGuessed,
        timerRemaining
      });

      session.lastActivity = Date.now();
      io.to(`host:${code}`).emit('player-joined', {
        players: getPlayerList(session)
      });
      if (session.phase === 'playing') emitGuessCount(session);
      return;
    }

    const player = {
      name: trimmedName,
      socketId: socket.id,
      connected: true,
      joinedAt: Date.now(),
      guesses: {},
      kicked: false
    };

    session.players[trimmedName] = player;
    session.totalScores[trimmedName] = 0;
    currentPlayerName = trimmedName;
    currentSessionCode = code;
    socket.join(`player:${code}`);

    callback({
      success: true,
      name: trimmedName,
      sessionCode: code,
      phase: session.phase,
      currentRound: session.currentRound,
      totalRounds: session.rounds.length,
      currentRoundName: session.currentRound >= 0 ? session.rounds[session.currentRound].name : null,
      hasGuessed: false,
      timerRemaining: null
    });

    session.lastActivity = Date.now();
    io.to(`host:${code}`).emit('player-joined', {
      players: getPlayerList(session)
    });
    if (session.phase === 'playing') emitGuessCount(session);
  });

  socket.on('submit-guess', ({ value }, callback) => {
    if (!currentSessionCode || !currentPlayerName) {
      callback({ success: false, reason: 'Not in a session' });
      return;
    }

    const session = sessions.get(currentSessionCode);
    if (!session) {
      callback({ success: false, reason: 'Session not found' });
      return;
    }

    if (session.phase !== 'playing') {
      callback({ success: false, reason: 'Not in playing phase' });
      return;
    }

    if (session.timer && Date.now() >= session.timer.endAt) {
      callback({ success: false, reason: 'Time is up' });
      return;
    }

    const player = session.players[currentPlayerName];
    if (!player || player.kicked) {
      callback({ success: false, reason: 'Player not found' });
      return;
    }

    const roundIndex = session.currentRound;
    if (player.guesses[roundIndex] !== undefined) {
      callback({ success: false, reason: 'Already submitted' });
      return;
    }

    const guessValue = parseFloat(value);
    if (isNaN(guessValue) || guessValue < 0) {
      callback({ success: false, reason: 'Invalid guess' });
      return;
    }

    player.guesses[roundIndex] = {
      value: Math.round(guessValue * 100) / 100,
      submittedAt: Date.now()
    };

    callback({ success: true });

    session.lastActivity = Date.now();
    emitGuessCount(session);
  });

  socket.on('disconnect', () => {
    if (currentSessionCode && currentPlayerName) {
      const session = sessions.get(currentSessionCode);
      if (session && session.players[currentPlayerName]) {
        // Ignore stale disconnects from an old socket after a reconnect
        if (session.players[currentPlayerName].socketId === socket.id) {
          session.players[currentPlayerName].connected = false;
          io.to(`host:${currentSessionCode}`).emit('player-joined', {
            players: getPlayerList(session)
          });
          if (session.phase === 'playing') emitGuessCount(session);
        }
      }
    }
  });
});

store.init().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`TPIR Scores server running on port ${PORT}`);
    console.log(`Local URL: ${getLocalURL()}`);
  });
}).catch((err) => {
  console.error('Failed to initialise rounds store:', err);
  process.exit(1);
});
