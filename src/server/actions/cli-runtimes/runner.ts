import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentEvent, AgentRuntimeConfig, AgentRuntimeKind, ModelProviderKind } from '../../types.js';
import { resolveModelProvider } from '../settings-actions.js';
import type { AgentProfile } from '../agent-roster.js';
import { envKey, runtimeDefinition } from './registry.js';

export type RuntimeExecutionResult = {
  text: string;
  ok: boolean;
  error: string | null;
  command: string;
  pid: number | null;
  events: AgentEvent[];
};

export type RuntimeExecutionCallbacks = {
  onCommand?: ((command: string, pid: number | null) => void | Promise<void>) | undefined;
  onEvent?: ((event: AgentEvent, transcript?: RuntimeTranscriptEntry | undefined) => void | Promise<void>) | undefined;
};

export type RuntimeTranscriptEntry = {
  kind: 'status' | 'thinking' | 'response' | 'error';
  content: string;
};

export type RuntimeExecutionInput = {
  conversationId: string;
  runtime: AgentRuntimeKind;
  agent: AgentProfile;
  config: AgentRuntimeConfig | null;
  workspace: string;
  prompt: string;
  timeoutMs?: number | undefined;
  envSnapshot?: NodeJS.ProcessEnv | undefined;
  callbacks?: RuntimeExecutionCallbacks | undefined;
};

const activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();

export function stopActiveRuntimeConversation(conversationId: string): boolean {
  const child = activeProcesses.get(conversationId);
  if (!child) return false;
  killProcess(child);
  activeProcesses.delete(conversationId);
  return true;
}

export async function executeCliRuntime(input: RuntimeExecutionInput): Promise<RuntimeExecutionResult> {
  const commandSpec = await commandForRuntime(input);
  const events: AgentEvent[] = [];
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const parser = parserForRuntime(input.runtime);

  const started: AgentEvent = {
    type: 'tool_use',
    id: `runtime_${input.conversationId}`,
    name: input.runtime,
    input: {
      command: commandSpec.display,
      agentId: input.agent.id,
      role: input.agent.role,
      cwd: input.workspace,
    },
  };
  await emit(started);

  const child = spawn(commandSpec.command, commandSpec.args, {
    cwd: input.workspace,
    env: commandSpec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  activeProcesses.set(input.conversationId, child);
  await input.callbacks?.onCommand?.(commandSpec.display, child.pid ?? null);

  if (commandSpec.stdin !== null) {
    child.stdin.write(commandSpec.stdin, 'utf8');
  }
  child.stdin.end();

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let pending = Promise.resolve();
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    pending = pending.then(() => parser.push(chunk, emit));
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const timer = input.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        killProcess(child);
      }, input.timeoutMs)
    : null;

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  if (timer) clearTimeout(timer);
  activeProcesses.delete(input.conversationId);
  await pending;
  await parser.flush(emit);

  const finalText = parser.text().trim() || stdout.trim() || stderr.trim();
  const ok = !timedOut && exitCode === 0 && finalText.length > 0;
  const error = timedOut ? 'runtime_timeout' : ok ? null : `runtime_exit_${exitCode}`;
  const terminal: AgentEvent = ok
    ? { type: 'done', finishReason: 'completed' }
    : { type: 'error', message: error ?? 'runtime_failed', recoverable: true };
  await emit(terminal, ok ? undefined : { kind: 'error', content: error ?? 'runtime_failed' });

  return {
    text: finalText,
    ok,
    error,
    command: commandSpec.display,
    pid: child.pid ?? null,
    events,
  };

  async function emit(event: AgentEvent, transcript?: RuntimeTranscriptEntry): Promise<void> {
    events.push(event);
    await input.callbacks?.onEvent?.(event, transcript);
  }
}

type CommandSpec = {
  command: string;
  args: string[];
  stdin: string | null;
  env: NodeJS.ProcessEnv;
  display: string;
};

