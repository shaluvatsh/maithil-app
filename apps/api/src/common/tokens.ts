/**
 * DI tokens live here, not in app.module.
 *
 * Controllers need the DB token, and app.module needs the controllers. Declaring the
 * tokens inside app.module makes that a cycle - and under ESM the token can evaluate
 * to `undefined` in whichever module loads first, so Nest fails to resolve the
 * dependency at boot with an error that points nowhere near the real cause.
 */
export const CONFIG = Symbol('CONFIG');
export const DB = Symbol('DB');
export const KV = Symbol('KV');
