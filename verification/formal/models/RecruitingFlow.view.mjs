export const title = '招聘主流程 从筛选到约面进展可见';
const labels = {
  read: '读取已确认岗位标准',
  screen: '取简历、筛选并记录依据',
  awaiting_user: '等待用户决定',
  deferred: '已暂缓，保留事项',
  ready: '已获授权，等待执行',
  verify_result: '结果不确定，先核实外部状态',
  sync_pending: '外部已成功，档案待同步',
  read_overview: '档案事件已写，待回读总览',
  done: '进展已核实可见',
};
export const state = (v) => labels[v.phase];
const steps = {
  ReadConfirmedStandards: '按现行标准开工',
  ScreenAndRecord: '发现需要确认的后续动作',
  UserApproves: '用户批准本次动作',
  UserDefers: '用户选择暂缓',
  ResumeDecision: '继续讨论此事项',
  ExternalSuccess: '约面动作核实成功',
  ExternalUncertain: '返回结果不足以判断成功',
  VerifyAlreadySucceeded: '核实已经成功，避免重复执行',
  VerifyNotExecuted: '核实尚未执行，可按有效授权续办',
  RecordProfileEvent: '用稳定事件身份同步档案',
  ReadBackOverview: '回读总览，确认事件可达',
  Done: '保持已完成',
};
export const step = (action) => steps[action];
export const group = (v) => v.phase === 'done' ? '完成' : ['awaiting_user', 'deferred', 'verify_result', 'sync_pending'].includes(v.phase) ? '待处理' : '进行';
export const colors = { 完成: 'teal', 待处理: 'orange', 进行: 'blue' };
