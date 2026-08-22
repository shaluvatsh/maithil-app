'use client';
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { auth } from '@/lib/api';
import { canAccess, homeFor, isRestricted, roleOf, type Role } from '@/lib/nav-model';

/**
 * Refuses a route to a role it is not for.
 *
 * The header stopped offering a purohit the "Book" link, which is styling. The
 * route stayed open — reachable by typing it, by an old bookmark, by any link in an
 * email — so a purohit could start booking a puja from themselves and an admin
 * could take a devotee's seat in the flow. Both end as support tickets.
 *
 * Client-side and therefore NOT a security boundary: it is a wrong-door redirect.
 * The security boundary is the API's `@Roles` guard, which is where the JWT is
 * verified and which no amount of URL editing gets past.
 *
 * THE THING THIS GETS WRONG IF YOU ARE NOT CAREFUL.
 *
 * The role can only be read from `localStorage`, which does not exist on the server
 * and is not available until after mount. The first version therefore returned
 * `null` until it knew — which meant the server rendered the header and the footer
 * with NOTHING between them, so every visitor saw the footer jump to the top of the
 * page and then get pushed down as the content arrived. It also stripped the body
 * out of the server HTML for `/services` and `/pooja/[slug]`, the two pages that
 * exist to be crawled.
 *
 * The fix is not to guess the role earlier; it is to notice that almost no route
 * needs one. `isRestricted` answers from the path alone, synchronously, on the
 * server. Public routes render immediately and never wait. Only the four listed
 * prefixes hold, and only for the moment it takes to read a token.
 */
export function RoleGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [role, setRole] = useState<Role | null>(null);

  useEffect(() => {
    setRole(roleOf(Boolean(auth.token), auth.role));
  }, [path]);

  useEffect(() => {
    if (role && !canAccess(role, path)) router.replace(homeFor(role));
  }, [role, path, router]);

  // The common case, and the only one that renders on the server.
  if (!isRestricted(path)) return <>{children}</>;

  if (role === null) {
    return (
      <div className="wrap gate-wait" aria-busy="true">
        <p className="muted">Checking your account…</p>
      </div>
    );
  }

  if (!canAccess(role, path)) {
    return (
      <div className="wrap gate-wait">
        <p className="muted">Taking you to your own pages…</p>
      </div>
    );
  }

  return <>{children}</>;
}
