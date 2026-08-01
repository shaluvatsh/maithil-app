import { type BookingState, TERMINAL_STATES } from './enums.js';

/**
 * Booking state machine. The spine of the system - every other module reacts to
 * the events it emits rather than calling into it. See ADR 0001 and 0005.
 *
 * Declared as data so it can be tested exhaustively and rendered in the admin UI.
 */
export type BookingTrigger =
  | 'submit'
  | 'pandit_accept'
  | 'pandit_decline'
  | 'accept_window_expired'
  | 'token_captured'
  | 'start_otp_verified'
  | 'complete_otp_verified'
  | 'cancel_devotee'
  | 'cancel_pandit'
  | 'review_window_closed';

export interface Transition {
  from: BookingState;
  trigger: BookingTrigger;
  to: BookingState;
  /** Named guards, evaluated by the service layer. Documented, not magic strings. */
  guards: readonly string[];
  /** Domain events emitted via the outbox, inside the same transaction. */
  emits: readonly string[];
}

export const TRANSITIONS: readonly Transition[] = [
  { from: 'draft', trigger: 'submit', to: 'pending_accept',
    guards: ['slot_hold_valid', 'within_booking_horizon', 'pandit_kyc_verified', 'cash_mode_allowed'],
    emits: ['booking.submitted'] },

  { from: 'pending_accept', trigger: 'pandit_accept', to: 'pending_accept',
    guards: ['is_assigned_pandit'], emits: ['booking.accepted'] },

  { from: 'pending_accept', trigger: 'token_captured', to: 'confirmed',
    guards: ['pandit_accepted', 'payment_captured', 'slot_still_open'],
    emits: ['booking.confirmed'] },

  { from: 'pending_accept', trigger: 'pandit_decline', to: 'expired',
    guards: ['is_assigned_pandit', 'decline_reason_given'],
    emits: ['booking.declined', 'booking.rematch_requested'] },

  { from: 'pending_accept', trigger: 'accept_window_expired', to: 'expired',
    guards: [], emits: ['booking.expired', 'booking.rematch_requested'] },

  { from: 'confirmed', trigger: 'start_otp_verified', to: 'in_progress',
    guards: ['is_assigned_pandit', 'otp_valid', 'within_start_window'],
    emits: ['booking.started'] },

  { from: 'in_progress', trigger: 'complete_otp_verified', to: 'completed',
    guards: ['is_assigned_pandit', 'otp_valid', 'cash_amount_matches_if_cash'],
    emits: ['booking.completed'] },

  { from: 'completed', trigger: 'review_window_closed', to: 'reviewed',
    guards: [], emits: ['booking.reviewed'] },

  { from: 'draft', trigger: 'cancel_devotee', to: 'cancelled_devotee',
    guards: [], emits: ['booking.cancelled'] },
  { from: 'pending_accept', trigger: 'cancel_devotee', to: 'cancelled_devotee',
    guards: [], emits: ['booking.cancelled'] },
  { from: 'confirmed', trigger: 'cancel_devotee', to: 'cancelled_devotee',
    guards: [], emits: ['booking.cancelled', 'booking.refund_due'] },

  { from: 'pending_accept', trigger: 'cancel_pandit', to: 'cancelled_pandit',
    guards: ['is_assigned_pandit'], emits: ['booking.cancelled', 'booking.rematch_requested'] },
  { from: 'confirmed', trigger: 'cancel_pandit', to: 'cancelled_pandit',
    guards: ['is_assigned_pandit'],
    emits: ['booking.cancelled', 'booking.refund_due', 'booking.rematch_requested'] },
];

export function findTransition(
  from: BookingState,
  trigger: BookingTrigger,
): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.trigger === trigger);
}

export function isTerminal(state: BookingState): boolean {
  return (TERMINAL_STATES as readonly BookingState[]).includes(state);
}

export function allowedTriggers(from: BookingState): BookingTrigger[] {
  return TRANSITIONS.filter((t) => t.from === from).map((t) => t.trigger);
}
