import {
  ABSTRACT_CHANNELS, MODELS, VISEME_TARGETS, DEFAULT_PHONEME_MAP,
  DEFAULT_TRANSITION, SAMPLE_SCHEDULES, DEFAULT_SAMPLE_DT, cloneConfig,
} from './config.js';
import {
  parseAnnotationJSON, parseAnnotationText, normalizeSegments,
  buildTimeline, sampleAt, sampleGrid, closureAudit, buildExportPayload,
} from './engine.js';
import { MediaClock } from './clock.js';
import { synthSampleBlob, computePeaks } from './synth.js';
import { drawFace, drawChannelBars } from './face.js';
import { drawWaveform, timeFromPointer } from './waveform.js';
import { drawCurves } from './curves.js';

// ---- 全局可变状态（用户编辑映射时整体替换并重建时间线）----
const state = {
  rawSegments: [],
  phonemeMap: cloneConfig(DEFAULT_PHONEME_MAP),
  visemeTargets: cloneConfig(VISEME_TARGETS),
  transition: { ...DEFAULT_TRANSITION },
  model: MODELS.full,
  timeline: null,
  peaks: null,
  audioDuration: 0,
  sampleBlobUrl: null,
  dt: DEFAULT_SAMPLE_DT,
};

const $ = (id) => document.getElementById(id);
const audioEl = $('audioEl');
const clock = new MediaClock(audioEl);

const faceCanvas = $('faceCanvas');
const barCanvas = $('barCanvas');
const waveCanvas = $('waveCanvas');
const curveCanvas = $('curveCanvas');

// ---------------------------------------------------------------------------
// 初始化下拉项
// ---------------------------------------------------------------------------
function initSelects() {
  const ss = $('sampleSelect');
  for (const s of Object.values(SAMPLE_SCHEDULES)) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label;
    ss.appendChild(opt);
  }
  const ms = $('modelSelect');
  for (const m of Object.values(MODELS)) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    ms.appendChild(opt);
  }
}

// ---------------------------------------------------------------------------
// 时间线重建（映射/参数/模型任何修改后调用，立即重算）
// ---------------------------------------------------------------------------
function rebuildTimeline() {
  if (!state.rawSegments.length) {
    state.timeline = null;
    renderAll();
    return;
  }
  state.timeline = buildTimeline(state.rawSegments, {
    phonemeMap: state.phonemeMap,
    visemeTargets: state.visemeTargets,
    transition: state.transition,
    model: state.model,
  });
  renderAll();
}

// ---------------------------------------------------------------------------
// 标注载入
// ---------------------------------------------------------------------------
function loadAnnotationText(text, isJSON) {
  let raw;
  if (isJSON) raw = parseAnnotationJSON(text);
  else raw = parseAnnotationText(text);
  const { segments, issues } = normalizeSegments(raw);
  state.rawSegments = segments;
  if (issues.length) console.warn('标注规范化提示：', issues);
  rebuildTimeline();
}

function loadSample(scheduleDef) {
  state.rawSegments = cloneConfig(scheduleDef.segments);
  // 浏览器内确定性合成音频
  if (state.sampleBlobUrl) URL.revokeObjectURL(state.sampleBlobUrl);
  const blob = synthSampleBlob(scheduleDef, state.phonemeMap, scheduleDef.sampleRate);
  state.sampleBlobUrl = URL.createObjectURL(blob);
  audioEl.src = state.sampleBlobUrl;
  const pcm = blobToPcm(blob, scheduleDef.sampleRate);
  pcm.then((data) => { state.peaks = computePeaks(data, 700); }).catch(() => { state.peaks = null; });
  state.audioDuration = scheduleDef.segments[scheduleDef.segments.length - 1].end;
  rebuildTimeline();
}

// 读取 WAV Blob 解码为 PCM（仅用于波形显示）
async function blobToPcm(blob, sampleRate) {
  const buf = await blob.arrayBuffer();
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ac.decodeAudioData(buf.slice(0));
    ac.close();
    return decoded.getChannelData(0);
  } catch {
    return pcmFromWavBytes(buf);
  }
}

