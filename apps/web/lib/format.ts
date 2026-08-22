export const rs = (paise: number): string =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR',
    minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(paise / 100);


export const SLOT_LABELS_EN = ['6–9 am', '9:30 am–12:30 pm', '1–4 pm', '4:30–7:30 pm'];

/**
 * What a booking state means — to the person reading it.
 *
 * `pending_accept` was labelled "Awaiting purohit" everywhere. Under ADR 0011 the
 * purohit accepted the moment they published the slot, and `submit()` sets
 * `acceptedAt` in the same transaction; what the booking is actually waiting for is
 * the DEVOTEE'S PAYMENT, which `confirmOnTokenCapture` turns into `confirmed`.
 *
 * So the one label was wrong twice over. A purohit opened their jobs, read
 * "awaiting purohit" against a job they had already accepted, looked for the accept
 * button that ADR 0011 deliberately removed, and concluded the app was broken. And
 * a devotee read the same words and blamed the purohit for their own unpaid token.
 *
 * The state name is now a misnomer too — it predates the ADR — but renaming an enum
 * value is a migration across `bookings`, `booking_events` and every guard. The
 * label is where the lie was doing damage, so the label is what changes.
 */
type Audience = 'devotee' | 'pandit' | 'admin';

const STATE_TEXT: Record<string, Partial<Record<Audience, string>> & { default: string }> = {
  draft: { default: 'Draft' },
  pending_accept: {
    default: 'Awaiting payment',
    // You already have this job; the devotee has not paid the token yet.
    pandit: 'Waiting for payment',
    devotee: 'Pay to confirm',
  },
  confirmed: { default: 'Confirmed' },
  in_progress: { default: 'In progress' },
  completed: { default: 'Completed' },
  reviewed: { default: 'Reviewed' },
  cancelled_devotee: { default: 'Cancelled by devotee' },
  cancelled_pandit: { default: 'Released by purohit' },
  expired: { default: 'Expired' },
};

export const stateLabel = (state: string, audience: Audience = 'devotee'): string => {
  const entry = STATE_TEXT[state];
  if (!entry) return state;
  return entry[audience] ?? entry.default;
};

/** Kept for callers that have no audience to hand. Prefer `stateLabel`. */
export const STATE_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_TEXT).map(([k, v]) => [k, v.default]),
);

/**
 * `n` consecutive IST dates.
 *
 * `from` defaults to 1 — tomorrow — because that is right for booking: a purohit
 * cannot be summoned for this afternoon and offering today is a promise the supply
 * side cannot keep.
 *
 * It is wrong for reading. The panchang page and the home page's almanac card both
 * used the default, so the calendar began tomorrow, today's cell never existed, and
 * the hero card printed tomorrow's tithi under the word "Today". Nothing looked
 * broken; it was simply the wrong day, every day. Reading views must pass `0`.
 */
export const dayList = (n = 21, from = 1): string[] =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.now() + 5.5 * 3600_000);
    d.setUTCDate(d.getUTCDate() + i + from);
    return d.toISOString().slice(0, 10);
  });

/** Today in IST, as the same `YYYY-MM-DD` the API and `dayList` speak. */
export const todayIso = (): string =>
  new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

export const prettyDate = (iso: string): string =>
  new Date(`${iso}T00:00:00+05:30`).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
