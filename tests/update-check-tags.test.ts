// =============================================================================
// P0-3 回归：版本检查必须基于真实存在的版本源。
// -----------------------------------------------------------------------------
// 现状：update-check.ts 打的是 /releases/latest，但本项目只打 git tag、不创建
// GitHub Release 对象。实测 releases/latest 停在 v4.12.0，而 tag 已到 v4.17.0
// —— 于是"发现新版本"从 v4.13.0 起永远不会触发，用户看不到包括重要修复在内的
// 5 个版本。改为读 /tags 并按 semver 取最大。
//
// GitHub /tags 不保证按版本序返回，所以"取最大 semver"是必需的，不能拿第一条。
// =============================================================================
import { describe, it, expect } from 'vitest';

describe('pickLatestTag（P0-3）', () => {
  it('从乱序 tag 列表里取最大 semver，而不是第一条', async () => {
    const { pickLatestTag } = await import('../src/utils/update-check.js');
    const tags = [
      { name: 'v4.9.2' }, { name: 'v4.17.0' }, { name: 'v4.10.0' }, { name: 'v4.9.1' },
    ];
    expect(pickLatestTag(tags)).toBe('v4.17.0');
  });

  it('跨主/次版本正确比较（4.9.9 < 4.10.0 < 4.17.0）', async () => {
    const { pickLatestTag } = await import('../src/utils/update-check.js');
    const tags = [{ name: 'v4.9.9' }, { name: 'v4.10.0' }, { name: 'v5.0.0' }, { name: 'v4.17.0' }];
    expect(pickLatestTag(tags)).toBe('v5.0.0');
  });

  it('忽略非版本号 tag 与脏数据', async () => {
    const { pickLatestTag } = await import('../src/utils/update-check.js');
    const tags = [{ name: 'latest' }, { name: 'v3-beta' }, null, { name: 42 }, {}, { name: 'v4.17.0' }];
    expect(pickLatestTag(tags)).toBe('v4.17.0');
  });

  it('无可用 tag 或非数组响应时返回 null（不发假警报）', async () => {
    const { pickLatestTag } = await import('../src/utils/update-check.js');
    expect(pickLatestTag([])).toBeNull();
    expect(pickLatestTag(undefined)).toBeNull();
    expect(pickLatestTag({ tag_name: 'v4.17.0' })).toBeNull();
    expect(pickLatestTag('v4.17.0')).toBeNull();
  });
});
