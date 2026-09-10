// =============================================================================
// 版本号：从 package.json 读取，避免各处硬编码导致 /health 报错版本。
// 兼容 pkg 打包（此时 cwd 不可靠，用可执行文件所在目录）。
// =============================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

function projectRoot(): string {
  if ((process as any).pkg || process.execPath.toLowerCase().includes('commandcode-proxy')) {
    return path.dirname(process.execPath);
  }
  return process.cwd();
}

function readVersion(): string {
  const candidates = [
    // 1) 模块相对路径：无论 cwd 在哪都指向仓库根（dist/utils/version.js → ../../package.json）
    fileURLToPath(new URL('../../package.json', import.meta.url)),
    // 2) 打包（pkg）或可执行文件与包同目录的场景
    path.join(projectRoot(), 'package.json'),
    // 3) 兜底：上一级目录
    path.join(projectRoot(), '..', 'package.json'),
  ];
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
