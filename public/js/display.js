const socket = io();
let state = null;
let hostToken = sessionStorage.getItem('tpirHost') || '';
let pending = null;
let autoAuthSent = false;
let booted = false;
let lastSeq = 0;
let shownPrice = false;
let seenTitleCount = null;
let presented = false;
let diamondPlayed = false;
let podiumBurst = false;
let podiumStage = 0; // 0 = winner pop-up, 1 = full board
const recent = {};

const intro = new Audio('/audio/intro.mp3');
intro.loop = true;
intro.preload = 'auto';
const bed = new Audio();
bed.loop = true;
bed.preload = 'auto';
let bedUrl = '';
const curtainMusic = new Audio('/audio/end.mp3');
curtainMusic.loop = true;
curtainMusic.preload = 'auto';
let master = 1;
const liveStingers = new Set();
function setGain(audio, intended) {
  audio._gain = intended;
  audio.volume = Math.max(0, Math.min(1, intended * master));
}
function playCurtainMusic() {
  setGain(curtainMusic, 0.85);
  curtainMusic.play().then(hideHint).catch(() => {
    document.getElementById('sound-hint').classList.remove('hidden');
  });
}
function stopCurtainMusic() {
  curtainMusic.pause();
  curtainMusic.currentTime = 0;
}

const screens = {
  title: document.getElementById('screen-title'),
  round: document.getElementById('screen-round'),
  podium: document.getElementById('screen-podium'),
};

