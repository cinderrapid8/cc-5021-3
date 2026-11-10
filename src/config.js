// 抽象形态通道、模型清单（实际形态名）与默认音素->口型映射配置。
// 映射只引用“抽象通道名”，与模型里的实际 morph 名称彻底分离。

export const SIL = 'SIL';

export const ABSTRACT_CHANNELS = [
  'jawOpen',      // 下颌/张嘴
  'lipRound',     // 圆唇（双唇前突）
  'lipSpread',    // 展唇（嘴角向两侧）
  'lipClose',     // 双唇闭合
  'tongueFront',  // 舌位前
  'tongueBack',   // 舌位后
];

// 每个抽象通道的权重取值范围（引擎会按此 clamp）。
export const CHANNEL_RANGES = {
  jawOpen:     { min: 0, max: 1 },
  lipRound:    { min: 0, max: 1 },
  lipSpread:   { min: 0, max: 1 },
  lipClose:    { min: 0, max: 1 },
  tongueFront: { min: 0, max: 1 },
  tongueBack:  { min: 0, max: 1 },
};

// 融合方式：
//  average —— 按各音素包络权重做加权平均（柔和通道）
//  max     —— 取最大（硬性闭合等不能被平均稀释的通道）
//  sum     —— 加权求和后 clamp
export const CHANNEL_COMBINE = {
  jawOpen:     'average',
  lipRound:    'average',
  lipSpread:   'average',
  lipClose:    'max',
  tongueFront: 'average',
  tongueBack:  'average',
};

// 模型清单：声明该模型“实际拥有”的 morph 名称。
// mapping 把抽象通道绑定到模型实际形态；缺省时约定实际名与抽象名相同。
// substitutes 用于该模型缺少某抽象通道对应形态时的可解释替代说明。
export const MODELS = {
  full: {
    id: 'full',
    label: '完整模型（6 个形态）',
    morphs: ['jawOpen', 'lipRound', 'lipSpread', 'lipClose', 'tongueFront', 'tongueBack'],
    mapping: {
      jawOpen: 'jawOpen',
      lipRound: 'lipRound',
      lipSpread: 'lipSpread',
      lipClose: 'lipClose',
      tongueFront: 'tongueFront',
      tongueBack: 'tongueBack',
    },
    substitutes: {},
  },
  limited: {
    id: 'limited',
    label: '受限模型（无舌位、无独立展唇）',
    morphs: ['jaw_open', 'lip_round', 'lip_close'],
    mapping: {
      jawOpen: 'jaw_open',
      lipRound: 'lip_round',
      lipClose: 'lip_close',
      // tongueFront / tongueBack / lipSpread 在该模型中没有对应形态
    },
    substitutes: {
      tongueFront: { to: 'jawOpen', reason: '模型无舌位形态，舌位前以轻微张嘴近似' },
      tongueBack:  { to: 'jawOpen', reason: '模型无舌位形态，舌位后以轻微张嘴近似' },
      lipSpread:   { to: 'lipRound', reason: '模型无展唇形态，展唇以减弱圆唇近似' },
    },
  },
  minimal: {
    id: 'minimal',
    label: '极简模型（仅张嘴/闭合）',
    morphs: ['jaw_open', 'lip_close'],
    mapping: {
      jawOpen: 'jaw_open',
      lipClose: 'lip_close',
    },
    substitutes: {
      lipRound:  { to: 'jawOpen', reason: '模型无圆唇形态，圆唇以小幅张嘴近似' },
      lipSpread: { to: 'jawOpen', reason: '模型无展唇形态，展唇以小幅张嘴近似' },
    },
  },
};

