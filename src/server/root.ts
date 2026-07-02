import { z } from 'zod';
import { polishText, suggestTasks } from './actions/ai-actions.js';
import {
  createChat,
  createMessage,
  deleteChat,
  listChats,
  listMessages,
} from './actions/chat-actions.js';
import {
  getUserProfile,
  listWorkbenchPins,
  pinWorkbench,
  unpinWorkbench,
  updateUserProfile,
} from './actions/memory-actions.js';
import { getMission, listMissions, listWorkflowTemplates } from './actions/mission-actions.js';
import { listArtifactsByChat, listHandoffsByChat } from './actions/read-actions.js';
import { createWorkbench, listWorkbenches } from './actions/workbench-actions.js';
import { createCallerFactory, createTRPCRouter, protectedProcedure, publicProcedure } from './trpc.js';

const idInput = z.object({ id: z.string().min(1) });
const chatIdInput = z.object({ chatId: z.string().min(1) });
const workbenchIdInput = z.object({ workbenchId: z.string().min(1) });

const workbenchesRouter = createTRPCRouter({
  list: protectedProcedure.query(({ ctx }) => listWorkbenches(ctx.user)),
  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1),
      workspacePath: z.string().optional(),
      description: z.string().nullable().optional(),
    }))
    .mutation(({ ctx, input }) => createWorkbench(ctx.user, input)),
});

const chatsRouter = createTRPCRouter({
  list: protectedProcedure.query(({ ctx }) => listChats(ctx.user)),
  create: protectedProcedure
    .input(z.object({ workbenchId: z.string().min(1), title: z.string().min(1) }))
    .mutation(({ ctx, input }) => createChat(ctx.user, input)),
  delete: protectedProcedure
    .input(idInput)
    .mutation(({ ctx, input }) => deleteChat(ctx.user, input.id)),
});

const messagesRouter = createTRPCRouter({
  list: protectedProcedure.input(chatIdInput).query(({ ctx, input }) => listMessages(ctx.user, input.chatId)),
  create: protectedProcedure
    .input(z.object({ chatId: z.string().min(1), content: z.string().min(1) }))
    .mutation(({ ctx, input }) => createMessage(ctx.user, input)),
});

const artifactsRouter = createTRPCRouter({
  listByChat: protectedProcedure.input(chatIdInput).query(({ ctx, input }) => listArtifactsByChat(ctx.user, input.chatId)),
});

const handoffsRouter = createTRPCRouter({
  listByChat: protectedProcedure.input(chatIdInput).query(({ ctx, input }) => listHandoffsByChat(ctx.user, input.chatId)),
});

const userProfileRouter = createTRPCRouter({
  get: protectedProcedure.query(({ ctx }) => getUserProfile(ctx.user)),
  update: protectedProcedure
    .input(z.object({
      defaultBrief: z.string().optional(),
      defaultSkills: z.array(z.string()).optional(),
      notes: z.string().optional(),
    }))
    .mutation(({ ctx, input }) => updateUserProfile(ctx.user, input)),
});

const workbenchPinnedRouter = createTRPCRouter({
  list: protectedProcedure.input(workbenchIdInput).query(({ ctx, input }) => listWorkbenchPins(ctx.user, input.workbenchId)),
  pin: protectedProcedure
    .input(z.object({ workbenchId: z.string().min(1), content: z.string().min(1) }))
    .mutation(({ ctx, input }) => pinWorkbench(ctx.user, input)),
  unpin: protectedProcedure
    .input(z.object({ workbenchId: z.string().min(1), id: z.string().min(1) }))
    .mutation(({ ctx, input }) => unpinWorkbench(ctx.user, input)),
});

const missionsRouter = createTRPCRouter({
  templates: publicProcedure.query(() => listWorkflowTemplates()),
  list: protectedProcedure
    .input(z.object({ chatId: z.string().min(1).optional() }).optional())
    .query(({ ctx, input }) => listMissions(ctx.user, input?.chatId)),
  get: protectedProcedure
    .input(idInput)
    .query(({ ctx, input }) => getMission(ctx.user, input.id)),
});

const aiRouter = createTRPCRouter({
  // Public: the local (unauthenticated) build flow uses Polish too, so it must
  // not require a session. It only rewrites the text the caller sends.
  polish: publicProcedure
    .input(z.object({ text: z.string() }))
    .mutation(({ input }) => polishText(input)),
  suggestTasks: publicProcedure
    .input(z.object({ context: z.string().optional() }).optional())
    .query(({ ctx, input }) => suggestTasks(ctx.user, input?.context)),
});

export const appRouter = createTRPCRouter({
  ai: aiRouter,
  artifacts: artifactsRouter,
  chats: chatsRouter,
  handoffs: handoffsRouter,
  messages: messagesRouter,
  missions: missionsRouter,
  userProfile: userProfileRouter,
  workbenches: workbenchesRouter,
  workbenchPinned: workbenchPinnedRouter,
});

export const createCaller = createCallerFactory(appRouter);

export type AppRouter = typeof appRouter;
