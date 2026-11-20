export const title = '约面任务收尾前 须回读到关联本轮的候选人档案事件';
// 合并缺失、未关联、关联别轮、坏记录与不可读原因；均不能通过收尾检查。
// 只有 ready 展示档案是否补齐；回读后的档案变化不改写已读快照。
// 不隐藏动作；标签相同的内部变化由 statechart 自动折叠。
export function state(v) {
  if (v.phase === 'ready') return v.archive === 'linked' ? '档案事件已关联本轮，等待回读' : '步骤已收尾，档案事件待补齐';
  if (v.phase === 'observed') return v.observed === 'linked' ? '已读到本轮候选人的合格档案事件' : '回读未找到合格的档案事件';
  if (v.phase === 'checked') return v.observed === 'linked' ? '档案核对通过，等待整理完成记录' : '档案不合格却通过了核对';
  if (v.phase === 'staged') return v.observed === 'linked' ? '完成记录已生成，等待写入任务' : '缺少合格档案事件却生成完成记录';
  return v.observed === 'linked' ? '本轮已完成，收尾时已核对档案事件' : '本轮已完成，却未核对到对应档案事件';
}
const labels = {
  ArchiveChanges: '档案内容发生变化',
  ReadArchive: '回读已关联候选人的档案事件',
  RejectMissingEvent: '拒绝收尾，补齐或核实后重试',
  ApproveArchive: '核对候选人、来源任务和事件有效性',
  StageCompletion: '整理任务重点与完成记录',
  PublishCompletion: '将完成记录写入本轮任务',
  Done: '保持本轮完成状态',
};
export const step = action => labels[action];
export const group = v => v.phase === 'completed' ? '已完成' : v.phase === 'checked' || v.phase === 'staged' ? '核对通过' : '待核对';
export const colors = { 已完成: 'teal', 核对通过: 'blue', 待核对: 'orange' };
