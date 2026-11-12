const socket = io({ transports: ['polling', 'websocket'] });

const LS = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} }
};

let adminToken = LS.get('tpir_host_token') || '';
let sessionCode = null;
let totalRounds = 0;
let rounds = [];            // working copy shown in the editor
let savedRounds = [];       // last copy known to be in the cloud
let selectedIds = new Set();
let dirty = false;

function esc(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function $(id) { return document.getElementById(id); }

function formatPrice(p) {
  if (Number.isInteger(p)) return p.toString();
  return p.toFixed(2);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// === AUTH ===

async function tryLogin(token) {
  adminToken = token;
  await api('POST', '/api/auth');
  LS.set('tpir_host_token', token);
  socket.emit('host-subscribe', { token });
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await tryLogin($('hostPassword').value);
    await boot();
  } catch (err) {
    $('loginError').textContent = err.status === 401 ? 'Wrong password' : err.message;
  }
});

// === ROUNDS EDITOR ===

function setDirty(v) {
  dirty = v;
  $('saveRoundsBtn').classList.toggle('hidden', !v);
  $('discardRoundsBtn').classList.toggle('hidden', !v);
  $('cloudStatus').textContent = v ? '● Unsaved changes' : '☁ Synced';
  $('cloudStatus').classList.toggle('dirty', v);
}

