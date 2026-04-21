import { describe, expect, it } from 'vitest';
import { isAcpAuthRequired, isAcpCancelled } from '../src/errors.js';

describe('isAcpCancelled', () => {
  it('matches JSON-RPC cancellation code', () => {
    expect(isAcpCancelled({ code: -32800, message: 'whatever' })).toBe(true);
  });

  it('matches "cancelled" / "canceled" / "aborted" in message', () => {
    expect(isAcpCancelled({ message: 'Request was cancelled' })).toBe(true);
    expect(isAcpCancelled({ message: 'Request was canceled' })).toBe(true);
    expect(isAcpCancelled({ message: 'operation aborted by user' })).toBe(true);
  });

  it('matches text inside error.data', () => {
    expect(isAcpCancelled({ data: { details: 'turn cancelled' } })).toBe(true);
    expect(isAcpCancelled({ data: { message: 'aborted' } })).toBe(true);
  });

  it('returns false for non-cancellation errors', () => {
    expect(isAcpCancelled({ code: -32603, message: 'Internal error' })).toBe(false);
    expect(isAcpCancelled(new Error('disk full'))).toBe(false);
  });

  it('returns false for non-objects', () => {
    expect(isAcpCancelled(null)).toBe(false);
    expect(isAcpCancelled(undefined)).toBe(false);
    expect(isAcpCancelled('cancelled')).toBe(false);
  });
});

describe('isAcpAuthRequired', () => {
  it('matches JSON-RPC auth-required code', () => {
    expect(isAcpAuthRequired({ code: -32000 })).toBe(true);
  });

  it('matches messages requiring authentication', () => {
    expect(isAcpAuthRequired({ message: 'Authentication required' })).toBe(true);
    expect(isAcpAuthRequired({ data: { details: 'auth is required for this method' } })).toBe(true);
  });

  it('does not match cancellation', () => {
    expect(isAcpAuthRequired({ code: -32800, message: 'cancelled' })).toBe(false);
  });

  it('returns false for messages mentioning only one of auth/require', () => {
    expect(isAcpAuthRequired({ message: 'auth failed' })).toBe(false);
    expect(isAcpAuthRequired({ message: 'this is required' })).toBe(false);
  });
});
