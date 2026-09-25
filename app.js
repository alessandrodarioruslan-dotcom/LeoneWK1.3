// ---------- IndexedDB ----------
const DB_NAME = 'WorkoutTrackerDB_Leone';
const DB_VERSION = 2;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains('workouts')) {
        _db.createObjectStore('workouts', { keyPath: 'id', autoIncrement: true });
      }
      if (!_db.objectStoreNames.contains('exercises')) {
        const ex = _db.createObjectStore('exercises', { keyPath: 'id', autoIncrement: true });
        ex.createIndex('workoutId', 'workoutId');
      }
      if (!_db.objectStoreNames.contains('sets')) {
        const st = _db.createObjectStore('sets', { keyPath: 'id', autoIncrement: true });
        st.createIndex('exerciseId', 'exerciseId');
      }
      if (!_db.objectStoreNames.contains('programItems')) {
        const pi = _db.createObjectStore('programItems', { keyPath: 'id', autoIncrement: true });
        pi.createIndex('weekday', 'weekday');
      }
      if (!_db.objectStoreNames.contains('programChecks')) {
        const pc = _db.createObjectStore('programChecks', { keyPath: 'id', autoIncrement: true });
        pc.createIndex('dateKey', 'dateKey');
        pc.createIndex('itemId', 'itemId');
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function tx(storeNames, mode = 'readonly') {
  return db.transaction(storeNames, mode);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- workouts ---
function addWorkout(data) {
  const t = tx('workouts', 'readwrite');
  return reqToPromise(t.objectStore('workouts').add(data));
}
function updateWorkout(workout) {
  const t = tx('workouts', 'readwrite');
  return reqToPromise(t.objectStore('workouts').put(workout));
}
function getWorkout(id) {
  const t = tx('workouts');
  return reqToPromise(t.objectStore('workouts').get(id));
}
function getAllWorkouts() {
  const t = tx('workouts');
  return reqToPromise(t.objectStore('workouts').getAll());
}

// --- exercises ---
function addExercise(data) {
  const t = tx('exercises', 'readwrite');
  return reqToPromise(t.objectStore('exercises').add(data));
}
function deleteExercise(id) {
  const t = tx('exercises', 'readwrite');
  return reqToPromise(t.objectStore('exercises').delete(id));
}
function getExercisesByWorkout(workoutId) {
  const t = tx('exercises');
  const idx = t.objectStore('exercises').index('workoutId');
  return reqToPromise(idx.getAll(workoutId));
}

// --- sets ---
function addSet(data) {
  const t = tx('sets', 'readwrite');
  return reqToPromise(t.objectStore('sets').add(data));
}
function updateSet(set) {
  const t = tx('sets', 'readwrite');
  return reqToPromise(t.objectStore('sets').put(set));
}
function deleteSet(id) {
  const t = tx('sets', 'readwrite');
  return reqToPromise(t.objectStore('sets').delete(id));
}
function getSetsByExercise(exerciseId) {
  const t = tx('sets');
  const idx = t.objectStore('sets').index('exerciseId');
  return reqToPromise(idx.getAll(exerciseId));
}
function deleteSetsByExercise(exerciseId) {
  return getSetsByExercise(exerciseId).then(sets =>
    Promise.all(sets.map(s => deleteSet(s.id)))
  );
}

// --- program items (checklist) ---
function addProgramItem(data) {
  const t = tx('programItems', 'readwrite');
  return reqToPromise(t.objectStore('programItems').add(data));
}
function deleteProgramItem(id) {
  const t = tx('programItems', 'readwrite');
  return reqToPromise(t.objectStore('programItems').delete(id));
}
function getProgramItemsByWeekday(weekday) {
  const t = tx('programItems');
  const idx = t.objectStore('programItems').index('weekday');
  return reqToPromise(idx.getAll(weekday));
}

// --- program checks (giorno per giorno) ---
function addCheck(data) {
  const t = tx('programChecks', 'readwrite');
  return reqToPromise(t.objectStore('programChecks').add(data));
}
function getChecksByDate(dateKey) {
  const t = tx('programChecks');
  const idx = t.objectStore('programChecks').index('dateKey');
  return reqToPromise(idx.getAll(dateKey));
}
function getChecksByItem(itemId) {
  const t = tx('programChecks');
  const idx = t.objectStore('programChecks').index('itemId');
  return reqToPromise(idx.getAll(itemId));
}
async function deleteCheckByItemAndDate(itemId, dateKey) {
  const checks = await getChecksByDate(dateKey);
  const match = checks.find(c => c.itemId === itemId);
  if (match) {
    const t = tx('programChecks', 'readwrite');
    await reqToPromise(t.objectStore('programChecks').delete(match.id));
  }
}
async function deleteChecksByItem(itemId) {
  const checks = await getChecksByItem(itemId);
  for (const c of checks) {
    const t = tx('programChecks', 'readwrite');
    await reqToPromise(t.objectStore('programChecks').delete(c.id));
  }
}

// ---------- App state ----------
let activeWorkoutId = null;
let timerInterval = null;
let chartOutsideClickHandler = null;
const view = document.getElementById('view');
const todayEl = document.getElementById('today');

const DAY_FMT = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
const TIME_FMT = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });

