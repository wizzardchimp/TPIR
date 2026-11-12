const socket = io();
const token = localStorage.getItem('tpirToken') || crypto.randomUUID();
localStorage.setItem('tpirToken', token);

let state = null;
let you = null;
let joined = false;
let lastRound = '';
let rawDigits = '';
let phoneRevealAt = 0;
let phoneRevealRound = '';

const gate = document.getElementById('gate');
const play = document.getElementById('play');
const guessForm = document.getElementById('guess-form');
const guessInput = document.getElementById('guess');
const status = document.getElementById('status');

function penceFromInput(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n > 10000000000) return null;
  return n;
}
function sourceLine(text) {
  if (!text) return '';
  if (/^source/i.test(text)) return text;
  return 'Source... ' + text;
}
function renderGuess() {
  if (!rawDigits) {
    guessInput.value = '';
    return;
  }
  const formatted = TPIR.formatPrice(Number(rawDigits));
  guessInput.value = formatted;
  const end = formatted.length;
  if (document.activeElement === guessInput) guessInput.setSelectionRange(end, end);
}
function pushDigit(digit) {
  let next = rawDigits + digit;
  next = next.replace(/^0+(?=\d)/, '');
  if (!next) next = '0';
  if (Number(next) > 10000000000) return;
  rawDigits = next;
  renderGuess();
}
function popDigit() {
  rawDigits = rawDigits.slice(0, -1);
  renderGuess();
}
let guessKeyHandled = false;
guessInput.addEventListener('keydown', (e) => {
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    guessKeyHandled = true;
    popDigit();
    return;
  }
  if (/^\d$/.test(e.key)) {
    e.preventDefault();
    guessKeyHandled = true;
    pushDigit(e.key);
    return;
  }
  if (e.key.length === 1 && e.key !== 'Enter') e.preventDefault();
});
guessInput.addEventListener('beforeinput', (e) => {
  if (guessKeyHandled) {
    e.preventDefault();
    guessKeyHandled = false;
    return;
  }
  if (e.inputType && e.inputType.indexOf('delete') === 0) {
    e.preventDefault();
    popDigit();
    return;
  }
  const data = e.data || '';
  if (/^\d+$/.test(data)) {
    e.preventDefault();
    for (const digit of data) pushDigit(digit);
    return;
  }
  e.preventDefault();
});
guessInput.addEventListener('input', () => {
  guessKeyHandled = false;
  renderGuess();
});
function paintClock() {
  const clock = document.getElementById('clock');
  if (!clock) return;
  const running = state && state.phase === 'guessing' && !state.bidsIn && state.roundEndsAt;
  clock.classList.toggle('hidden', !running);
  if (!running) return;
  const left = Math.max(0, state.roundEndsAt - Date.now());
  const sec = Math.ceil(left / 1000);
  clock.textContent = '0:' + String(sec).padStart(2, '0');
  if (left > 0) requestAnimationFrame(paintClock);
}
function paint() {
  if (!joined) return;
  paintClock();
  gate.classList.add('hidden');
  play.classList.remove('hidden');
  document.getElementById('kicker').textContent = ((state?.showTitle || "WMROCU'S") + ' ' + (state?.showSubtitle || '')).trim();
  const round = state?.round;
  const roundId = round?.id || '';
    if (roundId !== lastRound) {
      lastRound = roundId;
      rawDigits = '';
      guessInput.value = '';
      phoneRevealRound = '';
    }
  const label = document.getElementById('round-label');
  if (state && state.phase !== 'title' && state.phase !== 'podium') {
    label.textContent = 'Round ' + (state.roundIndex + 1) + ' of ' + state.roundCount;
  } else {
    label.textContent = '';
  }
  const title = document.getElementById('title');
  const source = document.getElementById('source');
  const hex = document.getElementById('hex');
  const photo = document.getElementById('photo');
  const badge = document.getElementById('badge');
  if (state?.phase === 'title') {
    title.textContent = 'You are in';
    source.textContent = 'Watch the big screen';
    hex.classList.add('hidden');
    badge.classList.add('hidden');
    guessForm.classList.add('hidden');
    status.classList.remove('hidden');
    status.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = you?.name || '';
    status.append(strong);
    return;
  }
  if (state?.phase === 'podium') {
    title.textContent = 'Final board';
    source.textContent = you && you.played ? 'You scored ' + you.total + ' points' : 'Scores are on the big screen';
    hex.classList.add('hidden');
    badge.classList.add('hidden');
    guessForm.classList.add('hidden');
    status.classList.add('hidden');
    return;
  }
  title.textContent = round?.title || 'Watch the screen';
  source.textContent = sourceLine(round?.source || '');
  const revealed = state.phase === 'revealed' && round?.pricePence != null;
  if (revealed && phoneRevealRound !== round.id) {
    phoneRevealRound = round.id;
    phoneRevealAt = Date.now() + 3000;
  }
  const revealReady = revealed && Date.now() >= phoneRevealAt;
  const points = document.getElementById('points');
  points.replaceChildren();
  if (!revealReady) {
    (round?.points || []).forEach((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      points.append(li);
    });
  }
  if (revealed && !revealReady) setTimeout(paint, phoneRevealAt - Date.now() + 20);
  if (!revealReady && round?.image) {
    photo.src = round.image;
    photo.alt = round.title || '';
    hex.classList.remove('hidden');
  } else {
    hex.classList.add('hidden');
  }
  badge.classList.add('hidden');
  const locked = state.bidsIn || state.phase !== 'guessing';
  const hasBid = you && you.guessPence != null && you.submitted;
  if (!locked) {
    guessForm.classList.remove('hidden');
    document.getElementById('send').textContent = hasBid ? 'Change bid' : 'Lock in';
    status.classList.toggle('hidden', !hasBid);
    if (hasBid) fillStatus();
  } else {
    guessForm.classList.add('hidden');
    status.classList.remove('hidden');
    fillStatus();
  }
}
function roundWinners() {
  if (!state || !state.round || state.round.pricePence == null) return [];
  const ranked = state.players.map((p) => ({
    name: p.name,
    offset: p.guessPence == null ? null : Math.abs(p.guessPence - state.round.pricePence),
  })).filter((p) => p.offset != null);
  if (!ranked.length) return [];
  const best = Math.min(...ranked.map((p) => p.offset));
  return ranked.filter((p) => p.offset === best).map((p) => p.name);
}
function fillStatus() {
  status.replaceChildren();
  const revealed = state && state.phase === 'revealed' && state.round && state.round.pricePence != null && Date.now() >= phoneRevealAt;
  if (revealed) {
    const grid = document.createElement('div');
    grid.className = 'compare';
    const yours = document.createElement('div');
    const yoursLabel = document.createElement('span');
    yoursLabel.textContent = 'Your guess';
    const yoursValue = document.createElement('strong');
    yoursValue.textContent = you && you.guessPence != null ? TPIR.formatPrice(you.guessPence) : 'No bid';
    yours.append(yoursLabel, yoursValue);
    const actual = document.createElement('div');
    const actualLabel = document.createElement('span');
    actualLabel.textContent = 'Actual price';
    const actualValue = document.createElement('strong');
    actualValue.textContent = TPIR.formatPrice(state.round.pricePence);
    actual.append(actualLabel, actualValue);
    grid.append(yours, actual);
    status.append(grid);
    const winners = roundWinners();
    const line = document.createElement('p');
    line.className = 'winner-line';
    if (!winners.length) line.textContent = 'No winner';
    else if (you && winners.length === 1 && winners[0] === you.name) line.textContent = 'You won';
    else line.textContent = 'Winner: ' + winners.join(', ');
    if (you && you.roundPoints != null) {
      const mine = document.createElement('p');
      mine.className = 'hint';
      mine.textContent = 'You scored ' + you.roundPoints + ' points';
      status.append(mine);
    }
    status.append(line);
    return;
  }
  if (you?.guessPence == null) {
    const p = document.createElement('p');
    p.className = 'bid';
    p.textContent = 'No bid';
    status.append(p);
  } else {
    const p = document.createElement('p');
    p.className = 'bid';
    p.textContent = TPIR.formatPrice(you.guessPence);
    status.append(p);
    const note = document.createElement('p');
    note.className = 'hint';
    if (state?.bidsIn) note.textContent = 'Bids are in';
    else note.textContent = 'Bid in';
    status.append(note);
  }
}
const joinCode = (new URLSearchParams(location.search).get('code') || '').toUpperCase();
function join(name) {
  if (!joinCode) {
    document.getElementById('join-err').textContent = 'Scan the code on the screen';
    return;
  }
  socket.emit('player:join', { token, name, code: joinCode });
}

