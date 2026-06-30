import type { Actor } from '../types.js';
import { listChats } from './chat-actions.js';
import { isMiniMaxAvailable, runOnMiniMax } from './adapters/minimax-adapter.js';
import { isOpenAICompatAvailable, runOnOpenAICompat } from './adapters/openai-compat-adapter.js';

const POLISH_SYSTEM = [
  'You sharpen a product build request for an AI engineering team.',
  'Rewrite the user\'s description so it is clear, concrete, and buildable:',
  'name the deliverable, key features, and any obvious scope — but do NOT invent',
  'requirements the user did not imply, and keep it concise (1-3 sentences).',
  'Preserve the user\'s language (if they wrote Chinese, answer in Chinese).',
  'Output ONLY the rewritten request — no preamble, no quotes, no explanation.',
].join('\n');

/**
 * Polish a build-request description with a real model when one is configured
 * (OpenAI-compatible adapter, else MiniMax). Falls back to a deterministic
 * tidy-up so the button always does something even with no model/network.
 */
export async function polishText(input: { text: string }): Promise<{ text: string }> {
  const text = input.text.trim();
  if (!text) return { text: '' };

  const messages = [
    { role: 'system' as const, content: POLISH_SYSTEM },
    { role: 'user' as const, content: text },
  ];
  try {
    if (isOpenAICompatAvailable()) {
      const run = await runOnOpenAICompat({ messages, maxTokens: 400, temperature: 0.4 });
      const polished = run.text.trim();
      if (polished) return { text: polished };
    } else if (isMiniMaxAvailable()) {
      const run = await runOnMiniMax({ messages, maxTokens: 400, temperature: 0.4 });
      const polished = run.text.trim();
      if (polished) return { text: polished };
    }
  } catch {
    // Model unavailable / network error — fall through to the local tidy-up.
  }
  return { text: tidy(text) };
}

// Deterministic, no-network fallback: collapse whitespace, ensure terminal punctuation.
function tidy(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return /[.?!。？！]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

export async function suggestTasks(actor: Actor): Promise<Array<{ title: string; goal: string }>> {
  const chats = await listChats(actor);
  if (chats.length > 0) {
    return chats.slice(0, 3).map((chat) => ({
      title: `Continue ${chat.title}`,
      goal: `Continue the current work in ${chat.title} and produce the next usable artifact.`,
    }));
  }
  return [
    {
      title: 'Build a waitlist flow',
      goal: 'Create a small waitlist experience with validation, persistence, and a review pass.',
    },
    {
      title: 'Review a landing page',
      goal: 'Review the landing page structure, identify risks, and produce prioritized fixes.',
    },
  ];
}
