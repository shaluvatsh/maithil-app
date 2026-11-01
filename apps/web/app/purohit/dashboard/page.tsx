'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PurohitDashboard } from '@/components/purohit/dashboard';
import { auth } from '@/lib/api';

/**
 * The dashboard, on its own page.
 *
 * It used to sit stacked above the job inbox on `/purohit`, which made "My jobs" —
 * the thing a purohit opens every day to see what is on today — also load today's
 * money, allocation, cohort standing, demand and the whole verification ladder
 * before a single job card appeared. That is a lot to put between someone and the
 * one thing they came to check, and it is a different QUESTION from "what am I
 * doing today": this page answers "how is my practice doing," which is read less
 * often and deserves its own destination rather than a scroll past.
 *
 * Reachable from the profile menu, not the main bar — the same reasoning that moved
 * "My practice" there: permanent chrome is for things used daily, and this is a
 * once-in-a-while look.
 */
export default function PurohitDashboardPage() {
  const router = useRouter();
  useEffect(() => { if (!auth.token) router.replace('/login?next=/purohit/dashboard'); }, [router]);

  return (
    <div className="wrap" style={{ padding: '40px 20px 80px' }}>
      <Link href="/purohit" className="btn-link" style={{ display: 'inline-block', marginBottom: 14 }}>
        ← My jobs
      </Link>
      <h1>Your dashboard</h1>
      <p className="sub">What is happening with your practice, and why.</p>
      <PurohitDashboard />
    </div>
  );
}