document.getElementById('join-form').onsubmit = (e) => {
  e.preventDefault();
  join(document.getElementById('name').value);
};
guessForm.onsubmit = (e) => {
  e.preventDefault();
  const pence = rawDigits === '' ? null : Number(rawDigits);
  if (pence == null) {
    document.getElementById('preview').textContent = 'Enter a price';
    return;
  }
  socket.emit('player:guess', { pence });
};

socket.on('connect', () => {
  document.getElementById('offline').classList.add('hidden');
  const saved = localStorage.getItem('tpirName');
  if (saved) join(saved);
});
socket.on('disconnect', () => document.getElementById('offline').classList.remove('hidden'));
socket.on('joined', ({ name }) => {
  joined = true;
  localStorage.setItem('tpirName', name);
  document.getElementById('join-err').textContent = '';
  paint();
});
socket.on('join:err', (message) => {
  document.getElementById('join-err').textContent = message;
});
socket.on('guess:err', (message) => {
  document.getElementById('preview').textContent = message;
});
socket.on('state', (next) => {
  if (joinCode && next.sessionCode && next.sessionCode !== joinCode) {
    joined = false;
    document.getElementById('play').classList.add('hidden');
    document.getElementById('gate').classList.remove('hidden');
    document.getElementById('join-err').textContent = 'Session ended. Scan the new code.';
  }
  state = next;
  paint();
});
socket.on('you', (next) => {
  you = next;
  paint();
});

if (localStorage.getItem('tpirName')) {
  document.getElementById('name').value = localStorage.getItem('tpirName');
}
