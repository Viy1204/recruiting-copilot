export const title = '本轮结束结果可信 步骤收尾后完成 终态保持不变';
const labels = {
  running: '本轮正在处理',
  waiting: '本轮暂停，等待确认或外部条件',
  completed: '步骤全部收尾，本轮已完成',
  failed: '本轮失败，记录已冻结',
  cancelled: '本轮取消，记录已冻结',
};
// 投影掉两项步骤的具体组合；相同状态内的步骤推进不另画箭头。
// sealed 只观察终态是否变化；不隐藏违反主要性质的状态。
export function state(v) {
  if (v.sealed.ended && (v.sealed.status !== v.status || JSON.stringify(v.sealed.steps) !== JSON.stringify(v.steps))) return '已经结束的轮次又被改写';
  if (v.status === 'completed' && [v.steps[1], v.steps[2]].some(value => !['completed', 'skipped'].includes(value))) return '仍有步骤未收尾，却已报告完成';
  return labels[v.status];
}
const labelsForStep = {
  StartStep: '继续处理本轮步骤',
  CompleteStep: '继续处理本轮步骤',
  SkipStep: '继续处理本轮步骤',
  Wait: '等待用户或外部条件',
  CompleteRun: '所有步骤完成或写明跳过理由，结束本轮',
  FailStep: '本轮失败并冻结记录',
  FailRun: '本轮失败并冻结记录',
  CancelRun: '取消本轮并冻结记录',
  Done: '保持结束结果',
};
export const step = action => labelsForStep[action];
export const group = v => ['completed', 'failed', 'cancelled'].includes(v.status) ? '已结束' : '处理中';
export const colors = { 已结束: 'teal', 处理中: 'blue' };
