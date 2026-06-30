import type { NextAuthOptions, Session } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { id, mutateData, nowIso } from './store.js';
import type { Actor } from './types.js';

export interface AuthSession extends Session {
  user: Actor;
}

export type AuthUser = Actor;

export async function upsertUser(emailInput: string, nameInput?: string | null): Promise<Actor> {
  const email = emailInput.trim().toLowerCase();
  if (!email) throw new Error('missing_email');
  return mutateData((data) => {
    const existing = data.users.find((user) => user.email === email);
    if (existing) {
      return { id: existing.id, email: existing.email, name: existing.name };
    }
    const created = {
      id: id('user'),
      email,
      name: nameInput ?? email.split('@')[0] ?? email,
      createdAt: nowIso(),
    };
    data.users.push(created);
    return { id: created.id, email: created.email, name: created.name };
  });
}

export function cliActor(): Actor {
  return {
    id: process.env.ROUNDTABLE_CLI_USER_ID || 'cli-user',
    email: process.env.ROUNDTABLE_CLI_USER_EMAIL || 'cli@roundtable.local',
    name: 'CLI User',
  };
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      id: 'dev',
      name: 'Dev login',
      credentials: {
        email: { label: 'Email', type: 'email' },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim() || 'dev@roundtable.local';
        return upsertUser(email);
      },
    }),
  ],
  session: {
    strategy: 'jwt',
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.email = typeof user.email === 'string' ? user.email : 'dev@roundtable.local';
        token.name = typeof user.name === 'string' ? user.name : null;
      }
      return token;
    },
    session({ session, token }) {
      const email = typeof token.email === 'string' ? token.email : 'dev@roundtable.local';
      return {
        ...session,
        user: {
          id: token.sub ?? email,
          email,
          name: typeof token.name === 'string' ? token.name : null,
        },
      };
    },
  },
};