function renderRoundsTable() {
  const last = rounds.length - 1;
  $('roundsBody').innerHTML = rounds.map((r, i) => `
    <tr data-i="${i}">
      <td><input type="checkbox" class="round-checkbox" ${selectedIds.has(r.id) ? 'checked' : ''}></td>
      <td><input type="text" class="edit-name" value="${esc(r.name)}" maxlength="140" placeholder="Item name"></td>
      <td><input type="number" class="edit-price" value="${esc(r.price)}" min="0" step="0.01"></td>
      <td><input type="number" class="edit-secs" value="${esc(r.seconds || 45)}" min="10" max="300" step="5"></td>
      <td class="row-actions">
        <button class="icon-btn" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn" data-act="down" title="Move down" ${i === last ? 'disabled' : ''}>↓</button>
        <button class="icon-btn danger" data-act="del" title="Delete">✕</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="muted-text" style="text-align:center">No rounds yet - add one.</td></tr>';
}

$('roundsBody').addEventListener('input', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const r = rounds[+tr.dataset.i];
  if (e.target.classList.contains('round-checkbox')) {
    e.target.checked ? selectedIds.add(r.id) : selectedIds.delete(r.id);
    return;
  }
  if (e.target.classList.contains('edit-name')) r.name = e.target.value;
  if (e.target.classList.contains('edit-price')) r.price = parseFloat(e.target.value);
  if (e.target.classList.contains('edit-secs')) r.seconds = parseInt(e.target.value, 10);
  setDirty(true);
});

$('roundsBody').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const i = +btn.closest('tr').dataset.i;
  const act = btn.dataset.act;
  if (act === 'up' && i > 0) [rounds[i - 1], rounds[i]] = [rounds[i], rounds[i - 1]];
  if (act === 'down' && i < rounds.length - 1) [rounds[i + 1], rounds[i]] = [rounds[i], rounds[i + 1]];
  if (act === 'del') {
    selectedIds.delete(rounds[i].id);
    rounds.splice(i, 1);
  }
  setDirty(true);
  renderRoundsTable();
});

$('addRoundBtn').addEventListener('click', () => {
  const id = 'new-' + Math.random().toString(36).slice(2);
  rounds.push({ id, name: '', price: 0, seconds: 45 });
  selectedIds.add(id);
  setDirty(true);
  renderRoundsTable();
  const inputs = document.querySelectorAll('.edit-name');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

$('discardRoundsBtn').addEventListener('click', () => {
  rounds = JSON.parse(JSON.stringify(savedRounds));
  selectedIds = new Set([...selectedIds].filter(id => rounds.some(r => r.id === id)));
  setDirty(false);
  renderRoundsTable();
});

async function saveRounds() {
  const payload = rounds.map(r => ({ ...r, id: r.id.startsWith('new-') ? undefined : r.id }));
  const saved = await api('PUT', '/api/rounds', payload);
  // Map new rows to their server-issued ids (same order), keep their selection
  const wasSelected = rounds.map(r => selectedIds.has(r.id));
  savedRounds = saved;
  rounds = JSON.parse(JSON.stringify(saved));
  selectedIds = new Set(rounds.filter((_, i) => wasSelected[i]).map(r => r.id));
  setDirty(false);
  renderRoundsTable();
}

$('saveRoundsBtn').addEventListener('click', async () => {
  try {
    await saveRounds();
    showToast('Rounds saved to the cloud');
  } catch (err) {
    showToast(err.message);
  }
});

async function loadRounds() {
  savedRounds = await api('GET', '/api/rounds');
  rounds = JSON.parse(JSON.stringify(savedRounds));
  selectedIds = new Set(rounds.map(r => r.id));
  setDirty(false);
  renderRoundsTable();
}

// Another host (or tab) changed the cloud rounds
socket.on('rounds-updated', (list) => {
  savedRounds = list;
  if (dirty) {
    showToast('Rounds were changed elsewhere - save or discard to refresh');
    return;
  }
  const hadAll = rounds.length > 0 && rounds.every(r => selectedIds.has(r.id));
  rounds = JSON.parse(JSON.stringify(list));
  selectedIds = new Set(rounds.filter(r => hadAll || selectedIds.has(r.id)).map(r => r.id));
  renderRoundsTable();
  showToast('Rounds updated from the cloud');
});

// === RENDERING ===

function renderPlayerList(players) {
  const container = $('playerList');
  $('playerCount').textContent = `${players.length} player${players.length !== 1 ? 's' : ''} joined`;

  if (players.length === 0) {
    container.innerHTML = '<p class="muted-text" style="text-align:center; padding:20px">Waiting for players to join...</p>';
    return;
  }

  container.innerHTML = players.map(p => `
    <div class="player-item">
      <div class="player-name">
        <span class="player-status ${p.connected ? 'connected' : 'disconnected'}"></span>
        ${esc(p.name)}
      </div>
      <button class="btn btn-danger btn-sm" data-kick="${esc(p.name)}">✕</button>
    </div>
  `).join('');
}

$('playerList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kick]');
  if (b && confirm(`Remove "${b.dataset.kick}" from the game?`)) socket.emit('kick-player', { name: b.dataset.kick });
});

function renderSubmitters(players) {
  $('submitters').innerHTML = (players || []).map(p =>
    `<span class="chip ${p.guessed ? 'chip-done' : ''} ${p.connected ? '' : 'chip-off'}">${p.guessed ? '✓ ' : ''}${esc(p.name)}</span>`
  ).join('');
}

function renderResults(rankings, totalScores) {
  $('resultsBody').innerHTML = rankings.map((r, i) => {
    const isOver = r.diff < 0;
    const diffStr = isOver ? `+£${Math.abs(r.diff).toFixed(2)} over` : `-£${Math.abs(r.diff).toFixed(2)}`;
    const rankStr = r.rank ? (r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : `#${r.rank}`) : '—';
    const rankClass = r.rank === 1 ? 'rank-1' : r.rank === 2 ? 'rank-2' : r.rank === 3 ? 'rank-3' : '';
    const bonus = isOver && r.points > 0;

    return `
      <tr class="reveal-row" style="animation-delay:${i * 0.15}s">
        <td>
          ${r.rank && r.rank <= 3 ? `<span class="rank-badge ${rankClass}">${rankStr}</span>` : rankStr}
          <span style="margin-left:8px">${esc(r.name)}</span>
        </td>
        <td>£${r.guess.toFixed(2)}</td>
        <td class="${isOver ? 'over-bid' : ''}">
          ${diffStr}
          ${bonus ? '<span class="bonus-badge">Fastest</span>' : ''}
        </td>
        <td class="points-cell ${r.points === 0 ? 'points-0' : ''}">${r.points > 0 ? '+' : ''}${r.points}</td>
      </tr>
    `;
  }).join('') || '<tr><td colspan="4" class="muted-text" style="text-align:center">Nobody submitted a guess.</td></tr>';

  const sorted = Object.entries(totalScores).sort((a, b) => b[1] - a[1]);
  $('scoreTotalsBody').innerHTML = sorted.map(([name, score], i) => `
    <tr>
      <td>${i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : i === 2 ? '🥉 ' : ''}${esc(name)}</td>
      <td style="text-align:center; color:#f5d76e; font-weight:700">${score}</td>
    </tr>
  `).join('');
}

