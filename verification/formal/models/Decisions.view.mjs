export const title = '事项依据不被旧版本覆盖 同一请求只登记一次';
// 合并客户端身份、读取版本与拒绝/重放回执；它们不改变用户已登记的依据。
// 读当前版本及无变化的拒绝/重放落在同一标签内，不单画箭头。
export function state(v) {
  const entries = Object.values(v.history);
  if (new Set(entries.map(entry => entry.request)).size !== entries.length) return '同一请求被重复登记';
  if (entries.some(entry => entry.expected !== entry.base)) return '旧版本请求覆盖了新依据';
  if (v.revision !== entries.length + 1 || (entries.length && v.current !== entries.at(-1).request)) return '当前事项与修订历史不一致';
  return ['事项已登记，等待新增依据', '已登记一份新依据', '两份依据均已登记'][entries.length];
}
const labels = {
  ReadCurrent: '重新读取事项当前版本',
  ApplyEvidence: '版本一致，登记一份新依据',
  RejectStale: '拒绝旧版本写入，保留当前事项',
  ReplayRequest: '返回原请求回执，保留当前事项',
  RejectRequestConflict: '拒绝复用请求身份修改内容',
  Done: '保持已登记的依据',
};
export const step = action => labels[action];
export const group = v => Object.keys(v.history).length === 2 ? '依据已登记' : '等待后续依据';
export const colors = { 依据已登记: 'teal', 等待后续依据: 'blue' };
