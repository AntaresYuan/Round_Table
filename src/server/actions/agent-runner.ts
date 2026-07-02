import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentEvent, ArtifactKind, PlanTask } from '../types.js';
import { agentForTask, type AgentProfile } from './agent-roster.js';
import { runOnE2B } from './adapters/e2b-adapter.js';
import { miniMaxModel, MiniMaxUnavailableError, runOnMiniMax } from './adapters/minimax-adapter.js';
import { openAICompatModel, OpenAICompatUnavailableError, runOnOpenAICompat } from './adapters/openai-compat-adapter.js';

export type AgentRunResult = {
  text: string;
  path: string;
  kind: ArtifactKind;
  events: AgentEvent[];
  ok: boolean;
  error: string | null;
};

export async function runAgentTask(input: {
  adapter: string;
  workspace: string;
  task: PlanTask;
  message: string;
  handoffContext?: string | undefined;
}): Promise<AgentRunResult> {
  const adapter = normalizeAdapter(input.adapter);
  if (adapter === 'minimax') {
    return runMiniMaxTask(input);
  }
  if (adapter === 'openai-compat') {
    return runOpenAICompatTask(input);
  }
  if (adapter === 'e2b') {
    return runE2BTask(input);
  }
  if (adapter === 'agent-cli') {
    return runAgentCliTask(input);
  }
  return runLocalTask(input);
}

export function normalizeAdapter(
  value: string | null | undefined,
): 'local-dispatch' | 'agent-cli' | 'e2b' | 'minimax' | 'openai-compat' {
  const raw = (value || process.env.ROUNDTABLE_AGENT_ADAPTER || 'local-dispatch').trim().toLowerCase();
  if (raw === 'minimax') return 'minimax';
  // Generic OpenAI-compatible adapter (DeepSeek, Together, Groq, local vLLM, …).
  // Accept a few friendly aliases for the same code path.
  if (raw === 'openai-compat' || raw === 'openai' || raw === 'deepseek') return 'openai-compat';
  if (raw === 'e2b') return 'e2b';
  const wantsExternalCli = raw === 'agent-cli'
    || raw === 'external-cli'
    || raw === 'claude'
    || raw === 'claude-code'
    || raw === 'claude-cli'
    || raw === 'opencode'
    || raw === 'cli';
  if (wantsExternalCli && externalCliEnabled()) return 'agent-cli';
  return 'local-dispatch';
}

function externalCliEnabled(): boolean {
  return process.env.ROUNDTABLE_ENABLE_EXTERNAL_AGENT === '1'
    || process.env.ROUNDTABLE_ALLOW_CLAUDE_CLI === '1';
}

async function runLocalTask(input: {
  workspace: string;
  task: PlanTask;
  message: string;
  handoffContext?: string | undefined;
}): Promise<AgentRunResult> {
  const agent = agentForTask(input.task);
  const role = agent.role;
  const path = pathForTask(input.task);
  const text = localArtifactText(input.task, input.message, path, input.handoffContext);
  await writeWorkspaceFile(input.workspace, path, text);
  const toolId = `tool_${input.task.id}`;
  return {
    text,
    path,
    kind: kindForPath(path),
    ok: true,
    error: null,
    events: [
      { type: 'thinking_delta', delta: `${role} received the handoff and prepared ${path}.` },
      { type: 'tool_use', id: toolId, name: 'write_artifact', input: { path, role, agentId: agent.id } },
      { type: 'tool_result', id: toolId, output: { path, bytes: text.length } },
      { type: 'file_change', path, kind: 'create', diff: `created ${path}` },
      { type: 'text_delta', delta: `Created ${path}.` },
      { type: 'done', finishReason: 'completed' },
    ],
  };
}

