import { prisma } from '../lib/prisma';

export interface RenderedPrompt {
  system: string;
  user: string;
}

class PromptRegistryService {
  async getActivePrompt(sourceId: string) {
    const template = await prisma.promptTemplate.findUnique({
      where: { sourceId },
      include: { versions: { where: { isActive: true }, take: 1 } },
    });
    return template?.versions?.[0] ?? null;
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
