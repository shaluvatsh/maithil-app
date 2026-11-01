'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { auth } from '@/lib/api';
import { roleOf, type Role } from '@/lib/nav-model';

/**
 * The signed-in role, read after mount.
 *
 * Always 'guest' on the first render, deliberately. `auth` reads `localStorage`,
 * which does not exist on the server — reading it during render produces different
 * markup on the two sides and React throws the whole tree away rather than
 * hydrating it. Every consumer of the role has to defer it the same way, so the
 * deferral lives here once instead of being re-derived (and eventually mis-derived)
 * at each call site.
 */
export function useRole(): Role {
  const path = usePathname();
  const [role, setRole] = useState<Role>('guest');
  // Re-read on navigation, not just on mount: signing in and signing out are both
  // route changes, and the chrome has to follow the role across them.
  useEffect(() => { setRole(roleOf(Boolean(auth.token), auth.role)); }, [path]);
  return role;
}
