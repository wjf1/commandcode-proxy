// =============================================================================
// 版本号：从 package.json 读取，避免各处硬编码导致 /health 报错版本。
// 兼容 pkg 打包（此时 cwd 不可靠，用可执行文件所在目录）。
// =============================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { getProjectRootDir } from './paths.js';

function readVersion(): string {
  const candidates: string[] = [];
  // CJS 打包（esbuild --format=cjs → bundle.cjs，再由 pkg 包进 exe）下 import.meta.url
  // 是空字符串，new URL('../../package.json', '') 会抛 ERR_INVALID_URL。
  // 关键在于抛出点在下面那个 try 之外——它在数组字面量求值时发生，于是整个模块加载
  // 失败、进程在起监听之前就死了，exe 完全不可用。单独包住这一句，让它降级到兜底候选。
  try {
    candidates.push(fileURLToPath(new URL('../../package.json', import.meta.url)));
  } catch {
    // 打包运行时没有 import.meta.url，交给下面的路径兜底
  }
  candidates.push(
    path.join(getProjectRootDir(), 'package.json'),
    path.join(getProjectRootDir(), '..', 'package.json'),
  );
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (typeof parsed?.version === 'string' && parsed.version) return parsed.version;
    } catch {
      // 试下一个候选路径
    }
  }
  return 'unknown';
}

export const PROXY_VERSION = readVersion();
