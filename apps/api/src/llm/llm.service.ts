import OpenAI from 'openai';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { redis } from '../lib/redis';
import { HTTP_LOG_REDIS_KEY } from '../lib/log-drain';
import { HttpLogEntry } from '../lib/http';

export interface LLMAnalysisResult {
  model: string;
  structuredOutput: Record<string, unknown>;
  telegramMessage: string;
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
  costUsd: number;
  durationMs: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function pushLlmLog(entry: HttpLogEntry): Promise<void> {
  try {
    await redis.lpush(HTTP_LOG_REDIS_KEY, JSON.stringify(entry));
  } catch {
    // never block on log errors
  }
}

class LLMService {
  private _openai: OpenAI | null = null;
  // Each LLMService instance shares one sessionId per process lifetime,
  // but analyze() generates a fresh one per call so calls are grouped correctly.
  private makeSessionId = () => `openai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  private async getOpenAI(): Promise<OpenAI> {
    const dbKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'llm.api_key' } });
    const apiKey = dbKeySetting?.value || process.env.OPENAI_API_KEY || '';
    if (!apiKey || apiKey.startsWith('sk-placeholder') || apiKey.startsWith('sk-your')) {
      throw new Error('OpenAI API key is not configured. Add it in Settings → AI / LLM → OpenAI API Key.');
    }
    if (!this._openai || (this._openai as any).apiKey !== apiKey) {
      this._openai = new OpenAI({ apiKey });
    }
    return this._openai;
  }

  async analyze(params: { systemPrompt: string; userPrompt: string; sourceId: string; runId: string }): Promise<LLMAnalysisResult> {
    const start = Date.now();
    const sessionId = this.makeSessionId();

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

    const openai = await this.getOpenAI();

    try {
      response = await this.callWithRetry(openai, model, maxTokens, temperature, params.systemPrompt, params.userPrompt);
    } catch (err) {
      logger.warn({ err }, 'Primary LLM model failed, trying fallback');
      const fallbackSetting = await prisma.systemSetting.findUnique({ where: { key: 'llm.fallback_model' } });
      usedModel = fallbackSetting?.value || 'gpt-4o-mini';
      response = await this.callWithRetry(openai, usedModel, maxTokens, temperature, params.systemPrompt, params.userPrompt);
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
    const durationMs = Date.now() - start;

    void pushLlmLog({
      id: `llm-${Date.now()}`,
      sessionId,
      ts: new Date().toISOString(),
      connector: 'openai',
      type: 'res',
      method: 'POST',
      url: '/chat/completions',
      params: { model: usedModel, sourceId: params.sourceId, runId: params.runId },
      status: 200,
      ms: durationMs,
      responseSample: {
        promptTokens:     usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens:      usage.total_tokens,
        costUsd:          cost,
        systemPrompt:     params.systemPrompt.slice(0, 500),
        userPrompt:       params.userPrompt.slice(0, 500),
        response:         content.slice(0, 2000),
      },
    });

    return {
      model: usedModel,
      structuredOutput: parsed,
      telegramMessage: (parsed['telegram_message'] as string) || content.slice(0, 4000),
      tokenUsage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens },
      costUsd: cost,
      durationMs,
    };
  }

  private async callWithRetry(
    openai: OpenAI,
    model: string,
    maxTokens: number,
    temperature: number,
    system: string,
    user: string,
  ): Promise<OpenAI.Chat.ChatCompletion> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await openai.chat.completions.create({
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

  /** Plain-text chat (not JSON format) — used for free-form bot queries. */
  async chat(systemPrompt: string, userPrompt: string): Promise<string> {
    const start = Date.now();
    const sessionId = this.makeSessionId();
    const openai = await this.getOpenAI();
    const modelSetting = await prisma.systemSetting.findUnique({ where: { key: 'llm.default_model' } });
    const model = modelSetting?.value || 'gpt-4o-mini';

    try {
      const response = await openai.chat.completions.create({
        model,
        max_tokens: 2000,
        temperature: 0.3,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      });
      const content = response.choices[0]?.message?.content || 'Нет ответа';
      const usage = response.usage;
      const durationMs = Date.now() - start;

      void pushLlmLog({
        id: `llm-chat-${Date.now()}`,
        sessionId,
        ts: new Date().toISOString(),
        connector: 'openai',
        type: 'res',
        method: 'POST',
        url: '/chat/completions',
        params: { model, mode: 'chat' },
        status: 200,
        ms: durationMs,
        responseSample: {
          promptTokens:     usage?.prompt_tokens,
          completionTokens: usage?.completion_tokens,
          costUsd:          usage ? this.computeCost(model, usage.prompt_tokens, usage.completion_tokens) : null,
          systemPrompt:     systemPrompt.slice(0, 300),
          userPrompt:       userPrompt.slice(0, 300),
          response:         content.slice(0, 2000),
        },
      });

      return content;
    } catch (err: any) {
      void pushLlmLog({
        id: `llm-chat-${Date.now()}-e`,
        sessionId,
        ts: new Date().toISOString(),
        connector: 'openai',
        type: 'err',
        method: 'POST',
        url: '/chat/completions',
        params: { model, mode: 'chat' },
        status: err?.status,
        ms: Date.now() - start,
        error: err.message,
        errorBody: err?.error ? JSON.stringify(err.error) : undefined,
      });
      throw err;
    }
  }

  private computeCost(model: string, promptTokens: number, completionTokens: number): number {
    const pricing: Record<string, { prompt: number; completion: number }> = {
      'gpt-4o':      { prompt: 0.000005,  completion: 0.000015 },
      'gpt-4o-mini': { prompt: 0.0000003, completion: 0.0000006 },
    };
    const p = pricing[model] || pricing['gpt-4o-mini'];
    return promptTokens * p.prompt + completionTokens * p.completion;
  }
}

export const llmService = new LLMService();