async function runAgentCliTask(input: {
  workspace: string;
  task: PlanTask;
  message: string;
  handoffContext?: string | undefined;
}): Promise<AgentRunResult> {
  const agent = agentForTask(input.task);
  const path = pathForTask(input.task);
  const prompt = agentPrompt(agent, input);
  const command = commandForAgent(agent);
  const args = commandArgs(prompt, agent);
  const toolId = `tool_${input.task.id}`;
  const started: AgentEvent[] = [
    { type: 'thinking_delta', delta: `Starting ${agent.displayName} through CLI: ${command}` },
    {
      type: 'tool_use',
      id: toolId,
      name: 'agent_cli',
      input: { command, agentId: agent.id, role: agent.role, path },
    },
  ];

  try {
    const result = await runCommand(command, args, input.workspace, timeoutMs());
    const output = result.stdout.trim() || result.stderr.trim();
    const ok = result.exitCode === 0 && output.length > 0;
    const text = ok ? output : `# ${input.task.title}\n\nAgent CLI did not produce a usable result.\n\n${result.stderr || result.stdout}`;
    await writeWorkspaceFile(input.workspace, path, text);
    return {
      text,
      path,
      kind: kindForPath(path),
      ok,
      error: ok ? null : `external_cli_exit_${result.exitCode}`,
      events: [
        ...started,
        {
          type: 'tool_result',
          id: toolId,
          output: { exitCode: result.exitCode, stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length },
          ...(ok ? {} : { isError: true }),
        },
        { type: 'file_change', path, kind: 'create', diff: `created ${path}` },
        { type: 'text_delta', delta: ok ? `${agent.displayName} completed via CLI; transcript saved at ${path}.` : `Agent CLI failed; captured diagnostic artifact at ${path}.` },
        ok ? { type: 'done', finishReason: 'completed' } : { type: 'error', message: `external_cli_exit_${result.exitCode}`, recoverable: true },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const text = `# ${input.task.title}\n\nAgent CLI failed before producing output.\n\n${message}`;
    await writeWorkspaceFile(input.workspace, path, text);
    return {
      text,
      path,
      kind: kindForPath(path),
      ok: false,
      error: message,
      events: [
        ...started,
        { type: 'tool_result', id: toolId, output: { error: message }, isError: true },
        { type: 'file_change', path, kind: 'create', diff: `created ${path}` },
        { type: 'error', message, recoverable: true },
      ],
    };
  }
}

// Runs the agent prompt inside an E2B sandbox. Throws E2BUnavailableError (from
// runOnE2B) when no key is configured — the dispatch layer catches it and falls
// back to local-dispatch, so this never silently degrades here.
async function runE2BTask(input: {
  workspace: string;
  task: PlanTask;
  message: string;
  handoffContext?: string | undefined;
}): Promise<AgentRunResult> {
  const agent = agentForTask(input.task);
  const path = pathForTask(input.task);
  const prompt = agentPrompt(agent, input);
  const command = commandForAgent(agent);
  const args = commandArgs(prompt, agent);
  const toolId = `tool_${input.task.id}`;
  const started: AgentEvent[] = [
    { type: 'thinking_delta', delta: `Starting ${agent.displayName} in E2B sandbox.` },
    { type: 'tool_use', id: toolId, name: 'e2b_run', input: { command, agentId: agent.id, role: agent.role, path } },
  ];
  const run = await runOnE2B({ command, args, env: e2bAgentEnv(), timeoutMs: timeoutMs() });
  const ok = run.exitCode === 0 && run.summary.length > 0;
  const text = ok
    ? run.summary
    : `# ${input.task.title}\n\nE2B run did not produce a usable result.\n\n${run.code || run.summary}`;
  await writeWorkspaceFile(input.workspace, path, text);
  return {
    text,
    path,
    kind: kindForPath(path),
    ok,
    error: ok ? null : `e2b_exit_${run.exitCode}`,
    events: [
      ...started,
      { type: 'tool_result', id: toolId, output: { exitCode: run.exitCode }, ...(ok ? {} : { isError: true }) },
      { type: 'file_change', path, kind: 'create', diff: `created ${path}` },
      { type: 'text_delta', delta: ok ? `${agent.displayName} completed in E2B; transcript at ${path}.` : `E2B run failed; diagnostic saved at ${path}.` },
      ok ? { type: 'done', finishReason: 'completed' } : { type: 'error', message: `e2b_exit_${run.exitCode}`, recoverable: true },
    ],
  };
}

function e2bAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && /^(ANTHROPIC|OPENAI|ROUNDTABLE)_/.test(key)) env[key] = value;
  }
  return env;
}

