// =============================================================================
// 路径解析（无项目内依赖，供 logger/config/models 共用，避免循环导入）
// -----------------------------------------------------------------------------
// pkg 打包产物取 exe 所在目录，源码运行取 cwd。
// =============================================================================
import path from 'path';

export function getProjectRootDir(): string {
  if ((process as any).pkg || process.execPath.toLowerCase().includes('commandcode-proxy')) {
    return path.dirname(process.execPath);
  }
  return process.cwd();
}
