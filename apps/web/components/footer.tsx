'use client';
import Link from 'next/link';
import { LanguagePicker } from '@/components/language-picker';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/api';
import { useRegion } from '@/lib/region-context';
import { RITUAL_CATEGORIES } from '@themaithil/region';
import { whatsappLink, PHONE_DISPLAY, PHONE_HREF } from '@/lib/contact';


/**
 * The footer, treated as a destination rather than a sitemap.
 *
 * People scroll to a footer for two reasons: they want help, or they are deciding
 * whether to trust you. Five columns of links served neither. So the help block
 * comes first and is the only thing with a button, the trust facts are stated as
 * facts a competitor cannot copy, and navigation is compressed.
 *
 * Two changes are specifically about this market and this device:
 *
 * - WhatsApp is the primary contact, because the market is WhatsApp-first and so is
 *   the notification pipeline.
 * - On a phone the link columns collapse into accordions. A footer with five open
 *   columns is a screen and a half of scrolling past things nobody is reading, and
 *   it pushes the legal strip — which people genuinely look for — out of reach.
 */
export function SiteFooter() {
  const { regions, region, setCity } = useRegion();
  const router = useRouter();
  const [isStaff, setIsStaff] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  // After mount only: `auth` reads localStorage, and branching on it during render
  // would make server and client markup disagree.
  useEffect(() => { setIsStaff(auth.role === 'admin' || auth.role === 'ops'); }, []);

  const goToCity = (slug: string) => { setCity(slug); router.push('/book'); };

  /** One column: a heading that becomes a disclosure toggle under 720px. */
  const column = (id: string, title: string, children: React.ReactNode) => (
    <div className={`fcol${open === id ? ' open' : ''}`}>
      <h4>
        <button type="button" aria-expanded={open === id}
                onClick={() => setOpen(open === id ? null : id)}>
          {title}
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
               stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </h4>
      <div className="fcol-body">{children}</div>
    </div>
  );

  return (
    <footer className="site">
      <div className="wrap">

        {/* Help first. This is what a worried person is scrolling for. */}
        <div className="fhelp">
          <div>
            <h3>Something wrong with a booking?</h3>
            <p>
              Message us and a person replies — not a bot. Have your booking date
              ready.
            </p>
          </div>
          <div className="fhelp-actions">
            <a className="btn wa-btn"
               href={whatsappLink('Hello, I need help with a booking. My booking date is: ')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22c5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2z" />
              </svg>
              WhatsApp us
            </a>
            <a className="fphone" href={PHONE_HREF}>{PHONE_DISPLAY}</a>
          </div>
        </div>

        {/* Trust, stated as specifics. "20,000+ pandits" is what the category does;
            these are things that are either true of us or not. */}
        <ul className="ftrust">
          <li><span aria-hidden="true">✓</span> Every pandit verified before listing</li>
          <li><span aria-hidden="true">₹</span> Itemised price, no package pricing</li>
          <li><span aria-hidden="true">↩</span> Full refund if we cannot send a pandit</li>
          <li><span aria-hidden="true">🔒</span> Pay a small amount now, the rest on the day</li>
        </ul>

        <div className="fcols">
          <div className="fbrand">
            <div className="brand">
              <span className="mark">ॐ</span>
              <span className="word">TheMaithil</span>
            </div>
            <p>
              Verified pandits at your doorstep, on a real time slot, at a price
              itemised before you pay — by your family&apos;s panchang.
            </p>
          </div>

          {column('book', 'Book a pooja', (
            <ul>
              <li><Link href="/book?browse=1">All services</Link></li>
              {RITUAL_CATEGORIES.slice(0, 4).map((c) => (
                <li key={c.id}><Link href={`/book?category=${c.id}`}>{c.en}</Link></li>
              ))}
              <li><Link href="/book?when=soon">Book within 48 hours</Link></li>
            </ul>
          ))}

          {column('online', 'Online & panchang', (
            <ul>
              <li><Link href="/pooja/online-aarti">Online aarti</Link></li>
              <li><Link href="/pooja/virtual-consultation">Virtual consultation</Link></li>
              <li><Link href="/panchang">Today&apos;s panchang</Link></li>
              <li><Link href="/pooja/personalised-puja">Personalised puja</Link></li>
            </ul>
          ))}

          {column('company', 'Company', (
            <ul>
              <li><Link href="/purohit">Work with us as a pandit</Link></li>
              <li><Link href="/contact">Contact us</Link></li>
              <li><Link href="/community/guidelines">Community guidelines</Link></li>
              <li><Link href="/terms">Terms &amp; refunds</Link></li>
              <li><Link href="/privacy">Privacy</Link></li>
              {isStaff && <li><Link href="/admin">Admin console</Link></li>}
            </ul>
          ))}
        </div>

        {/* Cities as wrapping chips, not a 14-item vertical list nobody reads.
            The one you are in is marked, so the row answers "do you serve me?"
            at a glance instead of asking you to scan. */}
        <div className="fcities">
          <span className="lbl">We serve</span>
          <div className="chips">
            {regions.map((r) => (
              <button key={r.slug} onClick={() => goToCity(r.slug)}
                      className={`fchip${r.slug === region.slug ? ' on' : ''}`}
                      aria-current={r.slug === region.slug ? 'true' : undefined}>
                {r.name.en}
              </button>
            ))}
          </div>
        </div>

        <div className="bottom">
          {/*
            * The permanent home for the language control.
            *
            * Conventional, always reachable, and costs no header space for an
            * action almost nobody repeats. The first-run banner is what reaches
            * the reader who cannot find this — the two are halves of one decision.
            */}
          <LanguagePicker />
          <span className="dot" aria-hidden="true">·</span>
          <span>© {new Date().getFullYear()} TheMaithil</span>
          <span className="dot" aria-hidden="true">·</span>
          <Link href="/terms">Terms</Link>
          <span className="dot" aria-hidden="true">·</span>
          <Link href="/privacy">Privacy</Link>
          <span className="dot" aria-hidden="true">·</span>
          <Link href="/contact">Contact</Link>
        </div>
      </div>
    </footer>
  );
}