// Runs the task against the real MiniMax model. Throws MiniMaxUnavailableError
// (from runOnMiniMax) when no key is set — the dispatch layer catches it and
// falls back to local-dispatch.
async function runMiniMaxTask(input: {
  workspace: string;
  task: PlanTask;
  message: string;
  handoffContext?: string | undefined;
}): Promise<AgentRunResult> {
  const agent = agentForTask(input.task);
  const path = pathForTask(input.task);
  const toolId = `tool_${input.task.id}`;
  const system = chatAgentPrompt(agent, input);
  const user = input.handoffContext
    ? `Task: ${input.task.title}\n\nUpstream deliverable to build on / review:\n\n${input.handoffContext}\n\nProduce your deliverable now.`
    : `Task: ${input.task.title}\n\nProduce your deliverable now.`;
  const started: AgentEvent[] = [
    { type: 'thinking_delta', delta: `${agent.displayName} querying MiniMax model.` },
    { type: 'tool_use', id: toolId, name: 'minimax_chat', input: { agentId: agent.id, role: agent.role, path } },
  ];
  try {
    const run = await runOnMiniMax({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      timeoutMs: timeoutMs(),
    });
    const text = deliverableText(run.text.trim(), path) || `# ${input.task.title}\n\nMiniMax returned no usable content.`;
    await writeWorkspaceFile(input.workspace, path, text);
    const reasoningTokens = (run.usage?.['completion_tokens_details'] as { reasoning_tokens?: number } | undefined)?.reasoning_tokens;
    return {
      text,
      path,
      kind: kindForPath(path),
      ok: true,
      error: null,
      events: [
        ...started,
        { type: 'tool_result', id: toolId, output: { model: miniMaxModel(), reasoningTokens: reasoningTokens ?? 0, chars: text.length } },
        { type: 'file_change', path, kind: 'create', diff: `created ${path}` },
        { type: 'text_delta', delta: `${agent.displayName} produced ${path} via MiniMax.` },
        { type: 'done', finishReason: 'completed' },
      ],
    };
  } catch (error) {
    if (error instanceof MiniMaxUnavailableError) throw error; // let dispatch fall back
    const message = error instanceof Error ? error.message : String(error);
    const text = `# ${input.task.title}\n\nMiniMax request failed.\n\n${message}`;
    await writeWorkspaceFile(input.workspace, path, text);
    return {
      text,
      path,
      kind: kindForPath(path),
      ok: false,
      error: message,
      events: [
        ...started,
        { type: 'tool_result', id: toolId, output: { error: message }, isError: true },
        { type: 'error', message, recoverable: true },
      ],
    };
  }
}

// Runs the task against the configured OpenAI-compatible model. Throws
// OpenAICompatUnavailableError (from runOnOpenAICompat) when unconfigured — the
// dispatch layer catches it and falls back to local-dispatch. Like runMiniMaxTask
// this is a chat-only model: the deliverable comes back in the response text (no
// shell / file tools).
async function runOpenAICompatTask(input: {
  workspace: string;
  task: PlanTask;
  message: string;
  handoffContext?: string | undefined;
}): Promise<AgentRunResult> {
  const agent = agentForTask(input.task);
  const path = pathForTask(input.task);
  const toolId = `tool_${input.task.id}`;
  const system = chatAgentPrompt(agent, input);
  const user = input.handoffContext
    ? `Task: ${input.task.title}\n\nUpstream deliverable to build on / review:\n\n${input.handoffContext}\n\nProduce your deliverable now.`
    : `Task: ${input.task.title}\n\nProduce your deliverable now.`;
  const started: AgentEvent[] = [
    { type: 'thinking_delta', delta: `${agent.displayName} querying ${openAICompatModel()}.` },
    { type: 'tool_use', id: toolId, name: 'model_chat', input: { agentId: agent.id, role: agent.role, path } },
  ];
  try {
    const run = await runOnOpenAICompat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      timeoutMs: timeoutMs(),
    });
    const text = deliverableText(run.text.trim(), path) || `# ${input.task.title}\n\nModel returned no usable content.`;
    await writeWorkspaceFile(input.workspace, path, text);
    const reasoningTokens = (run.usage?.['completion_tokens_details'] as { reasoning_tokens?: number } | undefined)?.reasoning_tokens;
    return {
      text,
      path,
      kind: kindForPath(path),
      ok: true,
      error: null,
      events: [
        ...started,
        { type: 'tool_result', id: toolId, output: { model: openAICompatModel(), reasoningTokens: reasoningTokens ?? 0, chars: text.length } },
        { type: 'file_change', path, kind: 'create', diff: `created ${path}` },
        { type: 'text_delta', delta: `${agent.displayName} produced ${path} via ${openAICompatModel()}.` },
        { type: 'done', finishReason: 'completed' },
      ],
    };
  } catch (error) {
    if (error instanceof OpenAICompatUnavailableError) throw error; // let dispatch fall back
    const message = error instanceof Error ? error.message : String(error);
    const text = `# ${input.task.title}\n\nModel request failed.\n\n${message}`;
    await writeWorkspaceFile(input.workspace, path, text);
    return {
      text,
      path,
      kind: kindForPath(path),
      ok: false,
      error: message,
      events: [
        ...started,
        { type: 'tool_result', id: toolId, output: { error: message }, isError: true },
        { type: 'error', message, recoverable: true },
      ],
    };
  }
}