async function getKnownWorkoutTypes() {
  const all = await getAllWorkouts();
  const sorted = all
    .filter(w => w.type && w.type.trim())
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const seen = new Set();
  const ordered = [];
  for (const w of sorted) {
    const t = w.type.trim();
    if (!seen.has(t)) { seen.add(t); ordered.push(t); }
  }
  return ordered;
}

function formatDate(iso) {
  return DAY_FMT.format(new Date(iso));
}

function computeElapsedSeconds(w) {
  let total = w.elapsedSeconds || 0;
  if (w.running && w.runningSince) {
    total += (Date.now() - new Date(w.runningSince).getTime()) / 1000;
  }
  return total;
}

function formatElapsed(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatDuration(totalSeconds) {
  if (!totalSeconds) return null;
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s} sec`;
  return `${Math.round(s / 60)} min`;
}

function formatDurationShort(seconds) {
  const s = Math.round(seconds);
  if (Math.abs(s) < 60) return `${s} sec`;
  const m = Math.trunc(s / 60);
  const rem = String(Math.abs(s % 60)).padStart(2, '0');
  return `${m}:${rem} min`;
}

function formatSetSummary(s) {
  if (s.weight != null) return `${s.weight}kg × ${s.reps ?? '-'}`;
  if (s.reps != null) return `${s.reps} rip.`;
  if (s.duration != null) return formatDurationShort(s.duration);
  return '-';
}

async function findActiveWorkout() {
  const all = await getAllWorkouts();
  return all.find(w => !w.completed) || null;
}

// ---------- Views ----------
async function getKnownExerciseNames() {
  const all = await getAllWorkouts();
  const sorted = all.sort((a, b) => new Date(b.date) - new Date(a.date));
  const seen = new Set();
  const ordered = [];
  for (const w of sorted) {
    const exercises = await getExercisesByWorkout(w.id);
    exercises.sort((a, b) => a.order - b.order);
    for (const ex of exercises) {
      const name = (ex.name || '').trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        ordered.push(name);
      }
    }
  }
  return ordered;
}

async function renderHome() {
  const active = await findActiveWorkout();
  if (!active) {
    const all = await getAllWorkouts();
    const completed = all.filter(w => w.completed).sort((a, b) => new Date(b.date) - new Date(a.date));
    const last = completed[0];
    const knownTypes = await getKnownWorkoutTypes();
    view.innerHTML = `
      <div id="checklist-section"></div>
      <div class="empty">
        ${last ? `<div class="last">Ultimo allenamento: ${formatDate(last.date)}</div>` : ''}
        <p>Oggi comandi tu.<br>Scrivi la tipologia e inizia: il resto lo teniamo noi.</p>
        <input id="workout-type-input" class="type-input" list="type-suggestions" placeholder="Tipo di allenamento (es. Gambe)">
        <datalist id="type-suggestions">
          ${knownTypes.map(t => `<option value="${escapeHtml(t)}"></option>`).join('')}
        </datalist>
        ${knownTypes.length > 0 ? `
          <div class="type-chips">
            ${knownTypes.map(t => `<button type="button" class="type-chip" data-type="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
          </div>` : ''}
        <button class="btn btn-primary btn-block" id="start-workout">Inizia allenamento</button>
      </div>`;
    document.getElementById('start-workout').onclick = () => {
      const raw = document.getElementById('workout-type-input').value.trim();
      startWorkout(raw || 'Generico');
    };
    document.querySelectorAll('.type-chip').forEach(chip => {
      chip.onclick = () => {
        document.getElementById('workout-type-input').value = chip.dataset.type;
      };
    });
    await renderChecklistSection();
    return;
  }
  activeWorkoutId = active.id;
  const exercises = await getExercisesByWorkout(active.id);
  exercises.sort((a, b) => a.order - b.order);

  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

  const knownExercises = (await getKnownExerciseNames()).slice(0, 14);

  let html = `
    <div id="checklist-section"></div>
    <div class="session-header">
      <div class="session-info">
        <span class="session-type">${escapeHtml(active.type || 'Generico')}</span>
        <span class="session-time">iniziato alle ${TIME_FMT.format(new Date(active.date))}</span>
      </div>
      <div class="timer-block">
        <span class="timer-display" id="timer-display">${formatElapsed(computeElapsedSeconds(active))}</span>
        <button class="btn btn-ghost btn-small" id="timer-toggle">${active.running ? 'Pausa' : 'Riprendi'}</button>
      </div>
    </div>
    <div class="new-exercise">
      <input id="new-exercise-input" list="exercise-suggestions" placeholder="Aggiungi esercizio">
      <button class="btn btn-primary" id="add-exercise-btn">Aggiungi</button>
    </div>
    <datalist id="exercise-suggestions">
      ${knownExercises.map(n => `<option value="${escapeHtml(n)}"></option>`).join('')}
    </datalist>
    ${knownExercises.length > 0 ? `
      <div class="type-chips exercise-chips">
        ${knownExercises.map(n => `<button type="button" class="type-chip" data-exercise="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('')}
      </div>` : ''}
    <div id="exercise-list"></div>
    <div class="finish-bar">
      <button class="btn btn-ghost btn-block" id="cancel-workout">Annulla</button>
      <button class="btn btn-primary btn-block" id="finish-workout">Termina</button>
    </div>
  `;
  view.innerHTML = html;

  await renderChecklistSection();

  const list = document.getElementById('exercise-list');
  for (const ex of exercises) {
    list.appendChild(await renderExerciseCard(ex));
  }

  document.getElementById('add-exercise-btn').onclick = onAddExercise;
  document.getElementById('new-exercise-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onAddExercise();
  });
  document.querySelectorAll('.exercise-chips .type-chip').forEach(chip => {
    chip.onclick = () => {
      document.getElementById('new-exercise-input').value = chip.dataset.exercise;
    };
  });
  document.getElementById('cancel-workout').onclick = onCancelWorkout;
  document.getElementById('finish-workout').onclick = onFinishWorkout;
  document.getElementById('timer-toggle').onclick = onToggleTimer;

  if (active.running) {
    timerInterval = setInterval(() => {
      const el = document.getElementById('timer-display');
      if (el) el.textContent = formatElapsed(computeElapsedSeconds(active));
    }, 1000);
  }
}

async function renderExerciseCard(ex) {
  const sets = await getSetsByExercise(ex.id);
  sets.sort((a, b) => a.setNumber - b.setNumber);

  const card = document.createElement('div');
  card.className = 'exercise';
  card.dataset.exerciseId = ex.id;

  let setsHtml = sets.map(s => setRowHtml(s)).join('');

  card.innerHTML = `
    <div class="exercise-head">
      <span class="exercise-name">${escapeHtml(ex.name)}</span>
      <button class="exercise-remove" data-action="remove-exercise">rimuovi</button>
    </div>
    <div class="sets">${setsHtml}</div>
    <button class="add-set" data-action="add-set">+ serie</button>
  `;

  card.querySelector('[data-action="remove-exercise"]').onclick = () => onRemoveExercise(ex.id, card);
  card.querySelector('[data-action="add-set"]').onclick = () => onAddSet(ex.id, sets.length, card);

  card.querySelectorAll('.set-row').forEach(row => bindSetRow(row));

  return card;
}

function setRowHtml(s) {
  const timeStr = s.timestamp ? TIME_FMT.format(new Date(s.timestamp)) : '';
  return `
    <div class="set-row" data-set-id="${s.id}">
      <span class="set-index">${s.setNumber}</span>
      <div class="set-field">
        <label>kg</label>
        <input type="number" inputmode="decimal" step="0.5" class="set-weight" value="${s.weight ?? ''}">
      </div>
      <div class="set-field">
        <label>ripetizioni</label>
        <input type="number" inputmode="numeric" class="set-reps" value="${s.reps ?? ''}">
      </div>
      <div class="set-field set-field-narrow">
        <label>sec</label>
        <input type="number" inputmode="numeric" class="set-duration" value="${s.duration ?? ''}">
      </div>
      <span class="set-time">${timeStr}</span>
      <button class="set-delete" data-action="delete-set">&times;</button>
    </div>`;
}

function bindSetRow(row) {
  const setId = Number(row.dataset.setId);
  const weightInput = row.querySelector('.set-weight');
  const repsInput = row.querySelector('.set-reps');
  const durationInput = row.querySelector('.set-duration');
  const save = async () => {
    const now = new Date();
    await updateSet({
      id: setId,
      exerciseId: Number(row.closest('.exercise').dataset.exerciseId),
      setNumber: Number(row.querySelector('.set-index').textContent),
      weight: weightInput.value ? parseFloat(weightInput.value) : null,
      reps: repsInput.value ? parseInt(repsInput.value) : null,
      duration: durationInput.value ? parseInt(durationInput.value) : null,
      timestamp: now.toISOString(),
    });
    row.querySelector('.set-time').textContent = TIME_FMT.format(now);
  };
  weightInput.addEventListener('change', save);
  repsInput.addEventListener('change', save);
  durationInput.addEventListener('change', save);
  row.querySelector('[data-action="delete-set"]').onclick = async () => {
    await deleteSet(setId);
    row.remove();
  };
}

async function renderHistory() {
  const all = await getAllWorkouts();
  const completed = all.filter(w => w.completed).sort((a, b) => new Date(b.date) - new Date(a.date));

  if (completed.length === 0) {
    view.innerHTML = `<div class="empty"><p>Nessun allenamento completato ancora.</p></div>`;
    return;
  }

  const types = Array.from(new Set(completed.map(w => w.type || 'Generico'))).sort((a, b) => a.localeCompare(b));

  view.innerHTML = `
    ${types.length > 1 ? `
      <div class="history-filter">
        <select id="history-type-filter">
          <option value="all">Tutti i tipi</option>
          ${types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
        </select>
      </div>` : ''}
    <div id="history-list"></div>
  `;

  const listEl = document.getElementById('history-list');
  const filterEl = document.getElementById('history-type-filter');

  async function renderList(filterType) {
    listEl.innerHTML = '';
    const filtered = (filterType && filterType !== 'all')
      ? completed.filter(w => (w.type || 'Generico') === filterType)
      : completed;

    for (const w of filtered) {
      const exercises = await getExercisesByWorkout(w.id);
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <div class="history-item-head" data-action="toggle">
          <div class="history-main">
            <span class="history-date">${formatDate(w.date)}</span>
            <span class="history-time">${TIME_FMT.format(new Date(w.date))}</span>
          </div>
          <div class="history-head-right">
            <span class="history-count">${exercises.length} esercizi</span>
            <button class="history-delete" data-action="delete-workout" aria-label="Elimina allenamento">&times;</button>
          </div>
        </div>
        <span class="history-type-badge">${escapeHtml(w.type || 'Generico')}</span>
        ${formatDuration(w.duration) ? `<span class="history-duration">${formatDuration(w.duration)}</span>` : ''}
        <div class="history-detail"></div>
      `;
      item.querySelector('[data-action="delete-workout"]').onclick = async (e) => {
        e.stopPropagation();
        if (!confirm('Eliminare questo allenamento? Verranno cancellati tutti i dati inseriti, in modo definitivo.')) return;
        for (const ex of exercises) {
          await deleteSetsByExercise(ex.id);
          await deleteExercise(ex.id);
        }
        const t = tx('workouts', 'readwrite');
        await reqToPromise(t.objectStore('workouts').delete(w.id));
        renderHistory();
      };
      const detail = item.querySelector('.history-detail');
      item.querySelector('[data-action="toggle"]').onclick = async () => {
        const isOpen = detail.classList.toggle('is-open');
        if (isOpen && !detail.dataset.loaded) {
          let detailHtml = '';
          for (const ex of exercises) {
            const sets = await getSetsByExercise(ex.id);
            sets.sort((a, b) => a.setNumber - b.setNumber);
            const setsStr = sets.map(s => formatSetSummary(s)).join(' · ');
            detailHtml += `<div class="history-ex">
              <div class="history-ex-name">${escapeHtml(ex.name)}</div>
              <div class="history-ex-sets">${setsStr || 'nessuna serie'}</div>
            </div>`;
          }
          detail.innerHTML = detailHtml;
          detail.dataset.loaded = '1';
        }
      };
      listEl.appendChild(item);
    }
  }

  if (filterEl) filterEl.onchange = () => renderList(filterEl.value);
  renderList('all');
}

