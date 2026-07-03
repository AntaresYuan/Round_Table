import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_ROSTER } from '../src/server/actions/agent-roster.js';
import { claudePrintArgs, executeCliRuntime } from '../src/server/actions/cli-runtimes/runner.js';
import {
  clearCliSession,
  cliSessionFor,
  runtimeSupportsResume,
  saveCliSession,
} from '../src/server/actions/cli-runtimes/sessions.js';
import type { AgentRuntimeConfig, AgentRuntimeKind } from '../src/server/types.js';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-sessions-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('cli session registry — chat-scoped resume state', () => {
  it('round-trips save → read → clear, keyed by runtime and agent', async () => {
    expect(await cliSessionFor(tempDir, 'claude-code', 'atlas')).toBeNull();
    await saveCliSession(tempDir, 'claude-code', 'atlas', 'sess_abc');
    expect(await cliSessionFor(tempDir, 'claude-code', 'atlas')).toBe('sess_abc');
    expect(await cliSessionFor(tempDir, 'claude-code', 'vera')).toBeNull();
    expect(await cliSessionFor(tempDir, 'codex', 'atlas')).toBeNull();
    await clearCliSession(tempDir, 'claude-code', 'atlas');
    expect(await cliSessionFor(tempDir, 'claude-code', 'atlas')).toBeNull();
  });

  it('treats a corrupt registry file as empty and recovers on the next save', async () => {
    await mkdir(join(tempDir, '.roundtable'), { recursive: true });
    await writeFile(join(tempDir, '.roundtable', 'cli-sessions.json'), 'not json', 'utf8');
    expect(await cliSessionFor(tempDir, 'claude-code', 'atlas')).toBeNull();
    await saveCliSession(tempDir, 'claude-code', 'atlas', 'sess_new');
    expect(await cliSessionFor(tempDir, 'claude-code', 'atlas')).toBe('sess_new');
  });

  it('only the claude runtimes support --resume for now', () => {
    expect(runtimeSupportsResume('claude-code')).toBe(true);
    expect(runtimeSupportsResume('claude-code-router')).toBe(true);
    expect(runtimeSupportsResume('codex')).toBe(false);
    expect(runtimeSupportsResume('opencode')).toBe(false);
    expect(runtimeSupportsResume('custom-cli')).toBe(false);
  });
});

describe('claudePrintArgs — session resume wiring', () => {
  it('prepends --resume when a stored session exists', () => {
    const args = claudePrintArgs(
      { runtime: 'claude-code', config: null, prompt: 'next step', resumeSessionId: 'sess_abc' },
      {} as NodeJS.ProcessEnv,
    );
    expect(args.slice(0, 4)).toEqual(['--resume', 'sess_abc', '-p', 'next step']);
  });

  it('omits --resume without a stored session', () => {
    const args = claudePrintArgs({ runtime: 'claude-code', config: null, prompt: 'first step' }, {} as NodeJS.ProcessEnv);
    expect(args).not.toContain('--resume');
    expect(args.slice(0, 2)).toEqual(['-p', 'first step']);
  });
});

describe('executeCliRuntime — captures CLI-native session ids', () => {
  it('keeps the LAST claude session_id seen in stream-json (resume forks a new id)', async () => {
    const result = await executeCliRuntime({
      conversationId: 'claude-session-test',
      runtime: 'claude-code',
      agent: agent('atlas'),
      config: runtimeConfig('atlas', 'claude-code', [
        '-e',
        [
          'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"sess_first"})+"\\n");',
          'process.stdout.write(JSON.stringify({type:"assistant",session_id:"sess_final",message:{content:[{type:"text",text:"done"}]}})+"\\n");',
        ].join(''),
      ]),
      workspace: tempDir,
      prompt: 'ignored prompt',
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('sess_final');
  });

  it('captures the codex thread id from thread.started', async () => {
    const result = await executeCliRuntime({
      conversationId: 'codex-session-test',
      runtime: 'codex',
      agent: agent('atlas'),
      config: runtimeConfig('atlas', 'codex', [
        '-e',
        [
          'let input="";',
          'process.stdin.on("data",(chunk)=>input+=chunk);',
          'process.stdin.on("end",()=>{',
          'process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"thread_42"})+"\\n");',
          'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"ok"}})+"\\n");',
          '});',
        ].join(''),
      ]),
      workspace: tempDir,
      prompt: 'hello codex',
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('thread_42');
  });

  it('reports no session id when the runtime never emits one', async () => {
    const result = await executeCliRuntime({
      conversationId: 'no-session-test',
      runtime: 'claude-code',
      agent: agent('atlas'),
      config: runtimeConfig('atlas', 'claude-code', [
        '-e',
        'process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"done"}]}})+"\\n")',
      ]),
      workspace: tempDir,
      prompt: 'ignored prompt',
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeNull();
  });
});

function agent(id: string) {
  const found = AGENT_ROSTER.find((item) => item.id === id);
  if (!found) throw new Error(`missing test agent ${id}`);
  return found;
}

function runtimeConfig(agentId: string, runtime: AgentRuntimeKind, args: string[]): AgentRuntimeConfig {
  return {
    agentId,
    runtime,
    command: process.execPath,
    args,
    env: {},
    model: null,
    modelProvider: null,
    interactionMode: null,
    effort: null,
    updatedAt: new Date(0).toISOString(),
  };
}
