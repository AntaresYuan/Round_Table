import { afterEach, describe, expect, it } from 'vitest';
import { polishText } from '../src/server/actions/ai-actions.js';

afterEach(() => {
  delete process.env.ROUNDTABLE_OPENAI_API_KEY;
  delete process.env.ROUNDTABLE_OPENAI_BASE_URL;
  delete process.env.ROUNDTABLE_OPENAI_MODEL;
  delete process.env.MINIMAX_API_KEY;
});

describe('polishText fallback', () => {
  it('rewrites a short clean request into a mission-ready brief without model keys', async () => {
    const result = await polishText({ text: 'A pricing page with monthly/annual toggle.' });

    expect(result.text).not.toBe('A pricing page with monthly/annual toggle.');
    expect(result.text).toContain('Feature Builder Mission');
    expect(result.text).toContain('front-end/back-end');
    expect(result.text).toContain('final delivery report');
  });

  it('keeps Chinese input in Chinese when using the local fallback', async () => {
    const result = await polishText({ text: '做一个价格页' });

    expect(result.text).toContain('启动一个可交付的 Mission');
    expect(result.text).toContain('做一个价格页');
  });
});
