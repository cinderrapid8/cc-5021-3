// 融合策略注册表：引擎只依赖此表分派，新增策略只需在此注册。
import { envelopeStrategy } from './envelope.js';
import { centerStrategy, DEFAULT_CENTER_PARAMS } from './center.js';
import { windowStrategy, DEFAULT_WINDOW_PARAMS } from './window.js';

export const FUSION_STRATEGIES = {
  envelope: envelopeStrategy,
  center: centerStrategy,
  window: windowStrategy,
};

export const DEFAULT_FUSION_ID = 'envelope';

export const FUSION_DEFAULT_PARAMS = {
  envelope: {},
  center: { ...DEFAULT_CENTER_PARAMS },
  window: { ...DEFAULT_WINDOW_PARAMS },
};

export function normalizeFusion(fusion) {
  if (!fusion || typeof fusion !== 'object') {
    return { strategy: DEFAULT_FUSION_ID, params: {} };
  }
  const strategy = FUSION_STRATEGIES[fusion.strategy] ? fusion.strategy : DEFAULT_FUSION_ID;
  const params = { ...FUSION_DEFAULT_PARAMS[strategy], ...(fusion.params || {}) };
  return { strategy, params };
}
