#!/usr/bin/env node
// =============================================================================
// 从 CHANGELOG.md 取出指定版本的正文，供 GitHub Release 使用。
// -----------------------------------------------------------------------------
// 存在理由：v4.13.0 起的 6 个版本只打了 tag、没建 Release 对象，而应用内检查读的是
// /releases/latest —— 于是"发现新版本"静默失效了 5 天。人工建 Release 正是这次的病根，
// 所以这里刻意做成：**取不到就非零退出**，让 workflow 红掉，而不是悄悄发一个空正文的 Release。
// =============================================================================
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** 取出版本正文；CHANGELOG 里没有该版本时返回 null。 */
export function extractSection(markdown, version) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const heads = [];
  lines.forEach((line, i) => {
    const m = /^## \[(\d+\.\d+\.\d+)\]/.exec(line);
    if (m) heads.push({ ver: m[1], start: i });
  });
  const idx = heads.findIndex(h => h.ver === version);
  if (idx < 0) return null;
  const end = idx + 1 < heads.length ? heads[idx + 1].start : lines.length;
  // 丢掉 `## [x.y.z] - 日期` 标题行：Release 标题已含版本，日期由 GitHub 记录。
  return lines.slice(heads[idx].start + 1, end).join('\n').trim() + '\n';
}

/** tag 名 → CHANGELOG 版本段名。只接受 vX.Y.Z，其余一律拒绝。 */
export function versionFromRef(refName) {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(String(refName || '').trim());
  return m ? m[1] : null;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).replace(/\\/g, '/') === fileURLToPath(import.meta.url).replace(/\\/g, '/');

if (isMain) {
  const [refName, changelogPath] = process.argv.slice(2);
  if (!refName || !changelogPath) {
    console.error('用法: extract-release-notes.mjs <tag 或 vX.Y.Z> <CHANGELOG 路径>');
    process.exit(2);
  }
  const version = versionFromRef(refName) || (/^\d+\.\d+\.\d+$/.test(refName) ? refName : null);
  if (!version) {
    console.error(`无法从 "${refName}" 解析出 vX.Y.Z 形式的版本号——拒绝发布，请检查 tag 命名。`);
    process.exit(1);
  }
  const body = extractSection(readFileSync(changelogPath, 'utf-8'), version);
  if (body === null) {
    console.error(`CHANGELOG.md 里没有 [${version}] 段落。发布前先补记录，不发空正文的 Release。`);
    process.exit(1);
  }
  if (!body.trim()) {
    console.error(`[${version}] 段落正文为空。`);
    process.exit(1);
  }
  process.stdout.write(body);
}
