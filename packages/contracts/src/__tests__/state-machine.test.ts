import { describe, it, expect } from 'vitest';
import { TRANSITIONS, findTransition, isTerminal, allowedTriggers } from '../state-machine.js';
import { BookingState } from '../enums.js';

describe('booking state machine', () => {
  it('has no ambiguous transitions', () => {
    const seen = new Set<string>();
    for (const t of TRANSITIONS) {
      const key = `${t.from}:${t.trigger}`;
      expect(seen.has(key), `duplicate transition ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('every non-terminal state can be left', () => {
    for (const s of BookingState.options) {
      if (isTerminal(s) || s === 'completed') continue;
      expect(allowedTriggers(s).length, `${s} is a dead end`).toBeGreaterThan(0);
    }
  });

  it('terminal states accept nothing', () => {
    for (const s of BookingState.options) {
      if (!isTerminal(s)) continue;
      expect(allowedTriggers(s)).toEqual([]);
    }
  });

  it('money never moves without a payment guard', () => {
    const confirm = findTransition('pending_accept', 'token_captured');
    expect(confirm?.to).toBe('confirmed');
    expect(confirm?.guards).toContain('payment_captured');
    expect(confirm?.guards).toContain('slot_still_open');
  });

  it('completion requires the cash amount to match in cash mode', () => {
    const complete = findTransition('in_progress', 'complete_otp_verified');
    expect(complete?.guards).toContain('cash_amount_matches_if_cash');
    expect(complete?.guards).toContain('otp_valid');
  });

  it('cannot skip straight from confirmed to completed', () => {
    expect(findTransition('confirmed', 'complete_otp_verified')).toBeUndefined();
  });

  it('cancelling a confirmed booking always raises a refund event', () => {
    for (const trigger of ['cancel_devotee', 'cancel_pandit'] as const) {
      expect(findTransition('confirmed', trigger)?.emits).toContain('booking.refund_due');
    }
  });

  it('the happy path is reachable end to end', () => {
    let state: BookingState = 'draft';
    const path = ['submit', 'pandit_accept', 'token_captured', 'start_otp_verified',
                  'complete_otp_verified', 'review_window_closed'] as const;
    for (const trigger of path) {
      const t = findTransition(state, trigger);
      expect(t, `stuck at ${state} on ${trigger}`).toBeDefined();
      state = t!.to;
    }
    expect(state).toBe('reviewed');
  });
});
