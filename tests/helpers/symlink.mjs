import { symlink } from 'node:fs/promises';

/**
 * Creates a directory symlink on POSIX or a directory junction on Windows,
 * which works without elevated symlink privileges.
 * @param {string} target
 * @param {string} linkPath
 */
export async function linkDir(target, linkPath) {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Attempts to create a file symlink. On Windows without developer-mode or
 * admin symlink privilege (`EPERM`), records a test diagnostic and returns `false`
 * instead of failing `npm test`. All other errors are rethrown.
 * @param {{ diagnostic?: (message: string) => void } | null | undefined} t
 * @param {string} target
 * @param {string} linkPath
 * @param {string} [diagnosticMessage]
 * @returns {Promise<boolean>}
 */
export async function tryLinkFile(
  t,
  target,
  linkPath,
  diagnosticMessage = '当前 Windows 账户无普通文件 symlink 权限；目录 junction 与工作区边界已验证'
) {
  try {
    await symlink(target, linkPath, 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') {
      t?.diagnostic?.(diagnosticMessage);
      return false;
    }
    throw error;
  }
}
