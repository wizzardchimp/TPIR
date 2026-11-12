const socket = io();
let state = null;
let hostToken = sessionStorage.getItem('tpirHost') || '';
let pending = null;
let autoAuthSent = false;
let booted = false;
let lastSeq = 0;
let shownPrice = false;
let editorOpen = false;
let seenTitleCount = null;
let presented = false;
let diamondPlayed = false;
let podiumBurst = false;
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
    resultTimer = setTimeout(() => {
      if (!state || state.phase !== 'revealed' || !state.round || state.round.id !== resultFor) return;
      pop.classList.remove('hidden');
      document.getElementById('badge').classList.remove('hold');
      scoreboardLocked = true;
      if (fresh('scores')) playStinger('scores.mp3', 'scores');
      paintRoundResult();
    }, 3000);
    return;
  }
  if (pop.classList.contains('hidden')) return;
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
    else detail.textContent = TPIR.formatPrice(p.guessPence) + ' · ' + p.points + ' pts';
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
function paintPodium() {
  const wrap = document.getElementById('grid-wrap');
  wrap.replaceChildren();
  const table = document.createElement('table');
  table.className = 'board';
  const head = document.createElement('tr');
  const playerTh = document.createElement('th');
  playerTh.textContent = 'Player';
  head.append(playerTh);
  for (const round of state.rounds) {
    const th = document.createElement('th');
    th.textContent = round.short || round.title;
    if (round.pricePence != null) {
      const small = document.createElement('small');
      small.textContent = TPIR.formatPrice(round.pricePence);
      th.append(small);
    }
    head.append(th);
  }
  const totalTh = document.createElement('th');
  totalTh.textContent = 'Total';
  head.append(totalTh);
  const thead = document.createElement('thead');
  thead.append(head);
  const body = document.createElement('tbody');
  const ranked = [...state.players].sort(compareStanding);
  const best = ranked.find((p) => p.played > 0);
  ranked.forEach((p) => {
    const tr = document.createElement('tr');
    if (best && p.played > 0 && p.total === best.total) tr.className = 'winner';
    const name = document.createElement('td');
    name.textContent = p.name;
    tr.append(name);
    (p.scores || []).forEach((score, i) => {
      if (i >= state.rounds.length) return;
      const td = document.createElement('td');
      td.textContent = score == null ? '—' : String(score);
      tr.append(td);
    });
    const total = document.createElement('td');
    total.textContent = p.played ? String(p.total) : '—';
    tr.append(total);
    body.append(tr);
  });
  table.append(thead, body);
  const note = document.createElement('p');
  note.className = 'board-note';
  note.textContent = '3 for closest, 2 for second, 1 for any other bid that does not go over. Highest score wins.';
  wrap.append(table, note);
  autoScroll(wrap);
}
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
function paintDock() {
  const bar = document.getElementById('toolbar');
  bar.classList.toggle('hidden', !state || (state.phase === 'title' && !presented));
  document.getElementById('dock-lock').disabled = state.phase !== 'guessing' || state.bidsIn;
  document.getElementById('dock-reveal').disabled = state.phase !== 'guessing';
  const next = document.getElementById('dock-next');
  next.disabled = state.phase !== 'revealed' && state.phase !== 'podium';
  if (state.phase === 'podium') next.textContent = 'Title';
  else next.textContent = state.roundIndex + 1 >= state.roundCount ? 'Podium' : 'Next';
  const code = document.getElementById('session-code');
  if (state.sessionCode) code.textContent = state.sessionCode;
  const qr = '/qr.svg?code=' + (state.sessionCode || '');
  ['qr', 'lobby-qr'].forEach((id) => {
    const img = document.getElementById(id);
    if (img && img.getAttribute('src') !== qr) img.src = qr;
  });
}
function paintPlayers() {
  const el = document.getElementById('host-players');
  if (!el || !state) return;
  el.replaceChildren();
  const label = document.createElement('p');
  label.className = 'sub';
  label.textContent = state.bidsIn && state.phase === 'guessing' ? 'Bids are in' : 'Players';
  el.append(label);
  for (const p of state.players) {
    const row = document.createElement('div');
    row.className = 'tick' + (p.submitted ? ' in' : '');
    const name = document.createElement('span');
    name.textContent = (p.submitted ? '✓ ' : '○ ') + p.name + (p.connected ? '' : ' (away)');
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = 'Remove';
    rm.onclick = () => socket.emit('host:remove', { token: hostToken, id: p.id });
    row.append(name, rm);
    el.append(row);
  }
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
function field(label, className, value) {
  const wrap = document.createElement('label');
  wrap.textContent = label;
  const input = document.createElement('input');
  input.className = className;
  input.value = value || '';
  wrap.append(input);
  return wrap;
}
function buildEditor(settings) {
  editorOpen = true;
  const sheet = document.getElementById('host-sheet');
  sheet.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = 'Host';
  const err = document.createElement('p');
  err.id = 'host-err';
  err.className = 'err';
  const fields = document.createElement('div');
  fields.className = 'fields';
  fields.append(
    field('Show name', 'f-title-show', settings.showTitle),
    field('Diamond text', 'f-sub', settings.showSubtitle),
  );
  const tagWrap = document.createElement('label');
  tagWrap.textContent = 'Tagline';
  const tag = document.createElement('input');
  tag.className = 'f-tag';
  tag.value = settings.tagline || '';
  tagWrap.append(tag);
  const list = document.createElement('div');
  list.id = 'round-list';
  const players = document.createElement('div');
  players.id = 'host-players';
  const actions = document.createElement('div');
  actions.className = 'actions';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'ghost';
  add.textContent = 'Add round';
  add.onclick = () => list.append(roundRow({ id: crypto.randomUUID(), title: '', source: '', pricePence: 0, image: '', audio: '' }, settings.beds));
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Save rounds';
  save.onclick = saveSettings;
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'ghost';
  reset.textContent = 'Back to title';
  reset.onclick = () => {
    socket.emit('host:reset', { token: hostToken });
    document.getElementById('host-pop').classList.add('hidden');
  };
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ghost';
  close.textContent = 'Close';
  close.onclick = () => {
    editorOpen = false;
    document.getElementById('host-pop').classList.add('hidden');
  };
  actions.append(add, save, reset, close);
  sheet.append(h, fields, tagWrap, list, players, err, actions);
  for (const round of settings.rounds) list.append(roundRow(round, settings.beds));
  paintPlayers();
}
function roundRow(round, beds) {
  const row = document.createElement('div');
  row.className = 'round-edit';
  row.dataset.id = round.id;
  row.dataset.image = round.image || '';
  row.dataset.points = JSON.stringify(round.points || []);
  row.dataset.short = round.short || '';
  const pounds = (Number(round.pricePence) / 100).toFixed(2);
  row.append(
    field('Item', 'f-title', round.title),
    field('Source', 'f-source', round.source),
    field('Price £', 'f-price', pounds),
  );
  const audio = document.createElement('label');
  audio.textContent = 'Music';
  const select = document.createElement('select');
  select.className = 'f-audio';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'None';
  select.append(none);
  for (const bedName of beds || []) {
    const opt = document.createElement('option');
    opt.value = bedName;
    opt.textContent = bedName;
    if (round.audio === bedName) opt.selected = true;
    select.append(opt);
  }
  audio.append(select);
  const tools = document.createElement('div');
  tools.className = 'row-actions';
  const img = document.createElement('img');
  img.className = 'preview-img';
  img.alt = '';
  if (round.image) img.src = round.image;
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/*';
  file.onchange = async () => {
    if (!file.files[0]) return;
    const body = new FormData();
    body.append('image', file.files[0]);
    const res = await fetch('/api/upload', { method: 'POST', headers: { 'x-host-token': hostToken }, body });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById('host-err').textContent = data.error || 'Upload failed';
      return;
    }
    row.dataset.image = data.url;
    img.src = data.url;
  };
  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'ghost';
  up.textContent = 'Up';
  up.onclick = () => {
    const prev = row.previousElementSibling;
    if (prev) row.parentNode.insertBefore(row, prev);
  };
  const down = document.createElement('button');
  down.type = 'button';
  down.className = 'ghost';
  down.textContent = 'Down';
  down.onclick = () => {
    const next = row.nextElementSibling;
    if (next) row.parentNode.insertBefore(next, row);
  };
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'text-btn';
  del.textContent = 'Delete';
  del.onclick = () => row.remove();
  tools.append(img, up, down, del);
  const fileLabel = document.createElement('label');
  fileLabel.textContent = 'Photo';
  fileLabel.append(file);
  row.append(audio, fileLabel, tools);
  return row;
}
function saveSettings() {
  const rounds = [...document.querySelectorAll('.round-edit')].map((row) => ({
    id: row.dataset.id,
    title: row.querySelector('.f-title').value,
    source: row.querySelector('.f-source').value,
    pricePence: TPIR.parsePrice(row.querySelector('.f-price').value, 'gbp'),
    points: JSON.parse(row.dataset.points || '[]'),
    short: row.dataset.short || '',
    image: row.dataset.image || '',
    audio: row.querySelector('.f-audio').value,
  }));
  if (rounds.some((round) => round.pricePence == null)) {
    document.getElementById('host-err').textContent = 'Check the prices. Use 0.85 for 85p.';
    return;
  }
  socket.emit('host:save', {
    token: hostToken,
    settings: {
      showTitle: document.querySelector('.f-title-show').value,
      showSubtitle: document.querySelector('.f-sub').value,
      tagline: document.querySelector('.f-tag').value,
      rounds,
    },
  });
}
function openHost() {
  ensureHost(() => {
    document.getElementById('host-pop').classList.remove('hidden');
    socket.emit('host:settings', { token: hostToken });
  });
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
document.getElementById('dock-lock').onclick = () => {
  mark('ding');
  playStinger('dingding.mp3', 'ding');
  socket.emit('host:lock', { token: hostToken });
};
document.getElementById('dock-reveal').onclick = () => {
  mark('reveal');
  playStinger('reveal.mp3', 'reveal');
  socket.emit('host:reveal', { token: hostToken });
};
document.getElementById('dock-next').onclick = continueRound;
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
document.getElementById('refresh-btn').onclick = () => {
  if (!confirm('Clear every player and refresh the dashboard?')) return;
  socket.emit('host:refresh', { token: hostToken });
  setTimeout(() => location.reload(), 200);
};
document.getElementById('score-btn').onclick = toggleGuesses;
document.getElementById('host-btn').onclick = openHost;
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
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    toggleFullscreen();
    return;
  }
  if (e.key === 'Escape') {
    document.getElementById('score-pop').classList.add('hidden');
    document.getElementById('host-pop').classList.add('hidden');
    document.getElementById('pin-pop').classList.add('hidden');
    document.getElementById('qr-full').classList.add('hidden');
    document.getElementById('lobby-pop').classList.add('hidden');
    editorOpen = false;
  }
  if (!state) return;
  if (e.key === 'l' && state.phase === 'guessing' && !state.bidsIn) document.getElementById('dock-lock').click();
  if (e.key === 'r' && state.phase === 'guessing') document.getElementById('dock-reveal').click();
  if (e.key === 'n') document.getElementById('dock-next').click();
  if (e.key === 's') toggleGuesses();
  if (e.key === 'q' || e.key === 'Q') toggleLobby();
  if (e.key === ' ' || e.key === 'Spacebar') {
    const result = document.getElementById('round-result');
    const pop = document.getElementById('lobby-pop');
    const full = document.getElementById('qr-full');
    if (!result.classList.contains('hidden')) {
      e.preventDefault();
      continueRound();
    } else if (!pop.classList.contains('hidden') || !full.classList.contains('hidden')) {
      e.preventDefault();
      beginShow();
    } else if (!document.getElementById('rules-pop').classList.contains('hidden')) {
      e.preventDefault();
      startRoundAfterRules();
    }
  }
});

fetch('/join.json').then((res) => res.json()).then((data) => {
  document.getElementById('join-url').textContent = data.url;
}).catch(() => {});

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
  if (!editorOpen) buildEditor(settings);
  else if (!document.getElementById('round-list')) buildEditor(settings);
});
socket.on('host:saved', () => {
  const err = document.getElementById('host-err');
  if (err) err.textContent = 'Saved';
});
socket.on('host:err', (message) => {
  const err = document.getElementById('host-err');
  if (err) err.textContent = message;
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