function pathForTask(task: PlanTask): string {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || task.id;
  const agent = agentForTask(task);
  // A web/page build should produce a previewable HTML artifact, not a Markdown
  // doc — otherwise the model is never asked for a real page and the UI can't
  // render a preview. Detect intent from the task's text (title + brief).
  if (agent.role === 'implementer') {
    const ext = wantsWebPage(`${task.title} ${task.brief}`) ? 'html' : 'md';
    return `.roundtable/runs/work/${slug}.${ext}`;
  }
  if (agent.role === 'reviewer') return `.roundtable/runs/review/${slug}.md`;
  if (agent.role === 'fixer') return `.roundtable/runs/fixes/${slug}.md`;
  return `.roundtable/runs/docs/${slug}.md`;
}

// Does this build target a renderable web page? Covers EN + 中文 vocabulary.
function wantsWebPage(text: string): boolean {
  return /\b(website|web\s?page|webpage|landing|page|site|html|frontend|ui|dashboard|portfolio|checkout|payment|cart)\b|网站|网页|页面|前端|官网|落地页|主页|仪表盘|看板|结账|支付|购物车/i.test(text);
}

function kindForPath(path: string): ArtifactKind {
  if (path.endsWith('.html')) return 'preview';
  if (path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.js')) return 'code';
  return 'markdown';
}

// Chat models often wrap a code/HTML deliverable in a Markdown code fence
// (```html … ```) despite being told not to. For artifacts that are meant to be
// raw code/HTML (rendered in an iframe or saved as a source file), unwrap a
// single enclosing fence so the file is the real content, not fenced text.
// Markdown artifacts (.md) keep their fences — they're documents.
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  // Only unwrap when the WHOLE response is one fenced block, to avoid mangling
  // docs that legitimately contain multiple code snippets.
  const match = trimmed.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/);
  return match ? match[1]!.trim() : trimmed;
}

function deliverableText(text: string, path: string): string {
  return path.endsWith('.md') ? text : stripCodeFence(text);
}

