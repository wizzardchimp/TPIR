const socket = io({ transports: ['polling'] });

let sessionCode = null;
let selectedRounds = [];
let totalRounds = 0;
let timerInterval = null;

// Load rounds data
async function loadRounds() {
  try {
    const res = await fetch('/data/default-rounds.json');
    const rounds = await res.json();
    selectedRounds = rounds;
    renderRoundsTable(rounds);
  } catch (e) {
    console.error('Failed to load rounds:', e);
  }
}

function renderRoundsTable(rounds) {
  const tbody = document.getElementById('roundsBody');
  tbody.innerHTML = rounds.map(r => `
    <tr>
      <td><input type="checkbox" class="round-checkbox" data-id="${r.id}" checked></td>
      <td>${r.name}</td>
      <td style="color:#f5d76e; font-weight:600">£${formatPrice(r.price)}</td>
    </tr>
  `).join('');

  document.querySelectorAll('.round-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) {
        const round = rounds.find(r => r.id === id);
        if (round) selectedRounds.push(round);
      } else {
        selectedRounds = selectedRounds.filter(r => r.id !== id);
      }
    });
  });
}

function formatPrice(p) {
  if (Number.isInteger(p)) return p.toString();
  return p.toFixed(2);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

function renderPlayerList(players) {
  const container = document.getElementById('playerList');
  document.getElementById('playerCount').textContent =
    `${players.length} player${players.length !== 1 ? 's' : ''} joined`;

  if (players.length === 0) {
    container.innerHTML = '<p style="color:rgba(255,255,255,0.3); text-align:center; padding:20px">Waiting for players to join...</p>';
    return;
  }

  container.innerHTML = players.map(p => `
    <div class="player-item">
      <div class="player-name">
        <span class="player-status ${p.connected ? 'connected' : 'disconnected'}"></span>
        ${p.name}
      </div>
      <button class="btn btn-danger btn-sm" onclick="kickPlayer('${p.name}')">✕</button>
    </div>
  `).join('');
}

function renderResults(rankings, totalScores) {
  const tbody = document.getElementById('resultsBody');
  tbody.innerHTML = rankings.map(r => {
    const diffStr = r.diff >= 0 ? `-£${Math.abs(r.diff).toFixed(2)}` : `+£${Math.abs(r.diff).toFixed(2)}`;
    const isOver = r.diff < 0;
    const rankStr = r.rank ? (r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : `#${r.rank}`) : '—';
    const rankClass = r.rank === 1 ? 'rank-1' : r.rank === 2 ? 'rank-2' : r.rank === 3 ? 'rank-3' : '';

    return `
      <tr>
        <td>
          ${r.rank && r.rank <= 3 ? `<span class="rank-badge ${rankClass}">${rankStr}</span>` : rankStr}
          <span style="margin-left:8px">${r.name}</span>
        </td>
        <td>£${r.guess.toFixed(2)}</td>
        <td class="${isOver ? 'over-bid' : ''}">
          ${diffStr}
          ${r.rank === null && !isOver ? '<span class="bonus-badge">Fastest</span>' : ''}
        </td>
        <td class="points-cell ${r.points === 0 ? 'points-0' : ''}">${r.points > 0 ? '+' : ''}${r.points}</td>
      </tr>
    `;
  }).join('');

  // Running scores
  const sorted = Object.entries(totalScores).sort((a, b) => b[1] - a[1]);
  const scoresBody = document.getElementById('scoreTotalsBody');
  scoresBody.innerHTML = sorted.map(([name, score], i) => `
    <tr>
      <td>
        ${i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : i === 2 ? '🥉 ' : ''}
        ${name}
      </td>
      <td style="text-align:center; color:#f5d76e; font-weight:700">${score}</td>
    </tr>
  `).join('');
}

function renderFinalStandings(totalScores) {
  const sorted = Object.entries(totalScores).sort((a, b) => b[1] - a[1]);
  const container = document.getElementById('finalStandings');
  container.innerHTML = sorted.map(([name, score], i) => {
    const medal = i === 0 ? '🏆' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
    return `
      <li class="standing-item ${i === 0 ? 'standing-winner' : ''}">
        <span class="standing-rank">${medal}</span>
        <span class="standing-name">${name}</span>
        <span class="standing-score">${score}</span>
      </li>
    `;
  }).join('');
}

function kickPlayer(name) {
  socket.emit('kick-player', { name });
}

// === SETUP ===

document.getElementById('createSessionBtn').addEventListener('click', () => {
  if (selectedRounds.length === 0) {
    showToast('Select at least one round');
    return;
  }
  const btn = document.getElementById('createSessionBtn');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  socket.emit('create-session', { rounds: selectedRounds }, (response) => {
    sessionCode = response.code;
    document.getElementById('lobbySessionCode').textContent = response.code;
    document.getElementById('qrCode').innerHTML = response.qrSvg;
    document.getElementById('qrUrl').textContent = response.qrUrl;

    btn.disabled = false;
    btn.textContent = 'Create Session';
    showScreen('lobbyScreen');
  });
});

document.getElementById('startGameBtn').addEventListener('click', () => {
  socket.emit('start-game');
});

document.getElementById('startRoundBtn').addEventListener('click', () => {
  socket.emit('start-round');
  document.getElementById('startRoundBtn').classList.add('hidden');
  document.getElementById('showResultsBtn').classList.add('hidden');
});

document.getElementById('showResultsBtn').addEventListener('click', () => {
  socket.emit('show-results');
});

document.getElementById('nextRoundBtn').addEventListener('click', () => {
  socket.emit('next-round');
});

document.getElementById('finalResultsBtn').addEventListener('click', () => {
  showScreen('finalScreen');
});

document.getElementById('newGameBtn').addEventListener('click', () => {
  location.reload();
});

document.getElementById('resetSessionBtn').addEventListener('click', () => {
  if (!confirm('Reset the entire session? All players will be disconnected and a new code will be generated.')) return;

  socket.emit('reset-session', (response) => {
    sessionCode = response.code;
    document.getElementById('lobbySessionCode').textContent = response.code;
    document.getElementById('qrCode').innerHTML = response.qrSvg;
    document.getElementById('qrUrl').textContent = response.qrUrl;
    document.getElementById('playerList').innerHTML =
      '<p style="color:rgba(255,255,255,0.3); text-align:center; padding:20px">Waiting for players to join...</p>';
    document.getElementById('playerCount').textContent = 'No players yet';
    showToast(`Session reset. New code: ${response.code}`);
  });
});

// === SOCKET EVENTS ===

socket.on('session-created', (data) => {
  sessionCode = data.code;
});

socket.on('player-joined', (data) => {
  renderPlayerList(data.players);
});

socket.on('game-started', (data) => {
  totalRounds = data.totalRounds;
  document.getElementById('gameSessionCode').textContent = sessionCode;
  document.getElementById('gameRoundIndicator').textContent = `Round 1 of ${totalRounds}`;
  showScreen('gameScreen');
  document.getElementById('startRoundBtn').classList.remove('hidden');
  document.getElementById('startRoundBtn').textContent = 'Start Round 1';
  document.getElementById('showResultsBtn').classList.add('hidden');
});

socket.on('timer-started', (data) => {
  document.getElementById('gameItemName').textContent = data.roundName;
  document.getElementById('gameRoundIndicator').textContent = `Round ${data.roundNumber} of ${data.totalRounds}`;
  document.getElementById('startRoundBtn').classList.add('hidden');
  document.getElementById('showResultsBtn').classList.add('hidden');
  document.getElementById('submissionCount').innerHTML = 'Submitted: <span>0</span> / <span>0</span>';
});

socket.on('timer-tick', (data) => {
  const mins = Math.floor(data.remaining / 60);
  const secs = data.remaining % 60;
  const el = document.getElementById('gameTimer');
  el.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  el.classList.toggle('timer-warning', data.remaining <= 10);
});

socket.on('time-up', () => {
  document.getElementById('gameTimer').textContent = '0:00';
  document.getElementById('showResultsBtn').classList.remove('hidden');
  document.getElementById('showResultsBtn').textContent = 'Show Results';
});

socket.on('guess-count', (data) => {
  document.getElementById('submissionCount').innerHTML =
    `Submitted: <span>${data.submitted}</span> / <span>${data.total}</span>`;

  if (data.submitted === data.total && data.total > 0) {
    document.getElementById('showResultsBtn').classList.remove('hidden');
    document.getElementById('showResultsBtn').textContent = 'Show Results';
  }
});

socket.on('round-results', (data) => {
  document.getElementById('resultsSessionCode').textContent = sessionCode;
  document.getElementById('resultsRoundLabel').textContent = `Round ${data.roundIndex + 1} Results`;
  document.getElementById('resultsTitle').textContent = data.roundName;
  document.getElementById('actualPrice').textContent = `£${formatPrice(data.roundPrice)}`;

  renderResults(data.rankings, data.totalScores);

  const isLast = data.roundIndex + 1 >= totalRounds;
  document.getElementById('nextRoundBtn').classList.toggle('hidden', isLast);
  document.getElementById('finalResultsBtn').classList.toggle('hidden', !isLast);

  showScreen('resultsScreen');
});

socket.on('round-ready', (data) => {
  document.getElementById('gameRoundIndicator').textContent = `Round ${data.roundNumber} of ${data.totalRounds}`;
  document.getElementById('startRoundBtn').textContent = `Start Round ${data.roundNumber}`;
  document.getElementById('startRoundBtn').classList.remove('hidden');
  document.getElementById('showResultsBtn').classList.add('hidden');
  document.getElementById('gameTimer').textContent = '0:45';
  document.getElementById('gameTimer').classList.remove('timer-warning');
  showScreen('gameScreen');
});

socket.on('game-finished', (data) => {
  renderFinalStandings(data.totalScores);
  showScreen('finalScreen');
});

// Init
loadRounds();
