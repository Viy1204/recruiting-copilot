export const title = '候选资料清单拒绝旧版本覆盖';

export const state = (value) => {
  if (value.owner === 'none') {
    if (Object.values(value.pc).every(phase => phase === 'done')) return '本轮资料请求均已结束';
    if (Object.values(value.pc).some(phase => phase === 'done')) return '另一份同版请求待处理';
    return '两份请求使用同一清单版本';
  }
  const phase = value.pc[value.owner];
  if (phase === 'release') return {
    saved: '新清单已保存，等待释放写锁',
    conflict: '旧请求已拒绝，等待释放写锁',
    interrupted: '导入已中断 原件保留 清单未提交',
  }[value.outcome[value.owner]];
  return {
    check: '已取得资料写锁，核对清单版本',
    prepare: '版本一致，准备关联资料',
    archived: '原件已归档，清单尚未提交',
    rename: '清单已复核，等待原子替换',
  }[phase];
};

export const step = (action) => ({
  Acquire: '取得资料写锁',
  CheckRevision: '核对请求版本',
  RecheckMapping: '保存前复核清单',
  RenameMapping: '原子替换资料清单',
  Release: '释放资料写锁',
  SeeBusyLock: '另一请求遇到写锁并停止',
  AcquireSet: '取得资料写锁', AcquireImport: '取得资料写锁',
  CheckSetRevision: '核对请求版本', CheckImportRevision: '核对请求版本',
  PublishImportedOriginal: '单独发布归档原件',
  InterruptImport: '导入中断，允许留下未关联原件',
  RecheckSetMapping: '保存前复核清单', RecheckImportMapping: '保存前复核清单',
  RenameSetMapping: '原子替换资料清单', RenameImportMapping: '原子替换资料清单',
  ReleaseSet: '释放资料写锁', ReleaseImport: '释放资料写锁',
  SetSeesBusyLock: '另一请求遇到写锁并停止', ImportSeesBusyLock: '另一请求遇到写锁并停止',
  Done: '保留本轮结果',
})[action];

export const group = (value) => value.owner === 'none' ? '可读取' : '持有资料写锁';
export const colors = { 可读取: 'blue', 持有资料写锁: 'orange' };
