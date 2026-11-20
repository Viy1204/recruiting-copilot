export const title = '看板刷新 单次读取与过期响应隔离';
export const state = (v) => {
  if (!v.active) return v.flight === 'none' ? '已暂停' : '已暂停，等待旧读取结束';
  if (v.flight === 'none') return '已连接，等待下次读取';
  if (v.flight === 'obsolete') return '旧读取失效，新读取排队';
  if (v.timedOut) return '读取超时，等待请求结束';
  return '正在读取当前工作区';
};
const labels = {
  Resume: '恢复查看',
  Refresh: '开始下一次读取',
  Invalidate: '保存后请求刷新',
  Suspend: '暂停查看',
  Timeout: '本轮读取超时',
};
export const step = (action, from) => {
  if (labels[action]) return labels[action];
  if (from.active && from.queued) return '旧读取结束，开始排队的新读取';
  if (!from.active) return '旧读取结束，不交付响应';
  if (from.timedOut || from.flight === 'obsolete') return '丢弃过期结果，等待重试';
  return action === 'ReceiveSuccess' ? '交付新快照' : '读取失败，保留原快照';
};
export const group = (v) => !v.active ? '暂停' : v.flight === 'obsolete' || v.timedOut ? '等待' : '读取';
export const colors = { 暂停: 'tan', 等待: 'orange', 读取: 'blue' };