async function commandForRuntime(input: RuntimeExecutionInput): Promise<CommandSpec> {
  const runtimeEnv = input.envSnapshot ?? process.env;
  const env = await buildRuntimeEnv(input.runtime, input.config, runtimeEnv);
  if (input.runtime === 'custom-cli') return customCommand(input, env);

  const command = input.config?.command
    || runtimeEnv[`ROUNDTABLE_${runtimeEnvName(input.runtime)}_COMMAND`]
    || runtimeDefinition(input.runtime).binary
    || input.runtime;

  if (input.runtime === 'claude-code') {
    const args = configuredRuntimeArgs(input) ?? claudePrintArgs(input, env);
    return commandSpec(command, args, null, env);
  }

  if (input.runtime === 'claude-code-router') {
    await prepareClaudeCodeRouterConfig(input, env);
    const args = configuredRuntimeArgs(input) ?? ['code', ...claudePrintArgs(input, env, { includeModel: false })];
    return commandSpec(command, args, null, env);
  }

  if (input.runtime === 'codex') {
    const model = runtimeModel(input.runtime, input.config);
    const args = configuredRuntimeArgs(input)
      ?? [
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '-C',
        input.workspace,
        ...(model ? ['-m', model] : []),
      ];
    return commandSpec(command, args, input.prompt, env);
  }

  if (input.runtime === 'opencode') {
    const model = runtimeModel(input.runtime, input.config);
    const args = configuredRuntimeArgs(input)
      ?? [
        'run',
        '--format',
        'json',
        '--dir',
        input.workspace,
        ...(model ? ['--model', providerQualifiedOpenCodeModel(model, env)] : []),
      ];
    return commandSpec(command, args, input.prompt, env);
  }

  return customCommand(input, env);
}

function customCommand(input: RuntimeExecutionInput, env: NodeJS.ProcessEnv): CommandSpec {
  const runtimeEnv = input.envSnapshot ?? process.env;
  const command = input.config?.command
    || runtimeEnv[`ROUNDTABLE_AGENT_COMMAND_${envKey(input.agent.id)}`]
    || runtimeEnv[`ROUNDTABLE_AGENT_COMMAND_${envKey(input.agent.role)}`]
    || runtimeEnv.ROUNDTABLE_AGENT_COMMAND
    || defaultCustomCommand(input.agent, runtimeEnv);
  const configured = input.config?.args.length
    ? input.config.args
    : splitArgs(
      runtimeEnv[`ROUNDTABLE_AGENT_ARGS_${envKey(input.agent.id)}`]
      || runtimeEnv[`ROUNDTABLE_AGENT_ARGS_${envKey(input.agent.role)}`]
      || runtimeEnv.ROUNDTABLE_AGENT_ARGS
      || '',
    );
  const args = configured.length > 0
    ? substitutePrompt(configured, input.prompt, 'stdin')
    : defaultCustomArgs(command, input.prompt);
  return commandSpec(command, args, null, env);
}

function commandSpec(command: string, args: string[], stdin: string | null, env: NodeJS.ProcessEnv): CommandSpec {
  return {
    command,
    args,
    stdin,
    env,
    display: [command, ...args.map((arg) => (arg.length > 80 ? `${arg.slice(0, 77)}...` : arg))].join(' '),
  };
}

function configuredRuntimeArgs(input: RuntimeExecutionInput): string[] | null {
  const runtimeEnv = input.envSnapshot ?? process.env;
  const promptMode = input.runtime === 'claude-code' || input.runtime === 'claude-code-router' ? 'argv' : 'stdin';
  if (input.config?.args.length) return substitutePrompt(input.config.args, input.prompt, promptMode);
  const raw = runtimeEnv[`ROUNDTABLE_${runtimeEnvName(input.runtime)}_ARGS`];
  if (!raw) return null;
  return substitutePrompt(splitArgs(raw), input.prompt, promptMode);
}

