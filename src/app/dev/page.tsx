'use client';
/* Phase 3 smoke probe — verifies the live tRPC pipe end-to-end (auth → /api/trpc →
   Postgres). Not part of the product UI; delete once the real read-path (P3.2) lands. */
import { useSession, signIn, signOut } from 'next-auth/react';
import { trpc } from '@/ui/lib/trpc';

const btn = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #ccc',
  background: '#fff',
  cursor: 'pointer',
  font: 'inherit',
} as const;

export default function DevPage() {
  const { data: session, status } = useSession();
  const authed = status === 'authenticated';
  const workbenches = trpc.workbenches.list.useQuery(undefined, { enabled: authed });
  const chats = trpc.chats.list.useQuery(undefined, { enabled: authed });
  const utils = trpc.useUtils();
  const createWorkbench = trpc.workbenches.create.useMutation({
    onSuccess: () => utils.workbenches.list.invalidate(),
  });
  const create = trpc.chats.create.useMutation({
    onSuccess: () => utils.chats.list.invalidate(),
  });

  const handleCreateChat = async () => {
    const workbench =
      workbenches.data?.[0] ??
      (await createWorkbench.mutateAsync({
        name: 'Dev workbench',
        workspacePath: `workspaces/dev-${Date.now()}`,
      }));
    if (!workbench) return;
    create.mutate({ title: 'Test chat', workbenchId: workbench.id });
  };

  return (
    <main style={{ maxWidth: 640, margin: '40px auto', padding: 24, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 22 }}>Phase 3 — live tRPC probe</h1>

      <section style={{ margin: '20px 0', padding: 16, border: '1px solid #eee', borderRadius: 10 }}>
        <h2 style={{ fontSize: 14, color: '#666' }}>Auth</h2>
        <p>status: <b>{status}</b>{session?.user?.email ? ` · ${session.user.email}` : ''}</p>
        {authed
          ? <button style={btn} onClick={() => signOut()}>Sign out</button>
          : <button style={btn} onClick={() => signIn()}>Sign in</button>}
      </section>

      <section style={{ margin: '20px 0', padding: 16, border: '1px solid #eee', borderRadius: 10 }}>
        <h2 style={{ fontSize: 14, color: '#666' }}>chats.list (live query)</h2>
        {!authed && <p style={{ color: '#999' }}>sign in to query</p>}
        {authed && chats.isLoading && <p>loading…</p>}
        {authed && chats.error && <p style={{ color: 'crimson' }}>error: {chats.error.message}</p>}
        {authed && chats.data && (
          <>
            <p>{chats.data.length} chat(s):</p>
            <ul>{chats.data.map((c: { id: string; title: string; workbenchId: string }) => (
              <li key={c.id}>{c.title} <code>{c.workbenchId}</code></li>
            ))}</ul>
            {workbenches.data?.[0] && (
              <p>default workbench: <code>{workbenches.data[0].workspacePath}</code></p>
            )}
            <button
              style={btn}
              disabled={create.isPending || createWorkbench.isPending}
              onClick={() => void handleCreateChat()}
            >
              {create.isPending || createWorkbench.isPending ? 'creating…' : '+ create test chat'}
            </button>
            {createWorkbench.error && <p style={{ color: 'crimson' }}>{createWorkbench.error.message}</p>}
            {create.error && <p style={{ color: 'crimson' }}>{create.error.message}</p>}
          </>
        )}
      </section>
    </main>
  );
}
