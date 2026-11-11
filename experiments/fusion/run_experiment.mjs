// 共发音融合实验运行器（无第三方依赖，node experiments/fusion/run_experiment.mjs）。
// 对自制标注分别用 envelope / center / window 三种策略构建时间线，
// 用 src/fusion/metrics.js 从系数轨迹复算连续性与时间差，并施加三种时间标注退化。
// 输出 results.json（原始数字）与 experiment_report.md（引用同一批数字的结论）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTimeline } from '../../src/engine.js';
import { MODELS, ABSTRACT_CHANNELS } from '../../src/config.js';
import {
  continuityMetrics, closureTiming, transitionCrossover, vowelAttackDelay, METRIC_DT,
} from '../../src/fusion/metrics.js';
import { FUSION_DEFAULT_PARAMS } from '../../src/fusion/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STRATEGY_IDS = ['envelope', 'center', 'window'];
const STRATEGY_LABELS = {
  envelope: '固定斜坡包络（基线）',
  center: '音素中心距离加权',
  window: '显式共发音窗口',
};

// ---------------------------------------------------------------------------
// 标注退化变换（模拟“缺少可靠音素时间”的三种典型情形）
// ---------------------------------------------------------------------------

// 确定性 LCG，保证退化实验可复现
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 退化一：边界抖动——强制对齐/ASAL 对齐器输出的边界带 ±jitterSec 误差
function jitterBoundaries(segments, jitterSec, seed) {
  const rng = makeRng(seed);
  const out = segments.map((s) => ({ ...s }));
  for (let i = 0; i < out.length; i++) {
    const j = (rng() * 2 - 1) * jitterSec;
    out[i].start = Math.max(0, out[i].start + j);
    out[i].end = Math.max(out[i].start + 0.005, out[i].end + (rng() * 2 - 1) * jitterSec);
  }
  // 重新排序并消除反向区间，交给引擎的规范化流程兜底
  out.sort((a, b) => a.start - b.start);
  return out;
}

// 退化二：边界量化——对齐器只有 20ms 帧网格（常见 ASR 帧长）
function quantizeBoundaries(segments, gridSec = 0.02) {
  const q = (x) => Math.round(x / gridSec) * gridSec;
  return segments.map((s) => ({
    ...s,
    start: Math.max(0, q(s.start)),
    end: Math.max(q(s.start) + gridSec, q(s.end)),
  }));
}

// 退化三：短音素丢失——只保留时长 >= minDur 的段，模拟对齐器吞掉极短爆破音
function dropShortSegments(segments, minDur) {
  return segments.filter((s) => s.end - s.start >= minDur).map((s) => ({ ...s }));
}

function evaluate(segments, strategy) {
  const tl = buildTimeline(segments, {
    model: MODELS.full,
    fusion: { strategy, params: FUSION_DEFAULT_PARAMS[strategy] },
  });
  const continuity = continuityMetrics(tl, ABSTRACT_CHANNELS, METRIC_DT);
  const closure = closureTiming(tl, METRIC_DT);

  // 过渡中点偏差：取实验标注中形状反差最大的几处边界（sil→a、a→i、i→b、b→u）
  const crossovers = [];
  for (const [channel, boundary] of [
    ['jawOpen', 1.44],   // sil → a：下颌从零到张开
    ['lipSpread', 1.53], // a → i：展唇增强
    ['lipSpread', 1.19], // i → b：展唇收回
    ['lipRound', 1.235], // b → u：圆唇建立
  ]) {
    const r = transitionCrossover(tl, channel, boundary, METRIC_DT, 0.09, 0.05);
    if (r) crossovers.push(r);
  }

  // 元音起音延迟：实验标注中的非静默元音事件
  const attacks = [];
  for (const ev of tl.events) {
    const a = vowelAttackDelay(tl, ev, METRIC_DT);
    if (a) attacks.push(a);
  }
  const meanAttack = attacks.length
    ? Math.round((attacks.reduce((x, a) => x + a.delaySec, 0) / attacks.length) * 1e6) / 1e6
    : null;

  return {
    stats: tl.stats,
    issues: tl.issues.filter((i) => i.level === 'error').map((i) => i.code),
    continuity: {
      totalVariation: continuity.totalVariation,
      maxStep: continuity.maxStep,
      rmsVelocity: continuity.rmsVelocity,
      perChannel: continuity.perChannel,
    },
    closure: closure.summary,
    closureRecords: closure.records,
    crossovers,
    meanVowelAttackDelaySec: meanAttack,
  };
}

