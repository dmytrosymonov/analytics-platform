import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { encrypt, decrypt } from '../../lib/encryption';
import { writeAuditLog } from '../../lib/audit';
import { connectorRegistry } from '../../connectors/registry';

export async function sourceRoutes(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.get('/', auth, async (request, reply) => {
    const sources = await prisma.dataSource.findMany({
      include: { credentials: { select: { isValid: true, lastValidatedAt: true, validationError: true } } },
      orderBy: { name: 'asc' },
    });
    return reply.send({ success: true, data: sources });
  });

  app.get('/:id', auth, async (request, reply) => {
    const { id } = request.params as any;
    const source = await prisma.dataSource.findUnique({
      where: { id },
      include: {
        credentials: { select: { isValid: true, lastValidatedAt: true, validationError: true } },
        settings: true,
      },
    });
    if (!source) return reply.status(404).send({ success: false, error: { message: 'Source not found' } });
    return reply.send({ success: true, data: source });
  });

  app.patch('/:id', auth, async (request, reply) => {
    const { id } = request.params as any;
    const body = z.object({ isEnabled: z.boolean().optional(), description: z.string().optional() }).parse(request.body);
    const actor = (request.user as any);

    const before = await prisma.dataSource.findUnique({ where: { id } });
    const updated = await prisma.dataSource.update({ where: { id }, data: body });

    await writeAuditLog({ actorType: 'admin', actorId: actor.sub, action: 'source.updated', entityType: 'data_source', entityId: id, beforeState: before as any, afterState: updated as any });

    return reply.send({ success: true, data: updated });
  });

  app.put('/:id/credentials', auth, async (request, reply) => {
    const { id } = request.params as any;
    const actor = (request.user as any);
    const body = request.body as Record<string, string>;

    const encryptedPayload = encrypt(JSON.stringify(body));
    const existing = await prisma.sourceCredential.findUnique({ where: { sourceId: id } });

    const cred = await prisma.sourceCredential.upsert({
      where: { sourceId: id },
      create: { sourceId: id, encryptedPayload, isValid: null },
      update: { encryptedPayload, isValid: null, lastValidatedAt: null, validationError: null },
    });

    await writeAuditLog({
      actorType: 'admin', actorId: actor.sub,
      action: existing ? 'credential.updated' : 'credential.created',
      entityType: 'source_credential', entityId: cred.id,
      beforeState: { exists: !!existing }, afterState: { exists: true },
      ipAddress: request.ip,
    });

    return reply.send({ success: true, data: { id: cred.id, exists: true, isValid: null } });
  });

  app.delete('/:id/credentials', auth, async (request, reply) => {
    const { id } = request.params as any;
    const actor = (request.user as any);

    await prisma.sourceCredential.deleteMany({ where: { sourceId: id } });
    await writeAuditLog({ actorType: 'admin', actorId: actor.sub, action: 'credential.deleted', entityType: 'data_source', entityId: id });

    return reply.send({ success: true });
  });

  app.get('/:id/settings', auth, async (request, reply) => {
    const { id } = request.params as any;
    const settings = await prisma.sourceSetting.findMany({ where: { sourceId: id } });
    return reply.send({ success: true, data: settings });
  });

  app.put('/:id/settings', auth, async (request, reply) => {
    const { id } = request.params as any;
    const { settings } = z.object({ settings: z.record(z.string()) }).parse(request.body);

    for (const [key, value] of Object.entries(settings)) {
      await prisma.sourceSetting.upsert({
        where: { sourceId_key: { sourceId: id, key } },
        create: { sourceId: id, key, value },
        update: { value },
      });
    }

    return reply.send({ success: true });
  });

  app.post('/:id/test', auth, async (request, reply) => {
    const { id } = request.params as any;
    const start = Date.now();

    const source = await prisma.dataSource.findUnique({ where: { id } });
    if (!source) return reply.status(404).send({ success: false, error: { message: 'Source not found' } });

    const credRecord = await prisma.sourceCredential.findUnique({ where: { sourceId: id } });
    if (!credRecord) {
      return reply.send({ success: false, data: { success: false, error: 'No credentials configured' } });
    }

    try {
      const credentials = JSON.parse(decrypt(credRecord.encryptedPayload));
      const connector = connectorRegistry.get(source.type as any);
      const valid = await connector.validateCredentials(credentials);

      await prisma.sourceCredential.update({
        where: { sourceId: id },
        data: { isValid: valid, lastValidatedAt: new Date(), validationError: valid ? null : 'Validation failed' },
      });

      return reply.send({ success: true, data: { success: valid, latencyMs: Date.now() - start } });
    } catch (err: any) {
      await prisma.sourceCredential.update({
        where: { sourceId: id },
        data: { isValid: false, lastValidatedAt: new Date(), validationError: err.message },
      });
      return reply.send({ success: true, data: { success: false, latencyMs: Date.now() - start, error: err.message } });
    }
  });
}