async function buildRuntimeEnv(
  runtime: AgentRuntimeKind,
  config: AgentRuntimeConfig | null,
  runtimeEnv: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...runtimeEnv, ...(config?.env ?? {}) };
  await applyModelProviderEnv(env, config?.modelProvider ?? null);
  const model = runtimeModel(runtime, config, env);
  if ((runtime === 'claude-code' || runtime === 'claude-code-router') && runtimeInteractionMode(config) === 'auto') {
    env.CI = env.CI || 'true';
    env.FORCE_COLOR = env.FORCE_COLOR || '0';
    env.NODE_NO_READLINE = env.NODE_NO_READLINE || '1';
    env.TERM = env.TERM || 'dumb';
  }
  if (model) {
    if (runtime === 'claude-code') env.CLAUDE_MODEL = model;
    if (runtime === 'claude-code-router') {
      env.LLM_MODEL = model;
      env.OPENAI_MODEL = model;
    }
    if (runtime === 'codex') env.CODEX_MODEL = model;
    if (runtime === 'opencode') env.OPENCODE_MODEL = model;
  }
  if (env.LLM_API_KEY && !env.OPENAI_API_KEY && (runtime === 'codex' || runtime === 'opencode')) {
    env.OPENAI_API_KEY = env.LLM_API_KEY;
  }
  if (env.LLM_BASE_URL && !env.OPENAI_BASE_URL && (runtime === 'codex' || runtime === 'opencode')) {
    env.OPENAI_BASE_URL = env.LLM_BASE_URL;
  }
  return env;
}

function runtimeModel(
  runtime: AgentRuntimeKind,
  config: AgentRuntimeConfig | null,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): string {
  if (config?.model) return config.model;
  if (runtime === 'claude-code') return runtimeEnv.CLAUDE_MODEL || runtimeEnv.LLM_MODEL || '';
  if (runtime === 'claude-code-router') return runtimeEnv.LLM_MODEL || runtimeEnv.OPENAI_MODEL || '';
  if (runtime === 'codex') return runtimeEnv.CODEX_MODEL || runtimeEnv.OPENAI_MODEL || runtimeEnv.LLM_MODEL || '';
  if (runtime === 'opencode') return runtimeEnv.OPENCODE_MODEL || runtimeEnv.LLM_MODEL || '';
  return '';
}

function claudePrintArgs(
  input: RuntimeExecutionInput,
  env: NodeJS.ProcessEnv,
  options: { includeModel?: boolean } = {},
): string[] {
  const includeModel = options.includeModel ?? true;
  const model = includeModel ? runtimeModel(input.runtime, input.config, env) : '';
  const effort = runtimeEffort(input.config, env);
  return [
    '-p',
    input.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    claudePermissionMode(input.config),
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
  ];
}

function runtimeInteractionMode(config: AgentRuntimeConfig | null): 'auto' | 'manual' {
  return config?.interactionMode ?? 'auto';
}

function claudePermissionMode(config: AgentRuntimeConfig | null): string {
  return runtimeInteractionMode(config) === 'manual' ? 'default' : 'auto';
}

function runtimeEffort(
  config: AgentRuntimeConfig | null,
  runtimeEnv: NodeJS.ProcessEnv,
): string {
  return config?.effort
    || runtimeEnv.ROUNDTABLE_CLAUDE_EFFORT
    || runtimeEnv.ROUNDTABLE_AGENT_EFFORT
    || '';
}

async function applyModelProviderEnv(
  env: NodeJS.ProcessEnv,
  provider: ModelProviderKind | null,
): Promise<void> {
  if (!provider) return;
  const resolved = await resolveModelProvider(provider);
  if (!resolved.configured || !resolved.apiKey) {
    throw new Error(`model_provider_not_configured:${provider}`);
  }
  env.ROUNDTABLE_CCR_PROVIDER = provider;
  env.ROUNDTABLE_CCR_API_KEY = resolved.apiKey;
  env.ROUNDTABLE_CCR_BASE_URL = resolved.baseUrl;
  env.ROUNDTABLE_CCR_MODEL = resolved.model;
  env.LLM_API_KEY = resolved.apiKey;
  env.LLM_BASE_URL = resolved.baseUrl;
  env.LLM_MODEL = resolved.model;
  env.OPENAI_API_KEY = resolved.apiKey;
  env.OPENAI_BASE_URL = resolved.baseUrl;
  env.OPENAI_MODEL = resolved.model;
}

