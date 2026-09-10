import { describe, it, expect } from 'vitest';
import {
  KNOWN_PLAN_KEYS,
  PLAN_TIERS,
  availablePlanNames,
  buildAvailabilityMap,
  isModelAvailableForPlan,
  planLabelForModel,
  planName,
  planTier,
} from '../src/utils/plans.js';

/** 上游定价页实测的 claude-opus-4-8 availability（Go 档位为 false）。 */
const OPUS_AVAILABILITY = {
  'individual-go': false,
  'individual-goat': false,
  'individual-pro': false,
  'individual-pro-v1': false,
  'individual-provider': true,
  'individual-max': true,
  'individual-ultra': true,
  'teams-pro': true,
  all: true,
};

/** 典型开源模型：Go 档位可用。 */
const OPEN_MODEL_AVAILABILITY = {
  'individual-go': true,
  'individual-goat': true,
  'individual-pro': true,
  'individual-provider': true,
  all: true,
};

describe('plan tier table', () => {
  it('carries the credit/cap values verified from the official docs', () => {
    expect(PLAN_TIERS['individual-go']).toMatchObject({ name: 'Go', monthlyCredits: 10, fiveHourCap: 3, weeklyCap: 6 });
    expect(PLAN_TIERS['individual-goat']).toMatchObject({ name: 'GOAT', monthlyCredits: 70, fiveHourCap: 14, weeklyCap: 35 });
    expect(PLAN_TIERS['individual-pro']).toMatchObject({ name: 'Pro', monthlyCredits: 80, fiveHourCap: 16, weeklyCap: 40 });
    expect(PLAN_TIERS['teams-pro']).toMatchObject({ name: 'Team Pro', monthlyCredits: 40, fiveHourCap: 12, weeklyCap: 24 });
  });

  it('does not invent numbers for tiers whose planId mapping is unverified', () => {
    for (const id of ['individual-max', 'individual-ultra', 'individual-pro-v1', 'individual-provider']) {
      expect(PLAN_TIERS[id].monthlyCredits, id).toBeUndefined();
      expect(PLAN_TIERS[id].fiveHourCap, id).toBeUndefined();
      expect(PLAN_TIERS[id].weeklyCap, id).toBeUndefined();
    }
  });

  it('resolves names, and falls back to the raw planId when unknown', () => {
    expect(planName('individual-go')).toBe('Go');
    expect(planName('individual-goat')).toBe('GOAT');
    expect(planName('individual-brand-new')).toBe('individual-brand-new');
    expect(planName(undefined)).toBeUndefined();
    expect(planTier('individual-nope')).toBeUndefined();
  });

  it('never treats the unverified "all" key as a plan tier', () => {
    expect(KNOWN_PLAN_KEYS).not.toContain('all');
  });
});

describe('isModelAvailableForPlan', () => {
  it('follows the explicit per-plan key', () => {
    expect(isModelAvailableForPlan(OPUS_AVAILABILITY, 'individual-go')).toBe(false);
    expect(isModelAvailableForPlan(OPUS_AVAILABILITY, 'individual-provider')).toBe(true);
    expect(isModelAvailableForPlan(OPEN_MODEL_AVAILABILITY, 'individual-go')).toBe(true);
  });

  it('ignores the "all" flag, which does not mean every plan', () => {
    // claude-opus-4-8 has all:true yet is NOT usable on Go (verified against the
    // live API: HTTP 403 MODEL_NOT_IN_PLAN).
    expect(OPUS_AVAILABILITY.all).toBe(true);
    expect(isModelAvailableForPlan(OPUS_AVAILABILITY, 'individual-go')).toBe(false);
  });

  it('fails open when the data or the plan key is missing', () => {
    expect(isModelAvailableForPlan(undefined, 'individual-go')).toBeUndefined();
    expect(isModelAvailableForPlan({}, 'individual-go')).toBeUndefined();
    expect(isModelAvailableForPlan(OPUS_AVAILABILITY, 'individual-unknown')).toBeUndefined();
    expect(isModelAvailableForPlan(OPUS_AVAILABILITY, undefined)).toBeUndefined();
  });
});

describe('buildAvailabilityMap (upstream availability → stored map)', () => {
  it('keeps every plan key instead of collapsing to a single boolean', () => {
    const map = buildAvailabilityMap({
      'individual-go': false,
      'individual-goat': false,
      'individual-provider': true,
      all: true,
    });
    expect(map).toEqual({
      'individual-go': false,
      'individual-goat': false,
      'individual-provider': true,
      all: true,
    });
    // The whole point of keeping the map: Go and Provider differ for one model.
    expect(isModelAvailableForPlan(map, 'individual-go')).toBe(false);
    expect(isModelAvailableForPlan(map, 'individual-provider')).toBe(true);
  });

  it('drops non-boolean values', () => {
    expect(buildAvailabilityMap({ a: true, b: 'true', c: 1, d: null })).toEqual({ a: true });
  });

  it('returns undefined for unusable input', () => {
    expect(buildAvailabilityMap(undefined)).toBeUndefined();
    expect(buildAvailabilityMap(null)).toBeUndefined();
    expect(buildAvailabilityMap('nope')).toBeUndefined();
    expect(buildAvailabilityMap([])).toBeUndefined();
    expect(buildAvailabilityMap({})).toBeUndefined();
    expect(buildAvailabilityMap({ a: 'x' })).toBeUndefined();
  });
});

describe('model plan labels', () => {
  it('lists the plans a model is explicitly available on', () => {
    expect(availablePlanNames(OPEN_MODEL_AVAILABILITY)).toEqual(['Go', 'GOAT', 'Pro', 'Provider']);
    expect(availablePlanNames(OPUS_AVAILABILITY)).toEqual(['Provider', 'Max', 'Ultra', 'Team Pro']);
  });

  it('folds long availability lists and renders short ones verbatim', () => {
    expect(planLabelForModel({ 'individual-go': true, 'individual-goat': true })).toBe('Go · GOAT');
    expect(planLabelForModel(OPEN_MODEL_AVAILABILITY)).toBe('多档位 (4)');
    expect(planLabelForModel(undefined)).toBeUndefined();
    expect(planLabelForModel({})).toBeUndefined();
  });
});