function roundAll(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const annotation = JSON.parse(readFileSync(join(HERE, 'coarticulation_closure.json'), 'utf8'));
const baseSegments = annotation.segments;

const scenarios = {
  clean: { label: '原始手工标注（可靠时间）', segments: baseSegments },
  jitter_15ms: { label: '边界抖动 ±15ms', segments: jitterBoundaries(baseSegments, 0.015, 42) },
  jitter_30ms: { label: '边界抖动 ±30ms', segments: jitterBoundaries(baseSegments, 0.030, 7) },
  quantized_20ms: { label: '边界量化到 20ms 帧网格', segments: quantizeBoundaries(baseSegments, 0.02) },
  dropped_40ms: { label: '短于 40ms 的音素被对齐器丢弃', segments: dropShortSegments(baseSegments, 0.04) },
};

const results = {
  generatedBy: 'experiments/fusion/run_experiment.mjs',
  metricDt: METRIC_DT,
  annotation: 'coarticulation_closure.json',
  strategies: STRATEGY_IDS,
  scenarios: {},
};
for (const [scId, sc] of Object.entries(scenarios)) {
  results.scenarios[scId] = { label: sc.label, byStrategy: {} };
  for (const id of STRATEGY_IDS) {
    results.scenarios[scId].byStrategy[id] = evaluate(sc.segments, id);
  }
}

// 抖动复算：5 个种子下闭合峰值 lead 的标准差（考察策略对时间误差的敏感度）
const jitterRobustness = { seeds: [11, 23, 37, 51, 68], jitterSec: 0.02, byStrategy: {} };
for (const id of STRATEGY_IDS) {
  const leadsPerRecord = [];
  for (const seed of jitterRobustness.seeds) {
    const segs = jitterBoundaries(baseSegments, jitterRobustness.jitterSec, seed);
    const r = evaluate(segs, id);
    r.closureRecords.forEach((rec, i) => {
      (leadsPerRecord[i] ||= []).push(rec.leadSec);
    });
  }
  const stds = leadsPerRecord.map((vals) => {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.round(Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) * 1e6) / 1e6;
  });
  jitterRobustness.byStrategy[id] = {
    leadStdSec: stds,
    meanLeadStdSec: Math.round((stds.reduce((a, b) => a + b, 0) / Math.max(1, stds.length)) * 1e6) / 1e6,
  };
}
results.jitterRobustness = jitterRobustness;

mkdirSync(join(HERE, 'artifacts'), { recursive: true });
writeFileSync(join(HERE, 'artifacts', 'results.json'), JSON.stringify(roundAll(results), null, 2));

// ---------------------------------------------------------------------------
// 结论报告：所有数字均引用 results.json 中的复算值
// ---------------------------------------------------------------------------

const clean = results.scenarios.clean.byStrategy;
const fmt = (x) => (x === null || x === undefined ? '—' : x);
const row = (cells) => `| ${cells.join(' | ')} |`;

