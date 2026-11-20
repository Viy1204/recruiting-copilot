export const title = '候选快照保留可信视图';

export const state = (value) => {
  if (value.phase === 'done') {
    if (value.result === 'stale') return '整套沿用最后可信视图并标陈旧';
    if (value.result === 'unknown') return '台账不可读，人数明确未知';
    return value.view.candidates === 'empty' ? '台账有效，确认为零人' : '按本次可用来源展示候选';
  }
  return {
    ledger: '开始读取候选台账',
    context: '台账读取结束，等待岗位表',
    config: '岗位表读取结束，等待兼容配置',
    project: '来源已读取，等待生成候选投影',
  }[value.phase];
};

export const step = (action) => ({
  ReadLedger: '独立读取候选台账',
  ReadContext: '独立读取正式岗位表',
  ReadConfig: '独立读取兼容配置',
  ProjectSnapshot: '核对来源并生成完整视图',
  Done: '保留当前读取结果',
})[action];

export const group = (value) => value.result === 'stale' || value.result === 'unknown' ? '来源待恢复' : '可核对';
export const colors = { 来源待恢复: 'orange', 可核对: 'blue' };