async function renderProgress() {
  const all = await getAllWorkouts();
  const completed = all.filter(w => w.completed).sort((a, b) => new Date(a.date) - new Date(b.date));

  if (completed.length === 0) {
    view.innerHTML = `<div class="empty"><p>Servono allenamenti completati per vedere l'andamento.</p></div>`;
    return;
  }

  // Aggrego per giorno: volume totale con peso, numero di serie a corpo libero
  // (ripetizioni, qualsiasi esercizio: stretching, core, mobilità, ecc.) e secondi totali isometrici
  const byDay = {};
  for (const w of completed) {
    const exercises = await getExercisesByWorkout(w.id);
    let weightedVolume = 0;
    let bodyweightSetsCount = 0;
    let isometricSeconds = 0;
    for (const ex of exercises) {
      const sets = await getSetsByExercise(ex.id);
      for (const s of sets) {
        if (s.weight != null && s.reps != null) {
          weightedVolume += s.weight * s.reps;
        } else if (s.reps != null) {
          bodyweightSetsCount += 1;
        } else if (s.duration != null) {
          isometricSeconds += s.duration;
        }
      }
    }
    if (weightedVolume === 0 && bodyweightSetsCount === 0 && isometricSeconds === 0) continue;
    const key = dayKey(new Date(w.date));
    byDay[key] ||= { date: w.date, weightedVolume: 0, bodyweightSetsCount: 0, isometricSeconds: 0 };
    byDay[key].weightedVolume += weightedVolume;
    byDay[key].bodyweightSetsCount += bodyweightSetsCount;
    byDay[key].isometricSeconds += isometricSeconds;
  }

  const days = Object.values(byDay).sort((a, b) => new Date(a.date) - new Date(b.date));
  if (days.length === 0) {
    view.innerHTML = `<div class="empty"><p>Nessuna serie con dati registrata ancora.</p></div>`;
    return;
  }

  view.innerHTML = `<div id="chart-container"></div>`;
  drawOverallChart(document.getElementById('chart-container'), days);
}

