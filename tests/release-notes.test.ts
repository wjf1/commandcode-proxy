// =============================================================================
// 发布正文提取器的契约测试。
// 重点是**失败路径**：取不到正文时必须非零退出，否则 workflow 会静默发出一个
// 空正文的 Release —— 而"静默不生效"正是这套自动化要消灭的东西。
// =============================================================================
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractSection, versionFromRef } from '../scripts/extract-release-notes.mjs';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'extract-release-notes.mjs');

const FIXTURE = [
  '# Changelog',
  '',
  '## [2.0.0] - 2026-09-21',
  '',
  '### 修复',
  '- 二点零的内容',
  '',
  '## [1.1.0] - 2026-09-01',
  '',
  '### 新增',
  '- 一点一零的内容',
  '',
  '## [1.0.0] - 2026-08-01',
  '',
  '- 一零零的内容',
  '',
].join('\n');

describe('versionFromRef', () => {
  it('接受 vX.Y.Z', () => {
    expect(versionFromRef('v4.18.0')).toBe('4.18.0');
    expect(versionFromRef('v4.9.2')).toBe('4.9.2');
  });

  it('拒绝 refs/tags/ 前缀与非补丁号形式，避免误发', () => {
    expect(versionFromRef('refs/tags/v4.18.0')).toBeNull();
    expect(versionFromRef('v4.18')).toBeNull();
    expect(versionFromRef('4.18.0')).toBeNull();
    expect(versionFromRef('latest')).toBeNull();
    expect(versionFromRef('')).toBeNull();
  });
});

describe('extractSection', () => {
  it('取到对应版本的正文，且不含标题行', () => {
    const body = extractSection(FIXTURE, '1.1.0');
    expect(body).toContain('一点一零的内容');
    expect(body).not.toContain('## [1.1.0]');
  });

  it('不越界吃进相邻版本的内容', () => {
    const body = extractSection(FIXTURE, '1.1.0');
    expect(body).not.toContain('二点零的内容');
    expect(body).not.toContain('一零零的内容');
  });

  it('CHANGELOG 里没有该版本时返回 null', () => {
    expect(extractSection(FIXTURE, '9.9.9')).toBeNull();
  });

  it('对本仓库真实 CHANGELOG 成立：4.18.0 段存在且含批次 A 的关键字', () => {
    const md = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');
    const body = extractSection(md, '4.18.0');
    expect(body).not.toBeNull();
    expect(body).toContain('onRetry');
    expect(body).toContain('upstream.timeoutMs');
  });
});

describe('CLI 退出码（workflow 依赖它做失败判定）', () => {
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });

  it('版本存在时退出码 0，正文写到 stdout', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'relnotes-'));
    const file = path.join(dir, 'CHANGELOG.md');
    writeFileSync(file, FIXTURE);
    const r = run(['v2.0.0', file]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('二点零的内容');
  });

  it('版本不在 CHANGELOG 里时非零退出并说明原因', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'relnotes-'));
    const file = path.join(dir, 'CHANGELOG.md');
    writeFileSync(file, FIXTURE);
    const r = run(['v7.7.7', file]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('CHANGELOG.md 里没有 [7.7.7]');
  });

  it('tag 名不合规范时非零退出（不会发出莫名版本的 Release）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'relnotes-'));
    const file = path.join(dir, 'CHANGELOG.md');
    writeFileSync(file, FIXTURE);
    const r = run(['nightly', file]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('无法从 "nightly" 解析');
  });
});
