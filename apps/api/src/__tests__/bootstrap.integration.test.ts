import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { AppModule } from '../app.module';
import { CONFIG, DB, KV } from '../common/tokens';
import { DomainExceptionFilter } from '../common/http-errors';
import { MemoryKv } from '../common/kv';
import { makeHarness, daysFromNow, TEST_CONFIG, type Harness } from '../test/harness';
import type { JwtClaims } from '../modules/auth/auth.service';
import type { UserRole } from '@themaithil/contracts';

/**
 * Boots the real Nest application over Postgres-in-wasm and drives it over HTTP.
 *
 * This exists because the unit and service tests all passed while the app itself
 * would not start: the DI tokens lived in app.module, the controllers imported them
 * from there, and app.module imported the controllers back. Under ESM that cycle left
 * the token undefined and Nest failed to resolve the dependency at boot. Nothing that
 * bypasses the module graph can catch that - only actually starting the app can.
 */
let app: INestApplication;
let h: Harness;
/**
 * No test anywhere authenticated as admin/ops before this file - signed directly
 * against the test JWT secret rather than round-tripping through OTP login and a
 * seeded admin user, since `@Roles` only inspects the token's claims and neither
 * route under test does a DB lookup keyed on the caller's own id.
 */
const adminToken = () => jwt.sign(
  { sub: 'test-admin', role: 'admin', typ: 'access' } satisfies JwtClaims,
  TEST_CONFIG.JWT_ACCESS_SECRET,
  { expiresIn: '15m' },
);

beforeAll(async () => {
  h = await makeHarness();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONFIG).useValue(TEST_CONFIG)
    .overrideProvider(DB).useValue(h.db)
    .overrideProvider(KV).useValue(new MemoryKv())
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.init();
}, 90_000);

afterAll(async () => { await app?.close(); await h?.pg.close(); });

describe('application bootstrap', () => {
  it('starts and reports healthy', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('up');
  });

  it('serves the catalogue publicly, in Bengali', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/rituals?locale=bn').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].name).toMatch(/[ঀ-৿]/);   // Bengali script
  });

  /**
   * 401, not 403 — and the difference is not cosmetic.
   *
   * This asserted 403, which is what the guard used to return for both "you are not
   * signed in" and "you are signed in and this is not yours". The web client refreshes
   * on 401, so an access token that lapsed after its fifteen minutes produced a 403
   * that nothing recovered from: the thirty-day refresh token was never used and the
   * only way out was to sign out and back in. See `session-expiry.test.ts`.
   */
  it('answers 401 on a protected route with no token, so a client can refresh', async () => {
    await request(app.getHttpServer()).get('/v1/bookings').expect(401);
  });

  /**
   * The four PUBLIC routes that personalise must serve a signed-out visitor.
   *
   * THE BUG THIS PINS, found by driving the real app and not by reading it. Each was
   * written as `@CurrentUser() user: JwtClaims | undefined` — which typechecks, reads
   * correctly, and is wrong, because `CurrentUser` THROWS when nobody is signed in.
   * So every one of them answered `FORBIDDEN: not authenticated` to exactly the
   * visitors the community and events surfaces exist to attract. No unit test caught
   * it: none of them went through the parameter decorator. This one goes over HTTP,
   * which is the only place the mistake was visible.
   */
  it.each([
    '/v1/community/feed',
    '/v1/events',
  ])('serves %s to a signed-out visitor', async (path) => {
    const res = await request(app.getHttpServer()).get(path).expect(200);
    expect(res.body).toHaveProperty('items');
  });

  it('answers 401 for a token it cannot verify, rather than 403', async () => {
    await request(app.getHttpServer())
      .get('/v1/bookings')
      .set('authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('runs the whole OTP login over HTTP', async () => {
    const server = app.getHttpServer();

    const asked = await request(server)
      .post('/v1/auth/otp/request')
      .send({ phone: '9830012345' })
      .expect(201);
    expect(asked.body.requestId).toBeTruthy();
    expect(asked.body.devOtp).toBe('123456');   // dev bypass is on in TEST_CONFIG

    const verified = await request(server)
      .post('/v1/auth/otp/verify')
      .send({ requestId: asked.body.requestId, phone: '9830012345', otp: asked.body.devOtp })
      .expect(201);
    const token = verified.body.tokens.accessToken;
    expect(token).toBeTruthy();

    const me = await request(server)
      .get('/v1/auth/me').set('authorization', `Bearer ${token}`).expect(200);
    expect(me.body.phone).toBe('+919830012345');
    expect(me.body.locale).toBe('bn');
  });

  it('returns a structured error, not an HTML stack trace', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/otp/verify')
      .send({ requestId: 'nope', phone: '9830012345', otp: '000000' })
      .expect(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
  });

  it('rejects a malformed body with 422 and field-level detail', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/otp/request').send({ phone: 'x' }).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.issues[0].path).toBe('phone');
  });

  it('runs the ranking query and returns purohits, unauthenticated', async () => {
    const rituals = await request(app.getHttpServer()).get('/v1/rituals').expect(200);
    const res = await request(app.getHttpServer())
      .get(`/v1/search/pandits?ritualId=${rituals.body[0].id}&lat=22.5148&lng=88.3639`)
      .expect(200);
    expect(res.body.results.length).toBeGreaterThan(0);
    const first = res.body.results[0];
    expect(first).toHaveProperty('pricePaise');
    expect(first).toHaveProperty('isNewPandit');
  });

  /**
   * `slotIdx` was validated with a flat `.max(3)` — Kolkata's four-slot day, applied
   * to every city. The southern cities run five slots (`SOUTH_SLOTS`), so their
   * 18:00-20:30 window was rejected by validation before the request reached the
   * service: unbookable through search, for a reason no error message explained.
   * The bound is the city's, so it is checked after `citySlug` is known.
   */
  it('bounds slotIdx by the city, not by the launch city', async () => {
    const rituals = await request(app.getHttpServer()).get('/v1/rituals').expect(200);
    const ritualId = rituals.body[0].id;

    // Bengaluru has five slots: idx 4 is real and must survive validation.
    const fiveSlot = await request(app.getHttpServer())
      .get(`/v1/search/pandits?ritualId=${ritualId}&citySlug=bengaluru&slotIdx=4`);
    expect(fiveSlot.status, fiveSlot.text).toBe(200);

    // Kolkata has four: idx 4 does not exist there and must still be refused.
    const fourSlot = await request(app.getHttpServer())
      .get(`/v1/search/pandits?ritualId=${ritualId}&citySlug=kolkata&slotIdx=4`);
    expect(fourSlot.status).toBe(422);
    expect(fourSlot.body.error.code).toBe('VALIDATION_FAILED');
    expect(fourSlot.body.error.issues[0].path).toBe('slotIdx');
  });
});


