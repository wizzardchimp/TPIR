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
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || '';

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.send('ok'));

const defaultRounds = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'public', 'data', 'default-rounds.json'), 'utf-8')
);

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
    code = String(Math.floor(100 + Math.random() * 900));
  } while (sessions.has(code));
  return code;
}

function getPlayerList(session) {
  return Object.values(session.players)
    .filter(p => !p.kicked)
    .map(p => ({
      name: p.name,
      connected: p.connected,
      joinedAt: p.joinedAt
    }));
}

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

io.on('connection', (socket) => {
  let currentSessionCode = null;
  let currentPlayerName = null;

  socket.on('create-session', async ({ rounds }, callback) => {
    try {
      const code = generateCode();
      const session = {
        code,
        rounds: rounds || defaultRounds,
        currentRound: -1,
        phase: 'setup',
        players: {},
        timer: null,
        timerInterval: null,
        totalScores: {}
      };
      sessions.set(code, session);
      currentSessionCode = code;
      socket.join(`host:${code}`);

      const baseUrl = PUBLIC_URL || getLocalURL();
      const qrUrl = `${baseUrl}/join.html?code=${code}`;
      const qrSvg = await QRCode.toString(qrUrl, { type: 'svg', margin: 1, width: 256, color: { dark: '#d4a843', light: '#0a1628' } });

      callback({ code, qrSvg, qrUrl });
    } catch (err) {
      console.error('create-session error:', err);
      callback({ error: err.message });
    }
  });

  socket.on('start-game', () => {
    if (!currentSessionCode) return;
    const session = sessions.get(currentSessionCode);
    if (!session || Object.keys(session.players).length === 0) return;

    session.phase = 'lobby';
    session.currentRound = 0;
    const playerNames = Object.keys(session.players);
    for (const name of playerNames) {
      session.totalScores[name] = 0;
    }

    io.to(`host:${currentSessionCode}`).emit('game-started', {
      players: getPlayerList(session),
      totalRounds: session.rounds.length
    });
    io.to(`player:${currentSessionCode}`).emit('game-started', {
      totalRounds: session.rounds.length
    });
  });

  socket.on('start-round', () => {
    if (!currentSessionCode) return;
    const session = sessions.get(currentSessionCode);
    if (!session) return;

    const roundIndex = session.currentRound;
    const round = session.rounds[roundIndex];
    if (!round) return;

    session.phase = 'playing';

    if (session.timerInterval) {
      clearInterval(session.timerInterval);
      session.timerInterval = null;
    }

    const endAt = Date.now() + 45000;
    session.timer = { endAt };

    io.to(`host:${currentSessionCode}`).emit('timer-started', {
      roundIndex,
      roundName: round.name,
      roundPrice: round.price,
      seconds: 45,
      roundNumber: roundIndex + 1,
      totalRounds: session.rounds.length
    });
    io.to(`player:${currentSessionCode}`).emit('timer-started', {
      roundIndex,
      roundName: round.name,
      seconds: 45,
      roundNumber: roundIndex + 1,
      totalRounds: session.rounds.length
    });

    session.timerInterval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((session.timer.endAt - Date.now()) / 1000));

      io.to(`host:${currentSessionCode}`).emit('timer-tick', { remaining });
      io.to(`player:${currentSessionCode}`).emit('timer-tick', { remaining });

      if (remaining <= 0) {
        clearInterval(session.timerInterval);
        session.timerInterval = null;
        io.to(`host:${currentSessionCode}`).emit('time-up');
        io.to(`player:${currentSessionCode}`).emit('time-up');
      }
    }, 1000);
  });

  socket.on('show-results', () => {
    if (!currentSessionCode) return;
    const session = sessions.get(currentSessionCode);
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

    io.to(`host:${currentSessionCode}`).emit('round-results', {
      roundIndex: session.currentRound,
      roundName: round.name,
      roundPrice: round.price,
      rankings,
      totalScores: session.totalScores
    });
    io.to(`player:${currentSessionCode}`).emit('round-results', {
      roundIndex: session.currentRound,
      roundName: round.name,
      roundPrice: round.price,
      rankings,
      totalScores: session.totalScores
    });
  });

  socket.on('next-round', () => {
    if (!currentSessionCode) return;
    const session = sessions.get(currentSessionCode);
    if (!session) return;

    session.currentRound++;

    if (session.currentRound >= session.rounds.length) {
      session.phase = 'finished';
      io.to(`host:${currentSessionCode}`).emit('game-finished', {
        totalScores: session.totalScores
      });
      io.to(`player:${currentSessionCode}`).emit('game-finished', {
        totalScores: session.totalScores
      });
    } else {
      session.phase = 'lobby';
      const round = session.rounds[session.currentRound];
      io.to(`host:${currentSessionCode}`).emit('round-ready', {
        roundNumber: session.currentRound + 1,
        roundName: round.name,
        totalRounds: session.rounds.length
      });
      io.to(`player:${currentSessionCode}`).emit('round-ready', {
        roundNumber: session.currentRound + 1,
        totalRounds: session.rounds.length
      });
    }
  });

  socket.on('kick-player', ({ name }) => {
    if (!currentSessionCode) return;
    const session = sessions.get(currentSessionCode);
    if (!session) return;

    const player = session.players[name];
    if (player) {
      player.kicked = true;
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (playerSocket) {
        playerSocket.emit('you-were-kicked');
        playerSocket.leave(`player:${currentSessionCode}`);
      }
      io.to(`host:${currentSessionCode}`).emit('player-joined', {
        players: getPlayerList(session)
      });
    }
  });

  socket.on('reset-session', async (callback) => {
    try {
      if (!currentSessionCode) return callback({ error: 'No session' });
      const oldCode = currentSessionCode;
      const session = sessions.get(oldCode);
      if (!session) return callback({ error: 'Session not found' });

      if (session.timerInterval) {
        clearInterval(session.timerInterval);
        session.timerInterval = null;
      }

      const newCode = generateCode();
      sessions.delete(oldCode);

      const newSession = {
        code: newCode,
        rounds: session.rounds,
        currentRound: -1,
        phase: 'setup',
        players: {},
        timer: null,
        timerInterval: null,
        totalScores: {}
      };
      sessions.set(newCode, newSession);
      currentSessionCode = newCode;

      socket.leave(`host:${oldCode}`);
      socket.join(`host:${newCode}`);

      io.to(`player:${oldCode}`).emit('session-reset');

      const baseUrl = PUBLIC_URL || getLocalURL();
      const qrUrl = `${baseUrl}/join.html?code=${newCode}`;
      const qrSvg = await QRCode.toString(qrUrl, { type: 'svg', margin: 1, width: 256, color: { dark: '#d4a843', light: '#0a1628' } });

      callback({ code: newCode, qrSvg, qrUrl });
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

    const trimmedName = name.trim();
    if (!trimmedName) {
      callback({ success: false, reason: 'Name is required' });
      return;
    }

    if (session.players[trimmedName]) {
      const existing = session.players[trimmedName];
      if (existing.connected && !existing.kicked) {
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

      io.to(`host:${code}`).emit('player-joined', {
        players: getPlayerList(session)
      });
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

    io.to(`host:${code}`).emit('player-joined', {
      players: getPlayerList(session)
    });
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

    const submitted = Object.values(session.players)
      .filter(p => !p.kicked && p.guesses[roundIndex] !== undefined).length;
    const total = Object.values(session.players).filter(p => !p.kicked).length;

    io.to(`host:${currentSessionCode}`).emit('guess-count', { submitted, total });
  });

  socket.on('disconnect', () => {
    if (currentSessionCode && currentPlayerName) {
      const session = sessions.get(currentSessionCode);
      if (session && session.players[currentPlayerName]) {
        session.players[currentPlayerName].connected = false;
        io.to(`host:${currentSessionCode}`).emit('player-joined', {
          players: getPlayerList(session)
        });
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TPIR Scores server running on port ${PORT}`);
  console.log(`Local URL: ${getLocalURL()}`);
});
