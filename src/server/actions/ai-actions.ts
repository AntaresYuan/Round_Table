import type { Actor } from '../types.js';
import { listChats } from './chat-actions.js';

export async function polishText(input: { text: string }): Promise<{ text: string }> {
  const text = input.text.trim();
  if (!text) return { text: '' };
  const cleaned = text.replace(/\s+/g, ' ');
  const finalText = cleaned.endsWith('.') || cleaned.endsWith('?') || cleaned.endsWith('!')
    ? cleaned
    : `${cleaned}.`;
  return { text: finalText };
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
