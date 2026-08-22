'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, auth } from '@/lib/api';
import { useRegion } from '@/lib/region-context';
import { CityPicker } from '@/components/city-picker';
import { navFor, roleOf, type Role } from '@/lib/nav-model';
import { whatsappLink } from '@/lib/contact';

/** States where the booking has not happened yet, so it still needs the user's attention. */
const LIVE = new Set(['draft', 'pending_accept', 'confirmed', 'in_progress']);

export function Nav() {
  const path = usePathname();
  const { region, chosen } = useRegion();
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const [acct, setAcct] = useState(false);
  const [who, setWho] = useState<string | null>(null);
  const [live, setLive] = useState(0);
  /**
   * Starts as `guest` on both server and client, then settles once the token has
   * been read. Reading `auth` during render would produce different markup on the
   * server than in the browser — a hydration mismatch — so the header opens as the
   * public one and adjusts.
   */
  const [role, setRole] = useState<Role>('guest');

  const acctRef = useRef<HTMLDivElement>(null);
  const nav = navFor(role);

  useEffect(() => {
    setWho(auth.name);
    setRole(roleOf(Boolean(auth.token), auth.role));
    setMenu(false); setAcct(false);
  }, [path]);

  // The badge is the only reason the header knows anything about bookings, and
  // only the roles that have an activity destination need to ask.
  useEffect(() => {
    if (!auth.token || !navFor(roleOf(true, auth.role)).activity) { setLive(0); return; }
    api<Array<{ state: string }>>('/v1/bookings?locale=en')
      .then((bs) => setLive(bs.filter((b) => LIVE.has(b.state)).length))
      .catch(() => setLive(0));
  }, [path]);

  // A dropdown that cannot be dismissed by clicking away or pressing Escape reads as
  // broken, and on mobile it traps the user behind an invisible layer.
  useEffect(() => {
    if (!acct) return;
    const away = (e: MouseEvent) => {
      if (!acctRef.current?.contains(e.target as Node)) setAcct(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAcct(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [acct]);

  /**
   * Keyed on the href because this is called from a `.map`. Without it React warns
   * on every render and, worse, reconciles the bar by position — so switching role
   * would reuse the previous role's anchor nodes and carry their state across.
   */
  const link = (href: string, label: string) => (
    <Link key={href} href={href} className={path === href ? 'on' : ''}>{label}</Link>
  );

  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <Link href="/" className="brand">
            <span className="mark">ॐ</span>
            <span className="word">TheMaithil</span>
          </Link>

          {/* A purohit's city is where their practice is registered and an admin's
              is not a personal setting at all; only a devotee is shopping in one. */}
          {nav.showCity && (
            <button className="city-pill" onClick={() => setPicker(true)}>
              <svg className="pin" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"
                   aria-hidden="true">
                <path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z" />
              </svg>
              {chosen ? region.name.en : 'Select your city'}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="3" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          )}

          {/* Four kinds of visitor, four surfaces. See lib/nav-model.ts — the
              header used to branch on one boolean, so an admin got the devotee's
              links and no way into the console they had signed in to use. */}
          <div className="links">
            {nav.links.map((l) => link(l.href, l.label))}
          </div>


          <div className="right">
            <button className="icon-btn menu-btn" aria-label="Menu"
                    aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" aria-hidden="true">
                <path d={menu ? 'M6 6l12 12M18 6L6 18' : 'M3 6h18M3 12h18M3 18h18'} />
              </svg>
            </button>
            {/* This product books one ritual at a time, so a cart icon promised a
                basket that does not exist. Bookings are what a devotee comes back
                for — and a signed-out visitor has none, so the icon counted
                nothing and led to a login wall dressed as a feature. */}
            {nav.activity && (
              <Link href={nav.activity.href} className="icon-btn"
                    aria-label={nav.activity.countLabel(live)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" aria-hidden="true">
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <path d="M3 10h18M8 3v4M16 3v4" />
                </svg>
                {live > 0 && <span className="badge">{live}</span>}
              </Link>
            )}

            {who ? (
              <div className="acct" ref={acctRef}>
                <button className="icon-btn" aria-label="Account menu" aria-haspopup="menu"
                        aria-expanded={acct} onClick={() => setAcct((v) => !v)}>
                  <span className="avatar sm" aria-hidden="true">
                    {who.trim().charAt(0).toUpperCase()}
                  </span>
                </button>
                {acct && (
                  <div className="acct-menu" role="menu">
                    <div className="acct-who">
                      <span className="nm">{who}</span>
                      <span className="rl">{nav.roleLabel ?? region.name.en}</span>
                    </div>
                    {/* A purohit was being sent to the devotee account page —
                        "Book a pooja", "Addresses", "which panchang does your
                        family follow". None of that is their product. */}
                    {nav.account.map((item, i) => (
                      <Link key={item.href} role="menuitem" href={item.href}>
                        {item.label}
                        {i === 0 && live > 0 && <span className="n">{live}</span>}
                      </Link>
                    ))}
                    <button role="menuitem" className="danger"
                            onClick={() => { auth.clear(); location.href = '/'; }}>
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <Link href="/login" className="btn outline sm">Sign in</Link>
            )}
          </div>
        </div>
        <div className={`mobile-menu${menu ? ' open' : ''}`}>
          {nav.links.filter((l) => l.mobile).map((l) => (
            <Link key={l.href} href={l.href}>{l.label}</Link>
          ))}
          {/*
            The activity link is appended only when it is not already in the bar.
            A purohit's header opens on "My jobs" and their activity destination is
            also "My jobs", so the sheet listed it twice — once as navigation and
            once as the thing the calendar icon points at. Two identical rows read
            as a rendering fault, not as emphasis.
          */}
          {who
            ? (nav.activity && !nav.links.some((l) => l.href === nav.activity!.href)
                && <Link href={nav.activity.href}>{nav.activity.label}</Link>)
            : <Link href="/login">Sign in</Link>}
        </div>
      </nav>
      {picker && <CityPicker onClose={() => setPicker(false)} />}
    </>
  );
}

export function WhatsAppFloat() {
  return (
    <>
      <a className="wa" href={whatsappLink()} aria-label="Chat with us on WhatsApp">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
          <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm5.8 14.09c-.24.68-1.4 1.3-1.94 1.38-.5.07-1.12.1-1.81-.11-.42-.13-.95-.31-1.64-.61-2.88-1.24-4.76-4.14-4.9-4.33-.14-.19-1.17-1.56-1.17-2.97s.74-2.11 1-2.4c.26-.29.57-.36.76-.36l.55.01c.17.01.41-.07.64.49.24.57.81 1.98.88 2.12.07.14.12.31.02.5-.09.19-.14.31-.28.48l-.42.49c-.14.14-.28.29-.12.57.16.29.71 1.17 1.53 1.9 1.05.94 1.94 1.23 2.22 1.37.28.14.44.12.6-.07.17-.19.69-.81.88-1.09.19-.29.38-.24.64-.14.26.09 1.66.78 1.95.93.28.14.47.21.54.33.07.12.07.69-.17 1.37z" />
        </svg>
      </a>
      <span className="wa-label">Chat with us</span>
    </>
  );
}