// 口型（viseme）在抽象通道上的目标权重。
export const VISEME_TARGETS = {
  // 元音
  A: { jawOpen: 0.90, lipRound: 0.00, lipSpread: 0.15, lipClose: 0.00, tongueFront: 0.30, tongueBack: 0.20 }, // a
  E: { jawOpen: 0.55, lipRound: 0.00, lipSpread: 0.55, lipClose: 0.00, tongueFront: 0.70, tongueBack: 0.10 }, // e/ɛ
  I: { jawOpen: 0.30, lipRound: 0.00, lipSpread: 0.85, lipClose: 0.00, tongueFront: 0.90, tongueBack: 0.00 }, // i
  O: { jawOpen: 0.55, lipRound: 0.75, lipSpread: 0.00, lipClose: 0.00, tongueFront: 0.10, tongueBack: 0.70 }, // o
  U: { jawOpen: 0.25, lipRound: 0.95, lipSpread: 0.00, lipClose: 0.00, tongueFront: 0.05, tongueBack: 0.80 }, // u
  V_er: { jawOpen: 0.45, lipRound: 0.10, lipSpread: 0.25, lipClose: 0.00, tongueFront: 0.20, tongueBack: 0.40 }, // 央元音/er/schwa
  V_yu: { jawOpen: 0.25, lipRound: 0.80, lipSpread: 0.30, lipClose: 0.00, tongueFront: 0.75, tongueBack: 0.10 }, // ü
  // 辅音
  C_b: { jawOpen: 0.00, lipRound: 0.00, lipSpread: 0.00, lipClose: 1.00, tongueFront: 0.00, tongueBack: 0.00, closure: true }, // b/p/m 闭口双唇
  C_f: { jawOpen: 0.15, lipRound: 0.00, lipSpread: 0.35, lipClose: 0.65, tongueFront: 0.30, tongueBack: 0.10, closure: true }, // f/v 唇齿
  C_d: { jawOpen: 0.20, lipRound: 0.00, lipSpread: 0.30, lipClose: 0.00, tongueFront: 0.85, tongueBack: 0.10 }, // d/t/n/l 舌尖
  C_g: { jawOpen: 0.25, lipRound: 0.00, lipSpread: 0.15, lipClose: 0.00, tongueFront: 0.10, tongueBack: 0.85 }, // g/k/h 舌根
  C_s: { jawOpen: 0.20, lipRound: 0.00, lipSpread: 0.60, lipClose: 0.00, tongueFront: 0.80, tongueBack: 0.00 }, // s/c/z/x/j/q 擦音/塞擦
  C_sh: { jawOpen: 0.22, lipRound: 0.35, lipSpread: 0.25, lipClose: 0.00, tongueFront: 0.55, tongueBack: 0.20 }, // zh/ch/sh/r
  C_w: { jawOpen: 0.20, lipRound: 0.85, lipSpread: 0.00, lipClose: 0.00, tongueFront: 0.10, tongueBack: 0.60 }, // w
  C_y: { jawOpen: 0.25, lipRound: 0.00, lipSpread: 0.65, lipClose: 0.00, tongueFront: 0.80, tongueBack: 0.10 }, // y
  // 停顿/静默：中性微张，绝不把音量当成张嘴驱动
  SIL: { jawOpen: 0.08, lipRound: 0.00, lipSpread: 0.00, lipClose: 0.00, tongueFront: 0.00, tongueBack: 0.00, relaxed: true },
};

// 默认音素 -> viseme 映射（键统一转小写后查表）。
// 覆盖汉语拼音声母/韵母、常见 ARPABET 与静默标记。
export const DEFAULT_PHONEME_MAP = {
  // 静默/停顿/呼吸/噪声
  sil: 'SIL', sp: 'SIL', pau: 'SIL', br: 'SIL', breath: 'SIL',
  '#': 'SIL', '.': 'SIL', '?': 'SIL', '!': 'SIL',
  // 拼音声母
  b: 'C_b', p: 'C_b', m: 'C_b',
  f: 'C_f',
  d: 'C_d', t: 'C_d', n: 'C_d', l: 'C_d',
  g: 'C_g', k: 'C_g', h: 'C_g', ng: 'C_g',
  s: 'C_s', c: 'C_s', z: 'C_s', x: 'C_s', j: 'C_s', q: 'C_s',
  zh: 'C_sh', ch: 'C_sh', sh: 'C_sh', r: 'C_sh',
  w: 'C_w', y: 'C_y',
  // 拼音韵母
  a: 'A', ai: 'A', ao: 'A', an: 'A', ang: 'A',
  o: 'O', ou: 'O', ong: 'O',
  e: 'V_er', ei: 'E', en: 'V_er', eng: 'V_er', er: 'V_er',
  i: 'I', in: 'I', ing: 'I',
  u: 'U', ui: 'U', un: 'U',
  v: 'V_yu', ü: 'V_yu', yu: 'V_yu', ue: 'V_yu', uan: 'V_yu',
  // ARPABET 元音
  aa: 'A', ae: 'A', ah: 'V_er', ao_r: 'O', aw: 'O', ay: 'A',
  eh: 'E', ey: 'E', ih: 'I', iy: 'I',
  ow: 'O', oy: 'O', uh: 'U', uw: 'U', er_r: 'V_er', ax: 'V_er',
  // ARPABET 辅音
  bcl: 'C_b', pcl: 'C_b', m_r: 'C_b',
  f_r: 'C_f', v_r: 'C_f',
  dcl: 'C_d', tcl: 'C_d', n_r: 'C_d', l_r: 'C_d',
  gcl: 'C_g', kcl: 'C_g', hh: 'C_g',
  s_r: 'C_s', z_r: 'C_s', sh_r: 'C_sh', zh_r: 'C_sh',
  ch_r: 'C_sh', jh: 'C_s', th: 'C_f', dh: 'C_f',
  w_r: 'C_w', y_r: 'C_y', r_r: 'C_sh',
};