function drawOverallChart(container, days) {
  const pointSpacing = 56;
  const pad = { top: 26, right: 24, bottom: 34 };
  const chartHeight = 170;
  const width = Math.max(days.length * pointSpacing, 240) + pad.right;
  const totalHeight = pad.top + chartHeight + pad.bottom;
  const xForIndex = (i) => 24 + i * pointSpacing;

  // Colori tema Leone per i tooltip di confronto
  const TIP_SURFACE = '#2A1F17';
  const TIP_TEXT = '#F5EAD8';
  const TIP_TEXT_DIM = '#B8A488';
  const TIP_GREEN = '#6E8F5C';
  const TIP_RED = '#B84A2E';
  const TIP_NEUTRAL = '#F5EAD8';

  const weightedPoints = days.map((d, i) => ({ i, value: d.weightedVolume, date: d.date })).filter(p => p.value > 0);
  const bodyweightPoints = days.map((d, i) => ({ i, value: d.bodyweightSetsCount, date: d.date })).filter(p => p.value > 0);

  function buildSeries(points, color, labelFn, opts) {
    if (points.length === 0) return { pathD: '', dotsAndLabels: '', tooltips: '' };
    const { isWeighted, seriesId } = opts;
    const values = points.map(p => p.value);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const range = max - min || 1;
    const plotted = points.map((p, idx) => ({
      x: xForIndex(p.i),
      y: pad.top + (1 - (p.value - min) / range) * chartHeight,
      value: p.value,
      date: p.date,
      prevValue: idx > 0 ? points[idx - 1].value : null,
    }));
    const pathD = plotted.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

    let dotsAndLabels = '';
    let tooltips = '';
    plotted.forEach((p, idx) => {
      const tipId = `tip-${seriesId}-${idx}`;
      dotsAndLabels += `
        <circle cx="${p.x}" cy="${p.y}" r="4" fill="${color}"/>
        <text x="${p.x}" y="${p.y - 12}" text-anchor="middle" font-family="Fraunces, serif" font-size="12" fill="${color}">${labelFn(p.value)}</text>
        <circle class="chart-hit" data-tip-target="${tipId}" cx="${p.x}" cy="${p.y}" r="15" fill="transparent"/>
      `;

      let cmpColor = TIP_NEUTRAL;
      let cmpText = 'primo dato registrato';
      if (p.prevValue != null) {
        const rounded = Math.round(p.value - p.prevValue);
        const unit = isWeighted ? 'kg' : 'serie';
        if (rounded > 0) { cmpColor = TIP_GREEN; cmpText = `+${rounded} ${unit} rispetto a prima`; }
        else if (rounded < 0) { cmpColor = TIP_RED; cmpText = `${rounded} ${unit} rispetto a prima`; }
        else { cmpColor = TIP_NEUTRAL; cmpText = 'invariato rispetto a prima'; }
      }

      const valueLabel = isWeighted ? `${Math.round(p.value)} kg` : `${Math.round(p.value)} serie`;
      const tipW = 138;
      const tipH = isWeighted ? 78 : 62;
      let tipX = p.x - tipW / 2;
      tipX = Math.max(4, Math.min(tipX, width - tipW - 4));
      let tipY = p.y - tipH - 16;
      if (tipY < 0) tipY = p.y + 18;

      tooltips += `
        <g class="chart-tip" id="${tipId}" transform="translate(${tipX},${tipY})">
          <rect width="${tipW}" height="${tipH}" rx="8" fill="${TIP_SURFACE}" stroke="${cmpColor}" stroke-width="1.5"/>
          <text x="10" y="18" font-family="Inter, sans-serif" font-size="11" fill="${TIP_TEXT_DIM}">${shortDate(p.date)}</text>
          <text x="10" y="36" font-family="Fraunces, serif" font-weight="600" font-size="16" fill="${TIP_TEXT}">${valueLabel}</text>
          ${isWeighted ? `<text x="10" y="52" font-family="Inter, sans-serif" font-size="11" fill="${TIP_TEXT_DIM}">~${formatKcal(p.value)}</text>` : ''}
          <text x="10" y="${isWeighted ? 68 : 52}" font-family="Inter, sans-serif" font-size="11" fill="${cmpColor}">${cmpText}</text>
        </g>`;
    });

    return { pathD, dotsAndLabels, tooltips };
  }

  const weightedSeries = buildSeries(weightedPoints, '#D9A030', v => `${Math.round(v)}`, { isWeighted: true, seriesId: 'w' });
  const bodyweightSeries = buildSeries(bodyweightPoints, '#9C3F3F', v => `${Math.round(v)}`, { isWeighted: false, seriesId: 'b' });

  const dateLabels = days.map((d, i) => `
    <text x="${xForIndex(i)}" y="${pad.top + chartHeight + 20}" text-anchor="middle" font-family="Inter, sans-serif" font-size="11" fill="#B8A488">${shortDate(d.date)}</text>
  `).join('');

  let summaryHtml = '';
  if (weightedPoints.length > 0) {
    const first = weightedPoints[0].value;
    const last = weightedPoints[weightedPoints.length - 1].value;
    const delta = last - first;
    const deltaClass = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
    const deltaSign = delta > 0 ? '+' : '';
    summaryHtml += `
      <div class="chart-summary">
        <span class="chart-last">${Math.round(last)} kg</span>
        <span class="chart-kcal">~${formatKcal(last)} stimate</span>
        <span class="chart-delta ${deltaClass}">${deltaSign}${Math.round(delta)} kg di volume totale con peso dal primo allenamento registrato</span>
      </div>`;
  }
  if (bodyweightPoints.length > 0) {
    const first = bodyweightPoints[0].value;
    const last = bodyweightPoints[bodyweightPoints.length - 1].value;
    const delta = last - first;
    const deltaClass = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
    const deltaSign = delta > 0 ? '+' : '';
    summaryHtml += `
      <div class="chart-summary chart-summary-secondary">
        <span class="chart-last chart-last-alt">${Math.round(last)} serie</span>
        <span class="chart-delta ${deltaClass}">${deltaSign}${Math.round(delta)} serie a corpo libero dal primo allenamento registrato</span>
      </div>`;
  }

  container.innerHTML = `
    <div class="chart-legend">
      <span class="legend-item"><span class="legend-dot legend-dot-weighted"></span>Con peso (kg totali)</span>
      <span class="legend-item"><span class="legend-dot legend-dot-bodyweight"></span>A corpo libero (n. serie)</span>
    </div>
    ${summaryHtml}
    <p class="chart-hint-press">Tocca un pallino per i dettagli</p>
    <div class="chart-scroll">
      <svg width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">
        ${weightedSeries.pathD ? `<path d="${weightedSeries.pathD}" fill="none" stroke="#D9A030" stroke-width="2"/>` : ''}
        ${bodyweightSeries.pathD ? `<path d="${bodyweightSeries.pathD}" fill="none" stroke="#9C3F3F" stroke-width="2" stroke-dasharray="4 3"/>` : ''}
        ${weightedSeries.dotsAndLabels}
        ${bodyweightSeries.dotsAndLabels}
        ${dateLabels}
        ${weightedSeries.tooltips}
        ${bodyweightSeries.tooltips}
      </svg>
    </div>
  `;

  const hideAllTips = () => {
    container.querySelectorAll('.chart-tip.is-visible').forEach(t => t.classList.remove('is-visible'));
  };

  container.querySelectorAll('.chart-hit').forEach(hit => {
    const tip = container.querySelector('#' + CSS.escape(hit.dataset.tipTarget));
    if (!tip) return;
    hit.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasVisible = tip.classList.contains('is-visible');
      hideAllTips();
      if (!wasVisible) tip.classList.add('is-visible');
    });
  });

  if (chartOutsideClickHandler) {
    document.removeEventListener('click', chartOutsideClickHandler);
  }
  chartOutsideClickHandler = hideAllTips;
  document.addEventListener('click', chartOutsideClickHandler);
}

