import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getDailyLookerWindow,
  getGtoLookerSyncStatus,
  syncGtoLookerOrders,
} from '../../services/gto-looker-sync.service';
import {
  getGtoAgentSegmentStatus,
  refreshGtoAgentSegments,
} from '../../services/gto-agent-segmentation.service';
import { prisma } from '../../lib/prisma';
import { writeAuditLog } from '../../lib/audit';

function normalizeAgentName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function lookerRoutes(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.get('/gto-orders/status', auth, async (_request, reply) => {
    const data = await getGtoLookerSyncStatus();
    return reply.send({ success: true, data });
  });

  app.get('/gto-orders/default-window', auth, async (_request, reply) => {
    return reply.send({ success: true, data: getDailyLookerWindow() });
  });

  app.post('/gto-orders/sync', auth, async (request, reply) => {
    const body = z.object({
      mode: z.enum(['daily', 'manual', 'backfill']).default('manual'),
      dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(request.body);

    const actor = request.user as any;
    const result = await syncGtoLookerOrders({
      mode: body.mode,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      triggeredBy: actor?.email || actor?.sub || 'admin',
    });

    return reply.send({ success: true, data: result });
  });

  app.get('/gto-agent-segments/status', auth, async (_request, reply) => {
    return reply.send({ success: true, data: await getGtoAgentSegmentStatus() });
  });

  app.post('/gto-agent-segments/refresh', auth, async (request, reply) => {
    const body = z.object({
      snapshotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dryRun: z.boolean().default(false),
    }).parse(request.body);
    if (body.snapshotDate && (body.from || body.to)) {
      return reply.status(400).send({ success: false, error: { message: 'Use snapshotDate or from/to, not both' } });
    }
    if ((body.from && !body.to) || (!body.from && body.to)) {
      return reply.status(400).send({ success: false, error: { message: 'Use both from and to' } });
    }
    const actor = request.user as any;
    const result = await refreshGtoAgentSegments({
      snapshotDate: body.snapshotDate,
      from: body.from,
      to: body.to,
      dryRun: body.dryRun,
      processDirty: !body.dryRun,
      triggeredBy: actor?.email || actor?.sub || 'admin',
    });
    return reply.send({ success: true, data: result });
  });

  app.get('/gto-agent-segments/scope-overrides', auth, async (_request, reply) => {
    const overrides = await prisma.reportingGtoAgentScopeOverride.findMany({
      orderBy: [{ isActive: 'desc' }, { normalizedAgentName: 'asc' }, { agentId: 'asc' }],
    });
    return reply.send({ success: true, data: overrides });
  });

  app.post('/gto-agent-segments/scope-overrides', auth, async (request, reply) => {
    const body = z.object({
      agentId: z.string().trim().min(1).optional(),
      agentName: z.string().trim().min(1).optional(),
      isCommercial: z.boolean(),
      reason: z.string().trim().min(3).max(500),
    }).refine((value) => value.agentId || value.agentName, { message: 'agentId or agentName is required' }).parse(request.body);
    const actor = request.user as any;
    const created = await prisma.reportingGtoAgentScopeOverride.create({
      data: {
        agentId: body.agentId || null,
        normalizedAgentName: body.agentName ? normalizeAgentName(body.agentName) : null,
        isCommercial: body.isCommercial,
        reason: body.reason,
        createdBy: actor?.email || actor?.sub || null,
      },
    });
    await writeAuditLog({
      actorType: 'admin', actorId: actor?.sub, action: 'gto_agent_scope_override.created',
      entityType: 'reporting_gto_agent_scope_override', entityId: created.id,
      afterState: { agentId: created.agentId, normalizedAgentName: created.normalizedAgentName, isCommercial: created.isCommercial, reason: created.reason },
      ipAddress: request.ip,
    });
    return reply.status(201).send({ success: true, data: created });
  });

  app.patch('/gto-agent-segments/scope-overrides/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      isCommercial: z.boolean().optional(),
      reason: z.string().trim().min(3).max(500).optional(),
      isActive: z.boolean().optional(),
    }).parse(request.body);
    const actor = request.user as any;
    const previous = await prisma.reportingGtoAgentScopeOverride.findUnique({ where: { id } });
    if (!previous) return reply.status(404).send({ success: false, error: { message: 'Scope override not found' } });
    const updated = await prisma.reportingGtoAgentScopeOverride.update({ where: { id }, data: body });
    await writeAuditLog({
      actorType: 'admin', actorId: actor?.sub, action: 'gto_agent_scope_override.updated',
      entityType: 'reporting_gto_agent_scope_override', entityId: id,
      beforeState: { isCommercial: previous.isCommercial, reason: previous.reason, isActive: previous.isActive },
      afterState: { isCommercial: updated.isCommercial, reason: updated.reason, isActive: updated.isActive },
      ipAddress: request.ip,
    });
    return reply.send({ success: true, data: updated });
  });
}
