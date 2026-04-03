import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { writeAuditLog } from '../../lib/audit';
import { llmService } from '../../llm/llm.service';
import { promptRegistry } from '../../llm/prompt-registry.service';

export async function promptRoutes(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.get('/', auth, async (request, reply) => {
    const templates = await prisma.promptTemplate.findMany({
      include: { source: { select: { id: true, name: true, type: true } } },
    });
    return reply.send({ success: true, data: templates });
  });

  app.get('/:id/versions', auth, async (request, reply) => {
    const { id } = request.params as any;
    const versions = await prisma.promptVersion.findMany({
      where: { templateId: id },
      orderBy: { versionNumber: 'desc' },
    });
    return reply.send({ success: true, data: versions });
  });

  app.post('/:id/versions', auth, async (request, reply) => {
    const { id } = request.params as any;
    const actor = (request.user as any);
    const body = z.object({
      systemPrompt: z.string().min(10),
      userPrompt: z.string().min(10),
      variables: z.array(z.string()).default([]),
      outputSchema: z.record(z.unknown()).optional(),
    }).parse(request.body);

    const lastVersion = await prisma.promptVersion.findFirst({
      where: { templateId: id },
      orderBy: { versionNumber: 'desc' },
    });

    const version = await prisma.promptVersion.create({
      data: {
        templateId: id,
        versionNumber: (lastVersion?.versionNumber ?? 0) + 1,
        systemPrompt: body.systemPrompt,
        userPrompt: body.userPrompt,
        variables: body.variables,
        outputSchema: body.outputSchema as any,
        createdBy: actor.sub,
      },
    });

    return reply.status(201).send({ success: true, data: version });
  });

  app.post('/:id/versions/:vid/activate', auth, async (request, reply) => {
    const { id, vid } = request.params as any;
    const actor = (request.user as any);

    // Deactivate all versions for this template
    await prisma.promptVersion.updateMany({ where: { templateId: id }, data: { isActive: false } });
    // Activate selected version
    await prisma.promptVersion.update({ where: { id: vid }, data: { isActive: true } });
    // Update template active version pointer
    await prisma.promptTemplate.update({ where: { id }, data: { activeVersionId: vid } });

    await writeAuditLog({ actorType: 'admin', actorId: actor.sub, action: 'prompt.version.activated', entityType: 'prompt_version', entityId: vid });

    return reply.send({ success: true });
  });

  app.post('/:id/versions/:vid/test', auth, async (request, reply) => {
    const { id, vid } = request.params as any;
    const body = z.object({ sampleData: z.record(z.unknown()).optional() }).optional().parse(request.body);

    const version = await prisma.promptVersion.findUnique({ where: { id: vid } });
    if (!version) return reply.status(404).send({ success: false, error: { message: 'Version not found' } });

    const template = await prisma.promptTemplate.findUnique({ where: { id }, include: { source: true } });
    if (!template) return reply.status(404).send({ success: false, error: { message: 'Template not found' } });

    // Get sample data from last successful result or use provided
    let sampleMetrics = body?.sampleData || {};
    if (!body?.sampleData) {
      const lastResult = await prisma.reportResult.findFirst({
        where: { sourceId: template.sourceId },
        orderBy: { createdAt: 'desc' },
      });
      sampleMetrics = (lastResult?.normalizedData as any) || { sample: true, message: 'No real data available yet' };
    }

    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    const rendered = await promptRegistry.renderPrompt(version as any, {
      report_period_start: yesterday.toISOString(),
      report_period_end: now.toISOString(),
      source_name: template.source.name,
      normalized_metrics_json: JSON.stringify(sampleMetrics),
      output_language: 'English',
      audience_type: 'business',
    });

    const result = await llmService.analyze({
      systemPrompt: rendered.system,
      userPrompt: rendered.user,
      sourceId: template.sourceId,
      runId: 'test',
    });

    return reply.send({ success: true, data: { output: result.structuredOutput, tokenUsage: result.tokenUsage, costUsd: result.costUsd, durationMs: result.durationMs } });
  });
}