async function prepareClaudeCodeRouterConfig(
  input: RuntimeExecutionInput,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const config = input.config;
  if (!config?.modelProvider) return;
  const providerName = `roundtable-${config.modelProvider}`;
  const model = env.ROUNDTABLE_CCR_MODEL || env.LLM_MODEL || env.OPENAI_MODEL;
  if (!model) throw new Error(`model_provider_missing_model:${config.modelProvider}`);

  const home = roundtableCcrHome(input.workspace, input.conversationId);
  const configDir = join(home, '.claude-code-router');
  const port = ccrPortForConversation(input.conversationId);
  env.HOME = home;
  if (process.platform === 'win32') env.USERPROFILE = home;

  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify({
    LOG: true,
    NON_INTERACTIVE_MODE: true,
    API_TIMEOUT_MS: 86_400_000,
    PORT: port,
    Providers: [{
      name: providerName,
      api_base_url: chatCompletionsUrl(env.ROUNDTABLE_CCR_BASE_URL || env.LLM_BASE_URL || env.OPENAI_BASE_URL || ''),
      api_key: '$ROUNDTABLE_CCR_API_KEY',
      models: [model],
    }],
    Router: {
      default: `${providerName},${model}`,
      background: `${providerName},${model}`,
      think: `${providerName},${model}`,
      longContext: `${providerName},${model}`,
    },
  }, null, 2)}\n`, 'utf8');
}

function roundtableCcrHome(workspace: string, conversationId: string): string {
  const base = resolve(workspace, '.roundtable', 'ccr-home');
  return join(base, conversationId.replace(/[^a-zA-Z0-9_-]+/g, '_'));
}

function ccrPortForConversation(conversationId: string): number {
  let hash = 0;
  for (const char of conversationId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 34_560 + (hash % 10_000);
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

function providerQualifiedOpenCodeModel(model: string, env: NodeJS.ProcessEnv): string {
  if (model.includes('/')) return model;
  const baseUrl = (env.OPENAI_BASE_URL || env.LLM_BASE_URL || '').toLowerCase();
  const provider = env.ANTHROPIC_API_KEY || baseUrl.includes('anthropic') ? 'anthropic' : 'openai';
  return `${provider}/${model}`;
}

function defaultCustomCommand(agent: AgentProfile, runtimeEnv: NodeJS.ProcessEnv): string {
  if (agent.role === 'reviewer' && runtimeEnv.ROUNDTABLE_REVIEWER_PREFERS_OPENCODE === '1') return 'opencode';
  return 'claude';
}

function defaultCustomArgs(command: string, prompt: string): string[] {
  if (command.endsWith('opencode') || command.includes('/opencode')) return ['run', prompt];
  return ['-p', prompt, '--permission-mode', 'auto'];
}

function substitutePrompt(args: string[], prompt: string, mode: 'argv' | 'stdin' = 'argv'): string[] {
  if (args.some((arg) => arg.includes('{prompt}'))) {
    return args.map((arg) => arg.replace('{prompt}', prompt));
  }
  return mode === 'argv' ? [...args, prompt] : args;
}

function splitArgs(raw: string): string[] {
  return raw.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function runtimeEnvName(runtime: AgentRuntimeKind): string {
  return runtime.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

function killProcess(child: ChildProcessWithoutNullStreams): void {
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGTERM');
      return;
    }
  } catch {
    // Fall through to direct child kill.
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Best effort.
  }
}

type RuntimeParser = {
  push(chunk: string, emit: EmitRuntimeEvent): Promise<void>;
  flush(emit: EmitRuntimeEvent): Promise<void>;
  text(): string;
};

type EmitRuntimeEvent = (event: AgentEvent, transcript?: RuntimeTranscriptEntry | undefined) => Promise<void>;

function parserForRuntime(runtime: AgentRuntimeKind): RuntimeParser {
  if (runtime === 'claude-code' || runtime === 'claude-code-router') return new JsonLineParser(handleClaudeEvent);
  if (runtime === 'codex') return new JsonLineParser(handleCodexEvent);
  if (runtime === 'opencode') return new JsonObjectParser(handleOpenCodeEvent);
  return new PlainParser();
}

class PlainParser implements RuntimeParser {
  private chunks: string[] = [];

  async push(chunk: string): Promise<void> {
    this.chunks.push(chunk);
  }

  async flush(): Promise<void> {}

  text(): string {
    return this.chunks.join('');
  }
}

class JsonLineParser implements RuntimeParser {
  private buffer = '';
  private texts: string[] = [];

  constructor(private readonly handle: StructuredEventHandler) {}

  async push(chunk: string, emit: EmitRuntimeEvent): Promise<void> {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) await this.processLine(line, emit);
  }

  async flush(emit: EmitRuntimeEvent): Promise<void> {
    if (this.buffer.trim()) await this.processLine(this.buffer, emit);
    this.buffer = '';
  }

  text(): string {
    return this.texts.join('\n');
  }

  private async processLine(line: string, emit: EmitRuntimeEvent): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = parseJsonObject(trimmed);
    if (!parsed) return;
    const result = await this.handle(parsed, emit);
    if (result) this.texts.push(result);
  }
}

class JsonObjectParser implements RuntimeParser {
  private buffer = '';
  private texts: string[] = [];

  constructor(private readonly handle: StructuredEventHandler) {}

  async push(chunk: string, emit: EmitRuntimeEvent): Promise<void> {
    this.buffer += chunk;
    const drained = drainJsonObjects(this.buffer);
    this.buffer = drained.rest;
    for (const item of drained.objects) {
      const result = await this.handle(item, emit);
      if (result) this.texts.push(result);
    }
  }

  async flush(emit: EmitRuntimeEvent): Promise<void> {
    const drained = drainJsonObjects(this.buffer);
    this.buffer = drained.rest;
    for (const item of drained.objects) {
      const result = await this.handle(item, emit);
      if (result) this.texts.push(result);
    }
  }

  text(): string {
    return this.texts.join('\n');
  }
}

type StructuredEventHandler = (event: Record<string, unknown>, emit: EmitRuntimeEvent) => Promise<string | null>;

async function handleClaudeEvent(event: Record<string, unknown>, emit: EmitRuntimeEvent): Promise<string | null> {
  const eventType = stringProp(event, 'type');
  if (eventType === 'assistant') {
    const message = objectProp(event, 'message');
    const content = arrayProp(message, 'content');
    const texts: string[] = [];
    for (const block of content) {
      const item = asObject(block);
      if (!item) continue;
      if (stringProp(item, 'type') === 'text') {
        const text = stringProp(item, 'text');
        if (text) {
          texts.push(text);
          await emit({ type: 'thinking_delta', delta: text }, { kind: 'thinking', content: text });
        }
      }
      if (stringProp(item, 'type') === 'tool_use') {
        await emit({
          type: 'tool_use',
          id: stringProp(item, 'id') || `tool_${Date.now()}`,
          name: stringProp(item, 'name') || 'tool',
          input: objectProp(item, 'input') ?? {},
        }, { kind: 'status', content: `Using ${stringProp(item, 'name') || 'tool'}` });
      }
    }
    return texts.join('\n').trim() || null;
  }
  if (eventType === 'result' && event.is_error === true) {
    const message = stringProp(event, 'result') || 'claude_error';
    await emit({ type: 'error', message, recoverable: true }, { kind: 'error', content: message });
  }
  return null;
}

async function handleCodexEvent(event: Record<string, unknown>, emit: EmitRuntimeEvent): Promise<string | null> {
  const eventType = stringProp(event, 'type');
  if (eventType !== 'item.completed') {
    if (eventType === 'turn.failed') {
      const error = objectProp(event, 'error');
      const message = stringProp(error, 'message') || 'codex_turn_failed';
      await emit({ type: 'error', message, recoverable: true }, { kind: 'error', content: message });
    }
    return null;
  }
  const item = objectProp(event, 'item');
  const itemType = stringProp(item, 'type');
  if (itemType === 'agent_message') {
    const text = stringProp(item, 'text');
    if (!text) return null;
    await emit({ type: 'thinking_delta', delta: text }, { kind: 'thinking', content: text });
    return text;
  }
  if (itemType === 'command_execution') {
    const command = stringProp(item, 'command') || 'command';
    const id = stringProp(item, 'id') || `cmd_${Date.now()}`;
    await emit({ type: 'tool_use', id, name: 'command_execution', input: { command } }, { kind: 'status', content: command });
    const exitCode = numberProp(item, 'exit_code');
    if (exitCode !== null) await emit({ type: 'tool_result', id, output: { exitCode } });
  }
  if (itemType === 'file_change') {
    const filename = stringProp(item, 'filename') || stringProp(item, 'path') || 'file';
    await emit({ type: 'file_change', path: filename, kind: 'edit', diff: `edited ${filename}` }, { kind: 'status', content: `Edited ${filename}` });
  }
  return null;
}

async function handleOpenCodeEvent(event: Record<string, unknown>, emit: EmitRuntimeEvent): Promise<string | null> {
  const eventType = (stringProp(event, 'type') || '').toLowerCase();
  if (eventType.includes('error')) {
    const message = errorText(event) || 'opencode_error';
    await emit({ type: 'error', message, recoverable: true }, { kind: 'error', content: message });
    return null;
  }
  if (isOpenCodeToolEvent(event)) {
    const tool = objectProp(event, 'part') || objectProp(event, 'item') || event;
    const name = stringProp(tool, 'name') || stringProp(tool, 'tool') || 'tool';
    const input = objectProp(tool, 'input') || objectProp(tool, 'args') || {};
    await emit({ type: 'tool_use', id: stringProp(tool, 'id') || `tool_${Date.now()}`, name, input }, { kind: 'status', content: `Using ${name}` });
    return null;
  }
  const text = openCodeText(event);
  if (!text) return null;
  await emit({ type: 'thinking_delta', delta: text }, { kind: 'thinking', content: text });
  return text;
}

function isOpenCodeToolEvent(event: Record<string, unknown>): boolean {
  const eventType = (stringProp(event, 'type') || '').toLowerCase();
  if (eventType === 'tool_use' || eventType === 'tool') return true;
  const part = objectProp(event, 'part');
  return (stringProp(part, 'type') || '').toLowerCase() === 'tool';
}

function openCodeText(event: Record<string, unknown>): string | null {
  const part = objectProp(event, 'part');
  const partText = stringProp(part, 'text') || stringProp(part, 'content');
  if (partText) return partText;
  const item = objectProp(event, 'item');
  return stringProp(item, 'text') || stringProp(item, 'content') || stringProp(event, 'text') || stringProp(event, 'content');
}

function errorText(event: Record<string, unknown>): string | null {
  const error = objectProp(event, 'error');
  return stringProp(error, 'message') || stringProp(error, 'error') || stringProp(event, 'message');
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return asObject(parsed);
  } catch {
    return null;
  }
}

function drainJsonObjects(raw: string): { objects: Array<Record<string, unknown>>; rest: string } {
  const objects: Array<Record<string, unknown>> = [];
  let position = 0;
  while (position < raw.length) {
    while (position < raw.length && /\s/.test(raw[position]!)) position += 1;
    if (raw[position] !== '{') {
      position += 1;
      continue;
    }
    const start = position;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let completed = false;
    for (let index = position; index < raw.length; index += 1) {
      const ch = raw[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      if (depth === 0) {
        const parsed = parseJsonObject(raw.slice(start, index + 1));
        if (parsed) objects.push(parsed);
        position = index + 1;
        completed = true;
        break;
      }
    }
    if (!completed) return { objects, rest: raw.slice(start) };
  }
  return { objects, rest: '' };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function objectProp(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (!value) return null;
  return asObject(value[key]);
}

function arrayProp(value: Record<string, unknown> | null, key: string): unknown[] {
  if (!value) return [];
  const item = value[key];
  return Array.isArray(item) ? item : [];
}

function stringProp(value: Record<string, unknown> | null, key: string): string | null {
  if (!value) return null;
  const item = value[key];
  return typeof item === 'string' && item.length > 0 ? item : null;
}

function numberProp(value: Record<string, unknown> | null, key: string): number | null {
  if (!value) return null;
  const item = value[key];
  return typeof item === 'number' && Number.isFinite(item) ? item : null;
}