function pcmFromWavBytes(buffer) {
  const view = new DataView(buffer);
  const dataOffset = 44;
  const n = Math.floor((buffer.byteLength - dataOffset) / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(dataOffset + i * 2, true) / 0x8000;
  return out;
}

// ---------------------------------------------------------------------------
// 渲染：映射表、viseme 矩阵、问题、闭合核对、芯片
// ---------------------------------------------------------------------------
function renderPhonemeTable() {
  const filter = $('phonemeFilter').value.trim().toLowerCase();
  const tbody = $('phonemeMapTable').querySelector('tbody');
  tbody.innerHTML = '';
  const keys = Object.keys(state.phonemeMap).sort();
  for (const key of keys) {
    if (filter && !key.includes(filter)) continue;
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = key;
    const td2 = document.createElement('td');
    const sel = document.createElement('select');
    for (const v of Object.keys(state.visemeTargets)) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      if (state.phonemeMap[key] === v) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      state.phonemeMap[key] = sel.value;
      rebuildTimeline();
    });
    td2.appendChild(sel);
    tr.append(td1, td2);
    tbody.appendChild(tr);
  }
}

function renderVisemeTable() {
  const head = $('visemeHead');
  const body = $('visemeBody');
  head.innerHTML = '';
  body.innerHTML = '';
  const hr = document.createElement('tr');
  const th0 = document.createElement('th');
  th0.textContent = 'viseme';
  hr.appendChild(th0);
  for (const ch of ABSTRACT_CHANNELS) {
    const th = document.createElement('th');
    th.textContent = ch;
    hr.appendChild(th);
  }
  head.appendChild(hr);

  for (const [vid, target] of Object.entries(state.visemeTargets)) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.textContent = vid + (target.closure ? ' ×' : '') + (target.relaxed ? ' ~' : '');
    tr.appendChild(td);
    for (const ch of ABSTRACT_CHANNELS) {
      const tdc = document.createElement('td');
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '0';
      inp.max = '1';
      inp.step = '0.05';
      inp.value = target[ch] ?? 0;
      inp.addEventListener('change', () => {
        let v = Number(inp.value);
        if (!Number.isFinite(v)) v = 0;
        v = Math.max(0, Math.min(1, v)); // 权重范围约束
        inp.value = v;
        state.visemeTargets[vid][ch] = v;
        rebuildTimeline();
      });
      tdc.appendChild(inp);
      tr.appendChild(tdc);
    }
    body.appendChild(tr);
  }
}

function renderIssues() {
  const list = $('issueList');
  list.innerHTML = '';
  const tl = state.timeline;
  const issues = tl ? tl.issues : [];
  const counts = { error: 0, warn: 0, info: 0 };
  for (const it of issues) counts[it.level] = (counts[it.level] || 0) + 1;
  $('errBadge').textContent = counts.error;
  $('warnBadge').textContent = counts.warn;
  $('infoBadge').textContent = counts.info;
  for (const it of issues) {
    const div = document.createElement('div');
    div.className = `issue ${it.level}`;
    div.textContent = `[${it.level}] ${it.message}`;
    list.appendChild(div);
  }
  if (!issues.length) {
    list.innerHTML = '<div class="hint">无诊断信息。</div>';
  }
}

