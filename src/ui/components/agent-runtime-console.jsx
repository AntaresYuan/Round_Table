'use client';

import React from 'react';
import { Avatar, Icon } from './primitives';

const { useEffect, useMemo, useState } = React;

const shell = {
  minHeight: '100vh',
  background: 'var(--bg)',
  color: 'var(--text)',
  display: 'flex',
  flexDirection: 'column',
};

const card = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  boxShadow: 'var(--shadow-card)',
};

const btn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--surface)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 12.5,
  padding: '7px 10px',
  cursor: 'pointer',
};

const field = {
  height: 34,
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--surface-2)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 12.5,
  padding: '0 9px',
  outline: 'none',
};

function AgentRuntimeConsole() {
  const [state, setState] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [runtimeDrafts, setRuntimeDrafts] = useState({});
  const [message, setMessage] = useState({});
  const [saving, setSaving] = useState(null);
  const [savingRuntime, setSavingRuntime] = useState(null);
  const [activatingAgentCli, setActivatingAgentCli] = useState(false);
  const [error, setError] = useState('');

  const hasRunning = useMemo(
    () => (state?.conversations || []).some((conversation) => conversation.status === 'running'),
    [state],
  );

  const load = async () => {
    try {
      const res = await fetch('/api/agent-runtimes', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'runtime_state_failed');
      setState(data.state);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const agent of data.state.agents || []) {
          if (!next[agent.id]) {
            next[agent.id] = {
              runtime: agent.runtime,
              command: agent.command || '',
              model: agent.model || '',
              argsText: (agent.args || []).join(' '),
            };
          }
        }
        return next;
      });
      setRuntimeDrafts((prev) => {
        const next = { ...prev };
        for (const runtime of data.state.supported || []) {
          if (!next[runtime.kind]) {
            next[runtime.kind] = {
              command: runtime.command || '',
              model: runtime.model || '',
              argsText: (runtime.args || []).join(' '),
              envText: '',
              clearEnv: false,
            };
          }
        }
        return next;
      });
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const timer = setInterval(load, hasRunning ? 2000 : 6000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  const runtimeOptions = state?.supported || [];
  const agents = state?.agents || [];
  const conversations = state?.conversations || [];
  const executionAdapter = state?.executionAdapter || 'local-dispatch';
  const executionSource = state?.executionAdapterSource || 'built-in';
  const workflowUsesAgentCli = executionAdapter === 'agent-cli';

  const updateDraft = (agentId, patch) => {
    setDrafts((prev) => ({ ...prev, [agentId]: { ...(prev[agentId] || {}), ...patch } }));
  };

  const updateRuntimeDraft = (runtimeKind, patch) => {
    setRuntimeDrafts((prev) => ({ ...prev, [runtimeKind]: { ...(prev[runtimeKind] || {}), ...patch } }));
  };

  const save = async (agentId) => {
    const draft = drafts[agentId] || {};
    setSaving(agentId);
    try {
      const res = await fetch('/api/agent-runtimes/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          runtime: draft.runtime,
          command: draft.command || null,
          model: draft.model || null,
          args: splitArgs(draft.argsText || ''),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'save_runtime_failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const saveRuntimeDefault = async (runtimeKind) => {
    const draft = runtimeDrafts[runtimeKind] || {};
    const env = parseEnvText(draft.envText || '');
    const body = {
      runtime: runtimeKind,
      command: draft.command || null,
      model: draft.model || null,
      args: splitArgs(draft.argsText || ''),
      clearEnv: Boolean(draft.clearEnv),
    };
    if (Object.keys(env).length > 0) body.env = env;
    setSavingRuntime(runtimeKind);
    try {
      const res = await fetch('/api/agent-runtimes/defaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'save_runtime_default_failed');
      setRuntimeDrafts((prev) => ({
        ...prev,
        [runtimeKind]: { ...(prev[runtimeKind] || {}), envText: '', clearEnv: false },
      }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRuntime(null);
    }
  };

  const activateAgentCli = async () => {
    setActivatingAgentCli(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultAgentAdapter: 'agent-cli' }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'activate_agent_cli_failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivatingAgentCli(false);
    }
  };

  const sendDirect = async (agentId) => {
    const content = (message[agentId] || '').trim();
    if (!content) return;
    setMessage((prev) => ({ ...prev, [agentId]: '' }));
    try {
      const res = await fetch('/api/agent-runtimes/direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, message: content }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'direct_runtime_failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = async (conversationId) => {
    try {
      const res = await fetch('/api/agent-runtimes/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, action: 'stop' }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'stop_runtime_failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main style={shell}>
      <header style={{ height: 54, display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px',
        borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
        <a href="/" style={{ ...btn, textDecoration: 'none' }}><Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} /> Roundtable</a>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Agent CLI Console</h1>
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{conversations.filter((item) => item.status === 'running').length} running</span>
        </div>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11.5, color: workflowUsesAgentCli ? 'var(--ok)' : 'var(--warn)',
          padding: '6px 9px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          workflow: {executionAdapter} · {executionSource}
        </span>
        {!workflowUsesAgentCli && (
          <button onClick={activateAgentCli} style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 'none' }}>
            <Icon name="code" size={14} /> {activatingAgentCli ? 'Switching' : 'Use Agent CLI'}
          </button>
        )}
        <a href="/settings" style={{ ...btn, textDecoration: 'none' }}><Icon name="wrench" size={14} /> Settings</a>
        <button onClick={load} style={btn}><Icon name="search" size={14} /> Refresh</button>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 520px) minmax(0, 1fr)', gap: 16,
        padding: 16, flex: 1, minHeight: 0 }}>
        <section style={{ ...card, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={sectionHead}>Agent Configuration</div>
          <div style={{ overflowY: 'auto', padding: 10, display: 'grid', gap: 8 }}>
            {agents.map((agent) => {
              const draft = drafts[agent.id] || {};
              return (
                <div key={agent.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10,
                  background: 'var(--surface-2)', display: 'grid', gap: 9 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <Avatar agent={{ id: agent.id, displayName: agent.name, role: agent.role, color: roleColor(agent.role) }} size={28} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700 }}>{agent.name}</div>
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{agent.id} · {agent.role}</div>
                    </div>
                    <span style={{ fontSize: 10.5, color: agent.configured ? 'var(--accent)' : 'var(--text-faint)' }}>
                      {agent.configured ? 'configured' : 'default'}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
                    <select value={draft.runtime || agent.runtime} onChange={(e) => updateDraft(agent.id, { runtime: e.target.value })} style={field}>
                      {runtimeOptions.map((runtime) => (
                        <option key={runtime.kind} value={runtime.kind}>{runtime.label}</option>
                      ))}
                    </select>
                    <input value={draft.model || ''} onChange={(e) => updateDraft(agent.id, { model: e.target.value })}
                      placeholder="model" style={field} />
                    <input value={draft.command || ''} onChange={(e) => updateDraft(agent.id, { command: e.target.value })}
                      placeholder="command override" style={{ ...field, gridColumn: '1 / -1' }} />
                    <input value={draft.argsText || ''} onChange={(e) => updateDraft(agent.id, { argsText: e.target.value })}
                      placeholder="args, use {prompt}" style={{ ...field, gridColumn: '1 / -1' }} />
                  </div>
                  <div style={{ display: 'flex', gap: 7 }}>
                    <button onClick={() => save(agent.id)} style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 'none' }}>
                      <Icon name="check" size={13} /> {saving === agent.id ? 'Saving' : 'Save'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 7 }}>
                    <input value={message[agent.id] || ''} onChange={(e) => setMessage((prev) => ({ ...prev, [agent.id]: e.target.value }))}
                      placeholder={`Message ${agent.name}`} style={{ ...field, flex: 1 }} />
                    <button onClick={() => sendDirect(agent.id)} style={btn}><Icon name="send" size={13} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', gap: 16, minHeight: 0 }}>
          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={sectionHead}>Runtime Settings</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 8, padding: 10 }}>
              {runtimeOptions.map((runtime) => {
                const draft = runtimeDrafts[runtime.kind] || {};
                const isLocal = runtime.kind === 'local-dispatch';
                return (
                  <div key={runtime.kind} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10,
                    background: runtime.ready ? 'var(--surface-2)' : 'color-mix(in oklab, var(--bad) 8%, var(--surface))',
                    display: 'grid', gap: 9 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: runtime.ready ? 'var(--ok)' : 'var(--bad)', flexShrink: 0 }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700 }}>{runtime.label}</div>
                        <div className="mono" style={{ marginTop: 2, fontSize: 10.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {runtime.ready ? runtimeCommandLabel(runtime) : runtime.readyReason}
                        </div>
                      </div>
                      <span style={{ fontSize: 10.5, color: runtime.configured ? 'var(--accent)' : 'var(--text-faint)' }}>
                        {runtime.configured ? 'configured' : 'default'}
                      </span>
                    </div>

                    {isLocal ? (
                      <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>built in</div>
                    ) : (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
                          <input value={draft.command || ''} onChange={(e) => updateRuntimeDraft(runtime.kind, { command: e.target.value })}
                            placeholder={runtime.binary ? `command (${runtime.binary})` : 'command'} style={field} />
                          <input value={draft.model || ''} onChange={(e) => updateRuntimeDraft(runtime.kind, { model: e.target.value })}
                            placeholder="model" style={field} />
                          <input value={draft.argsText || ''} onChange={(e) => updateRuntimeDraft(runtime.kind, { argsText: e.target.value })}
                            placeholder="args, use {prompt}" style={{ ...field, gridColumn: '1 / -1' }} />
                          <textarea value={draft.envText || ''} onChange={(e) => updateRuntimeDraft(runtime.kind, { envText: e.target.value })}
                            placeholder="ENV_KEY=value" rows={3} style={{ ...field, height: 64, resize: 'vertical', paddingTop: 8, gridColumn: '1 / -1' }} />
                        </div>
                        {runtime.configuredEnvKeys?.length > 0 && (
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                            {runtime.configuredEnvKeys.map((key) => (
                              <span key={key} className="mono" style={{ fontSize: 10.5, padding: '2px 6px',
                                borderRadius: 5, border: '1px solid var(--border)', color: 'var(--text-faint)' }}>{key}</span>
                            ))}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                          <button onClick={() => saveRuntimeDefault(runtime.kind)}
                            style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 'none' }}>
                            <Icon name="check" size={13} /> {savingRuntime === runtime.kind ? 'Saving' : 'Save'}
                          </button>
                          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-faint)' }}>
                            <input type="checkbox" checked={Boolean(draft.clearEnv)}
                              onChange={(e) => updateRuntimeDraft(runtime.kind, { clearEnv: e.target.checked })} />
                            Clear env
                          </label>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ ...card, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={sectionHead}>CLI Conversations</div>
            <div style={{ overflowY: 'auto', padding: 10, display: 'grid', gap: 9 }}>
              {conversations.length === 0 && (
                <div style={{ padding: 18, color: 'var(--text-faint)', fontSize: 13 }}>No runtime conversations yet.</div>
              )}
              {conversations.map((conversation) => (
                <ConversationCard key={conversation.id} conversation={conversation} onStop={stop} />
              ))}
            </div>
          </div>
        </section>
      </div>
      {error && <div style={{ position: 'fixed', right: 16, bottom: 16, maxWidth: 420, padding: '10px 12px',
        borderRadius: 8, background: 'var(--bad)', color: '#fff', fontSize: 12.5 }}>{error}</div>}
    </main>
  );
}

function ConversationCard({ conversation, onStop }) {
  const latest = conversation.transcript.slice(-8);
  return (
    <article style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(conversation.status) }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>{conversation.title}</strong>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{conversation.runtime}</span>
          </div>
          <div className="mono" style={{ marginTop: 2, fontSize: 10.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {conversation.agentId} · {conversation.command}
          </div>
        </div>
        {conversation.status === 'running' && (
          <button onClick={() => onStop(conversation.id)} style={{ ...btn, color: 'var(--bad)' }}>
            <Icon name="x" size={13} /> Stop
          </button>
        )}
      </div>
      <div style={{ display: 'grid', gap: 6, padding: 10 }}>
        {latest.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Waiting for output.</div>
        ) : latest.map((line) => (
          <div key={`${line.at}-${line.content.slice(0, 12)}`} style={{ borderLeft: `2px solid ${kindColor(line.kind)}`,
            padding: '4px 8px', background: 'var(--surface)', borderRadius: 5 }}>
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>{line.kind}</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{line.content}</div>
          </div>
        ))}
      </div>
    </article>
  );
}

function splitArgs(raw) {
  return raw.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function parseEnvText(raw) {
  const env = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && value) env[key] = value;
  }
  return env;
}

function runtimeCommandLabel(runtime) {
  if (runtime.command) return runtime.command;
  if (runtime.binary) return runtime.binary;
  if (runtime.kind === 'custom-cli') return 'ROUNDTABLE_AGENT_COMMAND';
  return 'built in';
}

function roleColor(role) {
  return {
    planner: '#5f86b8',
    pm: '#b27858',
    architect: '#8b7cf6',
    implementer: '#4cc38a',
    reviewer: '#e6a23c',
    fixer: '#c47766',
  }[role] || '#938b7c';
}

function statusColor(status) {
  return {
    running: 'var(--run)',
    completed: 'var(--ok)',
    failed: 'var(--bad)',
    stopped: 'var(--warn)',
  }[status] || 'var(--text-faint)';
}

function kindColor(kind) {
  return {
    status: 'var(--accent)',
    thinking: 'var(--run)',
    response: 'var(--ok)',
    error: 'var(--bad)',
  }[kind] || 'var(--border-strong)';
}

const sectionHead = {
  height: 40,
  display: 'flex',
  alignItems: 'center',
  padding: '0 12px',
  borderBottom: '1px solid var(--border)',
  fontSize: 12,
  fontWeight: 750,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

export default AgentRuntimeConsole;
