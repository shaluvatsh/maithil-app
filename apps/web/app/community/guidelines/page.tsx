import type { Metadata } from 'next';
import Link from 'next/link';
import { GRIEVANCE, grievanceOfficerAppointed } from '@/lib/contact';

export const metadata: Metadata = {
  title: 'Community guidelines — TheMaithil',
  description:
    'What belongs in the community, what does not, how moderation works, and how to raise a grievance.',
};

/**
 * Community guidelines and the grievance route.
 *
 * Required before the community surface is public: under the IT Rules 2021 this
 * product is an intermediary the moment a third party can publish, and the
 * obligations include a NAMED Grievance Officer, a published contact route, and the
 * acknowledgement and resolution windows stated where a user can read them.
 *
 * Written to be read by someone upset, not by a lawyer. Two things are stated that
 * most policies of this kind avoid: that nothing here is deleted automatically, and
 * that we remove contact details from posts and why. Both are commitments the code
 * actually keeps — `assert_post_shape`, the `held` state and `scrubContact` — rather
 * than intentions.
 */
export default function GuidelinesPage() {
  return (
    <div className="wrap legal">
      <h1>Community guidelines</h1>
      <p className="sub">
        This is a place to ask about rituals and have them answered by purohits who
        have been verified. These are the rules that keep it that way.
      </p>

      <section>
        <h2>What belongs here</h2>
        <ul className="ticks">
          <li>Questions about how a ritual is performed, and when</li>
          <li>Answers that say which tradition or almanac they follow</li>
          <li>Disagreement between traditions, stated as disagreement</li>
          <li>Anything you would say in front of the family you are advising</li>
        </ul>
        <p>
          Purohits differ, regions differ, and two verified purohits giving different
          answers is information rather than a fault. We ask that an answer says
          whose practice it describes.
        </p>
      </section>

      <section>
        <h2>What does not</h2>
        <ul>
          <li>Attacks on another tradition, sect or lineage</li>
          <li>Caste references used to rank or exclude anyone</li>
          <li>Communal provocation, and political organising of any kind</li>
          <li>Remedies presented as medical or legal advice</li>
          <li>Offers of vashikaran, black magic or similar services</li>
          <li>Claims of guaranteed outcomes, cures or miracles</li>
          <li>Phone numbers, UPI IDs and links that move a booking off the platform</li>
          <li>Anything that identifies a private individual who did not post it</li>
        </ul>
      </section>

      <section>
        <h2>How moderation works</h2>
        <p>
          <strong>Nothing here is deleted automatically.</strong> When something is
          flagged — by a person or by our own checks — the post is <em>held</em> for a
          human to read. Held is not removed: the post still exists, and it is
          published if the check was wrong. Only a person removes a post, and a
          removal always carries a reason.
        </p>
        <p>
          We do this the slow way round on purpose. An automatic deletion that gets it
          wrong lands hardest on someone asking about a parent&apos;s shraddha, and
          they would never know why their question disappeared.
        </p>
        <p>
          <strong>You post under a name you choose.</strong> Your real name, your
          phone number and what you have booked are never shown here. Purohits are
          the exception and they appear under their verified identity, because that
          verification is the point.
        </p>
        <p>
          <strong>We remove contact details from posts.</strong> Phone numbers, UPI
          IDs and links are replaced before a post is shown. This is not to keep you
          on the platform for its own sake: a booking made here carries the escrow,
          the codes at the start and finish of the ceremony, and the refund terms — a
          booking arranged in a private message carries none of them, and it is the
          devotee who bears that.
        </p>
      </section>

      <section>
        <h2>If you think we got it wrong</h2>
        <p>
          Report the post, or write to the Grievance Officer directly. Either route
          reaches a person.
        </p>
        <dl className="kv">
          <dt>Grievance Officer</dt>
          <dd>
            {GRIEVANCE.name}
            {!grievanceOfficerAppointed && (
              // Visibly unconfigured beats a plausible-looking fake: a page naming
              // someone who does not hold the role is worse than one saying so.
              <> — <strong>this must be set before the community is public</strong></>
            )}
          </dd>
          <dt>Email</dt>
          <dd><a href={`mailto:${GRIEVANCE.email}`}>{GRIEVANCE.email}</a></dd>
          <dt>We acknowledge within</dt>
          <dd>{GRIEVANCE.ackHours} hours</dd>
          <dt>We resolve within</dt>
          <dd>{GRIEVANCE.resolveDays} days</dd>
        </dl>
        <p>
          We act on a valid order from a court or a government authority within 36
          hours, as the Information Technology (Intermediary Guidelines and Digital
          Media Ethics Code) Rules, 2021 require.
        </p>
      </section>

      <p className="legal-foot">
        <Link href="/community">Back to the community</Link> ·{' '}
        <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link>
      </p>
    </div>
  );
}
