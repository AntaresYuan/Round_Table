/* ============================================================================
   minimax-adapter.ts — opt-in real-model execution via MiniMax.

   Calls the MiniMax OpenAI-compatible chat/completions endpoint. Like the E2B
   adapter, this is opt-in and never a silent fallback: if no key is configured
   it throws MiniMaxUnavailableError, which the dispatch layer catches to fall
   back to local-dispatch (logged on the task, not console).

   MiniMax-M3 is a reasoning model that emits <think>…</think> blocks; we strip
   them so the artifact is the clean answer, and surface the reasoning length via
   the returned usage for observability.
   ============================================================================ */

export type MiniMaxMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type MiniMaxRunInput = {
  messages: MiniMaxMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  timeoutMs?: number | undefined;
  // M3 emits <think> reasoning by default; disable it for clean deliverables.
  // Ignored by M2.x. Defaults to disabled.
  thinking?: boolean | undefined;
};

export type MiniMaxRunOutput = {
  text: string;
  reasoning?: string | undefined;
  raw: string;
  usage?: Record<string, unknown> | undefined;
};

export class MiniMaxUnavailableError extends Error {
  readonly code = 'minimax_unavailable';
  constructor(message = 'minimax_unavailable') {
    super(message);
    this.name = 'MiniMaxUnavailableError';
  }
}

export class MiniMaxRequestError extends Error {
  readonly code = 'minimax_request_failed';
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'MiniMaxRequestError';
  }
}

export function isMiniMaxAvailable(): boolean {
  return Boolean(process.env.MINIMAX_API_KEY && process.env.MINIMAX_API_KEY.trim());
}

function baseUrl(): string {
  return (process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1').replace(/\/$/, '');
}

export function miniMaxModel(): string {
  return process.env.MINIMAX_MODEL || 'MiniMax-M3';
}

/** Remove <think>…</think> reasoning blocks; return [clean, reasoning]. */
export function stripThink(content: string): [string, string | undefined] {
  const blocks: string[] = [];
  const clean = content
    .replace(/<think>([\s\S]*?)<\/think>/g, (_m, inner: string) => {
      blocks.push(inner.trim());
      return '';
    })
    // An unterminated <think> (truncated output) — drop everything after it.
    .replace(/<think>[\s\S]*$/, '')
    .trim();
  return [clean, blocks.length > 0 ? blocks.join('\n\n') : undefined];
}

/**
 * Run a chat completion against MiniMax. Throws MiniMaxUnavailableError when no
 * key is configured, MiniMaxRequestError on a non-2xx / API-level error.
 */
export async function runOnMiniMax(input: MiniMaxRunInput): Promise<MiniMaxRunOutput> {
  if (!isMiniMaxAvailable()) {
    throw new MiniMaxUnavailableError('MINIMAX_API_KEY is not set');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 120_000);
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
      },
      body: JSON.stringify({
        model: miniMaxModel(),
        messages: input.messages,
        max_tokens: input.maxTokens ?? 8192,
        temperature: input.temperature ?? 0.7,
        stream: false,
        // Default to no reasoning so the deliverable comes back clean and fast;
        // also split any reasoning out of `content` as a belt-and-suspenders.
        thinking: { type: input.thinking ? 'adaptive' : 'disabled' },
        reasoning_split: true,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MiniMaxRequestError(`minimax_network_error: ${message}`);
  } finally {
    clearTimeout(timer);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: Record<string, unknown>;
    base_resp?: { status_code?: number; status_msg?: string };
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new MiniMaxRequestError(data.error?.message || `http_${response.status}`, response.status);
  }
  // MiniMax surfaces app-level errors in base_resp even on HTTP 200.
  if (data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
    throw new MiniMaxRequestError(
      `minimax_${data.base_resp.status_code}: ${data.base_resp.status_msg ?? 'error'}`,
    );
  }

  const raw = data.choices?.[0]?.message?.content ?? '';
  const [text, reasoning] = stripThink(raw);
  return { text: text || raw, reasoning, raw, usage: data.usage };
}
