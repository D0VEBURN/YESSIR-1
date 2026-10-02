(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const midiKeys = ['a','w','s','e','d','f','t','g','y','h','u','j','k','o','l','p'];

  const state = {
    ctx: null,
    buffer: null,
    reverseBuffer: null,
    fileName: '',
    playing: false,
    frozen: false,
    mode: 'hold',
    sync: true,
    cells: 16,
    currentCell: 0,
    stepClock: 16,
    shape: 'hann',
    interval: null,
    stepTimer: null,
    animation: null,
    lastSpawn: 0,
    heldCells: new Set(),
    cellMap: [],
    cellEnabled: [],
    recordChunks: [],
    recorder: null,
    recording: false,
    reverseLock: false,
    microStutter: false,
    freezeAnchor: 0,
    stutterAnchor: null,
    params: {
      grainRate: 20,
      grainLength: 220,
      position: 25,
      space: 65,
      chaos: 10,
      tune: 0,
      output: -6,
      spray: 8,
      pitchJitter: 0.4,
      reverseChance: 8,
      stutterChance: 0,
      crush: 0,
      reverb: 18,
    }
  };

  const els = {
    fileInput: $('fileInput'), loadBtn: $('loadBtn'), dropZone: $('dropZone'),
    waveform: $('waveform'), fileName: $('fileName'), statusText: $('statusText'),
    playBtn: $('playBtn'), stopBtn: $('stopBtn'), freezeBtn: $('freezeBtn'),
    bpm: $('bpm'), timeText: $('timeText'), durationText: $('durationText'),
    playhead: $('playhead'), positionMarker: $('positionMarker'), sliceOverlay: $('sliceOverlay'),
    modeSwitch: $('modeSwitch'), syncBtn: $('syncBtn'), freeBtn: $('freeBtn'), cellsBtn: $('cellsBtn'),
    clockSelect: $('clockSelect'), resetCellsBtn: $('resetCellsBtn'), cellRow: $('cellRow'), cellHelp: $('cellHelp'),
    shapeButtons: $('shapeButtons'), shapeCanvas: $('shapeCanvas'),
    microStutterBtn: $('microStutterBtn'), reverseLockBtn: $('reverseLockBtn'), randomizeBtn: $('randomizeBtn'),
    presetGrid: $('presetGrid'), presetName: $('presetName'), keyboardHint: $('keyboardHint'),
    recordBtn: $('recordBtn'), downloadLink: $('downloadLink')
  };

  function initAudio() {
    if (state.ctx) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    state.ctx = new AudioContext();

    state.inputBus = state.ctx.createGain();
    state.dryBus = state.ctx.createGain();
    state.wetBus = state.ctx.createGain();
    state.filter = state.ctx.createBiquadFilter();
    state.filter.type = 'lowpass';
    state.filter.frequency.value = 19000;

    state.delay = state.ctx.createDelay(2.0);
    state.delay.delayTime.value = 0.17;
    state.delayFeedback = state.ctx.createGain();
    state.delayFeedback.gain.value = 0.18;
    state.delayWet = state.ctx.createGain();
    state.delayWet.gain.value = 0.10;

    state.convolver = state.ctx.createConvolver();
    state.convolver.buffer = makeImpulse(state.ctx, 2.6, 2.2);
    state.reverbWet = state.ctx.createGain();

    state.shaper = state.ctx.createWaveShaper();
    state.shaper.oversample = '2x';
    state.master = state.ctx.createGain();

    state.inputBus.connect(state.filter);
    state.filter.connect(state.dryBus);
    state.filter.connect(state.delay);
    state.delay.connect(state.delayWet);
    state.delay.connect(state.delayFeedback);
    state.delayFeedback.connect(state.delay);
    state.filter.connect(state.convolver);
    state.convolver.connect(state.reverbWet);

    state.dryBus.connect(state.shaper);
    state.delayWet.connect(state.shaper);
    state.reverbWet.connect(state.shaper);
    state.shaper.connect(state.master);
    state.master.connect(state.ctx.destination);

    state.recordDest = state.ctx.createMediaStreamDestination();
    state.master.connect(state.recordDest);

    updateFx();
  }

  function makeImpulse(ctx, seconds, decay) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return buffer;
  }

  function dbToGain(db) { return Math.pow(10, db / 20); }

  function updateFx() {
    if (!state.ctx) return;
    const chaos = state.params.chaos / 100;
    const rev = clamp((state.params.reverb / 100) + chaos * 0.55, 0, 1);
    state.reverbWet.gain.setTargetAtTime(rev * 0.62, state.ctx.currentTime, 0.02);
    state.delayWet.gain.setTargetAtTime((0.06 + chaos * 0.22), state.ctx.currentTime, 0.02);
    state.delayFeedback.gain.setTargetAtTime(0.12 + chaos * 0.52, state.ctx.currentTime, 0.02);
    state.filter.frequency.setTargetAtTime(lerp(19500, 5800, state.params.crush / 100), state.ctx.currentTime, 0.02);
    state.master.gain.setTargetAtTime(dbToGain(state.params.output), state.ctx.currentTime, 0.02);
    state.shaper.curve = makeCrushCurve(state.params.crush);
  }

  function makeCrushCurve(amount) {
    const n = 2048;
    const curve = new Float32Array(n);
    const mix = amount / 100;
    const steps = Math.max(4, Math.round(128 - mix * 118));
    const drive = 1 + mix * 4;
    for (let i = 0; i < n; i++) {
      let x = i * 2 / (n - 1) - 1;
      x = Math.tanh(x * drive);
      const q = Math.round(x * steps) / steps;
      curve[i] = x * (1 - mix) + q * mix;
    }
    return curve;
  }

  async function loadFile(file) {
    if (!file) return;
    initAudio();
    if (state.ctx.state === 'suspended') await state.ctx.resume();
    els.statusText.textContent = 'DECODING';
    try {
      const bytes = await file.arrayBuffer();
      const buf = await state.ctx.decodeAudioData(bytes.slice(0));
      state.buffer = buf;
      state.reverseBuffer = reverseAudioBuffer(buf);
      state.fileName = file.name;
      state.currentCell = 0;
      state.params.position = 25;
      setKnobValue('position', 25, true);
      initCells();
      drawWaveform();
      drawSliceOverlay();
      updatePositionMarker();
      els.fileName.textContent = file.name.toUpperCase();
      els.statusText.textContent = `${buf.numberOfChannels}CH / ${Math.round(buf.sampleRate / 1000)}K`;
      els.durationText.textContent = formatTime(buf.duration);
      els.playBtn.disabled = false;
      els.stopBtn.disabled = false;
      els.recordBtn.disabled = false;
    } catch (err) {
      console.error(err);
      els.statusText.textContent = 'LOAD ERROR';
      alert('Could not decode that audio file. Try MP3, WAV, FLAC or OGG supported by your browser.');
    }
  }

  function reverseAudioBuffer(src) {
    const out = state.ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
    for (let c = 0; c < src.numberOfChannels; c++) {
      const s = src.getChannelData(c);
      const d = out.getChannelData(c);
      for (let i = 0, j = s.length - 1; i < s.length; i++, j--) d[i] = s[j];
    }
    return out;
  }

  function start() {
    if (!state.buffer) return;
    initAudio();
    if (state.ctx.state === 'suspended') state.ctx.resume();
    state.playing = true;
    state.lastSpawn = performance.now();
    els.playBtn.classList.add('active');
    els.statusText.textContent = state.mode.toUpperCase();
    startSchedulers();
    animate();
  }

  function stop() {
    state.playing = false;
    state.heldCells.clear();
    if (state.interval) clearInterval(state.interval);
    if (state.stepTimer) clearInterval(state.stepTimer);
    state.interval = null;
    state.stepTimer = null;
    cancelAnimationFrame(state.animation);
    els.playBtn.classList.remove('active');
    clearCurrentCells();
    els.playhead.style.left = '0%';
    if (state.buffer) els.statusText.textContent = 'READY';
  }

  function startSchedulers() {
    if (state.interval) clearInterval(state.interval);
    if (state.stepTimer) clearInterval(state.stepTimer);
    state.interval = setInterval(scheduleTick, 12);
    if (state.mode === 'step') restartStepTimer();
  }

  function restartStepTimer() {
    if (state.stepTimer) clearInterval(state.stepTimer);
    if (!state.playing || state.mode !== 'step') return;
    const bpm = clamp(parseFloat(els.bpm.value) || 138, 40, 240);
    const div = parseInt(els.clockSelect.value, 10) || 16;
    const quarterMs = 60000 / bpm;
    const stepMs = quarterMs * (4 / div);
    state.stepTimer = setInterval(() => advanceStep(), stepMs);
  }

  function advanceStep() {
    if (!state.cellEnabled.length) return;
    let tries = 0;
    do {
      state.currentCell = (state.currentCell + 1) % state.cells;
      tries++;
    } while (!state.cellEnabled[state.currentCell] && tries <= state.cells);
    highlightCell(state.currentCell);
  }

  function scheduleTick() {
    if (!state.playing || !state.buffer) return;
    if (state.mode === 'keys' && state.heldCells.size === 0) return;

    const now = performance.now();
    const rate = getGrainRate();
    const intervalMs = 1000 / Math.max(0.5, rate);
    if (now - state.lastSpawn >= intervalMs) {
      const overdue = Math.min(4, Math.floor((now - state.lastSpawn) / intervalMs));
      for (let i = 0; i < Math.max(1, overdue); i++) spawnGrain();
      state.lastSpawn = now;
    }
  }

  function getGrainRate() {
    if (!state.sync) return state.params.grainRate;
    const bpm = clamp(parseFloat(els.bpm.value) || 138, 40, 240);
    const divisions = [2,4,6,8,12,16,24,32];
    const idx = Math.round((state.params.grainRate - 1) / 59 * (divisions.length - 1));
    const div = divisions[clamp(idx,0,divisions.length-1)];
    return (bpm / 60) * (div / 4);
  }

  function getBasePosition() {
    if (!state.buffer) return 0;
    let norm = state.params.position / 100;
    if (state.mode === 'step') {
      const mapped = state.cellMap[state.currentCell] ?? state.currentCell;
      norm = (mapped + 0.5) / state.cells;
    } else if (state.mode === 'keys' && state.heldCells.size) {
      const held = Array.from(state.heldCells);
      const idx = held[Math.floor(Math.random() * held.length)];
      const mapped = state.cellMap[idx] ?? idx;
      norm = (mapped + 0.5) / state.cells;
    }
    if (state.frozen) norm = state.freezeAnchor;
    return clamp(norm, 0, 1);
  }

  function spawnGrain() {
    if (!state.buffer || !state.ctx) return;
    const ctx = state.ctx;
    const dur = clamp(state.params.grainLength / 1000, 0.01, 1.0);
    const chaos = state.params.chaos / 100;
    const sprayNorm = (state.params.spray / 100) * 0.22 + chaos * 0.08;

    let baseNorm = getBasePosition();
    if (state.microStutter || Math.random() < state.params.stutterChance / 100) {
      if (state.stutterAnchor == null || Math.random() < 0.08) state.stutterAnchor = baseNorm;
      baseNorm = state.stutterAnchor + rand(-0.004, 0.004);
    } else if (!state.frozen) {
      state.stutterAnchor = null;
    }

    let norm = clamp(baseNorm + rand(-sprayNorm, sprayNorm), 0, 1);
    const reverse = state.reverseLock || Math.random() < state.params.reverseChance / 100;
    const buf = reverse ? state.reverseBuffer : state.buffer;
    let offset = norm * Math.max(0, buf.duration - dur);
    if (reverse) offset = (1 - norm) * Math.max(0, buf.duration - dur);

    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.buffer = buf;

    const tune = state.params.tune + rand(-state.params.pitchJitter, state.params.pitchJitter) + rand(-chaos * 2.4, chaos * 2.4);
    src.playbackRate.value = Math.pow(2, tune / 12);

    const born = ctx.currentTime + 0.01;
    applyEnvelope(gain.gain, born, dur, state.shape);
    const panAmount = state.params.space / 100;
    if (pan) pan.pan.value = rand(-panAmount, panAmount);

    src.connect(gain);
    if (pan) { gain.connect(pan); pan.connect(state.inputBus); }
    else gain.connect(state.inputBus);

    try {
      src.start(born, offset, Math.min(dur * src.playbackRate.value + 0.03, Math.max(0.02, buf.duration - offset)));
      src.stop(born + dur + 0.08);
    } catch (_) {}
  }

  function applyEnvelope(param, start, dur, shape) {
    const end = start + dur;
    const eps = 0.0001;
    param.cancelScheduledValues(start);
    if (shape === 'square') {
      param.setValueAtTime(0.0001, start);
      param.linearRampToValueAtTime(0.8, start + Math.min(.004, dur*.05));
      param.setValueAtTime(0.8, Math.max(start + .004, end - .005));
      param.linearRampToValueAtTime(0.0001, end);
      return;
    }
    if (shape === 'triangle') {
      param.setValueAtTime(eps, start);
      param.linearRampToValueAtTime(0.86, start + dur * 0.5);
      param.linearRampToValueAtTime(eps, end);
      return;
    }
    if (shape === 'gaussian') {
      param.setValueAtTime(eps, start);
      param.exponentialRampToValueAtTime(0.18, start + dur*.18);
      param.exponentialRampToValueAtTime(0.92, start + dur*.48);
      param.exponentialRampToValueAtTime(0.18, start + dur*.82);
      param.exponentialRampToValueAtTime(eps, end);
      return;
    }
    // Hann-ish approximation
    param.setValueAtTime(eps, start);
    param.linearRampToValueAtTime(0.35, start + dur*.18);
    param.linearRampToValueAtTime(0.92, start + dur*.5);
    param.linearRampToValueAtTime(0.35, start + dur*.82);
    param.linearRampToValueAtTime(eps, end);
  }

  function initCells() {
    state.cellMap = Array.from({length: state.cells}, (_, i) => i);
    state.cellEnabled = Array.from({length: state.cells}, () => true);
    renderCells();
  }

  function renderCells() {
    els.cellRow.innerHTML = '';
    els.cellRow.style.gridTemplateColumns = `repeat(${state.cells}, minmax(0,1fr))`;
    for (let i = 0; i < state.cells; i++) {
      const b = document.createElement('button');
      b.className = 'cell';
      b.dataset.index = i;
      b.textContent = state.mode === 'keys' ? keyLabel(i) : String(i + 1).padStart(2,'0');
      if (!state.cellEnabled[i]) b.classList.add('off');
      b.addEventListener('click', (e) => {
        if (e.shiftKey) {
          state.cellEnabled[i] = !state.cellEnabled[i];
          renderCells();
          return;
        }
        if (state.mode === 'hold') {
          state.params.position = ((state.cellMap[i] + 0.5) / state.cells) * 100;
          setKnobValue('position', state.params.position, true);
          return;
        }
        state.currentCell = i;
        highlightCell(i);
        if (state.mode === 'keys') {
          state.heldCells.add(i);
          if (!state.playing) start();
          setTimeout(() => state.heldCells.delete(i), 240);
        }
      });
      b.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 1 : -1;
        state.cellMap[i] = (state.cellMap[i] + delta + state.cells) % state.cells;
        b.textContent = `${String(i+1).padStart(2,'0')}→${String(state.cellMap[i]+1).padStart(2,'0')}`;
      }, {passive:false});
      els.cellRow.appendChild(b);
    }
    drawSliceOverlay();
  }

  function keyLabel(i) {
    const key = midiKeys[i] || String(i + 1);
    return key.toUpperCase();
  }

  function highlightCell(i) {
    els.cellRow.querySelectorAll('.cell').forEach((el, idx) => el.classList.toggle('current', idx === i));
    els.sliceOverlay.querySelectorAll('.slice-line').forEach((el, idx) => el.classList.toggle('active', idx === i));
  }

  function clearCurrentCells() {
    els.cellRow.querySelectorAll('.cell').forEach(el => el.classList.remove('current'));
    els.sliceOverlay.querySelectorAll('.slice-line').forEach(el => el.classList.remove('active'));
  }

  function drawSliceOverlay() {
    els.sliceOverlay.innerHTML = '';
    for (let i = 0; i < state.cells; i++) {
      const line = document.createElement('div');
      line.className = 'slice-line';
      line.style.left = `${i / state.cells * 100}%`;
      line.style.width = `${100 / state.cells}%`;
      els.sliceOverlay.appendChild(line);
    }
  }

  function setMode(mode) {
    state.mode = mode;
    els.modeSwitch.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    if (mode === 'hold') els.cellHelp.textContent = 'HOLD mode: drag POSITION or click the waveform to scan the file.';
    if (mode === 'step') els.cellHelp.textContent = 'STEP mode: the internal clock walks through the cells. Shift-click a cell to mute it; mouse wheel remaps its slice.';
    if (mode === 'keys') els.cellHelp.textContent = 'KEYS mode: A W S E D F T G Y H U J K O L P trigger slices. Mouse works too.';
    renderCells();
    if (state.playing) startSchedulers();
  }

  function animate() {
    if (!state.playing) return;
    const base = getBasePosition();
    els.playhead.style.left = `${base * 100}%`;
    els.timeText.textContent = state.buffer ? formatTime(base * state.buffer.duration) : '00:00.000';
    if (state.mode === 'step') highlightCell(state.currentCell);
    state.animation = requestAnimationFrame(animate);
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec)) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec - Math.floor(sec)) * 1000);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
  }

  function drawWaveform() {
    const c = els.waveform;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = '#0c0c0c'; ctx.fillRect(0,0,w,h);
    ctx.strokeStyle = '#202020'; ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) { const y = h * i / 6; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
    if (!state.buffer) return;
    const data = state.buffer.getChannelData(0);
    const mid = h * .54;
    const amp = h * .23;
    const samplesPerPx = Math.max(1, Math.floor(data.length / w));
    ctx.strokeStyle = '#d8d8d4'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const start = x * samplesPerPx;
      let lo = 1, hi = -1;
      for (let j = 0; j < samplesPerPx; j += Math.max(1, Math.floor(samplesPerPx / 12))) {
        const v = data[start + j] || 0; if (v < lo) lo = v; if (v > hi) hi = v;
      }
      ctx.moveTo(x, mid + lo * amp); ctx.lineTo(x, mid + hi * amp);
    }
    ctx.stroke();

    // mirrored quieter overview below, inspired by hardware samplers
    ctx.globalAlpha = .55;
    ctx.strokeStyle = '#b0b0ad';
    const mid2 = h * .84, amp2 = h * .09;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const start = x * samplesPerPx;
      let lo = 1, hi = -1;
      for (let j = 0; j < samplesPerPx; j += Math.max(1, Math.floor(samplesPerPx / 10))) {
        const v = data[start + j] || 0; if (v < lo) lo = v; if (v > hi) hi = v;
      }
      ctx.moveTo(x, mid2 + lo * amp2); ctx.lineTo(x, mid2 + hi * amp2);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
  }

  function drawShape() {
    const c = els.shapeCanvas;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = '#d7d1c5'; ctx.fillRect(0,0,w,h);
    ctx.strokeStyle = '#a59e92'; ctx.lineWidth = 1;
    ctx.strokeRect(14,14,w-28,h-28);
    ctx.strokeStyle = '#5f5b54'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 20; x <= w - 20; x++) {
      const t = (x - 20) / (w - 40);
      let y;
      if (state.shape === 'square') y = t < .04 || t > .96 ? 0.03 : .92;
      else if (state.shape === 'triangle') y = 1 - Math.abs(t * 2 - 1);
      else if (state.shape === 'gaussian') y = Math.exp(-Math.pow((t - .5) / .20, 2));
      else y = .5 - .5 * Math.cos(2 * Math.PI * t);
      const py = h - 18 - y * (h - 40);
      if (x === 20) ctx.moveTo(x, py); else ctx.lineTo(x, py);
    }
    ctx.stroke();
  }

  function updatePositionMarker() {
    els.positionMarker.style.left = `${state.params.position}%`;
  }

  function createKnobs() {
    document.querySelectorAll('.knob-control').forEach(ctrl => {
      const param = ctrl.dataset.param;
      const min = parseFloat(ctrl.dataset.min);
      const max = parseFloat(ctrl.dataset.max);
      const step = parseFloat(ctrl.dataset.step || '1');
      const value = parseFloat(ctrl.dataset.value);
      state.params[param] = value;

      const knob = document.createElement('div');
      knob.className = 'knob' + (ctrl.classList.contains('big') ? ' big' : '') + (ctrl.classList.contains('mini') ? ' mini' : '');
      const label = document.createElement('div'); label.className = 'knob-label'; label.textContent = ctrl.dataset.label || param;
      const readout = document.createElement('div'); readout.className = 'knob-value';
      ctrl.innerHTML = ''; ctrl.append(knob,label,readout);
      ctrl._knob = knob; ctrl._readout = readout; ctrl._min = min; ctrl._max = max; ctrl._step = step;

      let dragY = 0, dragStart = value;
      knob.addEventListener('pointerdown', e => { dragY = e.clientY; dragStart = state.params[param]; knob.setPointerCapture(e.pointerId); });
      knob.addEventListener('pointermove', e => {
        if (!knob.hasPointerCapture(e.pointerId)) return;
        const sensitivity = (max - min) / 180;
        const v = quantize(clamp(dragStart + (dragY - e.clientY) * sensitivity, min, max), step);
        setKnobValue(param, v, true);
      });
      knob.addEventListener('wheel', e => { e.preventDefault(); setKnobValue(param, clamp(state.params[param] + (e.deltaY < 0 ? step : -step), min, max), true); }, {passive:false});
      knob.addEventListener('dblclick', () => setKnobValue(param, value, true));
      updateKnobUI(ctrl, value);
    });
  }

  function quantize(v, step) { return Math.round(v / step) * step; }

  function setKnobValue(param, value, trigger = false) {
    state.params[param] = value;
    const ctrl = document.querySelector(`.knob-control[data-param="${param}"]`);
    if (ctrl) updateKnobUI(ctrl, value);
    if (param === 'position') updatePositionMarker();
    if (['output','chaos','crush','reverb'].includes(param)) updateFx();
    if (trigger && param === 'grainRate' && state.playing) state.lastSpawn = performance.now();
  }

  function updateKnobUI(ctrl, value) {
    const min = ctrl._min ?? parseFloat(ctrl.dataset.min);
    const max = ctrl._max ?? parseFloat(ctrl.dataset.max);
    const norm = (value - min) / (max - min);
    const angle = -135 + norm * 270;
    if (ctrl._knob) ctrl._knob.style.setProperty('--angle', `${angle}deg`);
    const unit = ctrl.dataset.unit || '';
    const decimals = (ctrl._step ?? parseFloat(ctrl.dataset.step || '1')) < 1 ? 1 : 0;
    if (ctrl._readout) ctrl._readout.textContent = `${Number(value).toFixed(decimals)}${unit}`;
  }

  function applyPreset(name) {
    const presets = {
      ambientPad: {mode:'hold', grainRate:18, grainLength:620, position:34, space:82, chaos:22, tune:0, spray:6, pitchJitter:.25, reverseChance:6, stutterChance:0, crush:0, reverb:38, shape:'hann'},
      rhythmicStutter: {mode:'step', grainRate:28, grainLength:82, position:24, space:34, chaos:8, tune:0, spray:3, pitchJitter:.1, reverseChance:8, stutterChance:62, crush:12, reverb:8, shape:'square'},
      playableSlices: {mode:'keys', grainRate:22, grainLength:190, position:20, space:32, chaos:4, tune:0, spray:1, pitchJitter:0, reverseChance:0, stutterChance:0, crush:0, reverb:10, shape:'hann'},
      frozenDrone: {mode:'hold', grainRate:34, grainLength:760, position:52, space:90, chaos:45, tune:-12, spray:2, pitchJitter:.8, reverseChance:18, stutterChance:0, crush:3, reverb:65, shape:'gaussian', freeze:true},
      digitalAngel: {mode:'hold', grainRate:32, grainLength:330, position:42, space:100, chaos:28, tune:12, spray:12, pitchJitter:1.2, reverseChance:14, stutterChance:8, crush:7, reverb:58, shape:'gaussian'},
      brokenCd: {mode:'step', grainRate:48, grainLength:46, position:18, space:72, chaos:18, tune:0, spray:22, pitchJitter:2.4, reverseChance:37, stutterChance:78, crush:48, reverb:12, shape:'square'},
      glassVocal: {mode:'hold', grainRate:26, grainLength:250, position:50, space:94, chaos:16, tune:7, spray:7, pitchJitter:.5, reverseChance:12, stutterChance:10, crush:4, reverb:46, shape:'hann'},
      clubCut: {mode:'step', grainRate:34, grainLength:105, position:20, space:55, chaos:7, tune:0, spray:4, pitchJitter:.2, reverseChance:10, stutterChance:48, crush:21, reverb:14, shape:'triangle'}
    };
    const p = presets[name]; if (!p) return;
    setMode(p.mode);
    Object.entries(p).forEach(([k,v]) => {
      if (k === 'mode' || k === 'shape' || k === 'freeze') return;
      if (k in state.params) setKnobValue(k,v,true);
    });
    if (p.shape) setShape(p.shape);
    if (p.freeze !== undefined) setFreeze(p.freeze);
    els.presetName.textContent = name.replace(/([A-Z])/g, ' $1').trim().toUpperCase();
  }

  function setShape(shape) {
    state.shape = shape;
    els.shapeButtons.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.shape === shape));
    drawShape();
  }

  function setFreeze(on) {
    state.frozen = on;
    if (on) state.freezeAnchor = getBasePosition();
    els.freezeBtn.classList.toggle('on', on);
  }

  function randomize() {
    const ranges = {
      grainRate:[8,52], grainLength:[35,720], position:[5,95], space:[15,100], chaos:[0,55], tune:[-12,12],
      spray:[0,30], pitchJitter:[0,4], reverseChance:[0,45], stutterChance:[0,65], crush:[0,45], reverb:[0,65]
    };
    Object.entries(ranges).forEach(([k,[a,b]]) => setKnobValue(k, rand(a,b), true));
  }

  function setupRecording() {
    if (!state.recordDest || !window.MediaRecorder) return;
    if (!state.recording) {
      state.recordChunks = [];
      let options = {};
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) options.mimeType = 'audio/webm;codecs=opus';
      state.recorder = new MediaRecorder(state.recordDest.stream, options);
      state.recorder.ondataavailable = e => { if (e.data.size) state.recordChunks.push(e.data); };
      state.recorder.onstop = () => {
        const blob = new Blob(state.recordChunks, {type: state.recorder.mimeType || 'audio/webm'});
        const url = URL.createObjectURL(blob);
        els.downloadLink.href = url;
        els.downloadLink.classList.remove('hidden');
        els.downloadLink.textContent = 'DOWNLOAD TAKE';
      };
      state.recorder.start();
      state.recording = true;
      els.recordBtn.textContent = 'STOP RECORDING';
      els.recordBtn.classList.add('active');
      if (!state.playing) start();
    } else {
      state.recorder.stop();
      state.recording = false;
      els.recordBtn.textContent = 'RECORD OUTPUT';
      els.recordBtn.classList.remove('active');
    }
  }

  function waveformPointer(e) {
    if (!state.buffer) return;
    const rect = els.waveform.getBoundingClientRect();
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    setKnobValue('position', x * 100, true);
    if (state.mode === 'step' || state.mode === 'keys') {
      state.currentCell = clamp(Math.floor(x * state.cells), 0, state.cells - 1);
      highlightCell(state.currentCell);
    }
  }

  // Wiring
  createKnobs();
  drawShape();
  initCells();
  drawSliceOverlay();
  updatePositionMarker();

  els.loadBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', e => loadFile(e.target.files[0]));
  ['dragenter','dragover'].forEach(ev => els.dropZone.addEventListener(ev, e => { e.preventDefault(); els.dropZone.classList.add('dragging'); }));
  ['dragleave','drop'].forEach(ev => els.dropZone.addEventListener(ev, e => { e.preventDefault(); els.dropZone.classList.remove('dragging'); }));
  els.dropZone.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
  els.waveform.addEventListener('pointerdown', e => { waveformPointer(e); els.waveform.setPointerCapture(e.pointerId); });
  els.waveform.addEventListener('pointermove', e => { if (els.waveform.hasPointerCapture(e.pointerId)) waveformPointer(e); });

  els.playBtn.addEventListener('click', () => state.playing ? stop() : start());
  els.stopBtn.addEventListener('click', stop);
  els.freezeBtn.addEventListener('click', () => setFreeze(!state.frozen));
  els.bpm.addEventListener('change', () => { if (state.playing && state.mode === 'step') restartStepTimer(); });

  els.modeSwitch.addEventListener('click', e => { const b = e.target.closest('button[data-mode]'); if (b) setMode(b.dataset.mode); });
  els.syncBtn.addEventListener('click', () => { state.sync = true; els.syncBtn.classList.add('active'); els.freeBtn.classList.remove('active'); });
  els.freeBtn.addEventListener('click', () => { state.sync = false; els.freeBtn.classList.add('active'); els.syncBtn.classList.remove('active'); });
  els.cellsBtn.addEventListener('click', () => { state.cells = state.cells === 16 ? 8 : 16; els.cellsBtn.textContent = `${state.cells} CELLS`; initCells(); });
  els.clockSelect.addEventListener('change', () => { state.stepClock = parseInt(els.clockSelect.value,10); restartStepTimer(); });
  els.resetCellsBtn.addEventListener('click', initCells);

  els.shapeButtons.addEventListener('click', e => { const b = e.target.closest('button[data-shape]'); if (b) setShape(b.dataset.shape); });
  els.microStutterBtn.addEventListener('click', () => { state.microStutter = !state.microStutter; els.microStutterBtn.classList.toggle('on', state.microStutter); if (!state.microStutter) state.stutterAnchor = null; });
  els.reverseLockBtn.addEventListener('click', () => { state.reverseLock = !state.reverseLock; els.reverseLockBtn.classList.toggle('on', state.reverseLock); });
  els.randomizeBtn.addEventListener('click', randomize);
  els.presetGrid.addEventListener('click', e => { const b = e.target.closest('button[data-preset]'); if (b) applyPreset(b.dataset.preset); });
  els.recordBtn.addEventListener('click', () => { initAudio(); setupRecording(); });

  document.addEventListener('keydown', e => {
    if (e.repeat || state.mode !== 'keys' || !state.buffer) return;
    const idx = midiKeys.indexOf(e.key.toLowerCase());
    if (idx >= 0 && idx < state.cells) {
      e.preventDefault(); state.heldCells.add(idx); state.currentCell = idx; highlightCell(idx); if (!state.playing) start();
    }
  });
  document.addEventListener('keyup', e => {
    if (state.mode !== 'keys') return;
    const idx = midiKeys.indexOf(e.key.toLowerCase());
    if (idx >= 0) state.heldCells.delete(idx);
  });
})();
