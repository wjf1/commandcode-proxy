import { describe, it, expect } from 'vitest';
import {
  ErrorCode,
  ProxyError,
  codeForStatus,
  terminalCodeFor,
  toProxyError,
} from '../src/utils/errors.js';
import { isRetryableFailure } from '../src/adapters/commandcode/upstream.js';

describe('codeForStatus', () => {
  it('maps auth failures to INVALID_CREDENTIAL', () => {
    expect(codeForStatus(401)).toBe(ErrorCode.INVALID_CREDENTIAL);
    expect(codeForStatus(403)).toBe(ErrorCode.INVALID_CREDENTIAL);
  });

  it('maps quota/payment failures to RATE_LIMIT', () => {
    expect(codeForStatus(402)).toBe(ErrorCode.RATE_LIMIT);
    expect(codeForStatus(429)).toBe(ErrorCode.RATE_LIMIT);
  });

  it('maps 404 to MODEL_NOT_FOUND and 5xx to SERVER_ERROR', () => {
    expect(codeForStatus(404)).toBe(ErrorCode.MODEL_NOT_FOUND);
    expect(codeForStatus(500)).toBe(ErrorCode.SERVER_ERROR);
    expect(codeForStatus(503)).toBe(ErrorCode.SERVER_ERROR);
  });

  it('treats 400/422 as request-shape problems, not network problems', () => {
    expect(codeForStatus(400)).toBe(ErrorCode.UNSUPPORTED_OPTION);
    expect(codeForStatus(422)).toBe(ErrorCode.UNSUPPORTED_OPTION);
  });

  it('falls back to NETWORK_ERROR for transport-level failures', () => {
    expect(codeForStatus(undefined)).toBe(ErrorCode.NETWORK_ERROR);
    expect(codeForStatus(0)).toBe(ErrorCode.NETWORK_ERROR);
  });
});

describe('terminalCodeFor', () => {
  it('detects the three terminal billing/plan markers', () => {
    expect(terminalCodeFor('error: model_not_in_plan')).toBe(ErrorCode.MODEL_NOT_IN_PLAN);
    expect(terminalCodeFor('premium_credits_exhausted')).toBe(ErrorCode.RATE_LIMIT);
    expect(terminalCodeFor('Insufficient credits to run this model')).toBe(ErrorCode.RATE_LIMIT);
  });

  it('is case-insensitive and returns undefined for ordinary errors', () => {
    expect(terminalCodeFor('MODEL_NOT_IN_PLAN')).toBe(ErrorCode.MODEL_NOT_IN_PLAN);
    expect(terminalCodeFor('upstream is overloaded')).toBeUndefined();
    expect(terminalCodeFor('')).toBeUndefined();
  });
});

describe('isRetryableFailure (terminal errors must never be retried)', () => {
  it('retries plain retryable statuses', () => {
    expect(isRetryableFailure(429, 'too many requests')).toBe(true);
    expect(isRetryableFailure(503, 'upstream unavailable')).toBe(true);
    expect(isRetryableFailure(500, 'boom')).toBe(true);
  });

  it('never retries terminal billing/plan errors, even on 429/5xx', () => {
    expect(isRetryableFailure(429, 'insufficient credits')).toBe(false);
    expect(isRetryableFailure(500, 'premium_credits_exhausted')).toBe(false);
    expect(isRetryableFailure(403, 'model_not_in_plan')).toBe(false);
  });

  it('does not retry non-retryable statuses', () => {
    expect(isRetryableFailure(400, 'bad request')).toBe(false);
    expect(isRetryableFailure(404, 'nope')).toBe(false);
  });
});

describe('ProxyError', () => {
  it('derives the HTTP status from the code', () => {
    expect(new ProxyError(ErrorCode.RATE_LIMIT, 'x').status).toBe(429);
    expect(new ProxyError(ErrorCode.MODEL_NOT_IN_PLAN, 'x').status).toBe(403);
    expect(new ProxyError(ErrorCode.GATEWAY_PAUSED, 'x').status).toBe(503);
    expect(new ProxyError(ErrorCode.STREAM_IDLE_TIMEOUT, 'x').status).toBe(504);
  });

  it('lets the caller override the status (to pass through the upstream one)', () => {
    expect(new ProxyError(ErrorCode.MODEL_NOT_FOUND, 'x', { status: 418 }).status).toBe(418);
  });

  it('exposes a non-empty hint for every code', () => {
    for (const code of Object.values(ErrorCode)) {
      const hint = new ProxyError(code, 'boom').hint;
      expect(hint, `hint missing for ${code}`).toBeTruthy();
      expect(hint.length).toBeGreaterThan(20);
    }
  });

  it('builds an OpenAI-shaped error payload', () => {
    const payload = new ProxyError(ErrorCode.RATE_LIMIT, 'window exhausted').openAIPayload();
    expect(payload).toMatchObject({
      message: 'window exhausted',
      type: 'rate_limit_error',
      code: 'RATE_LIMIT',
      param: null,
    });
    expect(payload.hint).toContain('usage window');
  });

  it('builds an Anthropic-shaped error envelope', () => {
    const payload = new ProxyError(ErrorCode.MODEL_NOT_IN_PLAN, 'tier too low').anthropicPayload();
    expect(payload.type).toBe('error');
    expect(payload.error.type).toBe('permission_error');
    expect(payload.error.code).toBe('MODEL_NOT_IN_PLAN');
    expect(payload.error.hint).toBeTruthy();
  });

  it('maps authentication failures into each family correctly', () => {
    const err = new ProxyError(ErrorCode.PROXY_AUTH_REQUIRED, 'nope');
    expect(err.openAIPayload().type).toBe('authentication_error');
    expect(err.anthropicPayload().error.type).toBe('authentication_error');
    expect(err.status).toBe(401);
  });

  it('serializes to JSON with code, status and hint', () => {
    const json = new ProxyError(ErrorCode.SERVER_ERROR, 'boom').toJSON();
    expect(json).toMatchObject({ code: 'SERVER_ERROR', status: 502, retryable: false });
    expect(json.hint).toBeTruthy();
  });
});

describe('toProxyError', () => {
  it('passes ProxyError through unchanged', () => {
    const original = new ProxyError(ErrorCode.MODEL_NOT_FOUND, 'x');
    expect(toProxyError(original)).toBe(original);
  });

  it('classifies plain errors by their message', () => {
    const converted = toProxyError(new Error('upstream said insufficient credits'));
    expect(converted.code).toBe(ErrorCode.RATE_LIMIT);
  });

  it('falls back to the supplied code for unknown errors', () => {
    expect(toProxyError(new Error('weird')).code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(toProxyError(new Error('weird'), ErrorCode.PROVIDER_PROTOCOL_ERROR).code).toBe(
      ErrorCode.PROVIDER_PROTOCOL_ERROR,
    );
  });

  it('handles non-Error throwables', () => {
    const converted = toProxyError('string failure');
    expect(converted.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(converted.message).toBe('string failure');
  });
});
