import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB } from '../common/tokens';
import type { Db } from '../db/client';
import { Public } from './auth/guards';

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Liveness: is the process up? Deliberately does NOT touch the database - a DB
   * blip should not make the orchestrator kill and restart a healthy process.
   */
  @Public()
  @Get('livez')
  livez() {
    return { status: 'ok', uptimeSec: Math.round(process.uptime()) };
  }

  /** Readiness: should this instance receive traffic? This one does check the DB. */
  @Public()
  @Get('readyz')
  async readyz() {
    const body = await this.health();
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }

  @Public()
  @Get('health')
  async health() {
    let database = 'down';
    try {
      await this.db.execute(sql`SELECT 1`);
      database = 'up';
    } catch { /* reported as down */ }
    return { status: database === 'up' ? 'ok' : 'degraded', database, at: new Date().toISOString() };
  }
}