// Stima approssimata: ~0.1 kcal per kg di volume sollevato (peso × ripetizioni, sommato).
// È una stima empirica indicativa, non una misura metabolica precisa: non tiene conto
// di ampiezza del movimento, velocità, recupero tra le serie o caratteristiche personali.
const KCAL_PER_KG_VOLUME = 0.1;

function formatKcal(volumeKg) {
  return `${Math.round(volumeKg * KCAL_PER_KG_VOLUME)} kcal`;
}

function shortDate(iso) {
  return new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit' }).format(new Date(iso));
}

let calendarCursor = null; // { year, month } — month is 0-indexed

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthTitle(cursor) {
  const label = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(new Date(cursor.year, cursor.month, 1));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatKeyDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return DAY_FMT.format(new Date(y, m - 1, d));
}

async function renderCalendar() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  const now = new Date();
  if (!calendarCursor) calendarCursor = { year: now.getFullYear(), month: now.getMonth() };

  const all = await getAllWorkouts();
  const completed = all.filter(w => w.completed);
  const byDay = {};
  for (const w of completed) {
    const key = dayKey(new Date(w.date));
    (byDay[key] ||= []).push(w);
  }

  view.innerHTML = `
    <div class="cal-header">
      <button class="cal-nav" id="cal-prev">&lsaquo;</button>
      <span class="cal-title">${monthTitle(calendarCursor)}</span>
      <button class="cal-nav" id="cal-next">&rsaquo;</button>
    </div>
    <div class="cal-weekdays">
      <span>L</span><span>M</span><span>M</span><span>G</span><span>V</span><span>S</span><span>D</span>
    </div>
    <div class="cal-grid" id="cal-grid"></div>
    <div id="cal-detail"><p class="cal-hint">Tocca un giorno per vedere cosa hai fatto.</p></div>
  `;

  renderCalGrid(byDay);

  document.getElementById('cal-prev').onclick = () => {
    calendarCursor.month -= 1;
    if (calendarCursor.month < 0) { calendarCursor.month = 11; calendarCursor.year -= 1; }
    renderCalendar();
  };
  document.getElementById('cal-next').onclick = () => {
    calendarCursor.month += 1;
    if (calendarCursor.month > 11) { calendarCursor.month = 0; calendarCursor.year += 1; }
    renderCalendar();
  };
}

