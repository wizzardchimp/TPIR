const socket = io({ transports: ['polling', 'websocket'] });

const params = new URLSearchParams(window.location.search);
const sessionCode = params.get('code') || localStorage.getItem('tpir_session_code');
const playerName = params.get('name') || localStorage.getItem('tpir_player_name');

let currentPhase = 'waiting';
let hasSubmitted = false;
let totalScores = {};

function showPlayerScreen(id) {
  document.querySelectorAll('.player-container .screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function formatPrice(p) {
  if (Number.isInteger(p)) return p.toString();
  return p.toFixed(2);
}

// Auto-join on load
if (sessionCode && playerName) {
  document.getElementById('playerSessionCode').textContent = `Session: ${sessionCode}`;
  socket.emit('join-session', { code: sessionCode, name: playerName }, (response) => {
    if (response.success) {
      localStorage.setItem('tpir_player_name', playerName);
      localStorage.setItem('tpir_session_code', sessionCode);

      if (response.phase === 'playing') {
        showPlayerScreen('playerGuess');
        currentPhase = 'playing';
        document.getElementById('guessRoundInfo').textContent =
          `Round ${response.currentRound + 1} of ${response.totalRounds}`;
        document.getElementById('guessItemName').textContent = response.currentRoundName || 'Ready...';

        if (response.timerRemaining !== null && response.timerRemaining !== undefined) {
          const mins = Math.floor(response.timerRemaining / 60);
          const secs = response.timerRemaining % 60;
          document.getElementById('guessTimer').textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
          document.getElementById('guessTimer').classList.toggle('warning', response.timerRemaining <= 10);
        }

        if (response.hasGuessed) {
          hasSubmitted = true;
          document.getElementById('submitGuessBtn').textContent = 'Submitted ✓';
          document.getElementById('submitGuessBtn').disabled = true;
          document.getElementById('submitGuessBtn').classList.add('submitted');
          document.getElementById('guessInput').disabled = true;
        }
      } else if (response.phase === 'results' || response.phase === 'finished') {
        showPlayerScreen('playerWaiting');
      } else {
        showPlayerScreen('playerWaiting');
      }
      currentPhase = response.phase || 'waiting';
    } else {
      // If we can't join, redirect to join page
      if (response.reason === 'You have been kicked from this session') {
        showPlayerScreen('playerKicked');
      } else {
        window.location.href = `/join.html?code=${sessionCode}&error=${encodeURIComponent(response.reason || 'Session error')}`;
      }
    }
  });
} else {
  window.location.href = '/join.html';
}

// Submit guess
document.getElementById('submitGuessBtn').addEventListener('click', () => {
  if (hasSubmitted) return;

  const input = document.getElementById('guessInput');
  const value = input.value.trim();

  if (!value || parseFloat(value) < 0) {
    input.focus();
    return;
  }

  const btn = document.getElementById('submitGuessBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  socket.emit('submit-guess', { value }, (response) => {
    if (response.success) {
      hasSubmitted = true;
      btn.textContent = 'Submitted ✓';
      btn.classList.add('submitted');
      input.disabled = true;
    } else {
      btn.disabled = false;
      btn.textContent = 'Submit Guess';
      alert(response.reason || 'Failed to submit');
    }
  });
});

// Allow Enter key to submit
document.getElementById('guessInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    document.getElementById('submitGuessBtn').click();
  }
});

// === SOCKET EVENTS ===

socket.on('game-started', () => {
  showPlayerScreen('playerWaiting');
});

socket.on('timer-started', (data) => {
  currentPhase = 'playing';
  hasSubmitted = false;

  document.getElementById('guessRoundInfo').textContent = `Round ${data.roundNumber} of ${data.totalRounds}`;
  document.getElementById('guessItemName').textContent = data.roundName;
  document.getElementById('guessInput').value = '';
  document.getElementById('guessInput').disabled = false;

  const btn = document.getElementById('submitGuessBtn');
  btn.textContent = 'Submit Guess';
  btn.disabled = false;
  btn.classList.remove('submitted');

  showPlayerScreen('playerGuess');
});

socket.on('timer-tick', (data) => {
  const mins = Math.floor(data.remaining / 60);
  const secs = data.remaining % 60;
  const el = document.getElementById('guessTimer');
  el.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  el.classList.toggle('warning', data.remaining <= 10);
});

socket.on('time-up', () => {
  document.getElementById('guessTimer').textContent = '0:00';
  document.getElementById('guessInput').disabled = true;
  const btn = document.getElementById('submitGuessBtn');
  btn.disabled = true;
  if (!hasSubmitted) {
    btn.textContent = 'Time\'s Up';
  }
});

socket.on('round-results', (data) => {
  currentPhase = 'results';
  totalScores = data.totalScores || {};

  // Find this player's result
  const myResult = data.rankings.find(r => r.name === playerName);

  if (myResult) {
    document.getElementById('resultGuess').textContent = `£${myResult.guess.toFixed(2)}`;
    document.getElementById('resultActual').textContent = `£${formatPrice(data.roundPrice)}`;

    const diff = data.roundPrice - myResult.guess;
    const diffStr = diff >= 0 ? `-£${Math.abs(diff).toFixed(2)}` : `+£${Math.abs(diff).toFixed(2)}`;
    const diffEl = document.getElementById('resultDiff');
    diffEl.textContent = diffStr;
    diffEl.style.color = diff < 0 ? '#ff4444' : '#44cc44';
    if (diff < 0) diffEl.textContent += ' OVER';

    document.getElementById('resultPoints').textContent = myResult.points > 0 ? `+${myResult.points}` : '0';
    if (myResult.points > 0) {
      document.getElementById('resultLabel').textContent = myResult.points === 1 ? 'Bonus point!' : 'Points this round';
    } else {
      document.getElementById('resultLabel').textContent = diff < 0 ? 'Over the price - no points' : 'No points this round';
    }

    const myTotal = totalScores[playerName] || 0;
    document.getElementById('resultTotal').textContent = myTotal;
  }

  showPlayerScreen('playerResult');
});

socket.on('round-ready', () => {
  showPlayerScreen('playerWaiting');
});

socket.on('game-finished', (data) => {
  totalScores = data.totalScores || {};

  const myScore = totalScores[playerName] || 0;
  document.getElementById('playerFinalScore').textContent = myScore;

  const sorted = Object.entries(totalScores).sort((a, b) => b[1] - a[1]);
  const myRank = sorted.findIndex(([name]) => name === playerName) + 1;
  const total = sorted.length;

  const rankStr = myRank === 1 ? '🥇 1st Place!' : myRank === 2 ? '🥈 2nd Place!' : myRank === 3 ? '🥉 3rd Place!' : `${myRank}th Place`;
  document.getElementById('playerFinalRank').textContent = rankStr;

  showPlayerScreen('playerFinal');
});

socket.on('you-were-kicked', () => {
  localStorage.removeItem('tpir_player_name');
  localStorage.removeItem('tpir_session_code');
  showPlayerScreen('playerKicked');
});

socket.on('session-reset', () => {
  localStorage.removeItem('tpir_player_name');
  localStorage.removeItem('tpir_session_code');
  alert('The session has been reset by the host. You will be redirected.');
  window.location.href = '/join.html';
});

socket.on('disconnect', () => {
  showPlayerScreen('playerWaiting');
  document.querySelector('#playerWaiting h2').textContent = 'Reconnecting...';
});

socket.on('connect', () => {
  if (sessionCode && playerName) {
    socket.emit('join-session', { code: sessionCode, name: playerName }, () => {});
  }
});
