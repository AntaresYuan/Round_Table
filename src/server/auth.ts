import type { NextAuthOptions, Session } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import { id, mutateData, nowIso } from './store.js';
import type { Actor } from './types.js';

export interface AuthSession extends Session {
  user: Actor;
}

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

const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
const googleConfigured = Boolean(googleClientId && googleClientSecret);
const devAuthEnabled = process.env.ROUNDTABLE_ENABLE_DEV_AUTH === '1'
  || (process.env.NODE_ENV !== 'production' && !googleConfigured);
const providers: NextAuthOptions['providers'] = [];

if (googleConfigured) {
  providers.push(GoogleProvider({
    clientId: googleClientId!,
    clientSecret: googleClientSecret!,
  }));
}

if (devAuthEnabled) {
  providers.push(CredentialsProvider({
    id: 'dev',
    name: 'Developer email',
    credentials: {
      email: { label: 'Email', type: 'email' },
      name: { label: 'Name', type: 'text' },
    },
    async authorize(credentials) {
      const email = credentials?.email?.trim() || 'dev@roundtable.local';
      const name = credentials?.name?.trim() || null;
      return upsertUser(email, name);
    },
  }));
}

export const authOptions: NextAuthOptions = {
  pages: {
    signIn: '/signin',
  },
  providers,
  session: {
    strategy: 'jwt',
  },
  callbacks: {
    signIn({ account, profile }) {
      if (account?.provider !== 'google') return true;
      const googleProfile = profile as { email?: string | undefined; email_verified?: boolean | undefined } | undefined;
      return Boolean(googleProfile?.email && googleProfile.email_verified === true);
    },
    async jwt({ token, user }) {
      if (user) {
        const email = typeof user.email === 'string' ? user.email : '';
        const name = typeof user.name === 'string' ? user.name : null;
        if (email) {
          const actor = await upsertUser(email, name);
          token.sub = actor.id;
          token.email = actor.email;
          token.name = actor.name;
        }
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
