import { prisma } from './prisma';

interface AuditOptions {
  actorType: 'admin' | 'system' | 'bot';
  actorId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

const SENSITIVE_FIELDS = ['password', 'passwordHash', 'api_key', 'service_account_json', 'encryptedPayload', 'encrypted_payload'];

function redact(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  return JSON.parse(JSON.stringify(obj, (key, value) =>
    SENSITIVE_FIELDS.includes(key) ? '[REDACTED]' : value
  ));
}

export async function writeAuditLog(opts: AuditOptions): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorType: opts.actorType as any,
        actorId: opts.actorId,
        action: opts.action,
        entityType: opts.entityType,
        entityId: opts.entityId,
        beforeState: opts.beforeState ? redact(opts.beforeState) as any : undefined,
        afterState: opts.afterState ? redact(opts.afterState) as any : undefined,
        ipAddress: opts.ipAddress,
        userAgent: opts.userAgent,
      },
    });
  } catch (err) {
    // audit log failure must never break the main flow
    console.error('Failed to write audit log', err);
  }
}