function renderAudit() {
  const tbody = $('auditTable').querySelector('tbody');
  tbody.innerHTML = '';
  const tl = state.timeline;
  if (!tl) return;
  const records = closureAudit(tl);
  for (const r of records) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.phoneme}</td><td>${r.time.toFixed(3)}</td><td>${r.expectedLipClose.toFixed(2)}</td>`;
    const tdActual = document.createElement('td');
    tdActual.textContent = r.morph ? `${r.achievedMorph.toFixed(2)} (${r.morph})` : r.achievedAbstract.toFixed(2);
    const tdPass = document.createElement('td');
    tdPass.className = r.pass ? 'audit-pass' : 'audit-fail';
    tdPass.textContent = r.pass ? '通过' : '不足';
    tr.append(tdActual, tdPass);
    tbody.appendChild(tr);
  }
  $('statPhonemes').textContent = tl.stats.phonemeCount;
  $('statClosures').textContent = tl.stats.closureEvents;
  $('statEnforced').textContent = tl.stats.closureEnforcedCount;
  $('statPauses').textContent = tl.stats.longPauseCount;
}

function renderMorphChips() {
  const wrap = $('morphChips');
  wrap.innerHTML = '';
  const tl = state.timeline;
  if (!tl) return;
  const { report } = tl.modelResolution;
  for (const d of report.direct) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = `${d.channel}→${d.morph}`;
    wrap.appendChild(c);
  }
  for (const s of report.substitutes) {
    const c = document.createElement('span');
    c.className = 'chip sub';
    c.title = s.reason;
    c.textContent = `${s.channel}⇒${s.morph}(替代×${s.scale})`;
    wrap.appendChild(c);
  }
  for (const ch of report.dropped) {
    const c = document.createElement('span');
    c.className = 'chip drop';
    c.textContent = `${ch} ×缺失`;
    wrap.appendChild(c);
  }
}

function renderAll() {
  renderPhonemeTable();
  renderVisemeTable();
  renderIssues();
  renderAudit();
  renderMorphChips();
}

// ---------------------------------------------------------------------------
// 播放帧循环：只从媒体时钟取时间，再向引擎求值
// ---------------------------------------------------------------------------
let stopLoop = null;
function startLoop() {
  if (stopLoop) stopLoop();
  stopLoop = clock.startFrameLoop((t) => {
    $('clockTime').textContent = `${t.toFixed(3)}s`;
    drawTick(t);
  });
}

function drawTick(t) {
  const tl = state.timeline;
  if (!tl) {
    drawFace(faceCanvas, {}, { label: '等待标注…' });
    drawChannelBars(barCanvas, {}, ABSTRACT_CHANNELS);
    return;
  }
  const s = sampleAt(tl, t);
  drawFace(faceCanvas, s.abstract, { label: `t=${s.t.toFixed(3)}s` });
  drawChannelBars(barCanvas, s.abstract, ABSTRACT_CHANNELS);

  // 当前音素 / viseme
  let cur = null;
  for (const ev of tl.events) {
    if (t >= ev.riseStart && t <= ev.fallEnd) {
      if (!cur || ev.closure) cur = ev;
    }
  }
  $('curViseme').textContent = cur ? cur.visemeId : 'SIL(中性)';
  $('curPhoneme').textContent = cur ? cur.phoneme : '—';

  const dur = state.audioDuration || tl.duration;
  drawWaveform(waveCanvas, state.peaks, tl, t, dur);
  drawCurves(curveCanvas, tl, t, state.dt);
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportWeightsJSON() {
  if (!state.timeline) return alert('请先载入标注并生成时间线');
  const payload = buildExportPayload(state.timeline, state.dt);
  download('viseme_weights.json', JSON.stringify(payload, null, 2), 'application/json');
}

function exportCsv() {
  if (!state.timeline) return alert('请先载入标注并生成时间线');
  const grid = sampleGrid(state.timeline, state.dt);
  const morphNames = [...new Set(Object.values(state.timeline.modelResolution.bindings).map((b) => b.morph))].sort();
  const header = ['t', ...ABSTRACT_CHANNELS.map((c) => `abstract.${c}`), ...morphNames.map((m) => `morph.${m}`)];
  const lines = [header.join(',')];
  for (const s of grid.samples) {
    const row = [s.t.toFixed(6)];
    for (const ch of ABSTRACT_CHANNELS) row.push((s.abstract[ch] || 0).toFixed(6));
    for (const m of morphNames) row.push((s.morphs[m] || 0).toFixed(6));
    lines.push(row.join(','));
  }
  download('viseme_weights.csv', lines.join('\n'), 'text/csv');
}

function exportReport() {
  if (!state.timeline) return alert('请先载入标注并生成时间线');
  const tl = state.timeline;
  const report = {
    generatedAtDeterministic: true,
    sampleStepSec: state.dt,
    duration: tl.duration,
    stats: tl.stats,
    model: tl.modelResolution.report,
    closureAudit: closureAudit(tl),
    pauses: tl.pauses,
    issues: tl.issues,
  };
  download('viseme_report.json', JSON.stringify(report, null, 2), 'application/json');
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
function bindEvents() {
  $('loadSampleBtn').addEventListener('click', () => {
    const def = SAMPLE_SCHEDULES[$('sampleSelect').value];
    loadSample(def);
  });

  $('audioFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (state.sampleBlobUrl) { URL.revokeObjectURL(state.sampleBlobUrl); state.sampleBlobUrl = null; }
    const url = URL.createObjectURL(file);
    audioEl.src = url;
    state.audioDuration = 0;
    audioEl.addEventListener('loadedmetadata', () => {
      state.audioDuration = audioEl.duration;
      $('durationTime').textContent = `${audioEl.duration.toFixed(3)}s`;
      drawTick(audioEl.currentTime);
    }, { once: true });
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await ac.decodeAudioData(await file.arrayBuffer());
      state.peaks = computePeaks(decoded.getChannelData(0), 700);
      ac.close();
    } catch { state.peaks = null; }
  });

  $('annotFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadAnnotationText(String(reader.result), file.name.endsWith('.json'));
    reader.readAsText(file);
  });

  $('pasteBtn').addEventListener('click', () => {
    const txt = $('annotPaste').value.trim();
    if (!txt) return;
    const isJSON = txt.startsWith('[') || txt.startsWith('{');
    loadAnnotationText(txt, isJSON);
  });

  $('modelSelect').addEventListener('change', () => {
    state.model = MODELS[$('modelSelect').value];
    rebuildTimeline();
  });

  $('playBtn').addEventListener('click', () => clock.play());
  $('pauseBtn').addEventListener('click', () => clock.pause());
  $('restartBtn').addEventListener('click', () => { clock.seek(0); drawTick(0); });

  $('rateRange').addEventListener('input', (e) => {
    const r = Number(e.target.value);
    $('rateVal').textContent = `${r.toFixed(2)}x`;
    clock.setRate(r);
  });

  const bindRange = (id, valId, key, suffix = '') => {
    $(id).addEventListener('input', (e) => {
      const v = Number(e.target.value);
      $(valId).textContent = `${v.toFixed(3)}${suffix}`;
      state.transition[key] = v;
      rebuildTimeline();
    });
    $(valId).textContent = `${Number($(id).value).toFixed(3)}${suffix}`;
  };
  bindRange('attackRange', 'attackVal', 'attack');
  bindRange('releaseRange', 'releaseVal', 'release');
  bindRange('holdRange', 'holdVal', 'closureHold');
  bindRange('pauseRange', 'pauseVal', 'pauseThreshold');

  $('phonemeFilter').addEventListener('input', renderPhonemeTable);

  $('resetMapBtn').addEventListener('click', () => {
    state.phonemeMap = cloneConfig(DEFAULT_PHONEME_MAP);
    state.visemeTargets = cloneConfig(VISEME_TARGETS);
    rebuildTimeline();
  });

  $('recomputeBtn').addEventListener('click', () => {
    const v = Number($('dtInput').value);
    if (!(v > 0)) return alert('采样步长必须为正数');
    state.dt = v;
    rebuildTimeline();
  });

  $('exportWeightsBtn').addEventListener('click', exportWeightsJSON);
  $('exportCsvBtn').addEventListener('click', exportCsv);
  $('exportReportBtn').addEventListener('click', exportReport);

  // 波形点击/拖动定位：直接写媒体时钟
  const seekFromEvent = (e) => {
    const dur = state.audioDuration || state.timeline?.duration || 0;
    if (!dur) return;
    const t = timeFromPointer(waveCanvas, e.clientX, dur);
    clock.seek(t);
    drawTick(t);
  };
  let dragging = false;
  waveCanvas.addEventListener('mousedown', (e) => { dragging = true; seekFromEvent(e); });
  window.addEventListener('mousemove', (e) => { if (dragging) seekFromEvent(e); });
  window.addEventListener('mouseup', () => { dragging = false; });

  audioEl.addEventListener('loadedmetadata', () => {
    $('durationTime').textContent = `${audioEl.duration.toFixed(3)}s`;
  });
  audioEl.addEventListener('seeked', () => drawTick(audioEl.currentTime));
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
initSelects();
bindEvents();
startLoop();
loadSample(SAMPLE_SCHEDULES.short_vowels);