// 过渡参数（秒）。相邻音素通过重叠包络自然过渡；
// 极短辅音保证最小闭合保持时间，避免被相邻元音平均掉。
export const DEFAULT_TRANSITION = {
  attack: 0.045,   // 进入目标的斜坡
  release: 0.060,  // 离开目标的斜坡
  closureHold: 0.055, // 闭口辅音最小保持
  pauseThreshold: 0.25, // 超过该时长的静默记录为“长停顿”
  transitionMaxSpan: 0.12, // 斜坡最长不超过相邻间隔
};

// 确定性采样的默认步长（秒）
export const DEFAULT_SAMPLE_RATE_HZ = 100;
export const DEFAULT_SAMPLE_DT = 1 / DEFAULT_SAMPLE_RATE_HZ;

// 内置演示样例（与 tools/gen_samples.py 保持一致，用于浏览器内合成与测试核对）
export const SAMPLE_SCHEDULES = {
  short_vowels: {
    id: 'short_vowels',
    label: '短元音 /a i u/（含闭口辅音 b）',
    audio: 'samples/short_vowels.wav',
    annotation: 'samples/short_vowels.json',
    sampleRate: 22050,
    segments: [
      { start: 0.000, end: 0.280, phoneme: 'sil' },
      { start: 0.280, end: 0.360, phoneme: 'b' },
      { start: 0.360, end: 0.560, phoneme: 'a' },
      { start: 0.620, end: 0.700, phoneme: 'b' },
      { start: 0.700, end: 0.880, phoneme: 'i' },
      { start: 0.940, end: 1.020, phoneme: 'b' },
      { start: 1.020, end: 1.220, phoneme: 'u' },
      { start: 1.220, end: 1.600, phoneme: 'sil' },
    ],
  },
  fast_syllables: {
    id: 'fast_syllables',
    label: '连续快速音节 ba-da-ga（核对连续闭合/舌位）',
    audio: 'samples/fast_syllables.wav',
    annotation: 'samples/fast_syllables.json',
    sampleRate: 22050,
    segments: [
      { start: 0.000, end: 0.150, phoneme: 'sil' },
      { start: 0.150, end: 0.205, phoneme: 'b' },
      { start: 0.205, end: 0.305, phoneme: 'a' },
      { start: 0.305, end: 0.360, phoneme: 'd' },
      { start: 0.360, end: 0.455, phoneme: 'a' },
      { start: 0.455, end: 0.515, phoneme: 'g' },
      { start: 0.515, end: 0.620, phoneme: 'a' },
      { start: 0.620, end: 0.675, phoneme: 'b' },
      { start: 0.675, end: 0.770, phoneme: 'a' },
      { start: 0.770, end: 0.825, phoneme: 'd' },
      { start: 0.825, end: 0.920, phoneme: 'a' },
      { start: 0.920, end: 0.980, phoneme: 'g' },
      { start: 0.980, end: 1.085, phoneme: 'a' },
      { start: 1.085, end: 1.400, phoneme: 'sil' },
    ],
  },
  long_pause: {
    id: 'long_pause',
    label: '长停顿（核对静默不张嘴与恢复）',
    audio: 'samples/long_pause.wav',
    annotation: 'samples/long_pause.json',
    sampleRate: 22050,
    segments: [
      { start: 0.000, end: 0.250, phoneme: 'sil' },
      { start: 0.250, end: 0.330, phoneme: 'b' },
      { start: 0.330, end: 0.550, phoneme: 'a' },
      { start: 0.550, end: 1.450, phoneme: 'sil' },
      { start: 1.450, end: 1.530, phoneme: 'b' },
      { start: 1.530, end: 1.750, phoneme: 'i' },
      { start: 1.750, end: 2.000, phoneme: 'sil' },
    ],
  },
};

export function cloneConfig(obj) {
  return JSON.parse(JSON.stringify(obj));
}
