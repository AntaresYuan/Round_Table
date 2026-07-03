import { NextResponse } from 'next/server';
import { ContactSubmissionSchema } from '@/data/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ----------------------------------------------------------------------------
   /photo-portfolio/api/contact
   - POST: accept a contact form submission.
   - Validates with Zod (strict), drops honey-pot positives, and rate-limits
     per IP using an in-memory token bucket. Suitable for the demo; in
     production, move the bucket to a KV store (Upstash / Vercel KV) so the
     limit holds across cold starts.
   ------------------------------------------------------------------------- */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]?.trim() ?? 'unknown';
  return req.headers.get('x-real-ip') ?? 'unknown';
}

function takeFromBucket(ip: string): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, retryAfterSec: 0 };
  }
  if (b.count >= MAX_PER_WINDOW) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    };
  }
  b.count += 1;
  return { ok: true, retryAfterSec: 0 };
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  const bucket = takeFromBucket(ip);
  if (!bucket.ok) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited' },
      {
        status: 429,
        headers: { 'retry-after': String(bucket.retryAfterSec) },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_json' },
      { status: 400 },
    );
  }

  const parsed = ContactSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: 'invalid',
        issues: parsed.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      },
      { status: 422 },
    );
  }

  // Honey-pot — silently accept and drop bot submissions.
  if (parsed.data.website && parsed.data.website.length > 0) {
    return NextResponse.json({ ok: true });
  }

  // No persistence layer in this demo; log and acknowledge.
  // The full submission (sans honey-pot) is intentionally logged so an
  // operator can see what's coming in.
  // eslint-disable-next-line no-console
  console.log('[photo-portfolio/contact] new submission', {
    name: parsed.data.name,
    email: parsed.data.email,
    shootType: parsed.data.shootType,
    preferredDate: parsed.data.preferredDate,
    messageLength: parsed.data.message.length,
  });

  return NextResponse.json({ ok: true });
}
