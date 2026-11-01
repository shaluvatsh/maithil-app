'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, auth } from '@/lib/api';
import { useRegion } from '@/lib/region-context';

type Mode = 'otp' | 'password';

/** Cool-down before "Resend OTP" works again — see the state it guards, below. */
const OTP_RESEND_COOLDOWN_SECONDS = 30;

interface AuthResponse {
  // `refreshToken` was missing from this type, so the field the API actually
  // returns was invisible — the session silently capped at 15 minutes and
  // typecheck had nothing to complain about.
  tokens: { accessToken: string; refreshToken: string };
  user: { id: string; role: string; name: string | null; phone: string };
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/book';
  /*
   * The city they picked, sent with signup.
   *
   * Every new account was filed under the launch city and nothing asked. For a
   * purohit that was structural rather than cosmetic: allocation joins candidates
   * on `users.city_id`, so someone signing up in Mumbai joined Kolkata's pool and
   * no Mumbai booking could ever reach them. Ignored by the API for an account
   * that already exists.
   */
  const { region, chosen } = useRegion();
  /*
   * Only once they have actually picked. Before that the context serves a default,
   * and sending it would file someone under a city they never chose — which is the
   * bug this exists to fix, just with a different constant. Omitted, the server
   * applies the launch city itself.
   */
  const citySlug = chosen ? region.slug : undefined;

  /**
   * Which door this deployment can actually open.
   *
   * Phone OTP is the right default for this market and stays the default wherever
   * it works (ADR 0009 — a purohit is likelier to have WhatsApp than an email
   * habit). But it depends on a messaging provider, and WhatsApp's is gated behind
   * Meta verification and template approval. Until that lands, opening on the OTP
   * tab greets every visitor with the one door that cannot open, while email and
   * password — which need nothing but the database — sit behind a tab nobody
   * clicks.
   *
   * Asked of the server rather than assumed, and optimistic while in flight: `otp`
   * is the normal answer, so showing it first avoids a visible flip on every load
   * for the deployments where it works.
   */
  const [otpAvailable, setOtpAvailable] = useState(true);
  const [mode, setMode] = useState<Mode>('otp');
  useEffect(() => {
    let live = true;
    api<{ otpLoginAvailable: boolean }>('/v1/config', { auth: false })
      .then((c) => {
        /*
         * Only an EXPLICIT false hides the tab.
         *
         * This read `if (c.otpLoginAvailable) return`, so any response without the
         * field — an older API, a proxy returning `{}`, a mock in a test that
         * predates this call — was treated as "no OTP" and the working door was
         * hidden. Absence of an answer is not an answer, and the failure mode of
         * guessing wrong here is removing the sign-in method this market actually
         * uses.
         */
        if (!live || c.otpLoginAvailable !== false) return;
        setOtpAvailable(false);
        // Only move them if they have not already chosen for themselves.
        setMode((m) => (m === 'otp' ? 'password' : m));
      })
      .catch(() => { /* keep the optimistic default */ });
    return () => { live = false; };
  }, []);
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // OTP
  const [phone, setPhone] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const boxes = useRef<Array<HTMLInputElement | null>>([]);

  // Password
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pwPhone, setPwPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  /**
   * Registering as a purohit was impossible — the endpoint hardcoded
   * `role: 'devotee'`, so the only purohits that ever existed came from
   * `db:seed:dev`. Supply could not onboard itself.
   */
  /**
   * Which side of the marketplace they arrived from.
   *
   * The only route into the product for a purohit is the footer's "Work with us as
   * a pandit", which lands here as `?next=/purohit`. So this is not a guess — it is
   * the link they clicked, and it decides the copy, the preselected role on the
   * register tab, and the role sent with an OTP signup.
   */
  const arrivingAsPurohit = next.startsWith('/purohit');
  const [role, setRole] = useState<'devotee' | 'pandit'>(
    arrivingAsPurohit ? 'pandit' : 'devotee',
  );

  const done = (res: AuthResponse) => {
    // The refresh token was being dropped on the floor here, which capped every
    // session at the 15-minute access-token lifetime.
    auth.set(
      res.tokens.accessToken,
      res.user.role,
      res.user.name ?? res.user.phone,
      res.tokens.refreshToken,
    );
    router.push(res.user.role === 'pandit' ? '/purohit' : next);
  };