async function writeWorkspaceFile(workspace: string, relativePath: string, text: string): Promise<void> {
  const target = join(workspace, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
}

function localArtifactText(task: PlanTask, message: string, path: string, handoffContext?: string): string {
  if (path.endsWith('.html')) return localHtmlArtifact(message);
  const focus = userGoalTitle(message);
  const agent = agentForTask(task);
  const role = agent.role;
  return [
    `# ${task.title}`,
    '',
    `Role: ${task.assignee}`,
    `Agent: ${agent.displayName}`,
    '',
    `User goal: ${message}`,
    '',
    ...(handoffContext ? ['## Previous agent output', '', handoffContext, ''] : []),
    '## What this task will produce',
    '',
    role === 'architect'
      ? `- Structure the work around "${focus}".\n- Keep the frontend contract stable.\n- Hand off clear implementation and review checkpoints.`
      : role === 'reviewer'
        ? `- Check that the output directly answers "${focus}".\n- Review accessibility, copy clarity, and visible completeness.\n- Call out missing production integrations.`
        : `- Produce a concrete deliverable for "${focus}".\n- Keep the artifact easy to preview from Roundtable.`,
    '',
    '## Notes',
    '',
    'This artifact was produced through the Roundtable backend action layer and can be replayed by devrt.',
  ].join('\n');
}

function localHtmlArtifact(message: string): string {
  const title = userGoalTitle(message);
  if (/\b(checkout|payment|cart|post-?payment|stripe)\b|结账|支付|购物车|订单确认/i.test(message)) {
    return checkoutFlowHtml(title);
  }
  const isPersonalSite = /个人网站|portfolio|personal\s+site|resume|简历|主页/i.test(message);
  const headline = isPersonalSite ? '个人网站' : title;
  const subhead = isPersonalSite
    ? '一个用于展示个人介绍、项目作品和联系方式的响应式页面。'
    : `根据任务「${title}」生成的可预览页面。`;
  const sections: Array<[string, string]> = isPersonalSite
    ? [
        ['关于我', '用一段清晰的简介说明身份、方向和当前关注的项目。'],
        ['精选项目', '展示 3 个代表性项目，包含背景、贡献和结果。'],
        ['技能栈', '列出前端、后端、AI 工具链和协作能力。'],
        ['联系我', '提供邮箱、社交链接和一个简短行动按钮。'],
      ]
    : [
        ['目标', `完成用户请求：${message}`],
        ['交付物', '提供一个可直接预览、可继续迭代的页面雏形。'],
        ['下一步', '接入真实数据、补充品牌样式，并进行可访问性检查。'],
      ];
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    ':root{color-scheme:light;--ink:#181622;--muted:#6f6a85;--line:#ded8ef;--accent:#7d6bd6;--bg:#f6f2ff}',
    '*{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(180deg,#fff,var(--bg));color:var(--ink)}',
    'main{max-width:980px;margin:0 auto;padding:56px 24px 72px}header{display:grid;gap:16px;margin-bottom:34px}.eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);font-weight:800}',
    'h1{font-size:clamp(40px,7vw,76px);line-height:.95;margin:0;letter-spacing:-.04em}p{font-size:18px;line-height:1.7;color:var(--muted);max-width:720px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:28px}',
    '.card{background:rgba(255,255,255,.82);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 18px 50px -32px rgba(50,38,100,.45)}h2{font-size:18px;margin:0 0 10px}.cta{display:inline-flex;margin-top:18px;padding:12px 18px;border-radius:999px;background:var(--accent);color:white;text-decoration:none;font-weight:800}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    '<header>',
    '<div class="eyebrow">Roundtable output</div>',
    `<h1>${escapeHtml(headline)}</h1>`,
    `<p>${escapeHtml(subhead)}</p>`,
    '<a class="cta" href="mailto:hello@example.com">开始联系</a>',
    '</header>',
    '<section class="grid">',
    ...sections.map(([heading, body]) => `<article class="card"><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(body)}</p></article>`),
    '</section>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}

function checkoutFlowHtml(title: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    ':root{color-scheme:light;--ink:#172033;--muted:#667085;--line:#d8e0ea;--panel:#ffffff;--bg:#f5f7fb;--accent:#2563eb;--ok:#12b76a;--warn:#f79009}',
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    'main{max-width:1180px;margin:0 auto;padding:34px 24px 54px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}h1{font-size:34px;line-height:1.08;margin:5px 0 0}.secure{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:999px;background:white;padding:8px 12px;color:var(--muted);font-size:13px}',
    '.layout{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:18px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 18px 50px -35px rgba(18,31,56,.38)}.section{padding:18px;border-bottom:1px solid var(--line)}.section:last-child{border-bottom:0}.section h2{font-size:15px;margin:0 0 12px}.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}.step{border:1px solid var(--line);background:#f8fafc;border-radius:10px;padding:10px}.step b{display:block;font-size:12px}.step span{display:block;color:var(--muted);font-size:11px;margin-top:2px}.step.active{border-color:var(--accent);background:#eff6ff;color:var(--accent)}',
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.field{display:grid;gap:6px}.field label{font-size:12px;font-weight:700;color:#344054}.field input,.field select{height:42px;border:1px solid var(--line);border-radius:9px;padding:0 11px;font:inherit;background:#fff}.error{border-color:#f04438!important;background:#fff8f7!important}.hint{font-size:12px;color:#f04438}.paybox{display:grid;gap:10px}.method{display:flex;align-items:center;justify-content:space-between;border:1px solid var(--line);border-radius:10px;padding:12px}.method.active{border-color:var(--accent);background:#eff6ff}.badge{font-size:11px;font-weight:800;color:var(--ok);background:#ecfdf3;border-radius:999px;padding:3px 8px}.summary{padding:18px;position:sticky;top:18px}.item,.row{display:flex;justify-content:space-between;gap:12px}.item{padding:12px 0;border-bottom:1px solid var(--line)}.item strong{font-size:13px}.item span,.row span{color:var(--muted);font-size:13px}.row{padding:8px 0}.total{font-size:18px;font-weight:850;color:var(--ink)}.cta{width:100%;height:46px;margin-top:14px;border:0;border-radius:11px;background:var(--accent);color:white;font:inherit;font-weight:850;cursor:pointer}.confirm{display:grid;gap:8px;border:1px solid #abefc6;background:#ecfdf3;color:#067647;border-radius:12px;padding:13px;margin-top:12px}.confirm b{font-size:14px}.confirm span{font-size:12px;color:#067647}@media(max-width:860px){.layout{grid-template-columns:1fr}.summary{position:static}.steps{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    '<div class="top"><div><div class="eyebrow">Checkout flow delivery</div><h1>Cart to confirmation checkout</h1></div><div class="secure">Lock icon Secure payment handoff</div></div>',
    '<div class="steps"><div class="step active"><b>1. Cart</b><span>Review order</span></div><div class="step active"><b>2. Details</b><span>Validate inputs</span></div><div class="step active"><b>3. Payment</b><span>Provider handoff</span></div><div class="step"><b>4. Confirmation</b><span>Receipt state</span></div></div>',
    '<div class="layout">',
    '<section class="panel">',
    '<div class="section"><h2>Customer details</h2><div class="grid"><div class="field"><label>Email</label><input value="alex@example.com" /></div><div class="field"><label>Phone</label><input value="+1 415 555 0148" /></div><div class="field"><label>Country</label><select><option>United States</option></select></div><div class="field"><label>ZIP code</label><input class="error" value="94" /><div class="hint">ZIP must be 5 digits before payment handoff.</div></div></div></div>',
    '<div class="section"><h2>Payment handoff</h2><div class="paybox"><div class="method active"><div><strong>Card via Stripe</strong><div class="hint" style="color:var(--muted)">Tokenize card, then create payment intent server-side.</div></div><span class="badge">selected</span></div><div class="method"><div><strong>Wallet</strong><div class="hint" style="color:var(--muted)">Apple Pay / Google Pay when available.</div></div><span>optional</span></div></div></div>',
    '<div class="section"><h2>Post-payment confirmation</h2><div class="confirm"><b>Payment authorized. Order RT-1048 ready.</b><span>Show this state after webhook confirmation and persist receipt details.</span></div></div>',
    '</section>',
    '<aside class="panel summary"><h2>Cart summary</h2><div class="item"><div><strong>Growth plan</strong><br><span>Annual subscription</span></div><strong>$240</strong></div><div class="item"><div><strong>Priority support</strong><br><span>Monthly add-on</span></div><strong>$29</strong></div><div class="row"><span>Subtotal</span><strong>$269</strong></div><div class="row"><span>Tax estimate</span><strong>$21.52</strong></div><div class="row total"><span>Total</span><strong>$290.52</strong></div><button class="cta">Continue to payment</button><div class="confirm"><b>Acceptance criteria covered</b><span>Cart summary, validation, payment handoff, and confirmation state are all represented.</span></div></aside>',
    '</div>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}

function userGoalTitle(message: string): string {
  const trimmed = message.replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
  return trimmed.length > 72 ? `${trimmed.slice(0, 72)}...` : trimmed || 'Roundtable deliverable';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function commandForAgent(agent: AgentProfile): string {
  return process.env[`ROUNDTABLE_AGENT_COMMAND_${envKey(agent.id)}`]
    || process.env[`ROUNDTABLE_AGENT_COMMAND_${envKey(agent.role)}`]
    || process.env.ROUNDTABLE_AGENT_COMMAND
    || defaultCommandForAgent(agent);
}

function defaultCommandForAgent(agent: AgentProfile): string {
  if (agent.role === 'reviewer' && process.env.ROUNDTABLE_REVIEWER_PREFERS_OPENCODE === '1') return 'opencode';
  return 'claude';
}

function commandArgs(prompt: string, agent: AgentProfile): string[] {
  const configured = splitArgs(
    process.env[`ROUNDTABLE_AGENT_ARGS_${envKey(agent.id)}`]
    || process.env[`ROUNDTABLE_AGENT_ARGS_${envKey(agent.role)}`]
    || process.env.ROUNDTABLE_AGENT_ARGS
    || '',
  );
  if (configured.length > 0) {
    if (configured.some((arg) => arg.includes('{prompt}'))) {
      return configured.map((arg) => arg.replace('{prompt}', prompt));
    }
    return [...configured, prompt];
  }
  if (commandForAgent(agent).endsWith('opencode') || commandForAgent(agent).includes('/opencode')) {
    return ['run', prompt];
  }
  return ['-p', prompt, '--permission-mode', 'bypassPermissions'];
}

function agentPrompt(agent: AgentProfile, input: { task: PlanTask; message: string; handoffContext?: string | undefined }): string {
  const roleInstruction = {
    planner: 'Create the initial breakdown and routing. Do not implement unless the task explicitly asks only for planning.',
    pm: 'Clarify product intent, constraints, acceptance criteria, and sequencing.',
    architect: 'Design the technical approach, interfaces, risks, and dependency order.',
    implementer: 'Modify the project files needed to complete your assigned slice.',
    reviewer: 'Review the current project state and report concrete issues, risks, and missing tests.',
    fixer: 'Apply focused fixes for known issues and summarize changed files.',
  }[agent.role];

  return [
    'You are running inside Roundtable as one CLI-backed coding agent.',
    `Agent: ${agent.displayName} (${agent.id})`,
    `Role: ${agent.role}`,
    `Instruction: ${roleInstruction}`,
    `Task: ${input.task.title}`,
    `Brief: ${input.task.brief}`,
    `Original user request: ${input.message}`,
    input.handoffContext
      ? `Previous agent output:\n\n${input.handoffContext}`
      : 'You are the first agent in this chain.',
    'Work inside the current working directory. You may inspect and edit files as needed for this role.',
    'Do not touch files outside this working directory.',
    'When finished, print a concise Markdown summary with changed files, commands run, and any blockers.',
  ].join('\n\n');
}

// Prompt for chat-only model adapters (MiniMax): no shell, no file tools — the
// deliverable must come back IN the response text. This is deliberately
// different from agentPrompt (which targets file-editing CLIs) because a chat
// model told to "edit files" just emits shell commands it can't run.
function chatAgentPrompt(
  agent: AgentProfile,
  input: { task: PlanTask; message: string; handoffContext?: string | undefined },
): string {
  const isHtml = pathForTask(input.task).endsWith('.html');
  const roleInstruction = {
    planner: 'Break the goal into a short, ordered task list with clear ownership. Output the plan as Markdown.',
    pm: 'State the product intent, constraints, and acceptance criteria as Markdown.',
    architect: 'Describe the technical approach, key interfaces, and risks as Markdown.',
    implementer: isHtml
      ? 'Output a COMPLETE, self-contained HTML document (with inline CSS/JS) that fulfills the task. Output only the HTML, no prose, no code fences.'
      : 'Output the complete deliverable content directly (code or Markdown). Do not describe what you would do — produce it.',
    reviewer: 'Review the upstream deliverable. Output a Markdown report: concrete issues, risks, and missing pieces, each with severity. If it is solid, say so explicitly.',
    fixer: 'Apply a focused fix for the reported problem and output the corrected deliverable plus a short summary of what changed.',
  }[agent.role] ?? 'Produce your deliverable directly in the response.';

  return [
    'You are one specialist on the Roundtable AI team. You respond through a chat API:',
    'you have NO shell and NO file system — never emit commands like `ls` or `cat`.',
    'Put your entire deliverable directly in your reply.',
    `You are ${agent.displayName}, the ${agent.role}.`,
    `Instruction: ${roleInstruction}`,
    `Original user request: ${input.message}`,
  ].join('\n\n');
}

function envKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

function splitArgs(raw: string): string[] {
  return raw.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function timeoutMs(): number {
  const parsed = Number(process.env.ROUNDTABLE_AGENT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}
