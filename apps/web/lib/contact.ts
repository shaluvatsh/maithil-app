/**
 * How to reach us, in one place.
 *
 * The WhatsApp number was written into `components/footer.tsx`, `app/contact/page.tsx`
 * and inline in `app/nav.tsx`; the display phone number existed only in the footer,
 * in a different format from the dialling number beside it. Three copies of a
 * business fact that changes the day support moves desks — and the kind that gets
 * changed in two places out of three, leaving one page quietly routing customers to
 * a dead line.
 *
 * Environment-overridable because staging must not message real customers, and the
 * launch number is not the number a second city will use.
 */
const digits = (s: string) => s.replace(/\D/g, '');

/** E.164 without the +, which is what wa.me expects. */
export const WHATSAPP = digits(process.env.NEXT_PUBLIC_WHATSAPP ?? '919830000000');

/** The same number, formatted for reading. Derived, so the two cannot disagree. */
export const PHONE_DISPLAY = WHATSAPP.length === 12
  ? `+${WHATSAPP.slice(0, 2)} ${WHATSAPP.slice(2, 7)} ${WHATSAPP.slice(7)}`
  : `+${WHATSAPP}`;

export const PHONE_HREF = `tel:+${WHATSAPP}`;

export const EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'help@themaithil.com';

/**
 * A wa.me link with the message pre-filled.
 *
 * Prefilling is not decoration: the notification pipeline is WhatsApp-first, and a
 * message that already says what it is about saves the person on the other end a
 * round trip asking.
 */
export const whatsappLink = (message?: string): string =>
  `https://wa.me/${WHATSAPP}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