function mark(name) {
  recent[name] = performance.now();
}
function fresh(name) {
  return !recent[name] || performance.now() - recent[name] > 1200;
}
function hideHint() {
  document.getElementById('sound-hint').classList.add('hidden');
}
function playIntro() {
  if (state && state.phase !== 'title') return;
  setGain(intro, 1);
  intro.play().then(hideHint).catch(() => {
    document.getElementById('sound-hint').classList.remove('hidden');
  });
}
function fade(audio, to, ms) {
  const from = audio._gain == null ? audio.volume : audio._gain;
  const t0 = performance.now();
  return new Promise((resolve) => {
    function frame(now) {
      const p = Math.min(1, (now - t0) / ms);
      setGain(audio, from + (to - from) * p);
      if (p < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}
async function goBed(url) {
  if (!url) {
    if (!bed.paused) await fade(bed, 0, 700);
    bed.pause();
    bedUrl = '';
    return;
  }
  if (bedUrl === url && !bed.paused) {
    const gain = bed._gain == null ? bed.volume : bed._gain;
    if (gain < 0.8) await fade(bed, 0.85, 500);
    return;
  }
  if (!bed.paused) await fade(bed, 0, 700);
  bed.src = url;
  bedUrl = url;
  setGain(bed, 0);
  try {
    await bed.play();
    hideHint();
    await fade(bed, 0.85, 400);
  } catch {
    document.getElementById('sound-hint').classList.remove('hidden');
  }
}
async function fadeIntroThenBed(url) {
  mark('start');
  if (!intro.paused && intro.currentTime > 0.05 && intro.volume > 0.05) {
    await fade(intro, 0, 1500);
  }
  intro.pause();
  intro.currentTime = 0;
  setGain(intro, 1);
  await goBed(url);
}
function playStinger(file, name) {
  mark(name);
  const a = new Audio('/audio/' + file);
  const prev = bed.paused ? 0.85 : (bed._gain == null ? bed.volume : bed._gain);
  if (!bed.paused) setGain(bed, 0.16);
  setGain(a, 1);
  liveStingers.add(a);
  a.play().then(hideHint).catch(() => {});
  a.addEventListener('ended', () => {
    liveStingers.delete(a);
    if (name === 'scores') {
      if (state && state.phase === 'revealed' && !bed.paused) fade(bed, 0, 600);
      return;
    }
    if (!bed.paused && state && state.phase !== 'podium' && state.phase !== 'title') {
      fade(bed, 0.85, 350);
    } else if (prev) {
      setGain(bed, prev);
    }
  }, { once: true });
}
function sourceLine(text) {
  if (!text) return '';
  if (/^source/i.test(text)) return text;
  return 'Source... ' + text;
}
function subtitle(el, text) {
  const words = String(text || 'PRICE IS RIGHT').trim().split(/\s+/).filter(Boolean);
  el.replaceChildren();
  words.forEach((word, i) => {
    if (i) el.append(document.createElement('br'));
    el.append(document.createTextNode(word));
  });
}
function compareStanding(a, b) {
  const revealed = state.revealedCount || 0;
  if (!a.played && b.played) return 1;
  if (a.played && !b.played) return -1;
  if (a.total !== b.total) return b.total - a.total;
  return a.name.localeCompare(b.name);
}
function paintRoundTimer() {
  const bar = document.getElementById('timer-bar');
  const fill = document.getElementById('timer-fill');
  if (!bar || !fill) return;
  const running = state && state.phase === 'guessing' && !state.bidsIn && state.roundEndsAt;
  bar.classList.toggle('hidden', !running);
  if (!running) return;
  const total = state.roundMs || 60000;
  const left = Math.max(0, state.roundEndsAt - Date.now());
  fill.style.width = Math.min(100, ((total - left) / total) * 100) + '%';
  if (left > 0) requestAnimationFrame(paintRoundTimer);
}
function playDiamond() {
  const wrap = document.querySelector('.diamond-wrap');
  if (!wrap || !state) return;
  if (state.phase === 'title' && presented) {
    if (diamondPlayed) return;
    diamondPlayed = true;
    wrap.classList.remove('arrive');
    void wrap.offsetWidth;
    wrap.classList.add('arrive');
    return;
  }
  diamondPlayed = false;
  wrap.classList.remove('arrive');
}
function showScreen(name) {
  screens.title.classList.toggle('active', name === 'title');
  screens.round.classList.toggle('active', name === 'round');
  screens.podium.classList.toggle('active', name === 'podium');
}
function render() {
  if (!state) return;
  document.getElementById('show-name').textContent = presenterName ? possessive(presenterName) : (state.showTitle || "WMROCU'S");
  subtitle(document.getElementById('show-sub'), state.showSubtitle);
  document.getElementById('tagline').textContent = presenterName ? taglineFor(presenterName) : (state.tagline || '');
  paintLobby();
  playDiamond();
  paintRoundTimer();
  if (presented && state.phase === 'title') startTitleFx();
  else if (state.phase === 'podium') {
    startTitleFx();
    if (!podiumBurst) {
      podiumBurst = true;
      burstConfetti();
    }
  } else {
    podiumBurst = false;
    podiumStage = 0;
    stopTitleFx();
  }

  const phase = state.phase;
  if (phase === 'title') showScreen('title');
  else if (phase === 'podium') showScreen('podium');
  else showScreen('round');


  if (phase !== 'title') hideHint();
  paintDock();
  paintRound();
  paintTimeUp();
  paintRoundResult();
  if (phase === 'podium') paintPodium();
  if (!document.getElementById('score-pop').classList.contains('hidden')) paintScores();
  paintPlayers();
}
function openLobby() {
  if (!presented || !state) return;
  document.getElementById('lobby-pop').classList.remove('hidden');
  document.getElementById('qr-full').classList.add('hidden');
}
function toggleLobby() {
  const pop = document.getElementById('lobby-pop');
  const full = document.getElementById('qr-full');
  if (!pop.classList.contains('hidden') || !full.classList.contains('hidden')) {
    pop.classList.add('hidden');
    full.classList.add('hidden');
    return;
  }
  openLobby();
}
function paintLobby() {
  const players = state.players || [];
  const n = players.length;
  const onTitle = state.phase === 'title' && presented;
  const badge = document.getElementById('qr-badge');
  badge.textContent = String(n);
  badge.classList.toggle('hidden', n === 0 || !onTitle);
  document.getElementById('toolbar').classList.toggle('hidden', state.phase === 'title' && !presented);
  const pop = document.getElementById('lobby-pop');
  if (!onTitle) {
    pop.classList.add('hidden');
    seenTitleCount = null;
    return;
  }
  if (seenTitleCount !== null && n > seenTitleCount) openLobby();
  seenTitleCount = n;
  const away = players.filter((p) => !p.connected).length;
  document.getElementById('join-count').textContent = n + (n === 1 ? ' player waiting' : ' players waiting') + (away ? ' · ' + away + ' away' : '');
  const list = document.getElementById('lobby-players');
  list.replaceChildren();
  for (const p of players) {
    const row = document.createElement('div');
    row.className = 'lobby-name';
    row.textContent = p.name + (p.connected ? '' : ' (away)');
    list.append(row);
  }
}
function beginShow() {
  if (!state || !state.roundCount) return;
  ensureHost(() => {
    hideHint();
    document.getElementById('lobby-pop').classList.add('hidden');
    document.getElementById('qr-full').classList.add('hidden');
    document.getElementById('rules-pop').classList.remove('hidden');
    paintDock();
  });
}
function startRoundAfterRules() {
  if (!state || !state.roundCount) return;
  ensureHost(() => {
    hideHint();
    document.getElementById('rules-pop').classList.add('hidden');
    if (intro.paused) {
      setGain(intro, 0.01);
      intro.play().catch(() => {});
    }
    mark('start');
    socket.emit('host:start', { token: hostToken });
    fadeIntroThenBed(state.startAudio || '');
    paintDock();
  });
}
function paintRound() {
  const round = state.round;
  if (!round) return;
  document.getElementById('item-title').textContent = round.title || '';
  document.getElementById('item-source').textContent = sourceLine(round.source);
  const img = document.getElementById('item-img');
  const hex = document.getElementById('hex');
  if (round.image) {
    if (img.getAttribute('src') !== round.image) img.src = round.image;
    img.alt = round.title || '';
    hex.classList.remove('empty');
  } else {
    img.removeAttribute('src');
    hex.classList.add('empty');
  }
  const reveal = state.phase === 'revealed' && round.pricePence != null;
  const badge = document.getElementById('badge');
  const scrim = document.getElementById('price-scrim');
  if (scrim) scrim.classList.toggle('hidden', !reveal);
  badge.classList.toggle('hidden', !reveal);
  badge.classList.toggle('focus', reveal);
  if (reveal) {
    const priceEl = document.getElementById('badge-price');
    priceEl.textContent = TPIR.formatPrice(round.pricePence);
    const winners = roundWinners();
    const winnerEl = document.getElementById('badge-winner');
    winnerEl.textContent = winners.length
      ? winners.join(' & ') + (winners.length > 1 ? ' win!' : ' wins!')
      : '';
    fitBadge(badge);
    if (!shownPrice) {
      badge.classList.remove('pop', 'hold');
      void badge.offsetWidth;
      badge.classList.add('pop');
      setTimeout(() => {
        if (badge.classList.contains('focus')) badge.classList.add('hold');
      }, 600);
    }
  } else {
    badge.classList.remove('hold');
    document.getElementById('badge-winner').textContent = '';
  }
  shownPrice = reveal;
  const points = document.getElementById('item-points');
  points.replaceChildren();
  (round.points || []).forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    points.append(li);
  });
  if (guessRound && guessRound !== round.id) guessesOpen = false;
  guessRound = round.id;
  paintGuessList();
}
function roundWinners() {
  if (!state || !state.players || !state.players.length) return [];
  const points = (p) => (p.scores ? p.scores[state.roundIndex] : null);
  const best = state.players.reduce((max, p) => Math.max(max, points(p) == null ? -1 : points(p)), -1);
  if (best <= 0) return [];
  return state.players.filter((p) => points(p) === best).map((p) => p.name);
}
function fitBadge(badge) {
  const price = badge.querySelector('#badge-price');
  if (!price) return;
  const size = badge.clientWidth || Math.min(window.innerHeight * 1.14, window.innerWidth * 0.9);
  const len = Math.max(1, price.textContent.length);
  const priceFont = Math.max(28, (size * 0.66) / (len * 0.62));
  price.style.fontSize = priceFont + 'px';
  const winner = badge.querySelector('#badge-winner');
  if (winner && winner.textContent) {
    const wlen = Math.max(1, winner.textContent.length);
    const wfont = Math.min(priceFont * 0.42, (size * 0.74) / (wlen * 0.58));
    winner.style.fontSize = Math.max(18, wfont) + 'px';
  } else if (winner) {
    winner.style.fontSize = '';
  }
}
window.addEventListener('resize', () => {
  const badge = document.getElementById('badge');
  if (badge && badge.classList.contains('focus')) fitBadge(badge);
});
let resultTimer = 0;
let scoreboardLocked = false;
let guessesOpen = false;
let guessRound = '';
let resultFor = '';
function paintGuessList() {
  const box = document.getElementById('guess-list');
  const show = guessesOpen && state && state.round && (state.phase === 'guessing' || state.phase === 'revealed');
  box.classList.toggle('hidden', !show);
  if (!show) return;
  box.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = 'Guesses';
  box.append(heading);
  if (!state.players.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No players yet.';
    box.append(empty);
    return;
  }
  state.players.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'guess-row';
    const name = document.createElement('span');
    name.textContent = p.name;
    const bid = document.createElement('strong');
    bid.textContent = p.guessPence == null ? '—' : TPIR.formatPrice(p.guessPence);
    row.append(name, bid);
    box.append(row);
  });
  autoScroll(box);
}
let timeUpRound = '';
function showTimeUp() {
  document.getElementById('time-up').classList.remove('hidden');
}
function hideTimeUp() {
  document.getElementById('time-up').classList.add('hidden');
}
function paintTimeUp() {
  if (!state || !state.timedOut || state.phase !== 'guessing') {
    if (!state || state.phase !== 'guessing') timeUpRound = '';
    if (!state || !state.timedOut) hideTimeUp();
    return;
  }
  if (timeUpRound === (state.round && state.round.id)) return;
  timeUpRound = state.round ? state.round.id : 'round';
  showTimeUp();
}
function continueRound() {
  if (!state) return;
  scoreboardLocked = false;
  hideTimeUp();
  document.getElementById('round-result').classList.add('hidden');
  document.getElementById('price-scrim').classList.add('hidden');
  const badge = document.getElementById('badge');
  badge.classList.add('hidden');
  badge.classList.remove('focus', 'hold', 'pop');
  if (state.phase === 'revealed' && state.roundIndex + 1 >= state.roundCount) {
    mark('end');
    goBed('/audio/end.mp3');
  } else if (state.phase === 'revealed' && state.nextAudio) {
    mark('round');
    goBed(state.nextAudio);
  } else if (state.phase === 'podium') {
    mark('title');
    bed.pause();
    playIntro();
  }
  socket.emit('host:next', { token: hostToken });
}
function toggleGuesses() {
  if (!state || !state.round || (state.phase !== 'guessing' && state.phase !== 'revealed')) return;
  guessesOpen = !guessesOpen;
  paintGuessList();
}
function openRoundResult() {
  const pop = document.getElementById('round-result');
  if (!state || state.phase !== 'revealed' || !state.round || state.round.id !== resultFor) return;
  clearTimeout(resultTimer);
  pop.classList.remove('hidden');
  document.getElementById('badge').classList.remove('hold');
  scoreboardLocked = true;
  if (fresh('scores')) playStinger('scores.mp3', 'scores');
  paintRoundResult();
  paintDock();
}
function showResultsNow() {
  if (!state || state.phase !== 'revealed' || !state.round) return;
  resultFor = state.round.id;
  openRoundResult();
}
function paintRoundResult() {
  const pop = document.getElementById('round-result');
  const sheet = document.getElementById('result-sheet');
  const locked = scoreboardLocked && state && state.round && state.round.id === resultFor;
  if (!state || state.phase !== 'revealed' || !state.round || state.round.pricePence == null) {
    clearTimeout(resultTimer);
    if (!locked) {
      pop.classList.add('hidden');
      if (!state || state.phase !== 'revealed') resultFor = '';
    }
    return;
  }
  if (resultFor !== state.round.id) {
    resultFor = state.round.id;
    clearTimeout(resultTimer);
    resultTimer = setTimeout(openRoundResult, 3000);
    return;
  }
  if (pop.classList.contains('hidden')) return;
  paintDock();
  sheet.replaceChildren();
  const head = document.createElement('div');
  head.className = 'result-head';
  const kicker = document.createElement('p');
  kicker.className = 'kicker';
  kicker.textContent = 'Round result';
  const heading = document.createElement('h2');
  heading.textContent = state.round.title;
  const price = document.createElement('p');
  price.className = 'sub';
  price.textContent = 'Actual price ' + TPIR.formatPrice(state.round.pricePence);
  head.append(kicker, heading, price);
  sheet.append(head);
  const ranked = state.players.map((p) => ({
    name: p.name,
    guessPence: p.guessPence,
    points: (p.scores || [])[state.roundIndex],
  })).sort((a, b) => {
    if (a.points == null) return 1;
    if (b.points == null) return -1;
    return b.points - a.points || a.name.localeCompare(b.name);
  });
  const best = ranked.find((p) => p.points != null);
  ranked.forEach((p) => {
    const row = document.createElement('div');
    const won = best && p.points != null && p.points === best.points && p.points > 0;
    row.className = 'result-row' + (won ? ' winner' : '');
    const name = document.createElement('span');
    name.textContent = won ? p.name + ' won' : p.name;
    const detail = document.createElement('strong');
    if (p.guessPence == null) detail.textContent = 'No bid';
    else detail.textContent = TPIR.formatPrice(p.guessPence) + ' · ' + p.points + (p.points === 1 ? ' pt' : ' pts');
    row.append(name, detail);
    sheet.append(row);
  });
  const cont = document.createElement('button');
  cont.type = 'button';
  cont.className = 'lobby-start';
  cont.textContent = state.roundIndex + 1 >= state.roundCount ? 'Final board' : 'Continue';
  cont.onclick = continueRound;
  sheet.append(cont);
  autoScroll(sheet);
}
function standings() {
  const ranked = [...state.players].sort(compareStanding);
  return ranked.map((p) => ({
    p,
    rank: 1 + ranked.filter((q) => q.played > 0 && q.total > p.total).length,
  }));
}
function podiumWinners() {
  const ranked = standings().filter((s) => s.p.played > 0);
  if (!ranked.length) return [];
  return ranked.filter((s) => s.rank === 1).map((s) => s.p);
}
function fitText(node, maxPx, minPx, boxWidth) {
  const len = Math.max(1, node.textContent.length);
  node.style.fontSize = Math.max(minPx, Math.min(maxPx, boxWidth / (len * 0.6))) + 'px';
}
function paintWinner() {
  const winners = podiumWinners();
  const name = document.getElementById('winner-name');
  const score = document.getElementById('winner-score');
  const others = document.getElementById('winner-others');
  const kicker = document.getElementById('winner-kicker');
  if (!winners.length) {
    kicker.textContent = 'Game over';
    name.textContent = 'No winner';
    score.textContent = 'Nobody scored this time';
    others.textContent = '';
  } else {
    kicker.textContent = winners.length > 1 ? 'Joint winners' : 'And the winner is';
    name.textContent = winners.map((w) => w.name).join(' & ');
    score.textContent = winners[0].total + (winners[0].total === 1 ? ' point' : ' points');
    const rest = standings().filter((s) => s.rank > 1 && s.p.played > 0).slice(0, 2);
    others.textContent = rest.map((s) => (s.rank === 2 ? '2nd ' : s.rank === 3 ? '3rd ' : s.rank + 'th ') + s.p.name + ' · ' + s.p.total).join('     ');
  }
  fitText(name, window.innerHeight * 0.2, 28, window.innerWidth * 0.82);
}
function fitBoard() {
  const wrap = document.getElementById('grid-wrap');
  const table = wrap.querySelector('table.board');
  if (!table || !state) return;
  const rows = Math.max(1, state.players.length);
  const cols = state.rounds.length;
  const names = state.players.reduce((m, p) => Math.max(m, p.name.length), 6);
  const byHeight = (wrap.clientHeight - 24) / (rows + 1.9) / 2.25;
  const byWidth = (wrap.clientWidth - 24) / (names * 0.62 + (cols + 1) * 3.6 + 5);
  const size = Math.max(14, Math.min(46, byHeight, byWidth));
  table.style.fontSize = size + 'px';
}
function paintPodium() {
  document.getElementById('winner-stage').classList.toggle('hidden', podiumStage !== 0);
  document.getElementById('board-stage').classList.toggle('hidden', podiumStage !== 1);
  if (podiumStage === 0) {
    paintWinner();
    return;
  }
  const winners = podiumWinners();
  document.getElementById('board-title').textContent = winners.length
    ? winners.map((w) => w.name).join(' & ') + (winners.length > 1 ? ' win' : ' wins') + ' with ' + winners[0].total
    : 'Final scores';
  const wrap = document.getElementById('grid-wrap');
  wrap.replaceChildren();
  const table = el('table', 'board');
  const thead = document.createElement('thead');
  const head = document.createElement('tr');
  head.append(el('th', 'rk', '#'), el('th', 'nm', 'Player'));
  for (const round of state.rounds) {
    const th = el('th', 'rd', round.short || round.title);
    if (round.pricePence != null) th.append(el('small', '', TPIR.formatPrice(round.pricePence)));
    head.append(th);
  }
  head.append(el('th', 'tt', 'Total'));
  thead.append(head);
  const body = document.createElement('tbody');
  for (const { p, rank } of standings()) {
    const tr = document.createElement('tr');
    const played = p.played > 0;
    if (played && rank === 1) tr.className = 'winner';
    else if (played && rank <= 3) tr.className = 'podium-' + rank;
    const rk = el('td', 'rk', played ? String(rank) : '–');
    const nm = el('td', 'nm', p.name);
    tr.append(rk, nm);
    (p.scores || []).forEach((score, i) => {
      if (i >= state.rounds.length) return;
      const td = el('td', 'rd');
      td.append(el('span', 'pt s' + (score == null ? 'x' : score), score == null ? '–' : String(score)));
      tr.append(td);
    });
    tr.append(el('td', 'tt', played ? String(p.total) : '–'));
    body.append(tr);
  }
  table.append(thead, body);
  wrap.append(table);
  fitBoard();
  autoScroll(wrap);
}
window.addEventListener('resize', () => {
  if (state && state.phase === 'podium') { paintPodium(); }
});
const scrollers = new Set();
function autoScroll(el) {
  if (!el || scrollers.has(el)) return;
  scrollers.add(el);
  let dir = 1;
  let pause = 0;
  function tick() {
    const visible = el.isConnected && !el.classList.contains('hidden') && el.offsetParent !== null;
    if (!visible) {
      scrollers.delete(el);
      return;
    }
    if (el.scrollHeight > el.clientHeight + 12) {
      if (pause > 0) pause -= 1;
      else {
        el.scrollTop += dir * 0.45;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
          dir = -1;
          pause = 50;
        } else if (el.scrollTop <= 0) {
          dir = 1;
          pause = 50;
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
function paintScores() {
  const sheet = document.getElementById('score-sheet');
  sheet.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = 'Scoreboard';
  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent = 'Lower is closer';
  sheet.append(h, sub);
  const ranked = [...state.players].sort(compareStanding);
  if (!ranked.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No players yet.';
    sheet.append(empty);
  }
  for (const p of ranked) {
    const row = document.createElement('div');
    row.className = 'score-row';
    const name = document.createElement('span');
    name.textContent = p.name;
    const total = document.createElement('strong');
    total.textContent = p.played ? String(p.total) : '—';
    row.append(name, total);
    sheet.append(row);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.onclick = () => document.getElementById('score-pop').classList.add('hidden');
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(close);
  sheet.append(actions);
}
function rulesOpen() {
  return !document.getElementById('rules-pop').classList.contains('hidden');
}
function resultOpen() {
  return !document.getElementById('round-result').classList.contains('hidden');
}
function lockBids() {
  if (!state || state.phase !== 'guessing' || state.bidsIn) return;
  mark('ding');
  playStinger('dingding.mp3', 'ding');
  socket.emit('host:lock', { token: hostToken });
}
function revealPrice() {
  if (!state || state.phase !== 'guessing') return;
  hideTimeUp();
  if (state.round) timeUpRound = state.round.id;
  mark('reveal');
  playStinger('reveal.mp3', 'reveal');
  socket.emit('host:reveal', { token: hostToken });
}
function revealBoard() {
  podiumStage = 1;
  burstConfetti();
  paintPodium();
  paintDock();
}
// The one "what happens next" action. Space, a clicker, or the big toolbar button all run this.
function currentStep() {
  if (!state || !presented || consoleOpen()) return null;
  if (rulesOpen()) return { label: 'Start game', run: startRoundAfterRules };
  const last = state.roundIndex + 1 >= state.roundCount;
  if (state.phase === 'title') return state.roundCount ? { label: 'Start game', run: beginShow } : null;
  if (state.phase === 'guessing') {
    return state.bidsIn
      ? { label: 'Reveal price', run: revealPrice }
      : { label: 'Lock bids', run: lockBids };
  }
  if (state.phase === 'revealed') {
    if (!resultOpen()) return { label: 'Show scores', run: showResultsNow };
    return { label: last ? 'Final results' : 'Next round', run: continueRound };
  }
  if (state.phase === 'podium') {
    return podiumStage === 0
      ? { label: 'Reveal board', run: revealBoard }
      : { label: 'New game', run: continueRound };
  }
  return null;
}
function advance() {
  const step = currentStep();
  if (step) step.run();
  paintDock();
}
function paintDock() {
  const bar = document.getElementById('toolbar');
  bar.classList.toggle('hidden', !state || (state.phase === 'title' && !presented));
  if (!state) return;
  const step = currentStep();
  const next = document.getElementById('dock-next');
  next.disabled = !step;
  document.getElementById('dock-label').textContent = step ? step.label : 'Next';
  const roundLine = document.getElementById('step-round');
  const stateLine = document.getElementById('step-state');
  const n = state.players.length;
  const bids = state.players.filter((p) => p.submitted).length;
  if (state.phase === 'title') {
    roundLine.textContent = 'Lobby';
    stateLine.textContent = n + (n === 1 ? ' player' : ' players');
  } else if (state.phase === 'podium') {
    roundLine.textContent = 'Final board';
    stateLine.textContent = podiumStage === 0 ? 'Winner' : 'Scores';
  } else {
    roundLine.textContent = 'Round ' + (state.roundIndex + 1) + ' of ' + state.roundCount;
    if (state.phase === 'guessing') stateLine.textContent = (state.bidsIn ? 'Bids locked' : 'Bids open') + ' · ' + bids + '/' + n + ' in';
    else stateLine.textContent = 'Price revealed';
  }
  const code = document.getElementById('session-code');
  if (state.sessionCode) code.textContent = state.sessionCode;
  const qr = '/qr.svg?code=' + (state.sessionCode || '');
  ['qr', 'lobby-qr'].forEach((id) => {
    const img = document.getElementById(id);
    if (img && img.getAttribute('src') !== qr) img.src = qr;
  });
  if (joinInfo.code !== state.sessionCode) loadJoinInfo();
}
function openPin() {
  document.getElementById('pin-err').textContent = '';
  document.getElementById('pin').value = '';
  document.getElementById('pin-pop').classList.remove('hidden');
  document.getElementById('pin').focus();
}
function ensureHost(next) {
  next();
}
function openScores() {
  if (fresh('scores')) playStinger('scores.mp3', 'scores');
  document.getElementById('score-pop').classList.remove('hidden');
  paintScores();
}
function onCue(name) {
  if (name === 'ding' && fresh('ding')) playStinger('dingding.mp3', 'ding');
  if (name === 'timeup' && fresh('timeup')) {
    playStinger('dingding.mp3', 'timeup');
    showTimeUp();
  }
  if (name === 'reveal' && fresh('reveal')) {
    playStinger('reveal.mp3', 'reveal');
    playStinger('dingding.mp3', 'reveal-ding');
    burstConfetti();
  }
  if (name === 'end' && fresh('end')) goBed('/audio/end.mp3');
  if (name === 'title') {
    bed.pause();
    bedUrl = '';
    playIntro();
    if (presented) burstConfetti();
  }
  if (name === 'round' && fresh('round') && state.round) goBed(state.round.audio);
  if (name === 'start' && fresh('start')) fadeIntroThenBed(state.startAudio || state.round?.audio || '');
}
// ===== Settings console =====
let draft = null;          // working copy: { showTitle, showSubtitle, tagline, rounds: [...] }
let savedSnapshot = '';
let consoleTab = 'rounds';
let openRoundId = '';
let beds = [];
let consoleErr = '';
let meta = { setId: 'default', activeSetId: 'default', sets: [], search: false };
let editingSetId = '';
const webUi = {}; // per-round photo/price search UI state (not part of the saved draft)

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function isDirty() {
  return Boolean(draft) && JSON.stringify(draft) !== savedSnapshot;
}
function consoleOpen() {
  return !document.getElementById('host-pop').classList.contains('hidden');
}
function loadDraft(settings) {
  beds = settings.beds || [];
  meta = { setId: settings.setId, activeSetId: settings.activeSetId, sets: settings.sets || [], search: Boolean(settings.search) };
  editingSetId = settings.setId;
  draft = {
    setName: settings.setName || '',
    showTitle: settings.showTitle || '',
    showSubtitle: settings.showSubtitle || '',
    tagline: settings.tagline || '',
    rounds: (settings.rounds || []).map((r) => ({
      id: r.id,
      title: r.title || '',
      short: r.short || '',
      source: r.source || '',
      points: r.points || [],
      price: (Number(r.pricePence) / 100).toFixed(2),
      image: r.image || '',
      audio: r.audio || '',
    })),
  };
  savedSnapshot = JSON.stringify(draft);
  if (!draft.rounds.some((r) => r.id === openRoundId)) openRoundId = '';
}
function openConsole() {
  consoleErr = '';
  document.getElementById('host-pop').classList.remove('hidden');
  if (draft) renderConsole();
  socket.emit('host:settings', { token: hostToken, setId: editingSetId || undefined });
}
function closeConsole(force) {
  if (!force && isDirty() && !confirm('You have unsaved changes. Close without saving?')) return;
  if (isDirty()) {
    draft = JSON.parse(savedSnapshot);
  }
  document.getElementById('host-pop').classList.add('hidden');
}
function switchEditingSet(id) {
  if (id === meta.setId) return;
  if (isDirty() && !confirm('Discard your unsaved changes to this set?')) return;
  draft = null;
  consoleErr = '';
  openRoundId = '';
  socket.emit('host:settings', { token: hostToken, setId: id });
}
function priceOk(value) {
  return TPIR.parsePrice(value, 'gbp') != null;
}
function saveConsole() {
  const bad = draft.rounds.findIndex((r) => !r.title.trim() || !priceOk(r.price));
  if (bad >= 0) {
    openRoundId = draft.rounds[bad].id;
    consoleTab = 'rounds';
    consoleErr = !draft.rounds[bad].title.trim()
      ? `Round ${bad + 1} needs a name.`
      : `Round ${bad + 1}: check the price (e.g. 0.85 for 85p, 139 for £139).`;
    renderConsole();
    return;
  }
  if (!draft.rounds.length) {
    consoleErr = 'Add at least one round.';
    renderConsole();
    return;
  }
  consoleErr = '';
  socket.emit('host:save', {
    token: hostToken,
    setId: meta.setId,
    settings: {
      setName: draft.setName,
      showTitle: draft.showTitle,
      showSubtitle: draft.showSubtitle,
      tagline: draft.tagline,
      rounds: draft.rounds.map((r) => ({
        id: r.id,
        title: r.title,
        short: r.short,
        source: r.source,
        points: r.points,
        pricePence: TPIR.parsePrice(r.price, 'gbp'),
        image: r.image,
        audio: r.audio,
      })),
    },
  });
}
function refreshFooter() {
  const status = document.getElementById('console-status');
  const save = document.getElementById('console-save');
  const discard = document.getElementById('console-discard');
  if (!status) return;
  const dirty = isDirty();
  status.textContent = consoleErr || (dirty ? 'Unsaved changes' : 'All changes saved');
  status.className = 'console-status' + (consoleErr ? ' bad' : dirty ? ' dirty' : '');
  save.disabled = !dirty;
  discard.disabled = !dirty;
}
function renderConsole() {
  const box = document.getElementById('console');
  const scroll = box.querySelector('.console-body');
  const keep = scroll ? scroll.scrollTop : 0;
  box.replaceChildren();

  const head = el('div', 'console-head');
  head.append(el('h2', '', 'Settings'));
  const x = el('button', 'console-x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.onclick = () => closeConsole(false);
  head.append(x);

  const setBar = el('div', 'set-bar');
  for (const s of meta.sets) {
    const pill = el('button', 'set-pill' + (s.id === meta.setId ? ' on' : ''));
    pill.type = 'button';
    pill.append(el('strong', '', s.id === meta.setId && draft ? draft.setName || s.name : s.name), el('small', '', s.rounds + (s.rounds === 1 ? ' round' : ' rounds')));
    if (s.active) pill.append(el('em', '', 'LIVE'));
    pill.onclick = () => switchEditingSet(s.id);
    setBar.append(pill);
  }
  if (meta.setId !== meta.activeSetId) {
    const play = el('button', 'btn primary sm set-play', 'Play this set');
    play.type = 'button';
    play.onclick = () => {
      if (isDirty()) { consoleErr = 'Save your changes before playing this set.'; refreshFooter(); return; }
      socket.emit('host:set-active', { token: hostToken, setId: meta.setId });
    };
    setBar.append(play);
  }

  const tabs = el('div', 'console-tabs');
  const defs = [['rounds', 'Rounds'], ['show', 'Show'], ['players', 'Players'], ['session', 'Session']];
  for (const [key, label] of defs) {
    const b = el('button', 'console-tab' + (consoleTab === key ? ' on' : ''), label);
    b.type = 'button';
    if (key === 'rounds' && draft) b.append(el('em', '', String(draft.rounds.length)));
    if (key === 'players' && state) b.append(el('em', '', String(state.players.length)));
    b.onclick = () => { consoleTab = key; renderConsole(); };
    tabs.append(b);
  }

  const body = el('div', 'console-body');
  if (!draft) body.append(el('p', 'sub', 'Loading…'));
  else if (consoleTab === 'rounds') body.append(roundsPanel());
  else if (consoleTab === 'show') body.append(showPanel());
  else if (consoleTab === 'players') body.append(playersPanel());
  else body.append(sessionPanel());

  const foot = el('div', 'console-foot');
  const status = el('span', 'console-status');
  status.id = 'console-status';
  const discard = el('button', 'btn ghost', 'Discard');
  discard.id = 'console-discard';
  discard.type = 'button';
  discard.onclick = () => { draft = JSON.parse(savedSnapshot); consoleErr = ''; renderConsole(); };
  const save = el('button', 'btn primary', 'Save changes');
  save.id = 'console-save';
  save.type = 'button';
  save.onclick = saveConsole;
  foot.append(status, discard, save);

  box.append(head, setBar, tabs, body, foot);
  body.scrollTop = keep;
  refreshFooter();
}
function inputField(label, value, onInput, opts) {
  const wrap = el('label', 'cf' + (opts && opts.wide ? ' wide' : '') + (opts && opts.third ? ' third' : ''));
  wrap.append(el('span', '', label));
  const input = document.createElement(opts && opts.area ? 'textarea' : 'input');
  if (opts && opts.area) input.rows = opts.rows || 3;
  if (opts && opts.max) input.maxLength = opts.max;
  if (opts && opts.placeholder) input.placeholder = opts.placeholder;
  if (opts && opts.inputmode) input.inputMode = opts.inputmode;
  input.value = value;
  input.oninput = () => { onInput(input.value); consoleErr = ''; refreshFooter(); if (opts && opts.live) opts.live(); };
  wrap.append(input);
  if (opts && opts.hint) wrap.append(el('small', '', opts.hint));
  return wrap;
}
function showPanel() {
  const panel = el('div', 'panel');
  panel.append(el('p', 'sub', 'What appears on the title screen.'));
  const grid = el('div', 'cgrid');
  grid.append(
    inputField('Set name', draft.setName, (v) => { draft.setName = v; }, { max: 24, wide: true, hint: 'Shown on the set tabs at the top.' }),
    inputField('Show name', draft.showTitle, (v) => { draft.showTitle = v; }, { max: 32 }),
    inputField('Diamond text', draft.showSubtitle, (v) => { draft.showSubtitle = v; }, { max: 32, hint: 'One word per line on the diamond.' }),
    inputField('Tagline', draft.tagline, (v) => { draft.tagline = v; }, { max: 140, wide: true }),
  );
  panel.append(grid);
  const tools = el('div', 'session-actions left');
  const exp = el('button', 'btn ghost', 'Export this set (JSON)');
  exp.type = 'button';
  exp.title = 'Download a copy you can commit to the sets/ folder in git';
  exp.onclick = async () => {
    try {
      const res = await fetch('/api/sets/' + meta.setId + '/export', { headers: { 'x-host-token': hostToken } });
      if (!res.ok) throw new Error('Export failed');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = meta.setId + '.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { consoleErr = err.message; refreshFooter(); }
  };
  const reset = el('button', 'btn danger', 'Reset to original');
  reset.type = 'button';
  reset.title = 'Throw away your edits and go back to the version stored in git';
  reset.onclick = () => {
    if (!confirm('Reset "' + (draft.setName || meta.setId) + '" to its original version? Your edits to this set are lost.')) return;
    draft = null;
    socket.emit('host:set-reset', { token: hostToken, setId: meta.setId });
  };
  tools.append(exp, reset);
  panel.append(tools);
  return panel;
}
function roundsPanel() {
  const panel = el('div', 'panel');
  panel.append(el('p', 'sub', 'Played in this order. Click a round to edit it.'));
  const list = el('div', 'rcards');
  draft.rounds.forEach((round, i) => list.append(roundCard(round, i)));
  panel.append(list);
  const add = el('button', 'btn ghost add-round', '+ Add round');
  add.type = 'button';
  add.onclick = () => {
    const id = crypto.randomUUID();
    draft.rounds.push({ id, title: '', short: '', source: '', points: [], price: '', image: '', audio: beds[0] || '' });
    openRoundId = id;
    renderConsole();
    const body = document.querySelector('.console-body');
    if (body) body.scrollTop = body.scrollHeight;
  };
  panel.append(add);
  return panel;
}
function roundCard(round, index) {
  const open = openRoundId === round.id;
  const card = el('div', 'rcard' + (open ? ' open' : ''));
  const bad = !round.title.trim() || (round.price !== '' && !priceOk(round.price));
  if (bad && open) card.classList.add('bad');

  const head = el('div', 'rhead');
  head.append(el('span', 'rnum', String(index + 1)));
  const thumb = el('span', 'rthumb' + (round.image ? '' : ' none'));
  if (round.image) {
    const img = document.createElement('img');
    img.src = round.image;
    img.alt = '';
    thumb.append(img);
  } else thumb.textContent = '＋';
  head.append(thumb);
  const main = el('button', 'rmain');
  main.type = 'button';
  main.append(el('strong', '', round.title.trim() || 'Untitled round'));
  const priceN = TPIR.parsePrice(round.price, 'gbp');
  main.append(el('span', '', priceN == null ? 'No price yet' : TPIR.formatPrice(priceN)));
  main.onclick = () => { openRoundId = open ? '' : round.id; renderConsole(); };
  head.append(main);

  const tools = el('div', 'rtools');
  const mk = (label, title, fn, disabled) => {
    const b = el('button', 'icon-btn', label);
    b.type = 'button';
    b.title = title;
    b.disabled = Boolean(disabled);
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  };
  tools.append(
    mk('↑', 'Move up', () => { [draft.rounds[index - 1], draft.rounds[index]] = [draft.rounds[index], draft.rounds[index - 1]]; renderConsole(); }, index === 0),
    mk('↓', 'Move down', () => { [draft.rounds[index + 1], draft.rounds[index]] = [draft.rounds[index], draft.rounds[index + 1]]; renderConsole(); }, index === draft.rounds.length - 1),
    mk('⧉', 'Duplicate', () => { const copy = { ...round, id: crypto.randomUUID(), points: [...round.points] }; draft.rounds.splice(index + 1, 0, copy); openRoundId = copy.id; renderConsole(); }),
    mk('✕', 'Delete', () => {
      if (!confirm('Delete "' + (round.title.trim() || 'this round') + '"?')) return;
      draft.rounds.splice(index, 1);
      renderConsole();
    }),
  );
  head.append(tools);
  card.append(head);
  if (!open) return card;

  const body = el('div', 'rbody');
  const fields = el('div', 'cgrid');
  const updateHead = () => {
    main.firstChild.textContent = round.title.trim() || 'Untitled round';
    const p = TPIR.parsePrice(round.price, 'gbp');
    main.lastChild.textContent = p == null ? 'No price yet' : TPIR.formatPrice(p);
  };
  const ui = webUi[round.id] || (webUi[round.id] = {});
  fields.append(
    titleField(round, updateHead, ui),
    priceField(round, updateHead, ui),
    inputField('Source', round.source, (v) => { round.source = v; }, { third: true, max: 80, placeholder: 'ASDA' }),
    inputField('Board label', round.short, (v) => { round.short = v; }, { third: true, max: 24, placeholder: 'Beans', hint: 'Short name for the final board.' }),
    inputField('Details (one per line)', round.points.join('\n'), (v) => { round.points = v.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8); }, { area: true, rows: 3, wide: true, placeholder: '1 x Sausage Roll' }),
  );
  const music = el('label', 'cf');
  music.append(el('span', '', 'Music'));
  const select = document.createElement('select');
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'No music';
  select.append(none);
  for (const name of beds) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.append(opt);
  }
  select.value = round.audio || '';
  select.onchange = () => { round.audio = select.value; refreshFooter(); };
  music.append(select);
  fields.append(music);

  const photo = el('div', 'cf photo');
  photo.append(el('span', '', 'Photo'));
  const row = el('div', 'photo-row');
  const preview = el('span', 'pthumb' + (round.image ? '' : ' none'));
  if (round.image) {
    const img = document.createElement('img');
    img.src = round.image;
    img.alt = '';
    preview.append(img);
  } else preview.textContent = 'No photo';
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/*';
  file.hidden = true;
  const pick = el('button', 'btn ghost sm', round.image ? 'Replace' : 'Upload');
  pick.type = 'button';
  pick.onclick = () => file.click();
  file.onchange = async () => {
    if (!file.files[0]) return;
    pick.disabled = true;
    pick.textContent = 'Uploading…';
    try {
      const body = new FormData();
      body.append('image', file.files[0]);
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'x-host-token': hostToken }, body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      round.image = data.url;
      consoleErr = '';
      renderConsole();
    } catch (err) {
      consoleErr = err.message;
      renderConsole();
    }
  };
  row.append(preview, pick, file);
  if (round.image) {
    const rm = el('button', 'btn ghost sm', 'Remove');
    rm.type = 'button';
    rm.onclick = () => { round.image = ''; renderConsole(); };
    row.append(rm);
  }
  photo.append(row);
  fields.append(photo);
  body.append(fields);
  card.append(body);
  return card;
}
function webGet(url, options) {
  return fetch(url, { ...options, headers: { 'x-host-token': hostToken, 'Content-Type': 'application/json' } }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Search failed');
    return data;
  });
}
function titleField(round, updateHead, ui) {
  const wrap = el('div', 'cf wide');
  wrap.append(el('span', '', 'Item / question'));
  const row = el('div', 'inline-row');
  const input = document.createElement('input');
  input.maxLength = 160;
  input.placeholder = 'How much is a tin of beans?';
  input.value = round.title;
  input.oninput = () => { round.title = input.value; consoleErr = ''; refreshFooter(); updateHead(); };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); runImageSearch(round, 0, round.title); } };
  const find = el('button', 'btn ghost find-btn', 'Find photo');
  find.type = 'button';
  find.disabled = !meta.search;
  find.title = meta.search ? 'Search the web for example photos' : 'Needs BRAVE_API_KEY on the server';
  find.onclick = () => runImageSearch(round, 0, round.title);
  row.append(input, find);
  wrap.append(row);
  if (!meta.search) wrap.append(el('small', '', 'Photo and price search is off. Add BRAVE_API_KEY on the server to turn it on.'));
  if (ui.img && ui.img.open) wrap.append(imageStrip(round, ui));
  return wrap;
}
function imageStrip(round, ui) {
  const s = ui.img;
  const box = el('div', 'imgsearch');
  const bar = el('div', 'inline-row');
  const q = document.createElement('input');
  q.value = s.q;
  q.placeholder = 'Search words';
  q.oninput = () => { s.q = q.value; };
  q.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); runImageSearch(round, 0, s.q); } };
  const go = el('button', 'btn ghost sm', 'Search');
  go.type = 'button';
  go.onclick = () => runImageSearch(round, 0, s.q);
  const more = el('button', 'btn ghost sm', 'Show others');
  more.type = 'button';
  more.disabled = s.loading || !(s.pages > 1);
  more.onclick = () => runImageSearch(round, (s.page || 0) + 1, s.q);
  const close = el('button', 'icon-btn', '✕');
  close.type = 'button';
  close.title = 'Close';
  close.onclick = () => { s.open = false; renderConsole(); };
  bar.append(q, go, more, close);
  box.append(bar);
  const grid = el('div', 'imggrid');
  if (s.loading) grid.append(el('p', 'sub', 'Searching…'));
  else if (s.err) grid.append(el('p', 'err', s.err));
  for (const item of s.items || []) {
    const tile = el('button', 'imgtile' + (s.importing === item.id ? ' busy' : ''));
    tile.type = 'button';
    tile.title = item.title || item.site;
    const img = document.createElement('img');
    img.src = item.thumb;
    img.alt = item.title || '';
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    tile.append(img, el('span', '', s.importing === item.id ? 'Saving…' : item.site || 'Use this'));
    tile.disabled = Boolean(s.importing);
    tile.onclick = () => pickImage(round, item);
    grid.append(tile);
  }
  box.append(grid);
  if ((s.items || []).length) {
    box.append(el('small', '', 'Click a photo to use it. It is copied to your server. Check you are happy with the licence if you share the show publicly.' + (s.pages > 1 ? ' Page ' + ((s.page || 0) + 1) + ' of ' + s.pages + '.' : '')));
  }
  return box;
}
async function runImageSearch(round, page, query) {
  const ui = webUi[round.id] || (webUi[round.id] = {});
  const q = String(query || '').trim();
  if (!q) {
    ui.img = { open: true, q: '', items: [], err: 'Type what you are looking for first.' };
    renderConsole();
    return;
  }
  ui.img = { open: true, q, page, pages: (ui.img && ui.img.pages) || 0, items: [], loading: true, err: '' };
  renderConsole();
  try {
    const data = await webGet('/api/image-search?q=' + encodeURIComponent(q) + '&page=' + page);
    ui.img = { open: true, q, page: data.page, pages: data.pages, items: data.items, err: data.items.length ? '' : 'No photos found. Try different words.' };
  } catch (err) {
    ui.img = { open: true, q, page, pages: 0, items: [], err: err.message };
  }
  renderConsole();
}
async function pickImage(round, item) {
  const ui = webUi[round.id];
  ui.img.importing = item.id;
  renderConsole();
  try {
    const data = await webGet('/api/image-import', { method: 'POST', body: JSON.stringify({ id: item.id }) });
    round.image = data.url;
    ui.img = { open: false };
    consoleErr = '';
  } catch (err) {
    ui.img.importing = '';
    ui.img.err = err.message;
  }
  renderConsole();
}
function priceField(round, updateHead, ui) {
  const wrap = el('div', 'cf third');
  wrap.append(el('span', '', 'Price (£)'));
  const row = el('div', 'inline-row');
  const input = document.createElement('input');
  input.inputMode = 'decimal';
  input.placeholder = '0.85';
  input.value = round.price;
  input.oninput = () => { round.price = input.value; consoleErr = ''; refreshFooter(); updateHead(); };
  const ask = el('button', 'btn ghost find-btn', 'Suggest');
  ask.type = 'button';
  ask.disabled = !meta.search;
  ask.title = meta.search ? 'Look up typical prices on the web' : 'Needs BRAVE_API_KEY on the server';
  ask.onclick = () => runPriceSuggest(round);
  row.append(input, ask);
  wrap.append(row);
  const p = ui.price;
  if (p) {
    if (p.loading) wrap.append(el('small', '', 'Looking up prices…'));
    else if (p.err) wrap.append(el('small', 'bad', p.err));
    else if (!p.items.length) wrap.append(el('small', '', 'No prices found. Type your own.'));
    else {
      const chips = el('div', 'chips');
      if (p.typical) {
        const t = el('button', 'chip typical', 'Typical ' + TPIR.formatPrice(p.typical));
        t.type = 'button';
        t.onclick = () => usePrice(round, p.typical);
        chips.append(t);
      }
      for (const item of p.items) {
        const c = el('button', 'chip', TPIR.formatPrice(item.pence) + ' · ' + item.site);
        c.type = 'button';
        c.title = item.context;
        c.onclick = () => usePrice(round, item.pence);
        chips.append(c);
      }
      wrap.append(chips, el('small', '', 'From web results, so check them. Hover for the snippet. Or type your own price.'));
    }
  } else if (meta.search) {
    wrap.append(el('small', '', 'Use 0.85 for 85p, or 139 for £139.'));
  }
  return wrap;
}
function usePrice(round, pence) {
  round.price = (pence / 100).toFixed(2);
  consoleErr = '';
  renderConsole();
}
async function runPriceSuggest(round) {
  const ui = webUi[round.id] || (webUi[round.id] = {});
  if (!round.title.trim()) {
    ui.price = { items: [], err: 'Type the item name first, then press Suggest.' };
    renderConsole();
    return;
  }
  ui.price = { loading: true, items: [] };
  renderConsole();
  try {
    const data = await webGet('/api/price-suggest?q=' + encodeURIComponent(round.title.trim()));
    ui.price = { items: data.items, typical: data.typical };
  } catch (err) {
    ui.price = { items: [], err: err.message };
  }
  renderConsole();
}
function playersPanel() {
  const panel = el('div', 'panel');
  panel.id = 'host-players';
  paintPlayersInto(panel);
  return panel;
}
function paintPlayersInto(box) {
  box.replaceChildren();
  const players = (state && state.players) || [];
  box.append(el('p', 'sub', players.length ? 'Everyone who has joined this show.' : 'Nobody has joined yet.'));
  for (const p of players) {
    const row = el('div', 'tick' + (p.submitted ? ' in' : ''));
    row.append(el('span', '', (p.submitted ? '✓ ' : '') + p.name + (p.connected ? '' : ' (away)')));
    const rm = el('button', 'text-btn', 'Remove');
    rm.type = 'button';
    rm.onclick = () => { if (confirm('Remove ' + p.name + '?')) socket.emit('host:remove', { token: hostToken, id: p.id }); };
    row.append(rm);
    box.append(row);
  }
}
function paintPlayers() {
  const box = document.getElementById('host-players');
  if (box && state) paintPlayersInto(box);
  const tab = document.querySelector('.console-tab:nth-child(3) em');
  if (tab && state) tab.textContent = String(state.players.length);
}
function sessionPanel() {
  const panel = el('div', 'panel');
  const info = el('div', 'join-info compact');
  info.append(el('p', 'join-label', 'Players join at'), el('p', 'join-host', joinInfo.host || ''), el('p', 'join-label', 'Room code'), el('p', 'join-code-big', joinInfo.code || ''));
  panel.append(info);
  const actions = el('div', 'session-actions');
  const back = el('button', 'btn ghost', 'Back to title screen');
  back.type = 'button';
  back.title = 'Keeps players and the room code, clears all bids';
  back.onclick = () => {
    if (!confirm('Go back to the title screen? All bids and scores will be cleared. Players stay connected.')) return;
    socket.emit('host:reset', { token: hostToken });
    closeConsole(true);
  };
  const fresh = el('button', 'btn danger', 'New session (new room code)');
  fresh.type = 'button';
  fresh.onclick = () => {
    if (!confirm('Disconnect every player and start a new session with a new room code?')) return;
    socket.emit('host:refresh', { token: hostToken });
    setTimeout(() => location.reload(), 200);
  };
  actions.append(back, fresh);
  panel.append(actions);
  return panel;
}

const fxColors = ['#ff4db8', '#ffb15a', '#fff6c8', '#7a5cff', '#6ec8ff', '#ffffff', '#ea8736'];
let fxParts = [];
let fxOn = false;
let confettiTimer = 0;
let fireworkTimer = 0;
function fxLive() {
  return Boolean(state && ((presented && state.phase === 'title') || state.phase === 'podium'));
}
function fxCanvas() {
  const canvas = document.getElementById(state && state.phase === 'podium' ? 'podium-fx' : 'confetti');
  if (!canvas) return null;
  const rect = canvas.parentElement.getBoundingClientRect();
  if (canvas.width !== rect.width || canvas.height !== rect.height) {
    canvas.width = rect.width;
    canvas.height = rect.height;
  }
  return canvas;
}
function ensureFxLoop() {
  if (fxOn) return;
  fxOn = true;
  const canvas = fxCanvas();
  const ctx = canvas.getContext('2d');
  function tick() {
    const view = fxCanvas();
    if (!view) return;
    ctx.clearRect(0, 0, view.width, view.height);
    fxParts = fxParts.filter((bit) => bit.life > 0 && bit.y < view.height + 40);
    fxParts.forEach((bit) => {
      bit.x += bit.vx;
      bit.y += bit.vy;
      bit.vy += bit.g;
      bit.vx *= bit.drag;
      bit.r += bit.vr;
      bit.life -= 1;
      ctx.save();
      ctx.globalAlpha = Math.max(0, bit.life / bit.max);
      ctx.translate(bit.x, bit.y);
      ctx.rotate(bit.r);
      ctx.fillStyle = bit.c;
      if (bit.spark) {
        ctx.fillRect(-1, -bit.h / 2, 2, bit.h);
      } else {
        ctx.fillRect(-bit.w / 2, -bit.h / 2, bit.w, bit.h);
      }
      ctx.restore();
    });
    if (fxParts.length || fxLive()) requestAnimationFrame(tick);
    else fxOn = false;
  }
  requestAnimationFrame(tick);
}
function burstConfetti() {
  if (!fxFocused()) return;
  const canvas = fxCanvas();
  if (!canvas) return;
  ensureFxLoop();
  for (let i = 0; i < 160; i += 1) {
    fxParts.push({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.35,
      w: 6 + Math.random() * 8,
      h: 8 + Math.random() * 12,
      vx: -2.5 + Math.random() * 5,
      vy: 1.5 + Math.random() * 4,
      g: 0.04,
      drag: 1,
      r: Math.random() * Math.PI,
      vr: -0.2 + Math.random() * 0.4,
      c: fxColors[Math.floor(Math.random() * fxColors.length)],
      life: 220,
      max: 220,
      spark: false,
    });
  }
}
function launchCannon() {
  if (!fxFocused()) return;
  const canvas = fxCanvas();
  if (!canvas) return;
  ensureFxLoop();
  const size = 0.45 + Math.random() * 1.15;
  const x = canvas.width * (0.06 + Math.random() * 0.88);
  const y = canvas.height - 6;
  const color = fxColors[Math.floor(Math.random() * fxColors.length)];
  const inward = x < canvas.width / 2 ? 1 : -1;
  const rise = (-8 - Math.random() * 7) * size;
  const drift = inward * (0.4 + Math.random() * 2.2) * size;
  const trail = Math.round(10 + size * 14);
  for (let i = 0; i < trail; i += 1) {
    fxParts.push({
      x,
      y,
      w: 2 + size,
      h: 8 + size * 4,
      vx: drift * 0.3 + (-0.5 + Math.random()),
      vy: rise * (0.7 + Math.random() * 0.3),
      g: 0.08,
      drag: 0.995,
      r: 0,
      vr: 0,
      c: color,
      life: 22 + Math.floor(Math.random() * 12),
      max: 36,
      spark: true,
    });
  }
  const boomX = x + drift * (18 + size * 16);
  const boomY = canvas.height * (0.12 + Math.random() * 0.5);
  const sparks = Math.round(28 + size * 70);
  setTimeout(() => {
    if (!fxLive() || !fxFocused()) return;
    ensureFxLoop();
    for (let i = 0; i < sparks; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (0.8 + Math.random() * 4.8) * size;
      fxParts.push({
        x: boomX,
        y: boomY,
        w: 2 + size,
        h: (5 + Math.random() * 10) * size,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        g: 0.03,
        drag: 0.985,
        r: angle,
        vr: 0,
        c: Math.random() > 0.4 ? color : '#fff6c8',
        life: 36 + Math.floor(Math.random() * 40 * size),
        max: 80,
        spark: true,
      });
    }
  }, 420 + Math.random() * 380);
}
let fxPaused = false;
function fxFocused() {
  return document.visibilityState !== 'hidden' && document.hasFocus();
}
function pauseFx() {
  fxPaused = true;
  clearInterval(confettiTimer);
  clearTimeout(fireworkTimer);
  confettiTimer = 0;
  fireworkTimer = 0;
  fxParts = [];
  fxOn = false;
}
function resumeFx() {
  if (!fxPaused) return;
  fxPaused = false;
  if (fxLive()) startTitleFx();
}
function startTitleFx() {
  if (!fxFocused()) {
    fxPaused = true;
    return;
  }
  if (confettiTimer) return;
  confettiTimer = setInterval(() => {
    if (fxFocused() && fxLive()) burstConfetti();
  }, 10000);
  scheduleFirework();
}
function scheduleFirework() {
  clearTimeout(fireworkTimer);
  if (!fxFocused()) return;
  fireworkTimer = setTimeout(() => {
    if (!fxFocused() || !fxLive()) return;
    const volley = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < volley; i += 1) launchCannon();
    scheduleFirework();
  }, 900 + Math.random() * 2200);
}
function stopTitleFx() {
  clearInterval(confettiTimer);
  clearTimeout(fireworkTimer);
  confettiTimer = 0;
  fireworkTimer = 0;
  fxPaused = false;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseFx();
  else resumeFx();
});
window.addEventListener('blur', pauseFx);
window.addEventListener('focus', resumeFx);
function fillSparkles() {
  ['sparkles', 'podium-sparkles'].forEach((id) => {
    const box = document.getElementById(id);
    if (!box || box.childElementCount) return;
    for (let i = 0; i < 70; i += 1) {
      const dot = document.createElement('i');
      dot.className = i % 2 ? 'light' : 'star';
      dot.style.left = Math.random() * 100 + '%';
      dot.style.top = Math.random() * 100 + '%';
      dot.style.animationDelay = (Math.random() * 2.4) + 's';
      box.append(dot);
    }
  });
}
fillSparkles();
let presenterName = '';
function possessive(name) {
  const clean = String(name || '').trim();
  if (!clean) return '';
  return /s$/i.test(clean) ? clean + "'" : clean + "'s";
}
function taglineFor(name) {
  return 'All prices are correct according to ' + name.trim() + ' so deal with it....';
}
document.getElementById('curtain').onsubmit = (e) => {
  e.preventDefault();
  const name = document.getElementById('host-name').value.trim();
  if (!name) {
    document.getElementById('host-name').focus();
    return;
  }
  presenterName = name;
  const curtain = document.getElementById('curtain');
  curtain.classList.add('fade-out');
  fade(curtainMusic, 0, 800).then(() => {
    stopCurtainMusic();
    curtain.classList.add('exited');
    setTimeout(() => {
      curtain.style.display = 'none';
      presented = true;
      hideHint();
      playIntro();
      burstConfetti();
      startTitleFx();
      socket.emit('host:name', { name });
      render();
    }, 600);
  });
};
document.getElementById('start').onclick = beginShow;
document.getElementById('lobby-start').onclick = beginShow;
document.getElementById('rules-continue').onclick = startRoundAfterRules;
document.getElementById('qr-icon').onclick = openLobby;
document.getElementById('qr-shot').onclick = () => document.getElementById('qr-full').classList.add('hidden');
document.getElementById('lobby-qr-btn').onclick = (e) => e.stopPropagation();
document.getElementById('qr-full').onclick = (e) => {
  if (e.target.id === 'qr-full') document.getElementById('qr-full').classList.add('hidden');
};
document.getElementById('dock-next').onclick = advance;
document.getElementById('time-up-min').onclick = () => {
  hideTimeUp();
  if (state && state.round) timeUpRound = state.round.id;
  guessesOpen = true;
  paintGuessList();
};
document.getElementById('volume').oninput = (e) => {
  master = Number(e.target.value) / 4;
  document.getElementById('curtain-volume').value = e.target.value;
  setGain(intro, intro._gain == null ? 1 : intro._gain);
  setGain(bed, bed._gain == null ? 0.85 : bed._gain);
  setGain(curtainMusic, curtainMusic._gain == null ? 0.85 : curtainMusic._gain);
  liveStingers.forEach((audio) => setGain(audio, audio._gain == null ? 1 : audio._gain));
};
document.getElementById('score-btn').onclick = toggleGuesses;
document.getElementById('host-btn').onclick = openConsole;
document.getElementById('pin-form').onsubmit = (e) => {
  e.preventDefault();
  socket.emit('host:auth', { pin: document.getElementById('pin').value });
};
document.body.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#present, #start, #lobby-start, .qr-icon, .qr-full, .dock, .corner-btn, .overlay, .curtain')) return;
  if (!presented || !state || state.phase !== 'title' || !intro.paused) return;
  playIntro();
});
function toggleFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
    return;
  }
  const enter = el.requestFullscreen || el.webkitRequestFullscreen;
  if (enter) enter.call(el);
}
// Keys a presentation clicker usually sends
const ADVANCE_KEYS = new Set([' ', 'Spacebar', 'ArrowRight', 'PageDown', '.']);
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (consoleOpen()) {
    if (e.key === 'Escape') closeConsole(false);
    return;
  }
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    toggleFullscreen();
    return;
  }
  if (e.key === 'Escape') {
    document.getElementById('score-pop').classList.add('hidden');
    document.getElementById('pin-pop').classList.add('hidden');
    document.getElementById('qr-full').classList.add('hidden');
    document.getElementById('lobby-pop').classList.add('hidden');
    return;
  }
  if (!state) return;
  if (ADVANCE_KEYS.has(e.key)) {
    e.preventDefault();
    if (e.repeat) return;
    // QR / lobby overlays count as "start the game" on the title screen
    advance();
    return;
  }
  if (e.key === 's' || e.key === 'S') toggleGuesses();
  if (e.key === 'q' || e.key === 'Q') toggleLobby();
});
// Buttons should never keep focus, otherwise Space would also "click" them
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !b.closest('#console')) b.blur();
});

let joinInfo = { host: '', code: '', url: '' };
function loadJoinInfo() {
  fetch('/join.json').then((res) => res.json()).then((data) => {
    joinInfo = data;
    ['join-host', 'lobby-host'].forEach((id) => { const n = document.getElementById(id); if (n) n.textContent = data.host; });
    ['join-code-big', 'lobby-code'].forEach((id) => { const n = document.getElementById(id); if (n) n.textContent = data.code; });
    if (consoleOpen() && consoleTab === 'session') renderConsole();
  }).catch(() => {});
}
loadJoinInfo();

socket.on('state', (next) => {
  const seq = next.cue?.seq || 0;
  const play = booted && seq > lastSeq;
  lastSeq = seq;
  state = next;
  if (!hostToken && next.pinRequired === false && !autoAuthSent) {
    autoAuthSent = true;
    socket.emit('host:auth', { pin: '' });
  }
  if (!booted) {
    booted = true;
    render();
    if (next.phase !== 'title') {
      presented = true;
      document.getElementById('curtain').classList.add('hidden');
      if (next.phase === 'podium') goBed('/audio/end.mp3');
      else if (next.round?.audio) goBed(next.round.audio);
    }
    return;
  }
  render();
  if (play && next.cue?.name) onCue(next.cue.name);
});
socket.on('host:ok', ({ token }) => {
  hostToken = token;
  sessionStorage.setItem('tpirHost', token);
  document.getElementById('pin-pop').classList.add('hidden');
  paintDock();
  const next = pending;
  pending = null;
  if (next) next();
});
socket.on('host:no', () => {
  hostToken = '';
  sessionStorage.removeItem('tpirHost');
  if (state && state.pinRequired === false) {
    socket.emit('host:auth', { pin: '' });
    return;
  }
  document.getElementById('pin-err').textContent = 'Wrong PIN';
  if (!document.getElementById('pin-pop').classList.contains('hidden')) return;
  openPin();
});
socket.on('host:settings', (settings) => {
  if (draft && isDirty() && consoleOpen()) return; // never overwrite edits in progress
  loadDraft(settings);
  if (consoleOpen()) renderConsole();
});
socket.on('host:saved', () => {
  savedSnapshot = JSON.stringify(draft);
  consoleErr = '';
  refreshFooter();
  const status = document.getElementById('console-status');
  if (status) { status.textContent = 'Saved'; status.className = 'console-status ok'; }
});
socket.on('host:err', (message) => {
  consoleErr = message;
  refreshFooter();
});
intro.addEventListener('ended', () => {
  if (state?.phase === 'title') {
    intro.currentTime = 0;
    intro.play().catch(() => {});
  }
});
document.getElementById('curtain-volume').oninput = (e) => {
  master = Number(e.target.value) / 4;
  document.getElementById('volume').value = e.target.value;
  setGain(intro, intro._gain == null ? 1 : intro._gain);
  setGain(bed, bed._gain == null ? 0.85 : bed._gain);
  setGain(curtainMusic, curtainMusic._gain == null ? 0.85 : curtainMusic._gain);
  liveStingers.forEach((audio) => setGain(audio, audio._gain == null ? 1 : audio._gain));
};
playCurtainMusic();
