import { describe, it, expect } from 'vitest';
import {
  normalizeSeverity,
  severityFromReportPolicy,
  routeSeverity,
} from './severity-router';

describe('normalizeSeverity', () => {
  it('returns valid severity unchanged', () => {
    expect(normalizeSeverity('L1')).toBe('L1');
    expect(normalizeSeverity('L2')).toBe('L2');
    expect(normalizeSeverity('L3')).toBe('L3');
    expect(normalizeSeverity('L4')).toBe('L4');
  });

  it('falls back to L2 on invalid input', () => {
    expect(normalizeSeverity('L0')).toBe('L2');
    expect(normalizeSeverity('high')).toBe('L2');
    expect(normalizeSeverity('')).toBe('L2');
    expect(normalizeSeverity(null)).toBe('L2');
    expect(normalizeSeverity(undefined)).toBe('L2');
    expect(normalizeSeverity(42)).toBe('L2');
  });
});

describe('severityFromReportPolicy', () => {
  it('silent → L1', () => {
    expect(severityFromReportPolicy('silent')).toBe('L1');
  });

  it('notification → L2', () => {
    expect(severityFromReportPolicy('notification')).toBe('L2');
  });

  it('legacy channel → L2', () => {
    expect(severityFromReportPolicy('channel')).toBe('L2');
  });

  it('default (legacy) → L2', () => {
    expect(severityFromReportPolicy('default')).toBe('L2');
  });

  it('kakao → L4', () => {
    expect(severityFromReportPolicy('kakao')).toBe('L4');
  });

  it('all → L4', () => {
    expect(severityFromReportPolicy('all')).toBe('L4');
  });

  it('null / undefined / unknown → L2 (safe default)', () => {
    expect(severityFromReportPolicy(null)).toBe('L2');
    expect(severityFromReportPolicy(undefined)).toBe('L2');
    expect(severityFromReportPolicy('lol')).toBe('L2');
  });
});

describe('routeSeverity', () => {
  it('L1 — nothing', () => {
    expect(routeSeverity('L1')).toEqual({
      notifyInApp: false,
      mention: false,
      boardIssue: false,
    });
  });

  it('L2 — Notification only', () => {
    expect(routeSeverity('L2')).toEqual({
      notifyInApp: true,
      mention: false,
      boardIssue: false,
    });
  });

  it('L3 — Notification + board issue, no mention', () => {
    expect(routeSeverity('L3')).toEqual({
      notifyInApp: true,
      mention: false,
      boardIssue: true,
    });
  });

  it('L4 — high-priority Notification + board + mention', () => {
    expect(routeSeverity('L4')).toEqual({
      notifyInApp: true,
      mention: true,
      boardIssue: true,
    });
  });
});