/**
 * The offer card vanished from the home page and nothing said why.
 *
 * The client fetches `/v1/offers/current`, and on any failure does
 * `.catch(() => setOffer(null))` — so a 500 from a missing column, a broken query
 * or an unregistered provider is indistinguishable from "there is no plan today".
 * That is the exact pattern that hid the panchang in twelve cities. Driving the
 * route over real HTTP is the only thing that tells the two apart.
 */
describe('the offer and stats routes are actually reachable', () => {
  it('serves /v1/offers/current without erroring', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/offers/current?citySlug=kolkata&locale=en');

    expect(res.status, `offers/current returned ${res.status}: ${res.text}`).toBe(200);
  });

  /** Null is the honest answer when no plan row exists; it must not be a 500. */
  it('returns null rather than failing when there is no plan', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/offers/current?citySlug=kolkata&locale=en');
    expect(res.status).toBe(200);
    expect(res.body === null || typeof res.body === 'object').toBe(true);
  });

  it('serves /v1/stats with every figure present', async () => {
    const res = await request(app.getHttpServer()).get('/v1/stats');
    expect(res.status, res.text).toBe(200);
    for (const k of ['verifiedPandits', 'rituals', 'cities', 'familiesServed']) {
      expect(typeof res.body[k], `${k} missing from /v1/stats`).toBe('number');
    }
  });

  it('serves /v1/panchang/schools', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/panchang/schools?citySlug=kolkata');
    expect(res.status, res.text).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

/**
 * `@Controller('v1/admin')` at the class level already supplies the `admin`
 * segment; `@Get('admin/coverage')` and `@Get('admin/incidents')` each doubled
 * it, so both only ever answered at `/v1/admin/admin/...` - the actual paths the
 * admin console and panchang/page.tsx call 404'd, silently, on a screen whose
 * whole job is surfacing failures (rematch could not save a booking) an operator
 * would otherwise never see. Static analysis can't catch a route-prefix typo;
 * only hitting the real, intended URL over HTTP tells the two apart.
 */
describe('admin routes answer at the path the frontend actually calls', () => {
  it('serves /v1/admin/coverage, not /v1/admin/admin/coverage', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/admin/coverage?citySlug=kolkata&from=2026-08-22&to=2026-08-29')
      .set('authorization', `Bearer ${adminToken()}`);
    expect(res.status, res.text).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('serves /v1/admin/incidents, not /v1/admin/admin/incidents', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/admin/incidents')
      .set('authorization', `Bearer ${adminToken()}`);
    expect(res.status, res.text).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('rejects both without an admin/ops role', async () => {
    const devoteeToken = jwt.sign(
      { sub: 'someone', role: 'devotee', typ: 'access' } satisfies JwtClaims,
      TEST_CONFIG.JWT_ACCESS_SECRET, { expiresIn: '15m' },
    );
    await request(app.getHttpServer()).get('/v1/admin/coverage')
      .set('authorization', `Bearer ${devoteeToken}`).expect(403);
    await request(app.getHttpServer()).get('/v1/admin/incidents')
      .set('authorization', `Bearer ${devoteeToken}`).expect(403);
  });
});

/**
 * `GET /v1/bookings/:id` had no test at all before the detail view that made
 * a real UI out of it - the panditProfile join in particular (experience,
 * languages, chanting sample) was added specifically for that screen and had
 * never been exercised over real HTTP.
 */
describe('the booking detail view has what the account page needs', () => {
  const token = (sub: string, role: UserRole) => jwt.sign(
    { sub, role, typ: 'access' } satisfies JwtClaims,
    TEST_CONFIG.JWT_ACCESS_SECRET, { expiresIn: '15m' },
  );

  it('returns pandit profile fields and the event timeline', async () => {
    const d = await h.bookings.createDraft({
      panditId: h.ids.panditId, ritualId: h.ids.ritualId, addressId: h.ids.addressId,
      date: daysFromNow(10),
      slotIdx: 2, samagriOption: 'pandit_brings', paymentMode: 'cash',
      attendeeCount: 10, devoteeId: h.ids.devoteeId,    } as never);
    await h.bookings.submit(d.id, h.ids.devoteeId);

    const res = await request(app.getHttpServer())
      .get(`/v1/bookings/${d.id}`)
      .set('authorization', `Bearer ${token(h.ids.devoteeId, 'devotee')}`);

    expect(res.status, res.text).toBe(200);
    expect(res.body.panditProfile).toBeTruthy();
    expect(typeof res.body.panditProfile.experienceYears).toBe('number');
    expect(Array.isArray(res.body.panditProfile.languages)).toBe(true);
    expect(Array.isArray(res.body.timeline)).toBe(true);
    expect(res.body.timeline.length).toBeGreaterThan(0);
    expect(res.body.timeline[0]).toHaveProperty('toState');
    expect(res.body.timeline[0]).toHaveProperty('at');
    // The full breakdown, not just the total - what the detail view itemises.
    expect(res.body.price).toHaveProperty('dakshinaPaise');
    expect(res.body.price).toHaveProperty('platformFeePaise');
    // No review exists yet - the account page must not read this as "already
    // submitted" just because it is present and falsy.
    expect(res.body.myReviewSubmitted).toBe(false);
  });

  /**
   * `state === 'reviewed'` does not mean THIS caller reviewed - a booking also
   * reaches `reviewed` when only the other side rated it and the 72-hour
   * one-sided window closes (reviews.service.ts publishExpired). The account
   * page used to read `state === 'reviewed'` as "thank you, already submitted"
   * regardless of who actually wrote a review; `myReviewSubmitted` exists
   * specifically so the devotee's own submission can be told apart from that.
   */
  it('reports myReviewSubmitted true once this caller has actually reviewed', async () => {
    const d = await h.bookings.createDraft({
      panditId: h.ids.panditId, ritualId: h.ids.ritualId, addressId: h.ids.addressId,
      date: daysFromNow(12),
      slotIdx: 1, samagriOption: 'pandit_brings', paymentMode: 'cash',
      attendeeCount: 10, devoteeId: h.ids.devoteeId,    } as never);
    await h.bookings.submit(d.id, h.ids.devoteeId);
    await h.bookings.accept(d.id, h.ids.panditId);
    const c = await h.bookings.confirmOnTokenCapture({
      bookingId: d.id, paymentIntentId: `pi_${d.id}`,
    });
    await h.bookings.start({ bookingId: d.id, panditId: h.ids.panditId, otp: c.startOtp! });
    const done = await h.bookings.complete({
      bookingId: d.id, panditId: h.ids.panditId, otp: c.completeOtp!,
      cashCollectedPaise: (d.price as { balancePaise: number }).balancePaise,
      capturedAt: new Date().toISOString(),
    });

    const devoteeToken = token(h.ids.devoteeId, 'devotee');
    const before = await request(app.getHttpServer())
      .get(`/v1/bookings/${done.id}`)
      .set('authorization', `Bearer ${devoteeToken}`);
    expect(before.body.myReviewSubmitted).toBe(false);

    await request(app.getHttpServer())
      .post(`/v1/bookings/${done.id}/review`)
      .set('authorization', `Bearer ${devoteeToken}`)
      .send({ panditStars: 5 })
      .expect(201);

    const after = await request(app.getHttpServer())
      .get(`/v1/bookings/${done.id}`)
      .set('authorization', `Bearer ${devoteeToken}`);
    expect(after.body.myReviewSubmitted).toBe(true);
    // Neither review published yet (only one side has), so the purohit's own
    // call still reports its own honest `false`, not the devotee's `true`.
    const panditView = await request(app.getHttpServer())
      .get(`/v1/bookings/${done.id}`)
      .set('authorization', `Bearer ${token(h.ids.panditId, 'pandit')}`);
    expect(panditView.body.myReviewSubmitted).toBe(false);
  });

  it('is forbidden to someone who is neither the devotee nor the purohit', async () => {
    const d = await h.bookings.createDraft({
      panditId: h.ids.panditId, ritualId: h.ids.ritualId, addressId: h.ids.addressId,
      date: daysFromNow(11),
      slotIdx: 3, samagriOption: 'pandit_brings', paymentMode: 'cash',
      attendeeCount: 10, devoteeId: h.ids.devoteeId,    } as never);

    const res = await request(app.getHttpServer())
      .get(`/v1/bookings/${d.id}`)
      .set('authorization', `Bearer ${token('some-other-user', 'devotee')}`);
    expect(res.status).toBe(403);
  });
});
