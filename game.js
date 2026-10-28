/*
 * Крокодил: Хаос — игровая логика.
 * Данные (слова, условия, подлянки) лежат в words.js.
 */
(function () {
  'use strict';

  // ==========================================================
  // Константы
  // ==========================================================

  const DATA = window.CROC_DATA;

  const DIFFS = {
    easy:   { name: 'Лёгкое',   points: 1, emoji: '🟢' },
    medium: { name: 'Среднее',  points: 2, emoji: '🟡' },
    crazy:  { name: 'Безумное', points: 3, emoji: '🔴' }
  };

  const TEAM_COLORS = ['#ff5d8f', '#4cc9f0', '#ffd166', '#06d6a0'];
  const DEFAULT_NAMES = ['Бешеные еноты', 'Танцующие кактусы', 'Летучие пельмени', 'Хитрые тапки'];
  const TEAM_COUNTS = [2, 3, 4];
  const TIME_OPTIONS = [30, 60, 90];
  const ROUNDS_MIN = 1;
  const ROUNDS_MAX = 10;
  const NAME_MAX = 20;

  const ACTION_COOLDOWN = 350;   // мс: защита от двойных нажатий
  const SCREEN_LOCK = 450;       // мс: клики игнорируются сразу после смены экрана
  const COUNTDOWN_STEP = 800;    // мс на каждую цифру «3-2-1»
  const WARN_AT = 10;            // сек: таймер желтеет
  const DANGER_AT = 5;           // сек: таймер краснеет и тикает
  const RING_LENGTH = 2 * Math.PI * 54;
  const STORAGE_KEY = 'croc-chaos-v1';

  // ==========================================================
  // Утилиты
  // ==========================================================

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  function plural(n, forms) {
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return forms[1];
    return forms[2];
  }

  const POINTS_FORMS = ['очко', 'очка', 'очков'];
  const WORDS_FORMS = ['слово', 'слова', 'слов'];

  // Перезапуск CSS-анимации на элементе
  function restartAnimation(node, className) {
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
  }

  // Превращает { 'Категория': ['слово', ...] } в [{ w, c }, ...]
  function flattenWords(byCategory) {
    const out = [];
    Object.keys(byCategory || {}).forEach((category) => {
      byCategory[category].forEach((word) => out.push({ w: word, c: category }));
    });
    return out;
  }

  // Колода: тасуется, раздаётся без повторов, после исчерпания тасуется заново
  function createDeck(items) {
    return { items: items, pile: [] };
  }

  function drawFrom(deck, avoid) {
    if (deck.pile.length === 0) deck.pile = shuffle(deck.items);
    let card = deck.pile.pop();
    // Не даём выпасть той же карте два раза подряд
    if (card === avoid && deck.pile.length > 0) {
      const other = deck.pile.pop();
      deck.pile.unshift(card);
      card = other;
    }
    return card;
  }

  // ==========================================================
  // Хранилище настроек (под file:// может быть недоступно)
  // ==========================================================

  const storage = {
    load() {
      try {
        return JSON.parse(window.localStorage.getItem(STORAGE_KEY)) || {};
      } catch (e) {
        return {};
      }
    },
    save(data) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (e) {
        /* хранилище недоступно: просто не запоминаем настройки */
      }
    }
  };

  const saved = storage.load();
  const settings = {
    teamCount: TEAM_COUNTS.indexOf(saved.teamCount) !== -1 ? saved.teamCount : 2,
    names: DEFAULT_NAMES.map((def, i) =>
      (Array.isArray(saved.names) && typeof saved.names[i] === 'string') ? saved.names[i].slice(0, NAME_MAX) : def),
    time: TIME_OPTIONS.indexOf(saved.time) !== -1 ? saved.time : 60,
    rounds: (Number.isInteger(saved.rounds) && saved.rounds >= ROUNDS_MIN && saved.rounds <= ROUNDS_MAX) ? saved.rounds : 3,
    muted: saved.muted === true
  };

  function persist() {
    storage.save(settings);
  }

  // ==========================================================
  // Защита от двойных нажатий
  // ==========================================================

  let lockUntil = 0;

  function lockFor(ms) {
    lockUntil = Math.max(lockUntil, performance.now() + ms);
  }

  // Оборачивает обработчик: повторный вызов в течение cooldown игнорируется
  function guarded(fn, cooldown) {
    return function (event) {
      const now = performance.now();
      if (now < lockUntil) return;
      lockUntil = now + (cooldown || ACTION_COOLDOWN);
      fn.call(this, event);
    };
  }

  // ==========================================================
  // Звук (Web Audio API)
  // ==========================================================

  const sound = (function () {
    let ctx = null;

    function getContext() {
      if (settings.muted) return null;
      if (!ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        try {
          ctx = new AudioCtx();
        } catch (e) {
          return null;
        }
      }
      if (ctx.state === 'suspended') {
        const p = ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
      return ctx;
    }

    function tone(freq, start, duration, type, volume, freqEnd) {
      const c = getContext();
      if (!c) return;
      const t0 = c.currentTime + start;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + duration);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(volume || 0.2, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.05);
    }

    return {
      unlock() { getContext(); },
      click()   { tone(700, 0, 0.08, 'triangle', 0.15); },
      count()   { tone(520, 0, 0.14, 'sine', 0.25); },
      go()      { tone(880, 0, 0.25, 'triangle', 0.3); tone(1320, 0.08, 0.3, 'triangle', 0.2); },
      tick()    { tone(1250, 0, 0.07, 'square', 0.07); },
      correct() { tone(660, 0, 0.12, 'triangle', 0.25); tone(990, 0.09, 0.2, 'triangle', 0.25); },
      skip()    { tone(320, 0, 0.2, 'sawtooth', 0.08, 170); },
      sabotage() { tone(220, 0, 0.35, 'sawtooth', 0.1, 110); tone(165, 0.2, 0.45, 'sawtooth', 0.1, 80); },
      timeUp() {
        // Сирена + низкий «гонг»
        tone(880, 0, 0.22, 'square', 0.14);
        tone(660, 0.24, 0.22, 'square', 0.14);
        tone(440, 0.48, 0.5, 'square', 0.14);
        tone(110, 0.48, 1.6, 'sine', 0.45, 90);
        tone(220, 0.48, 1.2, 'sine', 0.2, 180);
      },
      fanfare() {
        const notes = [523, 659, 784, 1047];
        notes.forEach((f, i) => tone(f, i * 0.13, 0.25, 'triangle', 0.25));
        tone(1047, 0.55, 0.8, 'triangle', 0.25);
        tone(784, 0.55, 0.8, 'sine', 0.18);
      }
    };
  })();

  // ==========================================================
  // Конфетти (canvas)
  // ==========================================================

  const confetti = (function () {
    const canvas = $('confetti');
    const ctx = canvas.getContext('2d');
    const COLORS = ['#ffd166', '#ff5d8f', '#4cc9f0', '#06d6a0', '#ffffff', '#f72585', '#ffaa00'];
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let parts = [];
    let raf = 0;
    let spawnUntil = 0;
    let width = 0;
    let height = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function spawn(count, fromTop) {
      for (let i = 0; i < count; i++) {
        parts.push({
          x: Math.random() * width,
          y: fromTop ? -20 - Math.random() * 40 : -20 - Math.random() * height * 0.6,
          vx: (Math.random() - 0.5) * 3,
          vy: 2 + Math.random() * 3,
          size: 6 + Math.random() * 9,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 0.3,
          wobble: Math.random() * 10,
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
          round: Math.random() < 0.35
        });
      }
    }

    function frame() {
      const now = performance.now();
      ctx.clearRect(0, 0, width, height);
      if (now < spawnUntil && parts.length < 320) spawn(3, true);

      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        p.wobble += 0.06;
        p.x += p.vx + Math.sin(p.wobble) * 0.9;
        p.y += p.vy;
        p.vy = Math.min(p.vy + 0.02, 6.5);
        p.rot += p.vr;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2.4, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        }
        ctx.restore();
      }

      parts = parts.filter((p) => p.y < height + 30);
      if (parts.length > 0 || now < spawnUntil) {
        raf = requestAnimationFrame(frame);
      } else {
        stop();
      }
    }

    function start(duration) {
      stop();
      resize();
      canvas.classList.add('is-on');
      spawn(reduced ? 40 : 160, false);
      spawnUntil = reduced ? 0 : performance.now() + (duration || 4000);
      raf = requestAnimationFrame(frame);
    }

    function stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      parts = [];
      spawnUntil = 0;
      ctx.clearRect(0, 0, width, height);
      canvas.classList.remove('is-on');
    }

    window.addEventListener('resize', () => {
      if (raf) resize();
    });

    return { start: start, stop: stop };
  })();

  // ==========================================================
  // Экраны
  // ==========================================================

  const screens = Array.prototype.slice.call(document.querySelectorAll('.screen'));

  function showScreen(name, lockMs) {
    screens.forEach((screen) => {
      screen.classList.toggle('is-active', screen.id === 'screen-' + name);
    });
    document.body.setAttribute('data-screen', name);
    lockFor(lockMs === undefined ? SCREEN_LOCK : lockMs);
    $('btn-home').hidden = (name === 'start' || name === 'setup' || name === 'final');
    if (name !== 'final') confetti.stop();
    window.scrollTo(0, 0);
  }

  // ==========================================================
  // Настройка
  // ==========================================================

  function buildSetup() {
    const wrap = $('team-inputs');
    DEFAULT_NAMES.forEach((def, i) => {
      const row = el('label', 'team-row');
      row.style.setProperty('--team', TEAM_COLORS[i]);
      const input = el('input', 'team-input');
      input.type = 'text';
      input.maxLength = NAME_MAX;
      input.placeholder = def;
      input.value = settings.names[i];
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Название команды ' + (i + 1));
      input.addEventListener('input', () => {
        settings.names[i] = input.value;
        persist();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
      row.append(el('span', 'team-dot'), input);
      wrap.append(row);
    });
  }

  function markSeg(id, value) {
    $(id).querySelectorAll('[data-value]').forEach((btn) => {
      const on = Number(btn.getAttribute('data-value')) === value;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function renderSetup() {
    markSeg('seg-teams', settings.teamCount);
    markSeg('seg-time', settings.time);
    $('rounds-value').textContent = settings.rounds;
    $('rounds-minus').disabled = settings.rounds <= ROUNDS_MIN;
    $('rounds-plus').disabled = settings.rounds >= ROUNDS_MAX;
    Array.prototype.forEach.call($('team-inputs').children, (row, i) => {
      row.hidden = i >= settings.teamCount;
    });
    const turns = settings.teamCount * settings.rounds;
    const minutes = Math.max(1, Math.round(turns * (settings.time + 25) / 60));
    $('setup-summary').textContent = 'Всего ходов: ' + turns + ' · примерно ' + minutes + ' мин';
  }

  function changeRounds(delta) {
    settings.rounds = Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, settings.rounds + delta));
    persist();
    renderSetup();
  }

  // Пустые названия заменяем дефолтными, одинаковые нумеруем
  function resolveNames() {
    const used = {};
    return settings.names.slice(0, settings.teamCount).map((raw, i) => {
      const base = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX) || DEFAULT_NAMES[i];
      let name = base;
      let k = 2;
      while (used[name.toLowerCase()]) name = base + ' ' + k++;
      used[name.toLowerCase()] = true;
      return name;
    });
  }

  // ==========================================================
  // Состояние игры
  // ==========================================================

  let WORDS = null;   // { easy: [{w, c}], medium: [...], crazy: [...] }
  let game = null;

  function startNewGame() {
    stopRoundActivity();
    const names = resolveNames();
    game = {
      teams: names.map((name, i) => ({
        name: name,
        color: TEAM_COLORS[i],
        score: 0,
        guessed: 0,
        skipped: 0,
        sabotageUsed: false
      })),
      roundTime: settings.time,
      roundsPerTeam: settings.rounds,
      turnIndex: 0,
      totalTurns: names.length * settings.rounds,
      history: [],
      decks: {
        easy: createDeck(WORDS.easy),
        medium: createDeck(WORDS.medium),
        crazy: createDeck(WORDS.crazy),
        conditions: createDeck(DATA.conditions),
        sabotages: createDeck(DATA.sabotages)
      },
      turn: null
    };
    beginTurn();
  }

  function beginTurn() {
    const count = game.teams.length;
    game.turn = {
      teamIdx: game.turnIndex % count,
      roundNum: Math.floor(game.turnIndex / count) + 1,
      diff: null,
      sabotage: null,
      sabotageBy: -1,
      word: null,
      condition: null,
      points: 0,
      guessed: 0,
      skipped: 0,
      log: [],
      active: false,   // идёт ли отсчёт таймера
      ended: false     // раунд завершён и очки начислены
    };
    renderTurn();
    showScreen('turn');
  }

  // Полностью останавливает всё, что может «тикать» в фоне
  function stopRoundActivity() {
    stopTimer();
    clearCountdown();
    setActionsEnabled(false);
    if (game && game.turn) game.turn.active = false;
    confetti.stop();
  }

  function abortGame() {
    stopRoundActivity();
    game = null;
    showScreen('start');
  }

  // ==========================================================
  // Отрисовка общих элементов
  // ==========================================================

  function setTeamPill(node, team) {
    node.textContent = team.name;
    node.style.setProperty('--team', team.color);
  }

  function fillCard(card, item, label) {
    card.querySelector('.card-icon').textContent = item.icon;
    card.querySelector('.card-label').textContent = label;
    card.querySelector('.card-text').textContent = item.text;
  }

  function renderScoreboard(container, currentIdx) {
    container.innerHTML = '';
    game.teams.forEach((team, i) => {
      const chip = el('div', 'score-chip' + (i === currentIdx ? ' is-current' : ''));
      chip.style.setProperty('--team', team.color);
      chip.append(el('span', 'score-name', team.name), el('span', 'score-value', team.score));
      container.append(chip);
    });
  }

  // ==========================================================
  // Экран хода и «Подлянка»
  // ==========================================================

  function renderTurn() {
    const t = game.turn;
    $('turn-round').textContent = 'Раунд ' + t.roundNum + ' из ' + game.roundsPerTeam +
      ' · ход ' + (game.turnIndex + 1) + '/' + game.totalTurns;
    renderScoreboard($('turn-scoreboard'), t.teamIdx);
    setTeamPill($('turn-team'), game.teams[t.teamIdx]);
    renderSabotage(false);
  }

  function renderSabotage(animate) {
    const t = game.turn;
    const buttons = $('sabotage-buttons');
    const card = $('sabotage-card');
    const hint = $('sabotage-hint');
    buttons.innerHTML = '';

    if (t.sabotage) {
      buttons.hidden = true;
      card.hidden = false;
      fillCard(card, t.sabotage, 'От команды «' + game.teams[t.sabotageBy].name + '»');
      hint.textContent = 'Это условие действует весь раунд — вместе с обычными картами!';
      if (animate) restartAnimation(card, 'flip-in');
      return;
    }

    card.hidden = true;
    const rivals = game.teams
      .map((team, i) => ({ team: team, i: i }))
      .filter((x) => x.i !== t.teamIdx);
    const available = rivals.filter((x) => !x.team.sabotageUsed);

    if (available.length === 0) {
      buttons.hidden = true;
      hint.textContent = 'У соперников не осталось подлянок. Можно выдохнуть 😌';
      return;
    }

    buttons.hidden = false;
    hint.textContent = 'Соперники могут подкинуть дополнительное условие на этот раунд. Один раз за игру!';
    rivals.forEach((x) => {
      const btn = el('button', 'btn btn-sabotage',
        x.team.sabotageUsed ? x.team.name + ': уже потрачена' : '😈 Подлянка от «' + x.team.name + '»');
      btn.type = 'button';
      btn.disabled = x.team.sabotageUsed;
      btn.style.setProperty('--team', x.team.color);
      btn.setAttribute('data-team', String(x.i));
      buttons.append(btn);
    });
  }

  function onSabotage(event) {
    const btn = event.target.closest('[data-team]');
    if (!btn || !game || !game.turn) return;
    const t = game.turn;
    const idx = Number(btn.getAttribute('data-team'));
    const team = game.teams[idx];
    if (!team || idx === t.teamIdx || team.sabotageUsed || t.sabotage || t.diff) return;

    team.sabotageUsed = true;
    t.sabotage = drawFrom(game.decks.sabotages);
    t.sabotageBy = idx;
    sound.sabotage();
    renderSabotage(true);
  }

  // ==========================================================
  // Ставка
  // ==========================================================

  function openBet() {
    if (!game || !game.turn || game.turn.diff) return;
    setTeamPill($('bet-team'), game.teams[game.turn.teamIdx]);
    showScreen('bet');
  }

  function onBet(event) {
    const btn = event.target.closest('[data-diff]');
    if (!btn || !game || !game.turn || game.turn.diff) return;
    const diff = btn.getAttribute('data-diff');
    if (!DIFFS[diff]) return;
    game.turn.diff = diff;
    startRound();
  }

  // ==========================================================
  // Раунд
  // ==========================================================

  let wordHidden = false;
  let hideLockUntil = 0;
  let countdownTimers = [];

  function setActionsEnabled(on) {
    $('btn-guess').disabled = !on;
    $('btn-skip').disabled = !on;
  }

  function setWordHidden(hidden) {
    wordHidden = hidden;
    $('word-card').classList.toggle('is-hidden', hidden);
    const btn = $('btn-hide');
    btn.textContent = hidden ? '👁 Показать' : '🙈 Скрыть';
    btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
  }

  function startRound() {
    const t = game.turn;
    const team = game.teams[t.teamIdx];
    const diff = DIFFS[t.diff];

    setTeamPill($('round-team'), team);
    $('round-diff').textContent = diff.emoji + ' ' + diff.name + ' · +' + diff.points;
    $('round-points').textContent = '0';

    const sab = $('round-sabotage');
    sab.hidden = !t.sabotage;
    if (t.sabotage) fillCard(sab, t.sabotage, '😈 Подлянка от «' + game.teams[t.sabotageBy].name + '»');

    setWordHidden(false);
    setActionsEnabled(false);
    resetTimerView();
    nextWord();
    showScreen('round');

    runCountdown(() => {
      if (!game || game.turn !== t || t.ended) return;
      t.active = true;
      setActionsEnabled(true);
      startTimer();
      sound.go();
      restartAnimation($('word-card'), 'pop-in');
      restartAnimation($('condition-card'), 'flip-in');
    });
  }

  function runCountdown(done) {
    clearCountdown();
    const overlay = $('countdown');
    const value = $('countdown-value');
    let n = 3;
    overlay.hidden = false;

    const step = () => {
      if (n === 0) {
        overlay.hidden = true;
        countdownTimers = [];
        done();
        return;
      }
      value.textContent = n;
      restartAnimation(value, 'count-pop');
      sound.count();
      n -= 1;
      countdownTimers.push(setTimeout(step, COUNTDOWN_STEP));
    };
    step();
  }

  function clearCountdown() {
    countdownTimers.forEach(clearTimeout);
    countdownTimers = [];
    $('countdown').hidden = true;
  }

  function nextWord() {
    const t = game.turn;
    t.word = drawFrom(game.decks[t.diff]);
    t.condition = drawFrom(game.decks.conditions, t.condition);

    const text = $('word-text');
    text.textContent = t.word.w;
    text.classList.toggle('is-long', t.word.w.length > 14);
    $('word-category').textContent = t.word.c;
    fillCard($('condition-card'), t.condition, 'Условие');

    restartAnimation($('word-card'), 'pop-in');
    restartAnimation($('condition-card'), 'flip-in');
  }

  function floatText(text, className) {
    const node = el('div', 'float-text ' + className, text);
    const remove = () => { if (node.parentNode) node.parentNode.removeChild(node); };
    node.addEventListener('animationend', remove);
    setTimeout(remove, 1500);
    document.body.append(node);
  }

  function onGuess() {
    const t = game && game.turn;
    if (!t || !t.active || t.ended) return;
    const pts = DIFFS[t.diff].points;
    t.points += pts;
    t.guessed += 1;
    t.log.push({ word: t.word.w, result: 'ok' });

    const pointsNode = $('round-points');
    pointsNode.textContent = t.points;
    restartAnimation(pointsNode, 'bump');
    floatText('+' + pts, 'is-plus');
    sound.correct();
    nextWord();
  }

  function onSkip() {
    const t = game && game.turn;
    if (!t || !t.active || t.ended) return;
    t.skipped += 1;
    t.log.push({ word: t.word.w, result: 'skip' });
    floatText('Пропуск', 'is-skip');
    sound.skip();
    nextWord();
  }

  function onToggleHide() {
    const now = performance.now();
    if (now < hideLockUntil) return;
    hideLockUntil = now + 250;
    setWordHidden(!wordHidden);
  }

  // Единственное место, где очки раунда попадают в общий счёт
  function endRound() {
    const t = game && game.turn;
    if (!t || !t.active || t.ended) return;
    t.active = false;
    t.ended = true;
    stopTimer();
    setActionsEnabled(false);
    $('timer-value').textContent = '0';
    setRing(0);

    if (t.word) t.log.push({ word: t.word.w, result: 'timeout' });

    const team = game.teams[t.teamIdx];
    team.score += t.points;
    team.guessed += t.guessed;
    team.skipped += t.skipped;
    game.history.push({
      teamIdx: t.teamIdx,
      roundNum: t.roundNum,
      diff: t.diff,
      points: t.points,
      guessed: t.guessed,
      skipped: t.skipped
    });

    sound.timeUp();
    renderRoundEnd();
    showScreen('roundend', 900);
  }

  // ==========================================================
  // Таймер
  // ==========================================================

  const timer = { endAt: 0, duration: 0, interval: 0, raf: 0, lastSec: -1 };

  function setRing(fraction) {
    const f = Math.max(0, Math.min(1, fraction));
    $('timer-progress').style.strokeDashoffset = (RING_LENGTH * (1 - f)).toFixed(2);
  }

  function resetTimerView() {
    $('timer-value').textContent = game.roundTime;
    $('timer').classList.remove('is-warn', 'is-danger');
    setRing(1);
  }

  function startTimer() {
    stopTimer();
    timer.duration = game.roundTime * 1000;
    timer.endAt = performance.now() + timer.duration;
    timer.lastSec = -1;

    // Логика (секунды, звук, завершение) — по интервалу; считаем от endAt, поэтому без дрейфа
    timer.interval = setInterval(timerTick, 100);

    // Плавное кольцо — по кадрам
    const frame = () => {
      const remain = Math.max(0, timer.endAt - performance.now());
      setRing(remain / timer.duration);
      if (remain > 0 && timer.raf) timer.raf = requestAnimationFrame(frame);
    };
    timer.raf = requestAnimationFrame(frame);

    timerTick();
  }

  function timerTick() {
    const t = game && game.turn;
    if (!t || !t.active) {
      stopTimer();
      return;
    }
    const remain = timer.endAt - performance.now();
    const sec = Math.max(0, Math.ceil(remain / 1000));

    if (sec !== timer.lastSec) {
      timer.lastSec = sec;
      $('timer-value').textContent = sec;
      const node = $('timer');
      node.classList.toggle('is-warn', sec <= WARN_AT && sec > DANGER_AT);
      node.classList.toggle('is-danger', sec <= DANGER_AT);
      if (sec > 0 && sec <= DANGER_AT) sound.tick();
    }

    if (remain <= 0) endRound();
  }

  function stopTimer() {
    clearInterval(timer.interval);
    cancelAnimationFrame(timer.raf);
    timer.interval = 0;
    timer.raf = 0;
  }

  // ==========================================================
  // Итог раунда
  // ==========================================================

  const RESULT_ICONS = { ok: '✅', skip: '⏭', timeout: '⌛' };

  function renderRoundEnd() {
    const t = game.turn;
    const team = game.teams[t.teamIdx];

    setTeamPill($('re-team'), team);
    $('re-points').textContent = '+' + t.points;
    $('re-points-label').textContent = plural(t.points, POINTS_FORMS);
    $('re-details').textContent = 'Угадано: ' + t.guessed + ' · Пропущено: ' + t.skipped;

    const list = $('re-words');
    list.innerHTML = '';
    t.log.forEach((item, i) => {
      const li = el('li', 're-word is-' + item.result, RESULT_ICONS[item.result] + ' ' + item.word);
      li.style.animationDelay = Math.min(i * 40, 600) + 'ms';
      if (item.result === 'timeout') li.title = 'Не успели';
      list.append(li);
    });

    renderScoreboard($('re-scoreboard'), t.teamIdx);

    const isLast = game.turnIndex + 1 >= game.totalTurns;
    $('btn-next-turn').textContent = isLast
      ? '🏆 К итогам'
      : 'Дальше: ' + game.teams[(game.turnIndex + 1) % game.teams.length].name + ' →';
  }

  function onNextTurn() {
    if (!game || !game.turn || !game.turn.ended) return;
    game.turnIndex += 1;
    if (game.turnIndex >= game.totalTurns) {
      showFinal();
    } else {
      beginTurn();
    }
  }

  // ==========================================================
  // Финал
  // ==========================================================

  function showFinal() {
    const teams = game.teams;
    const max = Math.max.apply(null, teams.map((t) => t.score));
    const winners = teams.filter((t) => t.score === max);

    const title = $('final-title');
    const winner = $('final-winner');
    if (winners.length === 1) {
      title.textContent = 'Победитель';
      winner.textContent = winners[0].name;
      winner.style.setProperty('--team', winners[0].color);
    } else {
      title.textContent = 'Ничья!';
      winner.textContent = winners.map((w) => w.name).join(' и ');
      winner.style.setProperty('--team', '#ffd166');
    }
    $('final-score').textContent = max + ' ' + plural(max, POINTS_FORMS);

    // Таблица: сортировка по очкам, при равенстве — по угаданным словам
    const ranked = teams.slice().sort((a, b) => b.score - a.score || b.guessed - a.guessed);
    const medals = ['🥇', '🥈', '🥉', '4'];
    const body = $('final-table');
    body.innerHTML = '';
    ranked.forEach((team) => {
      const place = ranked.findIndex((x) => x.score === team.score);
      const row = el('tr');
      const nameCell = el('td');
      const pill = el('span', 'team-pill', team.name);
      pill.style.setProperty('--team', team.color);
      nameCell.append(pill);
      row.append(
        el('td', null, medals[place]),
        nameCell,
        el('td', null, team.score),
        el('td', null, team.guessed),
        el('td', null, team.skipped)
      );
      body.append(row);
    });

    // Лучший раунд: больше очков, при равенстве — больше угаданных слов
    const best = game.history.reduce((b, r) => {
      if (!b || r.points > b.points || (r.points === b.points && r.guessed > b.guessed)) return r;
      return b;
    }, null);
    const bestNode = $('final-best');
    if (!best || best.points === 0) {
      bestNode.textContent = '⭐ Лучший раунд: в этот раз никто не набрал очков 🙈';
    } else {
      const d = DIFFS[best.diff];
      bestNode.textContent = '⭐ Лучший раунд: «' + teams[best.teamIdx].name + '» — ' +
        best.points + ' ' + plural(best.points, POINTS_FORMS) + ' в раунде ' + best.roundNum +
        ' (' + best.guessed + ' ' + plural(best.guessed, WORDS_FORMS) + ', ' + d.emoji + ' ' + d.name.toLowerCase() + ')';
    }

    showScreen('final', 900);
    sound.fanfare();
    confetti.start(4500);
  }

  // ==========================================================
  // Звук: кнопка
  // ==========================================================

  function renderSoundButton() {
    const btn = $('btn-sound');
    const label = settings.muted ? 'Включить звук' : 'Выключить звук';
    btn.textContent = settings.muted ? '🔇' : '🔊';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', settings.muted ? 'true' : 'false');
  }

  // ==========================================================
  // События
  // ==========================================================

  function bindEvents() {
    // Браузеры разрешают звук только после жеста пользователя
    const unlock = () => sound.unlock();
    document.addEventListener('pointerdown', unlock, { passive: true });
    document.addEventListener('keydown', unlock);

    $('btn-sound').addEventListener('click', () => {
      settings.muted = !settings.muted;
      persist();
      renderSoundButton();
      sound.click();
    });

    $('btn-home').addEventListener('click', () => {
      if (game && !window.confirm('Выйти в меню? Текущая игра будет потеряна.')) return;
      abortGame();
    });

    $('btn-play').addEventListener('click', guarded(() => {
      renderSetup();
      showScreen('setup');
    }));

    // Настройка
    $('seg-teams').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-value]');
      if (!btn) return;
      settings.teamCount = Number(btn.getAttribute('data-value'));
      persist();
      renderSetup();
    });
    $('seg-time').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-value]');
      if (!btn) return;
      settings.time = Number(btn.getAttribute('data-value'));
      persist();
      renderSetup();
    });
    $('rounds-minus').addEventListener('click', () => changeRounds(-1));
    $('rounds-plus').addEventListener('click', () => changeRounds(1));
    $('btn-setup-back').addEventListener('click', guarded(() => showScreen('start')));
    $('btn-start-game').addEventListener('click', guarded(startNewGame));

    // Ход
    $('sabotage-buttons').addEventListener('click', guarded(onSabotage));
    $('btn-to-bet').addEventListener('click', guarded(openBet));

    // Ставка
    $('bets').addEventListener('click', guarded(onBet));
    $('btn-bet-back').addEventListener('click', guarded(() => {
      if (game && game.turn && !game.turn.diff) showScreen('turn');
    }));

    // Раунд
    $('btn-guess').addEventListener('click', guarded(onGuess));
    $('btn-skip').addEventListener('click', guarded(onSkip));
    $('btn-hide').addEventListener('click', onToggleHide);

    // Итоги
    $('btn-next-turn').addEventListener('click', guarded(onNextTurn));
    $('btn-rematch').addEventListener('click', guarded(startNewGame));
    $('btn-new-game').addEventListener('click', guarded(() => {
      stopRoundActivity();
      game = null;
      renderSetup();
      showScreen('setup');
    }));
  }

  // ==========================================================
  // Запуск
  // ==========================================================

  function init() {
    if (!DATA || !DATA.words || !Array.isArray(DATA.conditions) || !Array.isArray(DATA.sabotages)) {
      $('app').textContent = 'Не удалось загрузить базу слов (words.js). Проверьте, что файл лежит рядом с index.html.';
      return;
    }
    WORDS = {
      easy: flattenWords(DATA.words.easy),
      medium: flattenWords(DATA.words.medium),
      crazy: flattenWords(DATA.words.crazy)
    };

    $('timer-progress').style.strokeDasharray = RING_LENGTH.toFixed(2);
    buildSetup();
    renderSetup();
    renderSoundButton();
    bindEvents();
    showScreen('start', 0);
  }

  init();
})();
