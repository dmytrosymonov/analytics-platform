import OpenAI from 'openai';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export interface LLMAnalysisResult {
  model: string;
  structuredOutput: Record<string, unknown>;
  telegramMessage: string;
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
  costUsd: number;
  durationMs: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class LLMService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async analyze(params: { systemPrompt: string; userPrompt: string; sourceId: string; runId: string }): Promise<LLMAnalysisResult> {
    const start = Date.now();

    const [modelSetting, maxTokensSetting, temperatureSetting] = await Promise.all([
      prisma.systemSetting.findUnique({ where: { key: 'llm.default_model' } }),
      prisma.systemSetting.findUnique({ where: { key: 'llm.max_tokens' } }),
      prisma.systemSetting.findUnique({ where: { key: 'llm.temperature' } }),
    ]);

    const model = modelSetting?.value || 'gpt-4o-mini';
    const maxTokens = parseInt(maxTokensSetting?.value || '4096');
    const temperature = parseFloat(temperatureSetting?.value || '0.3');

    let response: OpenAI.Chat.ChatCompletion | null = null;
    let usedModel = model;

    try {
      response = await this.callWithRetry(model, maxTokens, temperature, params.systemPrompt, params.userPrompt);
    } catch (err) {
      logger.warn({ err }, 'Primary LLM model failed, trying fallback');
      const fallbackSetting = await prisma.systemSetting.findUnique({ where: { key: 'llm.fallback_model' } });
      usedModel = fallbackSetting?.value || 'gpt-4o-mini';
      response = await this.callWithRetry(usedModel, maxTokens, temperature, params.systemPrompt, params.userPrompt);
    }

    const content = response.choices[0]?.message?.content || '{}';
    let parsed: Record<string, unknown> = {};
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    } catch {
      parsed = { executive_summary: content, telegram_message: content };
    }

    const usage = response.usage!;
    const cost = this.computeCost(usedModel, usage.prompt_tokens, usage.completion_tokens);

    return {
      model: usedModel,
      structuredOutput: parsed,
      telegramMessage: (parsed['telegram_message'] as string) || content.slice(0, 4000),
      tokenUsage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens },
      costUsd: cost,
      durationMs: Date.now() - start,
    };
  }

  private async callWithRetry(model: string, maxTokens: number, temperature: number, system: string, user: string): Promise<OpenAI.Chat.ChatCompletion> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.openai.chat.completions.create({
          model,
          max_tokens: maxTokens,
          temperature,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        });
      } catch (err: any) {
        if (attempt === 2) throw err;
        if (err?.status === 429 || (err?.status || 0) >= 500) {
          await sleep(2000 * Math.pow(2, attempt));
        } else {
          throw err;
        }
      }
    }
    throw new Error('LLM call failed after retries');
  }

  private computeCost(model: string, promptTokens: number, completionTokens: number): number {
    const pricing: Record<string, { prompt: number; completion: number }> = {
      'gpt-4o': { prompt: 0.000005, completion: 0.000015 },
      'gpt-4o-mini': { prompt: 0.0000003, completion: 0.0000006 },
    };
    const p = pricing[model] || pricing['gpt-4o-mini'];
    return promptTokens * p.prompt + completionTokens * p.completion;
  }
}

export const llmService = new LLMService();
