import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyBreakoutRequest,
  createBreakoutProposal,
  createBreakoutRoom,
  listBreakoutRooms,
  postBreakoutMessage,
  selectBreakoutResponder,
  sendBreakoutProposalToChat,
} from '../src/server/actions/breakout-actions.js';
import { createChat, deleteChat, listMessages } from '../src/server/actions/chat-actions.js';
import { createWorkbench } from '../src/server/actions/workbench-actions.js';
import { readData, resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

let tempDir = '';
const actor: Actor = { id: 'test-user', email: 'test@roundtable.local', name: 'Test User' };
const otherActor: Actor = { id: 'other-user', email: 'other@roundtable.local', name: 'Other User' };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-breakout-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  await rm(tempDir, { recursive: true, force: true });
});

describe('breakout rooms', () => {
  it('classifies breakout questions by current-work relevance and action boundary', () => {
    const context = {
      chatTitle: 'Breakout room design',
      missionGoal: 'Design breakout rooms that keep agents aware of main chat context without polluting the main thread.',
      currentStage: 'Plan',
      activeTasks: ['Define handoff boundary (pending)'],
      recentMainMessages: ['user:agent needs current chat context in breakout rooms'],
    };

    expect(classifyBreakoutRequest('这个现在应该怎么定边界？', context)).toBe('current_work');
    expect(classifyBreakoutRequest('顺便问一下，PLG 定价一般怎么想？', context)).toBe('general_sidebar');
    expect(classifyBreakoutRequest('把这段发到 main chat 让 Atlas 去做', context)).toBe('boundary_action');
  });

  it('routes each breakout turn to the participant whose responsibility best matches the question', () => {
    expect(selectBreakoutResponder({
      participantAgentIds: ['atlas', 'vera'],
      content: '@Vera 这个风险和测试覆盖够吗？',
    }).replyAuthorId).toBe('vera');

    expect(selectBreakoutResponder({
      participantAgentIds: ['atlas', 'vera'],
      content: '这个按钮的布局和 React 组件实现应该怎么改？',
    }).replyAuthorId).toBe('atlas');

    expect(selectBreakoutResponder({
      participantAgentIds: ['orchestrator', 'mira'],
      content: '这个 handoff 回主线的边界应该怎么定？',
    }).replyAuthorId).toBe('orchestrator');
  });

  it('keeps side-room transcript out of main chat until a proposal is confirmed', async () => {
    const workbench = await createWorkbench(actor, { name: 'Breakout test' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Main chat' });
    const room = await createBreakoutRoom(actor, {
      chatId: chat.id,
      participantAgentIds: ['atlas', 'vera'],
    });

    const message = await postBreakoutMessage(actor, {
      roomId: room.id,
      content: 'Do not change the visual layout.',
    });
    expect(await listMessages(actor, chat.id)).toHaveLength(0);

    const rooms = await listBreakoutRooms(actor, chat.id);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.messages.map((item) => item.content)).toContain('Do not change the visual layout.');

    const proposal = await createBreakoutProposal(actor, {
      roomId: room.id,
      targetAgentId: 'atlas',
      task: 'Update the email input accessibility label.',
      constraints: ['Do not change the visual layout.'],
      why: 'Vera identified an accessibility gap that Atlas should fix in the markup.',
      relevantMessageIds: [message.id],
    });
    expect(proposal.status).toBe('draft');
    expect(proposal.why).toContain('accessibility gap');

    const sent = await sendBreakoutProposalToChat(actor, { proposalId: proposal.id });
    expect(sent.proposal.status).toBe('sent');
    const mainMessages = await listMessages(actor, chat.id);
    expect(mainMessages).toHaveLength(1);
    expect(mainMessages[0]?.content).toContain('@atlas Update the email input accessibility label.');
    expect(mainMessages[0]?.content).toContain('Why: Vera identified an accessibility gap');
    expect(mainMessages[0]?.content).toContain('Must keep:');
    expect(mainMessages[0]?.content).toContain(message.id);
  });

  it('enforces owner boundaries and cleans rooms when deleting a chat', async () => {
    const workbench = await createWorkbench(actor, { name: 'Private breakouts' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Private chat' });
    const room = await createBreakoutRoom(actor, {
      chatId: chat.id,
      participantAgentIds: ['beam', 'vera'],
    });
    await postBreakoutMessage(actor, { roomId: room.id, content: 'Private room note.' });

    await expect(listBreakoutRooms(otherActor, chat.id)).rejects.toThrow('chat_not_found');
    await expect(postBreakoutMessage(otherActor, { roomId: room.id, content: 'Nope.' })).rejects.toThrow('breakout_room_not_found');

    await deleteChat(actor, chat.id);
    const data = await readData();
    expect(data.breakoutRooms).toHaveLength(0);
    expect(data.breakoutMessages).toHaveLength(0);
    expect(data.breakoutProposals).toHaveLength(0);
  });
});