  const run = async (fn: () => Promise<AuthResponse | void>) => {
    setBusy(true); setErr(null);
    try { const r = await fn(); if (r) done(r); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  /**
   * Seconds until "Resend OTP" is live again.
   *
   * The API allows 5 OTP requests an hour per IP (see `scripts/e2e/README.md`'s own
   * note on this). A purohit and a devotee testing from the same office exhaust
   * that budget in under a minute if the button has no cooldown — and a genuine
   * sender who mistypes their number and retries four times in ten seconds locks
   * out everyone else on their network for the rest of the hour.
   */
  const [resendIn, setResendIn] = useState(0);
  const counting = resendIn > 0;
  // Keyed on whether a countdown is running, not on the tick itself — ticking via
  // the functional update below means one interval for the whole 30 seconds,
  // rather than tearing one down and rebuilding it on every second that passes.
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [counting]);

  const sendOtp = () => run(async () => {
    const r = await api<{ requestId: string; devOtp?: string }>('/v1/auth/otp/request', {
      method: 'POST', auth: false, body: JSON.stringify({ phone }),
    });
    setRequestId(r.requestId);
    setResendIn(OTP_RESEND_COOLDOWN_SECONDS);
    if (r.devOtp) {
      setDigits(r.devOtp.split(''));
    } else {
      setDigits(Array(6).fill(''));
      setTimeout(() => boxes.current[0]?.focus(), 40);
    }
  });

  /**
   * Which side of the marketplace a NEW account belongs to.
   *
   * Phone OTP is the default tab and the likeliest route for a purohit (ADR 0009),
   * and it silently created a devotee every time — so someone arriving through
   * "For Pandits" ended up on the wrong side of the marketplace with no way back,
   * since nothing in the product changes a role afterwards. `?next=/purohit` is
   * exactly that arrival, and the role toggle below covers anyone who says so
   * outright. Ignored by the API for an account that already exists.
   */
  const signupRole = arrivingAsPurohit || role === 'pandit' ? 'pandit' : undefined;

  const verifyOtp = () => run(() => api<AuthResponse>('/v1/auth/otp/verify', {
    method: 'POST', auth: false,
    body: JSON.stringify({
      requestId, phone, otp: digits.join(''),
      ...(signupRole ? { role: signupRole } : {}),
      ...(citySlug ? { citySlug } : {}),
    }),
  }));

  const submitPassword = () => run(() => register
    ? api<AuthResponse>('/v1/auth/register', {
        method: 'POST', auth: false,
        body: JSON.stringify({
          name, email, phone: pwPhone, password, role,
          ...(citySlug ? { citySlug } : {}),
        }),
      })
    : api<AuthResponse>('/v1/auth/login', {
        method: 'POST', auth: false, body: JSON.stringify({ email, password }),
      }));

  const setDigit = (i: number, v: string) => {
    const clean = v.replace(/\D/g, '');
    if (clean.length > 1) {                       // paste of a whole code
      const spread = clean.slice(0, 6).split('');
      setDigits(Array.from({ length: 6 }, (_, k) => spread[k] ?? ''));
      boxes.current[Math.min(spread.length, 5)]?.focus();
      return;
    }
    const nextDigits = [...digits];
    nextDigits[i] = clean;
    setDigits(nextDigits);
    if (clean && i < 5) boxes.current[i + 1]?.focus();
  };

  const phoneOk = phone.replace(/\D/g, '').length >= 10;
  const otpOk = digits.every((d) => d !== '');
  /**
   * Mirrors the server's own checks (`password.ts`'s `passwordProblem`, and zod's
   * `.email()` on `RegisterBody`/`LoginBody`) just enough to stop an obviously bad
   * submission before it makes a round trip — not the full policy. The common-
   * password blocklist, for one, deliberately stays server-side only: duplicating
   * it here is exactly the kind of second copy that drifts, and it is the server's
   * rejection that is authoritative regardless of what this check lets through.
   */
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const passwordOk = register ? password.length >= 8 : password.length > 0;
  /**
   * Registering with an empty name or a short phone number used to be gated
   * only by the server — the button stayed enabled, the submit round-tripped,
   * and `RegisterBody`'s own zod checks (`name: min(1)`, `phone: min(10)`)
   * rejected it. Same two fields, checked here so that trip never happens.
   */
  const pwPhoneOk = pwPhone.replace(/\D/g, '').length >= 10;
  const registerOk = !register || (name.trim().length > 0 && pwPhoneOk);

  return (
    <div className="auth-split">
      <aside className="auth-aside">
        <h2>Your ritual, done right.</h2>
        <p className="lede">
          Verified pandits, a real time slot you can hold, and a price that is itemised
          before you pay.
        </p>
        <ul>
          <li><span className="ic">✓</span><div>
            <b>Verified pandits</b><span>Credentials and background checked before they are listed.</span>
          </div></li>
          <li><span className="ic">📅</span><div>
            <b>Real availability</b><span>Pick an open slot. No waiting 24 hours to be allocated.</span>
          </div></li>
          <li><span className="ic">₹</span><div>
            <b>Transparent pricing</b><span>Dakshina, samagri and fees on separate lines.</span>
          </div></li>
          <li><span className="ic">🔒</span><div>
            <b>Protected bookings</b><span>Full refund if we cannot send the pandit we promised.</span>
          </div></li>
        </ul>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <h1>{register ? 'Create your account' : 'Welcome back'}</h1>
          {/*
            * A purohit following "Work with us as a pandit" was told to "book a
            * pandit and track your ceremonies" — the devotee's words, on the one
            * screen that decides which side of the marketplace they join, and the
            * first thing they read after clicking a link that promised the other.
            */}
          <p className="sub">
            {arrivingAsPurohit
              ? (register
                  ? 'A few details and you can start taking bookings.'
                  : 'Sign in to manage your jobs, calendar and earnings.')
              : (register
                  ? 'A few details and you can book in under a minute.'
                  : 'Sign in to book a pandit and track your ceremonies.')}
          </p>

          {/*
            The OTP tab is hidden, not disabled, when no provider can deliver a
            code. A disabled tab is an invitation to keep tapping something that
            will never respond; its absence is simply a product with one way in.
          */}
          {!register && otpAvailable && (
            <div className="tabs">
              <button className={mode === 'otp' ? 'on' : ''}
                      onClick={() => { setMode('otp'); setErr(null); }}>
                Phone OTP
              </button>
              <button className={mode === 'password' ? 'on' : ''}
                      onClick={() => { setMode('password'); setErr(null); }}>
                Email &amp; password
              </button>
            </div>
          )}

          {err && <div className="notice err">{err}</div>}

          {!register && mode === 'otp' && (
            <>
              <div className="field with-prefix">
                <label htmlFor="phone">Mobile number</label>
                <span className="prefix">+91</span>
                <input id="phone" inputMode="numeric" autoComplete="tel" maxLength={10}
                       autoFocus={!requestId} value={phone}
                       onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                       placeholder="98300 12345"
                       onKeyDown={(e) => e.key === 'Enter' && phoneOk && !requestId && sendOtp()} />
              </div>

              {!requestId ? (
                <button className="btn-block" disabled={busy || !phoneOk} onClick={sendOtp}>
                  {busy ? 'Sending…' : 'Send OTP'}
                </button>
              ) : (
                <>
                  <div className="field">
                    <label id="otp-label">Enter the 6-digit code</label>
                    <div className="otp-boxes" role="group" aria-labelledby="otp-label">
                      {digits.map((d, i) => (
                        <input key={i} ref={(el) => { boxes.current[i] = el; }}
                               inputMode="numeric" maxLength={6} value={d}
                               aria-label={`Digit ${i + 1} of 6`}
                               // Lets the OS suggest the SMS the device just received
                               // rather than making someone switch apps to read it —
                               // the target device here is a phone, not a desktop.
                               autoComplete={i === 0 ? 'one-time-code' : 'off'}
                               autoFocus={i === 0}
                               onChange={(e) => setDigit(i, e.target.value)}
                               onKeyDown={(e) => {
                                 if (e.key === 'Backspace' && !digits[i] && i > 0) boxes.current[i - 1]?.focus();
                                 if (e.key === 'Enter' && otpOk) verifyOtp();
                               }} />
                      ))}
                    </div>
                    <div className="hint">Sent to +91 {phone}.{' '}
                      <button type="button" className="btn-link"
                              onClick={() => { setRequestId(null); setDigits(Array(6).fill('')); setResendIn(0); }}>
                        Change number
                      </button>
                    </div>
                  </div>
                  <button className="btn-block" disabled={busy || !otpOk} onClick={verifyOtp}>
                    {busy ? 'Verifying…' : 'Verify & continue'}
                  </button>
                  <div className="auth-alt">
                    Didn&apos;t get it?{' '}
                    <button className="btn-link" onClick={sendOtp} disabled={busy || counting}>
                      {counting ? `Resend OTP in ${resendIn}s` : 'Resend OTP'}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {(register || mode === 'password') && (
            <>
              {register && (
                <>
                  {/* Two-sided marketplace, one signup. Without this a purohit
                      had no way into the product at all. */}
                  <div className="field">
                    <label>I am</label>
                    <div className="opt-row">
                      <button type="button"
                              className={`opt ${role === 'devotee' ? 'on' : ''}`}
                              aria-pressed={role === 'devotee'}
                              onClick={() => setRole('devotee')}>
                        Booking a pooja
                        <span className="s">I want a pandit for a ceremony</span>
                      </button>
                      <button type="button"
                              className={`opt ${role === 'pandit' ? 'on' : ''}`}
                              aria-pressed={role === 'pandit'}
                              onClick={() => setRole('pandit')}>
                        A pandit
                        <span className="s">I perform ceremonies and want work</span>
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="name">Full name</label>
                    <input id="name" autoComplete="name" value={name}
                           onChange={(e) => setName(e.target.value)} placeholder="Your name" />
                  </div>
                  <div className="field with-prefix">
                    <label htmlFor="rphone">Mobile number</label>
                    <span className="prefix">+91</span>
                    <input id="rphone" inputMode="numeric" autoComplete="tel" maxLength={10}
                           value={pwPhone} onChange={(e) => setPwPhone(e.target.value.replace(/\D/g, ''))}
                           placeholder="98300 12345" />
                    <div className="hint">The pandit uses this to reach you on the day.</div>
                  </div>
                </>
              )}
              <div className="field">
                <label htmlFor="email">Email address</label>
                <input id="email" type="email" autoComplete="email" value={email}
                       aria-invalid={email.length > 0 && !emailOk || undefined}
                       onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                {email.length > 0 && !emailOk && (
                  <div className="err">Enter a valid email address.</div>
                )}
              </div>
              <div className="field with-reveal">
                <label htmlFor="pw">Password</label>
                <input id="pw" type={showPw ? 'text' : 'password'} value={password}
                       autoComplete={register ? 'new-password' : 'current-password'}
                       aria-invalid={register && password.length > 0 && !passwordOk || undefined}
                       onChange={(e) => setPassword(e.target.value)}
                       placeholder={register ? 'At least 8 characters' : 'Your password'}
                       onKeyDown={(e) => e.key === 'Enter' && emailOk && passwordOk && submitPassword()} />
                <button type="button" className="reveal"
                        aria-label={showPw ? 'Hide password' : 'Show password'}
                        onClick={() => setShowPw((v) => !v)}>
                  {showPw ? 'Hide' : 'Show'}
                </button>
                {register
                  ? <div className="hint">Length matters more than symbols. A short phrase works well.</div>
                  : (
                    <div className="hint">
                      <Link className="btn-link" href="/forgot-password">Forgot your password?</Link>
                    </div>
                  )}
              </div>
              <button className="btn-block"
                      disabled={busy || !emailOk || !passwordOk || !registerOk}
                      onClick={submitPassword}>
                {busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}
              </button>
            </>
          )}

          <div className="auth-alt">
            {register ? (
              <>Already have an account?{' '}
                <button className="btn-link" onClick={() => { setRegister(false); setErr(null); }}>Sign in</button></>
            ) : (
              <>New to TheMaithil?{' '}
                <button className="btn-link" onClick={() => { setRegister(true); setMode('password'); setErr(null); }}>
                  Create an account
                </button></>
            )}
          </div>

          {/*
            Development only. These are real, seeded accounts with real sessions
            behind them — printed on the sign-in page of a production build they
            are an invitation, not a convenience.
          */}
          {process.env.NODE_ENV !== 'production' && (
            <div className="demo-note">
              <strong>Demo accounts.</strong> Devotee <code>9830012345</code>, pandits{' '}
              <code>9830000101/102/103</code>.{' '}
              {/*
                Only true while a code can actually be issued. With `OTP_DEV_BYPASS`
                off and no provider, this promised a prefilled code for a tab that
                is no longer even on the screen.
              */}
              {otpAvailable
                ? 'In development the OTP is filled in for you.'
                : 'Phone sign-in is off on this deployment — use email and password.'}
            </div>
          )}

          {/*
            The documents being agreed to, linked. Naming Terms of Service and
            Privacy Policy as plain text while linking only "Back to home" asks
            for consent to something the page gives no way to read — and both
            routes have existed all along.
          */}
          <p className="auth-legal">
            By continuing you agree to our <Link href="/terms">Terms of Service</Link>{' '}
            and <Link href="/privacy">Privacy Policy</Link>.{' '}
            <Link href="/">Back to home</Link>
          </p>
        </div>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense fallback={null}><LoginInner /></Suspense>;
}
