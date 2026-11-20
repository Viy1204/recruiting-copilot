export const title = '岗位配置防止旧请求覆盖新值';

export const state = (value) => {
  if (value.owner === 0) {
    if (Object.values(value.pc).every(phase => phase === 'done')) return '本轮岗位保存请求均已结束';
    return value.revisions[value.kind] > 0 ? '新配置已保存，旧请求待核对' : '同一版本的两个岗位保存请求';
  }
  const phase = Array.isArray(value.pc) ? value.pc[value.owner - 1] : value.pc[value.owner];
  const outcome = Array.isArray(value.outcome) ? value.outcome[value.owner - 1] : value.outcome[value.owner];
  if (phase === 'release') return outcome === 'saved'
    ? '新岗位配置已提交，等待释放写锁'
    : '旧版本请求已拒绝，等待释放写锁';
  return {
    check: '已取得共用写锁，核对配置版本',
    recheck: '替换内容已准备，保存前再次核对',
    rename: '版本匹配，等待原子替换配置',
  }[phase];
};

export const step = (action) => ({
  Acquire: '取得岗位共用写锁',
  FirstVersionCheck: '核对原始配置版本',
  FinalVersionCheck: '保存前再次核对版本',
  RenameConfiguration: '原子替换当前配置文件',
  Release: '释放岗位写锁',
  SeeBusyLock: '另一保存请求遇到写锁并停止',
  AcquireFirst: '取得岗位共用写锁', AcquireSecond: '取得岗位共用写锁',
  CheckFirstRequest: '核对原始配置版本', CheckSecondRequest: '核对原始配置版本',
  RecheckFirstRequest: '保存前再次核对版本', RecheckSecondRequest: '保存前再次核对版本',
  RenameFirstConfiguration: '原子替换当前配置文件', RenameSecondConfiguration: '原子替换当前配置文件',
  ReleaseFirst: '释放岗位写锁', ReleaseSecond: '释放岗位写锁',
  FirstSeesBusyLock: '另一保存请求遇到写锁并停止', SecondSeesBusyLock: '另一保存请求遇到写锁并停止',
  Done: '保留本轮岗位保存结果',
})[action];

export const group = (value) => value.owner === 0 ? '可读取' : '持有岗位写锁';
export const colors = { 可读取: 'blue', 持有岗位写锁: 'orange' };
