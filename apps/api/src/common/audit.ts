import { ulid } from 'ulid';
import type { Executor } from '../db/client';
import { auditLog } from '../db/schema/index';

/**
 * Required by the PRD ("every admin mutation audit-logged") and absent from the
 * original schema. Call inside the same transaction as the mutation.
 */
export class AuditService {
  async record(tx: Executor, args: {
    actorId?: string | null;
    actorRole?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
  }): Promise<void> {
    await tx.insert(auditLog).values({
      id: ulid(),
      actorId: args.actorId ?? null,
      actorRole: args.actorRole ?? null,
      action: args.action,
      entityType: args.entityType,
      entityId: args.entityId,
      before: (args.before ?? null) as object | null,
      after: (args.after ?? null) as object | null,
      ip: args.ip ?? null,
    });
  }
}