function renderCalGrid(byDay) {
  const grid = document.getElementById('cal-grid');
  const { year, month } = calendarCursor;
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let startOffset = firstDay.getDay() - 1;
  if (startOffset < 0) startOffset = 6;

  let cellsHtml = '';
  for (let i = 0; i < startOffset; i++) {
    cellsHtml += `<div class="cal-cell cal-empty"></div>`;
  }
  const todayKey = dayKey(new Date());
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const hasWorkout = !!byDay[key];
    const isToday = key === todayKey;
    cellsHtml += `
      <button class="cal-cell ${hasWorkout ? 'has-workout' : ''} ${isToday ? 'is-today' : ''}" data-day-key="${key}">
        <span class="cal-day-num">${day}</span>
        ${hasWorkout ? '<span class="cal-dot"></span>' : ''}
      </button>`;
  }
  grid.innerHTML = cellsHtml;

  grid.querySelectorAll('.cal-cell[data-day-key]').forEach(cell => {
    cell.addEventListener('click', () => {
      grid.querySelectorAll('.cal-cell').forEach(c => c.classList.remove('is-selected'));
      cell.classList.add('is-selected');
      showDayDetail(cell.dataset.dayKey, byDay[cell.dataset.dayKey] || []);
    });
  });
}

async function showDayDetail(key, workouts) {
  const detail = document.getElementById('cal-detail');
  if (workouts.length === 0) {
    detail.innerHTML = `<p class="cal-hint">Nessun allenamento il ${formatKeyDate(key)}.</p>`;
    return;
  }
  let html = '';
  for (const w of workouts) {
    const exercises = await getExercisesByWorkout(w.id);
    let exHtml = '';
    for (const ex of exercises) {
      const sets = await getSetsByExercise(ex.id);
      sets.sort((a, b) => a.setNumber - b.setNumber);
      const setsStr = sets.map(s => formatSetSummary(s)).join(' · ');
      exHtml += `<div class="history-ex">
        <div class="history-ex-name">${escapeHtml(ex.name)}</div>
        <div class="history-ex-sets">${setsStr || 'nessuna serie'}</div>
      </div>`;
    }
    html += `
      <div class="cal-day-workout">
        <div class="cal-day-workout-head">
          <span class="session-type">${escapeHtml(w.type || 'Generico')}</span>
          <span class="session-time">${TIME_FMT.format(new Date(w.date))}${formatDuration(w.duration) ? ' · ' + formatDuration(w.duration) : ''}</span>
        </div>
        ${exHtml || '<p class="cal-hint">Nessun esercizio registrato.</p>'}
      </div>`;
  }
  detail.innerHTML = html;
}

