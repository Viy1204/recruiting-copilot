export const title = '约面流程 日程成功之后仍需核实同步';
const labels = {
  prepare: '核对候选档案与面试要素',
  awaiting_user: '建日前请用户确认',
  creating: '按已确认要素创建日程',
  verify_calendar: '创建结果不明，回查日程',
  deliver_invitation: '日程已核实，准备候选人邀约',
  sync: '分别同步档案排期 台账 进展事件',
  partial: '部分同步失败，明确保留缺项',
  read_overview: '三处已同步，回读总览',
  done: '人岗日期时段可达，约面收尾',
};
export const state = (v) => labels[v.phase];
export const step = (action, from) => ({
  Prepare: '核实要素与面试官空闲',
  Approve: '用户确认本次日程',
  CalendarVerified: from.phase === 'creating' ? '会议链接及全部面试官已核实' : '回查已创建且要素一致',
  CalendarUncertain: '超时或返回不足以证明创建结果',
  CalendarAbsent: '核实未创建，按有效授权重试',
  DeliverInvitation: '默认交付邀约话术，授权代发则核实发送',
  WriteSchedule: '档案排期写入成功',
  WriteLedger: '台账状态写入成功',
  WriteEvent: '稳定事件身份写入成功',
  SyncFailed: '报告未完成的同步项',
  RetryMissingSync: '只补缺项，不重复创建日程',
  SyncComplete: '三处写入分别核实成功',
  OverviewVerified: '回读事件及人岗日期时段',
  Done: '保持已完成',
})[action];
export const group = (v) => v.phase === 'done' ? '完成' : ['awaiting_user', 'verify_calendar', 'partial'].includes(v.phase) ? '待处理' : '执行';
export const colors = { 完成: 'teal', 待处理: 'orange', 执行: 'blue' };
