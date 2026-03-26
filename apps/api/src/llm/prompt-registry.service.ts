import { prisma } from '../lib/prisma';

export interface RenderedPrompt {
  system: string;
  user: string;
}

class PromptRegistryService {
  async getActivePrompt(sourceId: string) {
    const template = await prisma.promptTemplate.findUnique({ where: { sourceId } });
    if (!template) return null;

    // Prefer activeVersionId (set explicitly in admin panel), fall back to latest isActive
    if (template.activeVersionId) {
      const version = await prisma.promptVersion.findUnique({ where: { id: template.activeVersionId } });
      if (version) return version;
    }
    return prisma.promptVersion.findFirst({
      where: { templateId: template.id, isActive: true },
      orderBy: { versionNumber: 'desc' },
    });
  }

  async renderPrompt(version: { systemPrompt: string; userPrompt: string }, variables: Record<string, unknown>): Promise<RenderedPrompt> {
    const render = (template: string) =>
      template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
        variables[key] !== undefined ? String(variables[key]) : `{{${key}}}`
      );
    return { system: render(version.systemPrompt), user: render(version.userPrompt) };
  }
}

export const promptRegistry = new PromptRegistryService();