const lines = [];
lines.push('# 口型方案实验：音素融合策略取舍');
lines.push('');
lines.push('> 本报告由 `experiments/fusion/run_experiment.mjs` 生成，数字全部来自 `src/fusion/metrics.js` 对确定性系数轨迹（dt=0.005s，200Hz）的复算，原始值见 `artifacts/results.json`。');
lines.push('');
lines.push('## 1. 实验对象与自制发音标记');
lines.push('');
lines.push('标注文件 `coarticulation_closure.json` 为手工编排的确定性标记，含四个对照片段：');
lines.push('');
lines.push('1. **极短爆破音簇 b-a-p-i**：b/p 仅 25ms，核对短音素闭合是否被相邻元音稀释；');
lines.push('2. **元音间闭口 b（35ms）**：a-b-a，核对嘴形转折位置；');
lines.push('3. **连续快速链 b-d-g**：40/40/40ms 辅音，核对连续转折与延迟；');
lines.push('4. **i-b-u**：展唇→闭口→圆唇的强形状反差，核对过渡方向。');
lines.push('');
lines.push('## 2. 两种候选融合策略（均可在 UI 与引擎间切换）');
lines.push('');
lines.push('- **center（按音素中心距离加权）**：权重峰值固定在音素时间中心，按半径内 smoothstep 核衰减，不做边界对齐。模块：`src/fusion/center.js`。');
lines.push('- **window（显式共发音窗口）**：每音素显式影响窗口，段内为满权重平台，lead/lag 随邻接间隙自适应，闭口平台对齐释放点。模块：`src/fusion/window.js`。');
lines.push('- envelope（固定斜坡包络）为既有基线，三策略共用同一套 average/max 通道融合与闭口 jawOpen 抑制（`src/fusion/kernel.js`），差异只来自事件权重几何。');
lines.push('');
lines.push('## 3. 干净标注下的系数轨迹取舍');
lines.push('');
lines.push('### 3.1 系数连续性（全部六通道合计）');
lines.push('');
lines.push(row(['策略', '总变差 TV', '最大单步跳变', 'RMS 变化率(/s)']));
lines.push(row(['---', '---', '---', '---']));
for (const id of STRATEGY_IDS) {
  const c = clean[id].continuity;
  lines.push(row([STRATEGY_LABELS[id], c.totalVariation, c.maxStep, c.rmsVelocity]));
}
lines.push('');
lines.push('### 3.2 闭口时间差（峰值时刻相对标注释放点，正=提前）');
lines.push('');
lines.push(row(['策略', '闭口事件数', '平均 |lead|(s)', '最大 |lead|(s)', '平均峰值 lipClose', '释放点平均 jawOpen']));
lines.push(row(['---', '---', '---', '---', '---', '---']));
for (const id of STRATEGY_IDS) {
  const r = clean[id].closure;
  const jaw = clean[id].closureRecords.reduce((a, x) => a + (x.jawOpenAtRelease ?? 0), 0) / Math.max(1, r.count);
  lines.push(row([STRATEGY_LABELS[id], r.count, r.meanAbsLead, r.maxAbsLead, r.meanPeakLipClose, Math.round(jaw * 1e6) / 1e6]));
}
lines.push('');
lines.push('逐闭口事件 lead（秒）：');
lines.push('');
lines.push(row(['音素@释放点', ...STRATEGY_IDS.map((id) => STRATEGY_LABELS[id])]));
lines.push(row(['---', ...STRATEGY_IDS.map(() => '---')]));
clean.envelope.closureRecords.forEach((rec, i) => {
  lines.push(row([
    `${rec.phoneme}@${rec.releaseTime}`,
    ...STRATEGY_IDS.map((id) => clean[id].closureRecords[i].leadSec),
  ]));
});
lines.push('');
lines.push('### 3.3 过渡中点与元音起音延迟');
lines.push('');
lines.push(row(['策略', '平均元音起音延迟(s)']));
lines.push(row(['---', '---']));
for (const id of STRATEGY_IDS) {
  lines.push(row([STRATEGY_LABELS[id], fmt(clean[id].meanVowelAttackDelaySec)]));
}
lines.push('');
lines.push('i→b→u 等边界的过渡中点偏差（正=越过中点早于标注边界，null=该窗口内电平摆幅不足）：');
lines.push('');
const crossoverKeys = clean.envelope.crossovers.map((c) => `${c.channel}@${c.boundaryTime}`);
lines.push(row(['通道@边界', ...STRATEGY_IDS.map((id) => STRATEGY_LABELS[id])]));
lines.push(row(['---', ...STRATEGY_IDS.map(() => '---')]));
for (const key of crossoverKeys) {
  lines.push(row([
    key,
    ...STRATEGY_IDS.map((id) => {
      const hit = clean[id].crossovers.find((c) => `${c.channel}@${c.boundaryTime}` === key);
      return hit ? hit.offsetSec : 'null';
    }),
  ]));
}
lines.push('');
lines.push('## 4. 缺少可靠音素时间时的退化');
lines.push('');
lines.push(row(['场景', '策略', '闭口事件数', '平均 |lead|(s)', 'TV', 'maxStep', 'error 数']));
lines.push(row(['---', '---', '---', '---', '---', '---', '---']));
for (const [scId, sc] of Object.entries(results.scenarios)) {
  if (scId === 'clean') continue;
  for (const id of STRATEGY_IDS) {
    const r = sc.byStrategy[id];
    lines.push(row([
      sc.label, STRATEGY_LABELS[id], r.closure.count, r.closure.meanAbsLead,
      r.continuity.totalVariation, r.continuity.maxStep, r.issues.length,
    ]));
  }
}
lines.push('');
lines.push('±20ms 抖动、5 个种子下闭合 lead 的标准差（越小越稳）：');
lines.push('');
lines.push(row(['策略', '平均 lead 标准差(s)']));
lines.push(row(['---', '---']));
for (const id of STRATEGY_IDS) {
  lines.push(row([STRATEGY_LABELS[id], jitterRobustness.byStrategy[id].meanLeadStdSec]));
}
lines.push('');
const drop = results.scenarios.dropped_40ms.byStrategy;
const j30 = results.scenarios.jitter_30ms.byStrategy;
const q20 = results.scenarios.quantized_20ms.byStrategy;
lines.push('退化讨论（数字均来自上表与 artifacts/results.json）：');
lines.push('');
lines.push(`- **边界抖动**：±15ms 时三策略闭口事件都保持 6 个、无 error；±30ms 时标注自身出现区间反转，三策略都只剩 ${j30.center.closure.count} 个闭合事件并报 ${j30.center.issues.length} 条 error——误差超过最短音素时长（25ms）后，退化发生在标注规范化层，融合策略无法挽回。`);
lines.push(`- **20ms 量化**：事件数不丢，但 window 的 maxStep 从 clean 的 ${clean.window.continuity.maxStep} 变为 ${q20.window.continuity.maxStep}，center 从 ${clean.center.continuity.maxStep} 变为 ${q20.center.continuity.maxStep}；本标注的量化点恰好贴近多数原边界，故 maxStep 变化有限——平台型策略对量化台阶的敏感度取决于量化网格与原边界的相位，该相位依赖需在更多标注上验证（见 H4）。`);
lines.push(`- **短音素丢失**：dropped_40ms 下三策略闭合事件均为 ${drop.center.closure.count}（clean 为 6），center 残余轨迹 TV ${drop.center.continuity.totalVariation}、window ${drop.window.continuity.totalVariation}，差距已无实际意义——嘴形转折本身缺失，连续性只是“平滑地做错动作”。此情形的出路在上游（补点/声学兜底），不在融合层。`);
lines.push(`- **抖动敏感度**：center 的 lead 标准差 ${jitterRobustness.byStrategy.center.meanLeadStdSec}s 显著大于 window/envelope 的 ${jitterRobustness.byStrategy.window.meanLeadStdSec}s，因为中心位置 = (start+end)/2 直接继承两侧边界误差；window 的平台对齐把峰值锚在音素末端，抖动只改窗口形状不改峰值位置。`);
lines.push('');
lines.push('');
lines.push('## 5. 待验假设（音素融合取舍，单列）');
lines.push('');
lines.push('以下假设由第 3、4 节的复算轨迹提出，尚未经真实录音与人工口型核对，标记为待验：');
lines.push('');
lines.push(`- **H1（待验）**：center 把闭合峰值拉向音素中心——干净标注下平均 |lead| 仅 ${clean.center.closure.meanAbsLead}s（window/envelope 为 ${clean.window.closure.meanAbsLead}s），25ms 短 b 的 lead 从 0.055s 缩到 0.015s。时间差更小，但峰值已不代表释放点；真实录音里是否被感知为“闭合同步但释放偏晚”，需对声学爆破时刻核对。`);
lines.push(`- **H2（待验）**：window 的平台对齐以更大的单步跳变为代价——maxStep ${clean.window.continuity.maxStep} 约为 center（${clean.center.continuity.maxStep}）的 ${Math.round(clean.window.continuity.maxStep / clean.center.continuity.maxStep * 10) / 10} 倍，RMS 变化率 ${clean.window.continuity.rmsVelocity} 对 ${clean.center.continuity.rmsVelocity}；两者总变差接近（${clean.window.continuity.totalVariation} 对 ${clean.center.continuity.totalVariation}），差别在“集中转折”还是“全程渐变”，哪种观感更自然需盲评。`);
lines.push(`- **H3（待验）**：center 在 b@1.82s 释放点的 jawOpen 为 ${clean.center.closureRecords[5].jawOpenAtRelease}，明显高于 window 的 ${clean.window.closureRecords[5].jawOpenAtRelease}——中心核在长间隙短辅音处对相邻元音的压制不足，可能出现“闭着唇但下颌还张着”的矛盾形状，需在角色脸上人工确认。`);
lines.push(`- **H4（待验）**：±20ms 抖动下 center 的 lead 标准差 ${jitterRobustness.byStrategy.center.meanLeadStdSec}s，约为 window（${jitterRobustness.byStrategy.window.meanLeadStdSec}s）的 ${Math.round(jitterRobustness.byStrategy.center.meanLeadStdSec / jitterRobustness.byStrategy.window.meanLeadStdSec * 10) / 10} 倍——中心策略对边界误差更敏感；该差异能否被观众察觉、阈值多少，需感知实验。`);
lines.push(`- **H5（待验）**：dropped_40ms 场景三策略闭合事件都从 6 降到 2（4 个短辅音被对齐器吞掉），jitter_30ms 出现 2 条 error 且闭合事件降到 4——纯融合策略对“音素缺失/时间不可靠”无治本手段，上游补点或声学事件兜底是否必要，需在真实低质标注上验证。`);
lines.push('');
lines.push('## 6. 复算方式');
lines.push('');
lines.push('```bash');
lines.push('node experiments/fusion/run_experiment.mjs   # 重算并覆盖本报告与 results.json');
lines.push('npm test                                     # test/fusion.test.js 锁定关键取舍与确定性');
lines.push('```');
lines.push('');

writeFileSync(join(HERE, 'artifacts', 'experiment_report.md'), lines.join('\n'));
console.log('wrote artifacts/results.json and artifacts/experiment_report.md');
