export const title = '浏览器镜像 异步还原返回后重新核对熔断';
export const state = (v) => {
  if (v.writeRisk) return v.fitPhase === 'waiting_clear' ? '熔断后仍发出下一条还原命令' : '风险后的写入已返回 等待安全恢复';
  if (v.fitPhase === 'waiting_first') return v.risk === 'none' ? '首条视口命令等待返回' : '已熔断 首条视口命令仍在途';
  if (v.fitPhase === 'waiting_clear') return v.risk === 'none' ? '还原命令已发出 等待返回' : '命令发出后才熔断 等待返回';
  if (v.risk !== 'none') return '已熔断 自动维护入口被拦截';
  return '未熔断 可以自动维护';
};
export const step = (action, from) => ({
  ObserveRisk: '观察到风险页',
  ManualClear: '用户处理后显式解除',
  EligibilityChanges: '连接或盯梢条件变化',
  TryRecovery: '看门狗检查自愈条件',
  TryFit: from.writeRisk ? '重新还原 [已经人工解除风险]' : '入口检查后开始视口还原',
  FirstCommandReturns: from.risk === 'none' ? '首条返回 检查通过后发送清除命令' : '首条返回 熔断中止后续还原',
  ClearCommandReturns: '清除命令返回',
})[action];
export const group = (v) => v.writeRisk ? '发现问题' : v.risk !== 'none' ? '熔断' : '正常';
export const colors = { 发现问题: 'pink', 熔断: 'orange', 正常: 'teal' };
