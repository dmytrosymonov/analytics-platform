import { Job } from 'bullmq';
import { prisma } from '../lib/prisma';
import { llmService } from '../llm/llm.service';
import { promptRegistry } from '../llm/prompt-registry.service';
import { deliverQueue } from '../queue/queues';
import { logger } from '../lib/logger';

function stripSummerSection(text: string) {
  return text.replace(/\n{2,}☀️ Лето:[\s\S]*$/u, '').trim();
}

function annotateCnfFinancials(text: string) {
  return text
    .replace(/^💶\s*Выручка:/gmu, '💶 Выручка по CNF:')
    .replace(/^Прибыль:/gmu, 'Прибыль по CNF:')
    .replace(/^💼\s*Средний чек:/gmu, '💼 Средний чек по CNF:')
    .replace(/^💼 Средний чек по CNF:.*$/gmu, (line) => `${line}\nВсе денежные показатели приведены к EUR.`);
}

function toColumnList(text: string, header: string) {
  const pattern = new RegExp(`^${header}:\\s*(.+)$`, 'gmu');
  return text.replace(pattern, (_match, items: string) => {
    const lines = items.split(/\s*,\s*/).filter(Boolean);
    return `${header}:\n${lines.join('\n')}`;
  });
}

function removeOtherAnomalies(text: string) {
  return text.replace(/\n⚠️ Прочие аномалии:[\s\S]*?(?=\n(?:📊 За последние 7 дней|🔮 Старт Ближ\. 7 дней|Старт ближ\. 30 дней|☀️ |\Z))/gu, '');
}

function sortDestinationLines(lines: string[]) {
  return [...lines].sort((a, b) => {
    const aTourists = Number(a.match(/-\s*(\d+)\s+турист/u)?.[1] || 0);
    const bTourists = Number(b.match(/-\s*(\d+)\s+турист/u)?.[1] || 0);
    return bTourists - aTourists;
  });
}

function sortUpcomingBlocks(text: string) {
  const lines = text.split('\n');
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    result.push(lines[i]);
    if (lines[i].trim() === 'Самые популярные направления:' || /^Старт ближ\. 30 дней:/u.test(lines[i].trim())) {
      const block: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (!next.trim()) break;
        if (/^(📊|🔮|☀️|💶|📦|👥|💎|Самые популярные направления:)/u.test(next.trim())) break;
        block.push(next);
        i++;
      }
      if (block.length > 0) result.push(...sortDestinationLines(block));
    }
  }
  return result.join('\n');
}

function formatGtoReportText(text: string) {
  let formatted = text;
  formatted = annotateCnfFinancials(formatted);
  formatted = toColumnList(formatted, '🌍 Направления');
  formatted = toColumnList(formatted, '📦 Продукты');
  formatted = removeOtherAnomalies(formatted);
  formatted = sortUpcomingBlocks(formatted);
  return formatted.trim();
}

export async function handleAnalyzeJob(job: Job) {
  const { runId, sourceId } = job.data;
  logger.info({ runId, sourceId }, 'Starting analyze job');

  await prisma.reportJob.upsert({
    where: { runId_sourceId_jobType: { runId, sourceId, jobType: 'analyze' } },
    create: { runId, sourceId, jobType: 'analyze', status: 'running', startedAt: new Date() },
    update: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 } },
  });

  const result = await prisma.reportResult.findUnique({ where: { runId_sourceId: { runId, sourceId } } });
  if (!result) throw new Error('No fetch result found');

  const promptVersion = await promptRegistry.getActivePrompt(sourceId);
  if (!promptVersion) {
    logger.warn({ sourceId }, 'No active prompt, using default message');
    const fallbackMessage = `📊 *Analytics Report*\n\nData collected successfully but no analysis prompt configured.\n\n\`\`\`\n${JSON.stringify(result.normalizedData, null, 2).slice(0, 3000)}\n\`\`\``;
    await prisma.reportResult.update({
      where: { runId_sourceId: { runId, sourceId } },
      data: { formattedMessage: fallbackMessage },
    });
    await prisma.reportJob.update({
      where: { runId_sourceId_jobType: { runId, sourceId, jobType: 'analyze' } },
      data: { status: 'success', completedAt: new Date() },
    });
    await deliverQueue.add('deliver', { runId, sourceId }, { jobId: `deliver:${runId}:${sourceId}` });
    return;
  }

  const run = await prisma.reportRun.findUnique({ where: { id: runId } });
  const source = await prisma.dataSource.findUnique({ where: { id: sourceId } });

  const rendered = await promptRegistry.renderPrompt(promptVersion, {
    report_period_start: run!.periodStart.toISOString(),
    report_period_end: run!.periodEnd.toISOString(),
    source_name: source!.name,
    normalized_metrics_json: JSON.stringify(result.normalizedData),
    output_language: 'English',
    audience_type: 'business',
  });

  const llmResult = await llmService.analyze({
    systemPrompt: rendered.system,
    userPrompt: rendered.user,
    sourceId,
    runId,
  });

  let formattedMessage = llmResult.telegramMessage;
  if (source?.type === 'gto' && run?.scheduleId) {
    const schedule = await prisma.reportSchedule.findUnique({ where: { id: run.scheduleId } });
    if (schedule?.periodType === 'daily') {
      formattedMessage = stripSummerSection(formattedMessage);
      formattedMessage = formatGtoReportText(formattedMessage);
    }
  }

  await prisma.reportResult.update({
    where: { runId_sourceId: { runId, sourceId } },
    data: {
      promptVersionId: promptVersion.id,
      llmRequest: { system: rendered.system, user: rendered.user } as any,
      llmResponse: llmResult.structuredOutput as any,
      structuredOutput: llmResult.structuredOutput as any,
      formattedMessage,
      tokenUsage: llmResult.tokenUsage as any,
      llmModel: llmResult.model,
      llmCostUsd: llmResult.costUsd,
    },
  });

  await prisma.reportJob.update({
    where: { runId_sourceId_jobType: { runId, sourceId, jobType: 'analyze' } },
    data: { status: 'success', completedAt: new Date() },
  });

  logger.info({ runId, sourceId, costUsd: llmResult.costUsd }, 'Analyze job succeeded, enqueueing deliver');
  await deliverQueue.add('deliver', { runId, sourceId }, { jobId: `deliver:${runId}:${sourceId}`, attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
}
