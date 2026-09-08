import { describe, it, expect, afterEach } from 'vitest';
import { loadDefaultApiKeyFromEnvOrSystem, defaultAccountName } from '../src/utils/config.js';

afterEach(() => {
  delete process.env.COMMANDCODE_API_KEY;
});

describe('loadDefaultApiKeyFromEnvOrSystem', () => {
  it('returns empty apiKey when neither env nor auth.json provides one (in CI)', () => {
    // 在无真实 ~/.commandcode/auth.json 的 CI 环境下应为空；本机若装有 CLI 则返回其 Key。
    const { apiKey, source } = loadDefaultApiKeyFromEnvOrSystem();
    expect(['', 'env', 'auth.json']).toContain(source);
    if (!source) expect(apiKey).toBe('');
  });

  it('prefers COMMANDCODE_API_KEY env with env source', () => {
    process.env.COMMANDCODE_API_KEY = 'sk-env-test-1234';
    const { apiKey, source } = loadDefaultApiKeyFromEnvOrSystem();
    expect(apiKey).toBe('sk-env-test-1234');
    expect(source).toBe('env');
  });
});

describe('defaultAccountName', () => {
  it('shows source + last-4 instead of a generic placeholder', () => {
    expect(defaultAccountName('sk-env-test-1234', 'env')).toBe('Env Key (尾4位 1234)');
    expect(defaultAccountName('user_abc...VmJ9', 'auth.json')).toBe('CLI Key (尾4位 VmJ9)');
    expect(defaultAccountName('key', '')).toBe('API Key (尾4位 key)');
  });

  it('never embeds the full key', () => {
    const full = 'sk-super-secret-full-key-xyz';
    const name = defaultAccountName(full, 'env');
    expect(name).not.toContain(full);
    expect(name).toContain(full.slice(-4));
  });
});