function renderFinalStandings(totalScores) {
  const sorted = Object.entries(totalScores).sort((a, b) => b[1] - a[1]);
  $('finalStandings').innerHTML = sorted.map(([name, score], i) => {
    const medal = i === 0 ? '🏆' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
    return `
      <li class="standing-item ${i === 0 ? 'standing-winner' : ''}">
        <span class="standing-rank">${medal}</span>
        <span class="standing-name">${esc(name)}</span>
        <span class="standing-score">${score}</span>
      </li>
    `;
  }).join('');
}

function showLobby(resp) {
  sessionCode = resp.code;
  LS.set('tpir_host_session', JSON.stringify({ code: resp.code, hostKey: resp.hostKey }));
  $('lobbySessionCode').textContent = resp.code;
  $('qrCode').innerHTML = resp.qrSvg;
  $('qrUrl').textContent = resp.qrUrl;
}

function fmtTime(s) {
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

// === SETUP ===

$('createSessionBtn').addEventListener('click', () => {
  if (dirty) { showToast('Save or discard your round changes first'); return; }
  const roundIds = rounds.filter(r => selectedIds.has(r.id)).map(r => r.id);
  if (roundIds.length === 0) { showToast('Select at least one round'); return; }

  const btn = $('createSessionBtn');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  socket.emit('create-session', { token: adminToken, roundIds }, (response) => {
    btn.disabled = false;
    btn.textContent = 'Create Session';
    if (response.error) { showToast(response.error); return; }
    showLobby(response);
    renderPlayerList([]);
    showScreen('lobbyScreen');
  });
});

$('startGameBtn').addEventListener('click', () => {
  if (!document.querySelector('#playerList .player-item')) { showToast('Wait for at least one player'); return; }
  socket.emit('start-game');
});

$('startRoundBtn').addEventListener('click', () => {
  socket.emit('start-round');
  $('startRoundBtn').classList.add('hidden');
  $('showResultsBtn').classList.add('hidden');
});

$('showResultsBtn').addEventListener('click', () => socket.emit('show-results'));
$('nextRoundBtn').addEventListener('click', () => socket.emit('next-round'));
$('finalResultsBtn').addEventListener('click', () => showScreen('finalScreen'));

$('newGameBtn').addEventListener('click', () => {
  LS.del('tpir_host_session');
  location.reload();
});

$('resetSessionBtn').addEventListener('click', () => {
  if (!confirm('Reset the entire session? All players will be disconnected and a new code will be generated.')) return;

  socket.emit('reset-session', (response) => {
    if (response.error) { showToast(response.error); return; }
    showLobby(response);
    renderPlayerList([]);
    showToast(`Session reset. New code: ${response.code}`);
  });
});

// === SOCKET EVENTS ===

socket.on('player-joined', (data) => renderPlayerList(data.players));

socket.on('game-started', (data) => {
  totalRounds = data.totalRounds;
  $('gameSessionCode').textContent = sessionCode;
  $('gameRoundIndicator').textContent = `Round 1 of ${totalRounds}`;
  $('gameItemName').textContent = 'Ready?';
  $('submitters').innerHTML = '';
  showScreen('gameScreen');
  $('startRoundBtn').classList.remove('hidden');
  $('startRoundBtn').textContent = 'Start Round 1';
  $('showResultsBtn').classList.add('hidden');
});

socket.on('timer-started', (data) => {
  $('gameItemName').textContent = data.roundName;
  $('gameRoundIndicator').textContent = `Round ${data.roundNumber} of ${data.totalRounds}`;
  $('gameTimer').textContent = fmtTime(data.seconds);
  $('gameTimer').classList.remove('timer-warning');
  $('startRoundBtn').classList.add('hidden');
  $('showResultsBtn').classList.add('hidden');
});

socket.on('timer-tick', (data) => {
  const el = $('gameTimer');
  el.textContent = fmtTime(data.remaining);
  el.classList.toggle('timer-warning', data.remaining <= 10);
});

socket.on('time-up', () => {
  $('gameTimer').textContent = '0:00';
  $('showResultsBtn').classList.remove('hidden');
  $('showResultsBtn').textContent = 'Show Results';
});

socket.on('guess-count', (data) => {
  $('submissionCount').innerHTML = `Submitted: <span>${data.submitted}</span> / <span>${data.total}</span>`;
  renderSubmitters(data.players);
  if (data.submitted === data.total && data.total > 0) {
    $('showResultsBtn').classList.remove('hidden');
    $('showResultsBtn').textContent = 'Show Results';
  }
});

socket.on('round-results', (data) => {
  $('resultsSessionCode').textContent = sessionCode;
  $('resultsRoundLabel').textContent = `Round ${data.roundIndex + 1} Results`;
  $('resultsTitle').textContent = data.roundName;
  $('actualPrice').textContent = `£${formatPrice(data.roundPrice)}`;

  renderResults(data.rankings, data.totalScores);

  const isLast = data.roundIndex + 1 >= totalRounds;
  $('nextRoundBtn').classList.toggle('hidden', isLast);
  $('finalResultsBtn').classList.toggle('hidden', !isLast);
  showScreen('resultsScreen');
});

socket.on('round-ready', (data) => {
  $('gameRoundIndicator').textContent = `Round ${data.roundNumber} of ${data.totalRounds}`;
  $('gameItemName').textContent = 'Ready?';
  $('startRoundBtn').textContent = `Start Round ${data.roundNumber}`;
  $('startRoundBtn').classList.remove('hidden');
  $('showResultsBtn').classList.add('hidden');
  $('gameTimer').textContent = '--:--';
  $('gameTimer').classList.remove('timer-warning');
  $('submitters').innerHTML = '';
  $('submissionCount').innerHTML = 'Submitted: <span>0</span> / <span>0</span>';
  showScreen('gameScreen');
});

socket.on('game-finished', (data) => {
  renderFinalStandings(data.totalScores);
  showScreen('finalScreen');
});

// Re-attach after a refresh or network drop
function tryRejoin() {
  let saved = null;
  try { saved = JSON.parse(LS.get('tpir_host_session')); } catch {}
  if (!saved) return Promise.resolve(false);
  return new Promise((resolve) => {
    socket.emit('host-rejoin', saved, (r) => {
      if (!r || r.error) { LS.del('tpir_host_session'); return resolve(false); }
      sessionCode = r.code;
      totalRounds = r.totalRounds;
      $('lobbySessionCode').textContent = r.code;
      $('gameSessionCode').textContent = r.code;
      $('resultsSessionCode').textContent = r.code;
      $('qrCode').innerHTML = r.qrSvg;
      $('qrUrl').textContent = r.qrUrl;
      renderPlayerList(r.players);
      $('gameRoundIndicator').textContent = `Round ${r.currentRound + 1} of ${r.totalRounds}`;

      if (r.phase === 'setup') {
        showScreen('lobbyScreen');
      } else if (r.phase === 'lobby') {
        $('gameItemName').textContent = 'Ready?';
        $('startRoundBtn').textContent = `Start Round ${r.currentRound + 1}`;
        $('startRoundBtn').classList.remove('hidden');
        $('showResultsBtn').classList.add('hidden');
        showScreen('gameScreen');
      } else if (r.phase === 'playing') {
        $('gameItemName').textContent = r.roundName || '';
        $('gameTimer').textContent = fmtTime(r.remaining || 0);
        $('startRoundBtn').classList.add('hidden');
        $('showResultsBtn').classList.remove('hidden');
        $('showResultsBtn').textContent = 'Show Results';
        showScreen('gameScreen');
      } else if (r.phase === 'results') {
        $('resultsTitle').textContent = r.roundName || 'Results';
        $('actualPrice').textContent = r.roundPrice != null ? `£${formatPrice(r.roundPrice)}` : '';
        renderResults([], r.totalScores);
        const isLast = r.currentRound + 1 >= r.totalRounds;
        $('nextRoundBtn').classList.toggle('hidden', isLast);
        $('finalResultsBtn').classList.toggle('hidden', !isLast);
        showScreen('resultsScreen');
      } else if (r.phase === 'finished') {
        renderFinalStandings(r.totalScores);
        showScreen('finalScreen');
      }
      resolve(true);
    });
  });
}

async function boot() {
  try {
    await loadRounds();
  } catch (err) {
    if (err.status === 401) { showScreen('loginScreen'); return; }
    showToast(err.message);
    return;
  }
  if (!(await tryRejoin())) showScreen('setupScreen');
}

socket.on('connect', async () => {
  // After a drop, silently take the session back
  if (sessionCode && adminToken) {
    socket.emit('host-subscribe', { token: adminToken });
    tryRejoin();
  }
});

(async function init() {
  try {
    await tryLogin(adminToken);
    await boot();
  } catch {
    showScreen('loginScreen');
  }
})();