const WEEKDAY_LABELS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];

function todayWeekday() {
  return (new Date().getDay() + 6) % 7; // Lunedì = 0 ... Domenica = 6
}

let checklistEditorDay = null;

async function renderChecklistSection() {
  const container = document.getElementById('checklist-section');
  if (!container) return;

  const weekday = todayWeekday();
  const items = await getProgramItemsByWeekday(weekday);
  items.sort((a, b) => a.order - b.order);
  const key = dayKey(new Date());
  const checks = await getChecksByDate(key);
  const checkedIds = new Set(checks.map(c => c.itemId));
  const doneCount = items.filter(it => checkedIds.has(it.id)).length;

  const itemsHtml = items.length > 0
    ? items.map(it => `
        <label class="checklist-item ${checkedIds.has(it.id) ? 'is-checked' : ''}">
          <input type="checkbox" data-item-id="${it.id}" ${checkedIds.has(it.id) ? 'checked' : ''}>
          <span>${escapeHtml(it.text)}</span>
        </label>`).join('')
    : `<p class="cal-hint">Nessuna voce nel programma di oggi.</p>`;

  container.innerHTML = `
    <div class="checklist-card">
      <div class="checklist-head">
        <span class="checklist-title">Programma di oggi</span>
        <button class="checklist-edit" id="checklist-edit-btn">Modifica</button>
      </div>
      ${items.length > 0 ? `<span class="checklist-count">${doneCount}/${items.length} completati</span>` : ''}
      ${itemsHtml}
    </div>`;

  document.getElementById('checklist-edit-btn').onclick = () => renderChecklistEditor();

  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const itemId = Number(cb.dataset.itemId);
      if (cb.checked) {
        await addCheck({ itemId, dateKey: key, checkedAt: new Date().toISOString() });
      } else {
        await deleteCheckByItemAndDate(itemId, key);
      }
      renderChecklistSection();
    });
  });
}

