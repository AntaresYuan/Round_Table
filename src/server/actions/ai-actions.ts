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
  return { text: localPolish(text) };
}

// Deterministic, no-network fallback: make the button visibly useful even when
// no model key is configured. It keeps the user's scope, but rewrites a short
// ask into a Mission-ready brief with deliverable, workflow, and review outcome.
function localPolish(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (isChinese(cleaned)) {
    const core = stripTerminalPunctuation(cleaned);
    return `围绕“${core}”启动一个可交付的 Mission：先澄清目标用户、核心页面或接口、成功标准与约束，再产出实现方案、完成必要的前后端改动，并由 Reviewer 检查可用性、测试证据和剩余风险。`;
  }

  const core = sentenceCase(stripTerminalPunctuation(cleaned));
  const lower = cleaned.toLowerCase();
  if (/\bbug|fix|error|crash|broken|regression\b/.test(lower)) {
    return `Diagnose and fix ${lowerFirst(core)}. Capture the repro path, identify the smallest safe patch, implement it, and return verification evidence plus any remaining risk.`;
  }
  if (/\bonboard|understand|architecture|map|learn|codebase|repo\b/.test(lower)) {
    return `Map ${lowerFirst(core)} into an onboarding Mission. Identify the relevant modules, data/control flow, integration points, and starter tasks, then have Reviewer flag unsupported assumptions and confidence gaps.`;
  }
  return `Build ${lowerFirst(core)} as a Feature Builder Mission. Clarify the target user, core behavior, constraints, and acceptance criteria, then produce the implementation plan, required front-end/back-end changes, review findings, and final delivery report.`;
}

function stripTerminalPunctuation(text: string): string {
  return text.replace(/[.?!。？！]+$/g, '').trim();
}

function isChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function sentenceCase(text: string): string {
  if (!text) return text;
  return text[0]!.toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  if (!text) return text;
  return text[0]!.toLowerCase() + text.slice(1);
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