async function renderChecklistEditor() {
  const container = document.getElementById('checklist-section');
  if (!container) return;
  if (checklistEditorDay === null) checklistEditorDay = todayWeekday();

  const items = await getProgramItemsByWeekday(checklistEditorDay);
  items.sort((a, b) => a.order - b.order);

  container.innerHTML = `
    <div class="checklist-card">
      <div class="checklist-head">
        <span class="checklist-title">Modifica programma</span>
        <button class="checklist-edit" id="checklist-done-btn">Fatto</button>
      </div>
      <div class="checklist-daytabs">
        ${WEEKDAY_LABELS.map((label, i) => `<button class="checklist-daytab ${i === checklistEditorDay ? 'is-active' : ''}" data-weekday="${i}">${label}</button>`).join('')}
      </div>
      <div class="checklist-edit-list">
        ${items.length > 0
          ? items.map(it => `
              <div class="checklist-edit-item">
                <span>${escapeHtml(it.text)}</span>
                <button class="checklist-item-remove" data-item-id="${it.id}">&times;</button>
              </div>`).join('')
          : `<p class="cal-hint">Nessuna voce per questo giorno.</p>`}
      </div>
      <div class="checklist-add">
        <input id="checklist-new-item" placeholder="Aggiungi voce">
        <button class="btn btn-primary btn-small" id="checklist-add-btn">Aggiungi</button>
      </div>
    </div>`;

  document.getElementById('checklist-done-btn').onclick = () => {
    checklistEditorDay = null;
    renderChecklistSection();
  };
  container.querySelectorAll('.checklist-daytab').forEach(btn => {
    btn.onclick = () => {
      checklistEditorDay = Number(btn.dataset.weekday);
      renderChecklistEditor();
    };
  });
  container.querySelectorAll('.checklist-item-remove').forEach(btn => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.itemId);
      await deleteChecksByItem(id);
      await deleteProgramItem(id);
      renderChecklistEditor();
    };
  });
  const addNewItem = async () => {
    const input = document.getElementById('checklist-new-item');
    const text = input.value.trim();
    if (!text) return;
    const existing = await getProgramItemsByWeekday(checklistEditorDay);
    await addProgramItem({ weekday: checklistEditorDay, text, order: existing.length });
    input.value = '';
    renderChecklistEditor();
  };
  document.getElementById('checklist-add-btn').onclick = addNewItem;
  document.getElementById('checklist-new-item').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addNewItem();
  });
}

// ---------- Actions ----------
async function startWorkout(type) {
  const now = new Date().toISOString();
  const id = await addWorkout({
    date: now,
    type,
    completed: false,
    elapsedSeconds: 0,
    running: true,
    runningSince: now,
  });
  activeWorkoutId = id;
  renderHome();
}

async function onToggleTimer() {
  const w = await getWorkout(activeWorkoutId);
  if (w.running) {
    const delta = (Date.now() - new Date(w.runningSince).getTime()) / 1000;
    w.elapsedSeconds = (w.elapsedSeconds || 0) + delta;
    w.running = false;
    w.runningSince = null;
  } else {
    w.running = true;
    w.runningSince = new Date().toISOString();
  }
  await updateWorkout(w);
  renderHome();
}

async function onAddExercise() {
  const input = document.getElementById('new-exercise-input');
  const name = input.value.trim();
  if (!name) return;
  const existing = await getExercisesByWorkout(activeWorkoutId);
  await addExercise({ workoutId: activeWorkoutId, name, order: existing.length });
  input.value = '';
  renderHome();
}

async function onRemoveExercise(exerciseId, cardEl) {
  await deleteSetsByExercise(exerciseId);
  await deleteExercise(exerciseId);
  cardEl.remove();
}

async function onAddSet(exerciseId, currentCount, cardEl) {
  const setNumber = currentCount + 1;
  const timestamp = new Date().toISOString();
  const id = await addSet({ exerciseId, setNumber, weight: null, reps: null, duration: null, timestamp });
  const setsContainer = cardEl.querySelector('.sets');
  const wrapper = document.createElement('div');
  wrapper.innerHTML = setRowHtml({ id, setNumber, weight: '', reps: '', duration: '', timestamp });
  const row = wrapper.firstElementChild;
  setsContainer.appendChild(row);
  bindSetRow(row);
  cardEl.querySelector('[data-action="add-set"]').onclick = () => onAddSet(exerciseId, setNumber, cardEl);
}

async function onCancelWorkout() {
  if (!confirm('Annullare questo allenamento? Verranno eliminati tutti i dati inseriti.')) return;
  const exercises = await getExercisesByWorkout(activeWorkoutId);
  for (const ex of exercises) {
    await deleteSetsByExercise(ex.id);
    await deleteExercise(ex.id);
  }
  const t = tx('workouts', 'readwrite');
  await reqToPromise(t.objectStore('workouts').delete(activeWorkoutId));
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  activeWorkoutId = null;
  renderHome();
}

async function onFinishWorkout() {
  const w = await getWorkout(activeWorkoutId);
  if (w.running && w.runningSince) {
    const delta = (Date.now() - new Date(w.runningSince).getTime()) / 1000;
    w.elapsedSeconds = (w.elapsedSeconds || 0) + delta;
  }
  w.running = false;
  w.runningSince = null;
  w.completed = true;
  w.duration = Math.round(w.elapsedSeconds || 0);
  await updateWorkout(w);
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  activeWorkoutId = null;
  renderHome();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Navigation ----------
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    if (chartOutsideClickHandler) {
      document.removeEventListener('click', chartOutsideClickHandler);
      chartOutsideClickHandler = null;
    }
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
    tab.classList.add('is-active');
    if (tab.dataset.view === 'home') renderHome();
    else if (tab.dataset.view === 'progress') renderProgress();
    else if (tab.dataset.view === 'calendar') renderCalendar();
    else renderHistory();
  });
});

// ---------- Init ----------
(async function init() {
  todayEl.textContent = formatDate(new Date().toISOString());
  await openDB();
  await renderHome();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
})();
