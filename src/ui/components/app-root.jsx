'use client';
/* ============================================================================
   Roundtable — app.jsx
   Top-level: timeline driver, drawer, Table scene + Gallery, controls, Tweaks.
   ============================================================================ */

import React from 'react';
import { RT } from '../lib/rt';
import { Avatar, RoleTag, Icon, Spinner, Chip, Md, tint, alpha } from './primitives';
import { ArtifactRenderer, CodeBlock, VChip, TodoListCard, HandoffCard, BreakoutChip, iconBtn, normalizeArtifactForDisplay } from './cards';
import { MessageGroup, Composer, ConversationRail, LogoMark } from './chat';
import { RoundtableScene, WhiteboardZoom, sceneAt, meetingNotes } from './roundtable';
import { WorkflowView, WorkflowStrip } from './workflow';
import { Modal, NewTaskModal, NewWorkbenchModal, AddAgentModal, EditHandoffModal } from './modals';
import { DependencyGraphSidebar } from './dep-graph';
import { MemoryPanel } from './memory-panel';
import { useSession } from 'next-auth/react';
import { trpc } from '@/ui/lib/trpc';

const { useState, useEffect, useMemo, useRef, useCallback } = React;

// Minimal tweak-state hook — replaces the prototype's tweaks-panel dev tool.
function useTweaks(defaults) {
  const [t, setT] = useState(defaults);
  const setTweak = (k, v) => setT((prev) => ({ ...prev, [k]: v }));
  return [t, setTweak];
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/* ---- palette remap -------------------------------------------------------- */
const PALETTES = {
  soft:    { architect: '#9579b0', planner: '#5f86b8', implementer: '#5a9e8c', reviewer: '#bd9a55', fixer: '#c47766' },
  vivid:   { architect: '#6366f1', planner: '#0ea5e9', implementer: '#10b981', reviewer: '#f59e0b', fixer: '#ef4444' },
  earthen: { architect: '#b16286', planner: '#458588', implementer: '#98971a', reviewer: '#d79921', fixer: '#cc241d' },
};
function palettize(palette) {
  const p = PALETTES[palette] || PALETTES.soft;
  const base = RT.AGENTS;
  const map = { atlas: p.planner, beam: p.implementer, vera: p.reviewer, nova: p.architect };
  const out = {};
  for (const k in base) out[k] = { ...base[k], color: map[k] || base[k].color };
  return out;
}

/* ---- timeline hook -------------------------------------------------------- */
function useScene(autoplay, speed) {
  const [clock, setClock] = useState(0);
  const [playing, setPlaying] = useState(autoplay);
  const raf = useRef(0), last = useRef(0);
  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const loop = (now) => {
      const dt = (now - last.current) * (speed || 1);
      last.current = now;
      setClock(c => {
        const n = c + dt;
        if (n >= RT.SCENE_DURATION) { setPlaying(false); return RT.SCENE_DURATION; }
        return n;
      });
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed]);
  const replay = () => { setClock(0); setPlaying(true); };
  const toggle = () => {
    if (clock >= RT.SCENE_DURATION) replay();
    else setPlaying(p => !p);
  };
  return { clock, playing, replay, toggle, setClock, setPlaying };
}

/* ---- Drawer --------------------------------------------------------------- */
function Drawer({ art, agents, onClose }) {
  if (!art) return null;
  const displayArt = normalizeArtifactForDisplay(art);
  const owner = ownerForDrawer(displayArt, agents);
  const isPreview = displayArt.kind === 'preview';
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100,
      background: alpha('#000', 32), backdropFilter: 'blur(2px)', display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} className="rt-rise" style={{ width: 'min(620px, 92vw)',
        height: '100%', background: 'var(--surface)', borderLeft: '1px solid var(--border)',
        boxShadow: 'var(--shadow-pop)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px',
          borderBottom: '1px solid var(--border)' }}>
          <Avatar agent={owner} size={28} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 13.5, fontWeight: 600 }}>{displayArt.title}</div>
            <div style={{ marginTop: 2 }}><RoleTag agent={owner} showName /></div>
          </div>
          <VChip v={displayArt.version} />
          <button onClick={onClose} style={iconBtn}><Icon name="x" size={16} /></button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 18, background: 'var(--surface-2)' }}>
          {isPreview
            ? <div style={{ borderRadius: 'var(--r-card)', overflow: 'hidden', border: '1px solid var(--border)',
                boxShadow: 'var(--shadow-card)' }}>
                <iframe title="preview" srcDoc={displayArt.preview} sandbox="allow-scripts"
                  style={{ width: '100%', height: 560, border: 'none', display: 'block', background: '#fff' }} />
              </div>
            : displayArt.kind === 'diff'
            ? <div style={{ borderRadius: 'var(--r-card)', overflow: 'hidden', border: '1px solid var(--border)' }}>
                <ArtifactRenderer art={displayArt} agents={agents} /></div>
            : <div style={{ borderRadius: 'var(--r-card)', overflow: 'hidden', border: '1px solid var(--border)',
                background: 'var(--surface)' }}>
                <CodeBlock code={displayArt.code || displayArt.preview || displayArt.uri || ''} /></div>}
        </div>
      </div>
    </div>
  );
}

function ownerForDrawer(art, agents) {
  const ownerId = art.ownerAgentId;
  const direct = ownerId ? agents?.[ownerId] : null;
  if (direct) return direct;
  const byRole = ownerId
    ? Object.values(agents || {}).find((agent) => agent.role === ownerId)
    : null;
  if (byRole) return byRole;
  return {
    agentId: ownerId || 'agent',
    role: ownerId || 'agent',
    displayName: ownerId ? `@${ownerId}` : 'Agent',
    color: 'var(--text-muted)',
  };
}

/* ---- Aggregate quick actions --------------------------------------------- */
function Aggregate({ beat, agents, onAction }) {
  const pm = agents.orchestrator;
  return (
    <div className="rt-rise" style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
      <Avatar agent={pm} size={26} ring={false} />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
          <Icon name="check" size={15} style={{ color: 'var(--ok)' }} />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Round complete</span>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13.5, marginBottom: 12, lineHeight: 1.55 }}>{beat.text}</div>
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
          {beat.actions.map(a => (
            <button key={a.id} onClick={() => onAction(a.id)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px',
              borderRadius: 'var(--r-sm)', font: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer',
              border: a.kind === 'primary' ? 'none' : '1px solid var(--border)',
              background: a.kind === 'primary' ? 'var(--accent)' : 'var(--surface)',
              color: a.kind === 'primary' ? '#fff' : 'var(--text)', transition: 'all .15s ease' }}>
              <Icon name={a.icon} size={15} />{a.label}
              {a.badge && <span className="tnum" style={{ fontSize: 11, fontWeight: 700, minWidth: 16, height: 16,
                padding: '0 4px', borderRadius: 8, display: 'grid', placeItems: 'center',
                background: a.kind === 'primary' ? alpha('#fff', 25) : alpha('var(--warn)', 18),
                color: a.kind === 'primary' ? '#fff' : 'var(--warn)' }}>{a.badge}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---- Thread (Table view center) ------------------------------------------ */
function Thread({ agents, scene, onOpenArtifact, onAction }) {
  const ref = useRef(null);
  const revealed = RT.SCRIPT.filter(b => b.at <= scene.clock);
  const [handoff, setHandoff] = useState(RT.HANDOFF);
  const [syncHandoffs, setSyncHandoffs] = useState([]);
  const [editingHandoff, setEditingHandoff] = useState(null); // { ho, onSave } | null
  const noticesByArtifact = useMemo(() => {
    const m = new Map();
    (RT.DEP_CHANGED_NOTICES || []).forEach(n => m.set(n.downstream.artifactId, n));
    return m;
  }, []);
  const reviewsByArtifact = useMemo(() => {
    const m = new Map();
    (RT.REVIEW_COMMENTS || []).forEach(c => {
      if (!m.has(c.artifactId)) m.set(c.artifactId, []);
      m.get(c.artifactId).push(c);
    });
    return m;
  }, []);
  const applyReviewFix = (comment) => {
    const art = Object.values(RT.ARTIFACTS).find(a => a.id === comment.artifactId);
    const fixer = agents[comment.author] || agents.vera;
    const prefill = {
      ...handoff,
      id: `ho-fix-${comment.id}`,
      to: `@fixer`,
      scenario: 'agent_handoff',
      taskBrief:
        `Apply ${fixer?.displayName || comment.author}'s review note ` +
        `on ${art?.title || comment.artifactId}` +
        (comment.line !== undefined ? `:${comment.line}` : '') +
        `:\n\n${comment.body}\n\n` +
        `Edit the file in place — multi-author diff lines will tint by author.`,
    };
    setEditingHandoff({
      ho: prefill,
      onSave: (next) =>
        setSyncHandoffs((prev) => {
          const without = prev.filter((p) => p.id !== next.id);
          return [...without, next];
        }),
    });
  };
  const openEditDispatch = () =>
    setEditingHandoff({ ho: handoff, onSave: (next) => setHandoff(next) });
  const askSync = (notice) => {
    const owner = agents[notice.upstream.ownerAgentId];
    const prefill = {
      ...handoff,
      id: `ho-sync-${notice.upstream.artifactId}-${notice.upstream.toVersion}`,
      to: `@${owner?.role || notice.upstream.ownerAgentId}`,
      scenario: 'agent_handoff',
      taskBrief:
        `Sync ${notice.downstream.title || notice.downstream.artifactId} ` +
        `after ${notice.upstream.title || notice.upstream.artifactId} bumped ` +
        `v${notice.upstream.fromVersion}→v${notice.upstream.toVersion} ` +
        `(${notice.kind}). Repair the downstream call site.`,
    };
    setEditingHandoff({
      ho: prefill,
      onSave: (next) =>
        setSyncHandoffs((prev) => {
          const without = prev.filter((p) => p.id !== next.id);
          return [...without, next];
        }),
    });
  };
  const plan = useMemo(() => {
    const tasks = RT.PLAN.tasks.map(t => ({ ...t }));
    RT.PLAN_TIMELINE.forEach(u => { if (u.at <= scene.clock) { const tk = tasks.find(x => x.id === u.id); if (tk) tk.status = u.status; } });
    return { ...RT.PLAN, tasks };
  }, [scene.clock]);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [revealed.length, scene.clock >= RT.SCENE_DURATION]);

  // follow the live stream to the bottom while playing
  useEffect(() => {
    if (!scene.playing) return;
    const iv = setInterval(() => {
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    }, 160);
    return () => clearInterval(iv);
  }, [scene.playing]);

  return (
    <div ref={ref} id="thread-scroll" style={{ flex: 1, overflowY: 'auto', padding: '26px 26px 8px' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--thread-gap)' }}>
        {revealed.map(b => {
          const live = scene.playing && scene.clock < b.at + (b.dur || 1400) + 300;
          if (b.kind === 'user') return <UserMsg key={b.id} text={b.text} />;
          if (b.kind === 'agent') return <MessageGroup key={b.id} beat={b} agents={agents} playing={live} onOpenArtifact={onOpenArtifact} noticesByArtifact={noticesByArtifact} onAskSync={askSync} reviewsByArtifact={reviewsByArtifact} onApplyFix={applyReviewFix} />;
          if (b.kind === 'plan') return <TodoListCard key={b.id} plan={plan} agents={agents} />;
          if (b.kind === 'handoff') return <HandoffCard key={b.id} ho={handoff} agents={agents} onEdit={openEditDispatch} />;
          if (b.kind === 'breakout') return <div key={b.id} className="rt-rise"><BreakoutChip data={b} agents={agents} /></div>;
          if (b.kind === 'aggregate') return <Aggregate key={b.id} beat={b} agents={agents} onAction={onAction} />;
          return null;
        })}
        {syncHandoffs.map((syncHo) => (
          <HandoffCard
            key={syncHo.id}
            ho={syncHo}
            agents={agents}
            onEdit={() =>
              setEditingHandoff({
                ho: syncHo,
                onSave: (next) =>
                  setSyncHandoffs((prev) =>
                    prev.map((p) => (p.id === syncHo.id ? next : p)),
                  ),
              })
            }
          />
        ))}
        <div style={{ height: 8 }} />
      </div>
      {editingHandoff && (
        <EditHandoffModal
          ho={editingHandoff.ho}
          onClose={() => setEditingHandoff(null)}
          onSave={editingHandoff.onSave}
        />
      )}
    </div>
  );
}
function UserMsg({ text }) {
  return (
    <div className="rt-rise" style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
      <div style={{ maxWidth: '78%', padding: '11px 15px', borderRadius: '14px 14px 4px 14px',
        background: 'var(--accent)', color: '#fff', fontSize: 14, lineHeight: 1.5,
        boxShadow: 'var(--shadow-card)' }}>{text}</div>
      <Avatar agent={{ id: 'you-user', displayName: 'You', color: '#8076a0' }} size={30} />
    </div>
  );
}

function LocalLiveThread({ turns, agents, turnActions }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [turns?.[0]?.id, turns?.[0]?.result?.dispatchStatus, turns?.[0]?.result?.artifacts?.length]);

  if (!turns || turns.length === 0) {
    return (
      <div style={{ minHeight: 220, display: 'grid', placeItems: 'center', textAlign: 'center', color: 'var(--text-faint)' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5 }}>No live turn yet</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>Send a message below to run the real PM model from local env.</div>
        </div>
      </div>
    );
  }
  return (
    <div ref={ref} style={{ flex: 1, overflowY: 'auto', padding: '18px 24px 26px' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {turns.map((turn, index) => (
          <LocalLiveTurn
            key={turn.id}
            turn={turn}
            agents={agents}
            turnActions={turnActions}
            showPreview={index === 0}
          />
        ))}
      </div>
    </div>
  );
}

function LiveCenterHeader({ turn, agents, onOpenPanel }) {
  const result = turn?.result;
  const tasks = result?.plan?.tasks || [];
  const dispatchStatus = result?.dispatchStatus || (turn?.status === 'pending' ? 'running' : 'idle');
  const completed = dispatchStatus === 'completed';
  const failed = dispatchStatus === 'failed';
  const statusColor = completed ? 'var(--ok)' : failed ? 'var(--bad)' : 'var(--run)';
  return (
    <div style={{ flexShrink: 0, padding: '14px 24px', borderBottom: '1px solid var(--border)',
      background: 'var(--surface)', display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
        <Avatar agent={agents.orchestrator} size={30} ring={false} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 750, color: 'var(--text)' }}>Live agent pipeline</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 750,
              color: statusColor, background: alpha(statusColor, 12), borderRadius: 999, padding: '3px 9px' }}>
              {dispatchStatus === 'running' && <Spinner size={10} color={statusColor} />}
              {completed ? 'completed' : failed ? 'failed' : 'running'}
            </span>
          </div>
          <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            {tasks.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Send a message to start planning.</span>
            ) : tasks.map((task, i) => {
              const owner = agentForTask(task, agents);
              return (
                <React.Fragment key={task.id}>
                  {i > 0 && <Icon name="chevron" size={11} style={{ color: 'var(--text-faint)' }} />}
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 7px',
                    borderRadius: 6, background: tint(owner.color, 8), color: owner.color, fontSize: 11.5,
                    fontWeight: 700 }}>
                    <Avatar agent={owner} size={16} ring={false} />@{owner.mention || owner.role}
                  </span>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
      {result?.dispatchAdapter && (
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', flexShrink: 0 }}>
          adapter={result.dispatchAdapter}
        </span>
      )}
      {onOpenPanel && (
        <button onClick={onOpenPanel} title="Open inspector panel" style={{ display: 'inline-flex', alignItems: 'center',
          gap: 6, padding: '7px 11px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)',
          background: 'var(--surface-2)', color: 'var(--text-muted)', font: 'inherit', fontSize: 12,
          fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>
          <Icon name="layers" size={13} />Panel
        </button>
      )}
    </div>
  );
}

function LiveCenter({ turns, agents, turnActions, onOpenPanel }) {
  const latest = latestLiveTurn(turns);
  const visibleTurns = latest ? [latest] : turns;
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <LiveCenterHeader turn={latest} agents={agents} onOpenPanel={onOpenPanel} />
      <LocalLiveThread turns={visibleTurns} agents={agents} turnActions={turnActions} />
    </div>
  );
}

function agentForTask(task, agents) {
  if (task?.owner && agents[task.owner]) return agents[task.owner];
  const assignee = String(task?.assignee || '').replace(/^@/, '');
  if (agents[assignee]) return agents[assignee];
  return Object.values(agents).find((agent) => agent.role === assignee && !agent.pm) || agents.orchestrator;
}

const STAGE_STATUS_STYLE = {
  done: { color: 'var(--ok)', label: 'done' },
  active: { color: 'var(--accent)', label: 'running' },
  blocked: { color: 'var(--warn, #b8860b)', label: 'blocked' },
  failed: { color: 'var(--bad)', label: 'failed' },
  pending: { color: 'var(--text-faint)', label: 'pending' },
};

// The planner needs more detail before it can build. Render its questions as
// pick-one cards — a nocode user just clicks an option per question, then submits.
function ClarifyCard({ turn, onSubmit }) {
  const questions = turn.result?.clarifyQuestions || [];
  const [picks, setPicks] = useState({});
  const submitting = turn.clarifying;
  const allAnswered = questions.length > 0 && questions.every((q) => picks[q.id]);
  const submit = () => {
    if (!allAnswered || submitting) return;
    const answers = questions.map((q) => {
      const opt = q.options.find((o) => o.id === picks[q.id]);
      return { questionId: q.id, optionId: picks[q.id], label: opt?.label || picks[q.id] };
    });
    onSubmit(answers);
  };
  return (
    <div className="rt-rise" style={{ marginTop: 4, border: '1px solid var(--border)',
      borderLeft: '3px solid var(--accent)', borderRadius: 'var(--r-card)', background: 'var(--surface)',
      boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <Icon name="layers" size={15} style={{ color: 'var(--accent)' }} />
        <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text)' }}>A few quick questions before we build</div>
      </div>
      <div style={{ padding: '12px 14px', display: 'grid', gap: 16 }}>
        {questions.map((q) => (
          <div key={q.id} style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{q.question}</div>
            <div style={{ display: 'grid', gap: 7 }}>
              {q.options.map((opt) => {
                const active = picks[q.id] === opt.id;
                return (
                  <button key={opt.id} onClick={() => setPicks((p) => ({ ...p, [q.id]: opt.id }))}
                    disabled={submitting}
                    style={{ textAlign: 'left', display: 'grid', gap: 2, padding: '9px 12px', cursor: submitting ? 'default' : 'pointer',
                      borderRadius: 'var(--r-sm)', font: 'inherit',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      background: active ? alpha('var(--accent)', 10) : 'var(--surface-2)',
                      color: 'var(--text)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600 }}>
                      <span style={{ width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                        border: `2px solid ${active ? 'var(--accent)' : 'var(--text-faint)'}`,
                        background: active ? 'var(--accent)' : 'transparent', boxShadow: active ? 'inset 0 0 0 2px var(--surface)' : 'none' }} />
                      {opt.label}
                    </span>
                    {opt.description && (
                      <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 21, lineHeight: 1.4 }}>{opt.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {turn.clarifyError && (
          <div style={{ fontSize: 12, color: 'var(--bad)' }}>{turn.clarifyError}</div>
        )}
        <button onClick={submit} disabled={!allAnswered || submitting}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '10px 14px',
            borderRadius: 'var(--r-sm)', border: 'none', font: 'inherit', fontSize: 13, fontWeight: 600,
            cursor: !allAnswered || submitting ? 'default' : 'pointer',
            background: !allAnswered || submitting ? 'var(--surface-3)' : 'var(--accent)',
            color: !allAnswered || submitting ? 'var(--text-faint)' : '#fff' }}>
          {submitting ? <><Spinner size={13} color="var(--text-faint)" /> Planning…</> : <><Icon name="check" size={14} /> Start building</>}
        </button>
      </div>
    </div>
  );
}

function LocalLiveTurn({ turn, agents, turnActions, showPreview }) {
  const completed = turn.result?.dispatchStatus === 'completed';
  const failed = turn.result?.dispatchStatus === 'failed';
  const running = turn.result?.dispatchStatus === 'running';
  const stopping = turn.result?.dispatchStage === 'interrupting' || turn.interrupting;
  const interrupted = failed && turn.result?.dispatchError === 'interrupted_by_user';
  const artifacts = turn.result?.artifacts || [];
  const previewArtifact = artifacts.find((artifact) => artifact.kind === 'preview');
  return (
    <>
      <UserMsg text={turn.message} />
      <div className="rt-rise" style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
        <Avatar agent={agents.orchestrator} size={28} ring={false} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--pm)' }}>Roundtable</span>
            <span className="mono" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>agent chain</span>
          </div>
          {turn.status === 'pending' && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13.5 }}>
              <Spinner size={13} color="var(--text-muted)" /> running agents…
            </div>
          )}
          {turn.status === 'error' && (
            <div style={{ padding: '10px 12px', borderRadius: 'var(--r-sm)', background: alpha('var(--bad)', 12),
              color: 'var(--bad)', fontSize: 13, borderLeft: '2px solid var(--bad)' }}>
              {turn.error}
            </div>
          )}
          {turn.result?.needsClarification && (
            <ClarifyCard
              turn={turn}
              onSubmit={(answers) => turnActions?.clarify && turnActions.clarify(turn.id, answers)}
            />
          )}
          {turn.result && !turn.result.needsClarification && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13.5, lineHeight: 1.55 }}>
              <AgentChainCard
                plan={turn.result.plan}
                records={turn.result.dispatch}
                artifacts={artifacts}
                agents={agents}
                dispatchStatus={turn.result.dispatchStatus}
                dispatchAdapter={turn.result.dispatchAdapter}
                workspacePath={turn.result.dispatchWorkspacePath || turn.result.workspacePath}
              />
              {running && turnActions && (
                <LocalStopBar
                  stopping={stopping}
                  interruptError={turn.interruptError}
                  onStop={() => turnActions.interrupt(turn.id)}
                />
              )}
              {interrupted && !turn.discarded && (
                <LocalInterruptedCard
                  turn={turn}
                  agents={agents}
                  artifacts={artifacts}
                  onResume={turnActions ? () => turnActions.redispatch(turn.id) : null}
                  onDiscard={turnActions ? () => turnActions.discard(turn.id) : null}
                  onHandoff={null}
                />
              )}
              {turn.result.workflow && turn.result.workflowRun ? (
                <StageCards
                  workflow={turn.result.workflow}
                  workflowRun={turn.result.workflowRun}
                  artifacts={artifacts}
                  agents={agents}
                  dispatchStatus={turn.result.dispatchStatus}
                />
              ) : ((completed || failed || running || interrupted) && !(interrupted && turn.discarded) && (
                <LocalResultCard
                  artifacts={artifacts}
                  dispatchStatus={turn.result.dispatchStatus}
                  dispatchAdapter={turn.result.dispatchAdapter}
                  dispatchStage={turn.result.dispatchStage}
                  workspacePath={turn.result.dispatchWorkspacePath || turn.result.workspacePath}
                  previewArtifact={showPreview && !interrupted ? previewArtifact : null}
                  agents={agents}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function agentForSeat(agents, agentId, role) {
  return (
    agents[agentId] ||
    Object.values(agents).find((a) => a.role === role) ||
    agents.orchestrator
  );
}

// Per-stage card: as the workflow advances, each stage that starts gets its own
// card showing who's on it, live status, and the artifacts they produced. This
// is the "new stage → new card" timeline (not a tab/strip).
function StageCard({ stage, stageRun, artifacts, agents }) {
  const status = stageRun?.status || 'pending';
  const sty = STAGE_STATUS_STYLE[status] || STAGE_STATUS_STYLE.pending;
  const roles = new Set(
    stage.seats.filter((s) => s.ref.kind === 'role').map((s) => s.ref.role),
  );
  const stageArtifacts = artifacts.filter((a) => roles.has(a.ownerAgentId));
  return (
    <div className="rt-rise" style={{ marginTop: 10, border: `1px solid ${alpha(sty.color, 35)}`,
      borderRadius: 'var(--r-card)', background: 'var(--surface)', boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 13px',
        borderBottom: '1px solid var(--border)', background: alpha(sty.color, 6) }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, borderRadius: 6,
          background: alpha(sty.color, 16), color: sty.color }}>
          {status === 'active' ? <Spinner size={12} color={sty.color} />
            : status === 'done' ? <Icon name="check" size={13} />
            : <Icon name={stage.icon || 'layers'} size={13} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{stage.name}</div>
          {stage.desc && <div style={{ fontSize: 11, color: 'var(--text-faint)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stage.desc}</div>}
        </div>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: sty.color, padding: '2px 8px', borderRadius: 999,
          background: alpha(sty.color, 14) }}>{sty.label}</span>
      </div>
      <div style={{ padding: '10px 13px', display: 'grid', gap: 8 }}>
        {(stageRun?.seatRuns || []).map((seatRun, i) => {
          const role = stage.seats[i]?.ref?.kind === 'role' ? stage.seats[i].ref.role : 'user';
          const ag = agentForSeat(agents, seatRun.agentId, role);
          const ss = STAGE_STATUS_STYLE[seatRun.status] || STAGE_STATUS_STYLE.pending;
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Avatar agent={ag} size={22} ring={false} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: ag.color }}>{ag.displayName}</span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>@{ag.role || role}</span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: 11, color: ss.color, fontWeight: 600 }}>
                {seatRun.status === 'active' ? <Spinner size={10} color={ss.color} />
                  : seatRun.status === 'done' ? <Icon name="check" size={11} /> : null}
                {ss.label}
              </span>
            </div>
          );
        })}
        {stageArtifacts.length > 0 && (
          <div style={{ display: 'grid', gap: 6, marginTop: 2 }}>
            {stageArtifacts.map((a) => (
              <ExpandableArtifact key={`${a.id}-${a.version}`} artifact={a} owner={agentForArtifact(a, agents)} />
            ))}
          </div>
        )}
        {status === 'active' && stageArtifacts.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic' }}>Working…</div>
        )}
      </div>
    </div>
  );
}

function LocalStopBar({ stopping, interruptError, onStop }) {
  return (
    <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
      border: '1px solid var(--border)', borderRadius: 'var(--r-card)', background: 'var(--surface)',
      boxShadow: 'var(--shadow-card)' }}>
      <Spinner size={14} color="var(--run)" />
      <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-muted)' }}>
        {stopping ? 'Stopping — interrupting every active agent session…' : 'Agents are working on this run.'}
        {interruptError && (
          <span style={{ color: 'var(--bad)', marginLeft: 8 }}>{interruptError}</span>
        )}
      </div>
      <button onClick={onStop} disabled={stopping} title="Stop the run — interrupts every active agent session"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px',
          borderRadius: 'var(--r-sm)', border: 'none', cursor: stopping ? 'default' : 'pointer',
          background: stopping ? 'var(--surface-3)' : 'var(--bad)', color: stopping ? 'var(--text-faint)' : '#fff',
          font: 'inherit', fontSize: 12.5, fontWeight: 750, minHeight: 30, flexShrink: 0 }}>
        <span style={{ width: 9, height: 9, borderRadius: 2, background: 'currentColor', display: 'inline-block' }} />
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
    </div>
  );
}

function LocalInterruptedCard({ turn, agents, artifacts, onResume, onDiscard, onHandoff }) {
  const plan = turn.result?.plan;
  const records = turn.result?.dispatch || [];
  const taskById = new Map((plan?.tasks || []).map((task) => [task.id, task]));
  const ownerFor = (task) => {
    if (task?.owner && agents[task.owner]) return agents[task.owner];
    const target = (task?.assignee || '').replace(/^@/, '');
    if (agents[target]) return agents[target];
    return Object.values(agents).find((a) => a.role === target && !a.pm) || agents.orchestrator;
  };
  const ranTasks = records.map((record) => {
    const task = taskById.get(record.taskId);
    return {
      taskId: record.taskId,
      title: task?.title || record.taskId,
      owner: ownerFor(task),
      status: record.status,
    };
  });
  const notStarted = (plan?.tasks || []).filter((task) => !records.some((r) => r.taskId === task.id));
  const quickAction = (label, icon, onClick, primary) => onClick && (
    <button onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 11px',
      borderRadius: 'var(--r-sm)', border: primary ? 'none' : '1px solid var(--border)', cursor: 'pointer',
      background: primary ? 'var(--accent)' : 'var(--surface)', color: primary ? '#fff' : 'var(--text)',
      font: 'inherit', fontSize: 12.5, fontWeight: 700, minHeight: 30 }}>
      <Icon name={icon} size={13} />{label}
    </button>
  );
  return (
    <div style={{ marginTop: 12, border: '1px solid var(--border)', borderLeft: '3px solid var(--warn)',
      borderRadius: 'var(--r-card)', background: 'var(--surface)', boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <Icon name="pause" size={15} style={{ color: 'var(--warn)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 750, fontSize: 14, color: 'var(--text)' }}>Run interrupted</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
            {ranTasks.length} task{ranTasks.length === 1 ? '' : 's'} ran · {notStarted.length} not started · {artifacts.length} partial artifact{artifacts.length === 1 ? '' : 's'}
          </div>
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--warn)', padding: '3px 8px', borderRadius: 999,
          background: alpha('var(--warn)', 14), fontWeight: 750 }}>stopped by you</span>
      </div>
      <div style={{ padding: '10px 14px', display: 'grid', gap: 7 }}>
        {ranTasks.map((entry) => (
          <div key={entry.taskId} style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <Avatar agent={entry.owner} size={22} />
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>{entry.taskId}</span>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.title}
            </span>
            <span className="mono" style={{ fontSize: 10.5, color: entry.status === 'completed' ? 'var(--ok)' : 'var(--warn)' }}>
              {entry.status === 'completed' ? 'finished' : 'stopped mid-task'}
            </span>
          </div>
        ))}
        {notStarted.length > 0 && (
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            never started: {notStarted.map((task) => task.id).join(', ')}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px 13px', flexWrap: 'wrap', borderTop: '1px solid var(--border)' }}>
        {quickAction('Resume', 'play', onResume, true)}
        {quickAction('Discard partial', 'x', onDiscard, false)}
        {quickAction('Hand off to different agent', 'send', onHandoff, false)}
      </div>
    </div>
  );
}

// The stage timeline for one workflow-driven turn — renders a card per stage
// that has started, in workflow order. While the dispatch is still running the
// store only holds the initial all-pending projection, so we synthesize an
// "active" marker on the first unfinished stage to keep the run from looking
// frozen until completion.
function StageCards({ workflow, workflowRun, artifacts, agents, dispatchStatus }) {
  if (!workflow || !workflowRun) return null;
  const stages = workflow.stages.filter(
    (s) => s.kind !== 'intake' && (s.seats?.length ?? 0) > 0,
  );
  const running = dispatchStatus === 'running';
  const firstUnfinishedId = stages.find(
    (s) => (workflowRun.stageStates?.[s.id]?.status || 'pending') !== 'done',
  )?.id;

  const visible = stages.filter((s) => {
    const status = workflowRun.stageStates?.[s.id]?.status || 'pending';
    if (status !== 'pending') return true;
    return running && s.id === firstUnfinishedId;
  });
  if (visible.length === 0) return null;

  return (
    <div style={{ marginTop: 4 }}>
      {visible.map((stage) => {
        let stageRun = workflowRun.stageStates?.[stage.id];
        const status = stageRun?.status || 'pending';
        if (running && status === 'pending' && stage.id === firstUnfinishedId) {
          stageRun = {
            ...(stageRun || {}),
            status: 'active',
            seatRuns: (stageRun?.seatRuns || stage.seats.map((seat) => ({
              agentId: seat.ref.kind === 'role' ? seat.ref.agentId ?? seat.ref.role : 'user',
              status: 'pending',
              artifactIds: [],
            }))).map((sr) => ({ ...sr, status: sr.status === 'done' ? 'done' : 'active' })),
          };
        }
        return (
          <StageCard
            key={stage.id}
            stage={stage}
            stageRun={stageRun}
            artifacts={artifacts}
            agents={agents}
          />
        );
      })}
    </div>
  );
}

function AgentChainCard({ plan, records, artifacts, agents, dispatchStatus, dispatchAdapter, workspacePath }) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const visibleRecords = Array.isArray(records) ? records : [];
  const statusColor = dispatchStatus === 'completed'
    ? 'var(--ok)'
    : dispatchStatus === 'failed'
      ? 'var(--bad)'
      : 'var(--run)';
  const ownerFor = (task, record) => {
    if (task?.owner && agents[task.owner]) return agents[task.owner];
    if (record?.agentId && agents[record.agentId]) return agents[record.agentId];
    const target = String(task?.assignee || record?.agentId || '').replace(/^@/, '');
    if (agents[target]) return agents[target];
    return Object.values(agents).find((agent) => agent.role === target && !agent.pm) || agents.orchestrator;
  };
  const artifactFor = (taskId) => artifacts.find((artifact) => artifact.id.startsWith(`${taskId}_`));

  return (
    <div style={{ marginTop: 6, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: statusColor, fontSize: 12.5, fontWeight: 700 }}>
        {dispatchStatus === 'running' ? <Spinner size={12} color={statusColor} /> : <Icon name={dispatchStatus === 'failed' ? 'x' : 'check'} size={13} />}
        <span>{dispatchStatus === 'completed' ? 'run complete' : dispatchStatus === 'failed' ? 'run failed' : 'running'}</span>
        {dispatchAdapter && <span className="mono" style={{ color: 'var(--text-faint)', fontWeight: 500 }}>via {dispatchAdapter}</span>}
      </div>
      {visibleRecords.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Waiting for the first agent output.</div>
      ) : visibleRecords.map((record) => {
        const task = taskById.get(record.taskId);
        const owner = ownerFor(task, record);
        const artifact = artifactFor(record.taskId);
        return (
          <div key={record.taskId} style={{ borderLeft: `2px solid ${alpha(owner.color, 60)}`, paddingLeft: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Avatar agent={owner} size={24} ring={false} />
              <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{owner.displayName}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>@{owner.mention || owner.agentId || owner.role}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: record.status === 'failed' ? 'var(--bad)' : 'var(--ok)', fontWeight: 700 }}>
                {record.status}
              </span>
            </div>
            {task?.title && (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: artifact ? 8 : 0 }}>{task.title}</div>
            )}
            {artifact ? (
              <ExpandableArtifact artifact={artifact} owner={owner} />
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic' }}>No output captured.</div>
            )}
          </div>
        );
      })}
      {workspacePath && (
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          workspace: {workspacePath}
        </div>
      )}
    </div>
  );
}

// One agent's deliverable, click to expand and read what they actually produced
// — turns the result list from a black box into reviewable output.
function ExpandableArtifact({ artifact, owner }) {
  const [open, setOpen] = useState(false);
  const content = artifact.preview || '';
  const isHtml = artifact.kind === 'html' || artifact.kind === 'preview';
  return (
    <div style={{ borderRadius: 'var(--r-sm)', background: tint(owner.color, 7),
      border: `1px solid ${alpha(owner.color, 22)}`, overflow: 'hidden' }}>
      <button onClick={() => setOpen((v) => !v)} style={{ width: '100%', display: 'grid',
        gridTemplateColumns: 'auto auto auto 1fr auto', gap: 9, alignItems: 'center', padding: '8px 10px',
        background: 'transparent', border: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
        <Icon name={open ? 'chevdown' : 'chevron'} size={12} style={{ color: owner.color }} />
        <Avatar agent={owner} size={20} ring={false} />
        <Icon name={artifact.kind === 'preview' ? 'eye' : artifact.kind === 'markdown' ? 'clip' : 'code'} size={14}
          style={{ color: owner.color }} />
        <span className="mono" style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifact.title}</span>
        <span style={{ fontSize: 11, color: owner.color, fontWeight: 700 }}>@{owner.role || artifact.ownerAgentId}</span>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${alpha(owner.color, 22)}`, background: 'var(--bg)', padding: '10px 12px',
          maxHeight: 320, overflowY: 'auto' }}>
          {!content
            ? <div style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic' }}>No content captured for this artifact.</div>
            : isHtml
            ? <iframe title={artifact.title} srcDoc={content} sandbox="allow-scripts"
                style={{ width: '100%', height: 280, border: 'none', background: '#fff', borderRadius: 6 }} />
            : <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text)' }}><Md text={content} /></div>}
        </div>
      )}
    </div>
  );
}

function LocalResultCard({ artifacts, dispatchStatus, dispatchAdapter, dispatchStage, workspacePath, previewArtifact, agents }) {
  const completed = dispatchStatus === 'completed';
  const codeCount = artifacts.filter((artifact) => artifact.kind === 'code').length;
  const reviewCount = artifacts.filter((artifact) => artifact.ownerAgentId === 'reviewer').length;
  const statusColor = completed ? 'var(--ok)' : dispatchStatus === 'failed' ? 'var(--bad)' : 'var(--run)';
  return (
    <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 'var(--r-card)',
      background: 'var(--surface)', boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
        borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <Icon name={completed ? 'check' : 'code'} size={15} style={{ color: statusColor }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 750, fontSize: 14, color: 'var(--text)' }}>
            {completed ? 'Result ready' : 'Result in progress'}
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
            {artifacts.length} artifacts · {codeCount} code · {reviewCount} review · adapter={dispatchAdapter || 'local-dispatch'} · next={dispatchStage || 'done'}
          </div>
        </div>
        <span style={{ fontSize: 11.5, color: statusColor, padding: '3px 8px', borderRadius: 999,
          background: alpha(statusColor, 14), fontWeight: 750 }}>
          {dispatchStatus || 'not_started'}
        </span>
      </div>
      {previewArtifact && (
        <div style={{ background: 'var(--surface-3)', padding: 12 }}>
          <div style={{ borderRadius: 'var(--r-sm)', overflow: 'hidden', border: '1px solid var(--border)',
            background: '#fff', boxShadow: 'var(--shadow-card)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px',
              background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
              {['#e5687a', '#e6a23c', '#4cc38a'].map((color) => (
                <span key={color} style={{ width: 9, height: 9, borderRadius: '50%', background: color, opacity: .8 }} />
              ))}
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 6 }}>
                {previewArtifact.title}
              </span>
            </div>
            <iframe title={previewArtifact.title} srcDoc={previewArtifact.preview} sandbox="allow-scripts allow-forms allow-modals"
              style={{ width: '100%', height: 360, border: 'none', display: 'block', background: '#fff' }} />
          </div>
        </div>
      )}
      <div style={{ padding: '11px 14px', display: 'grid', gap: 8 }}>
        {artifacts.slice(0, 8).map((artifact) => (
          <ExpandableArtifact
            key={`${artifact.id}-${artifact.version}`}
            artifact={artifact}
            owner={agentForArtifact(artifact, agents)}
          />
        ))}
        {workspacePath && (
          <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>workspace: {workspacePath}</div>
        )}
      </div>
    </div>
  );
}

// #12: live TodoList — per-task status derived from approval + dispatch records,
// so one card transitions pending → running → done/failed in place as the run polls.
const TODO_STATUS_STYLE = {
  pending: { color: 'var(--text-faint)', label: 'pending', icon: null },
  running: { color: 'var(--run, var(--accent))', label: 'running', icon: 'spinner' },
  completed: { color: 'var(--ok)', label: 'done', icon: 'check' },
  failed: { color: 'var(--bad)', label: 'failed', icon: 'x' },
};

function todoStatusFor(task, record, approved, dispatchStatus) {
  if (record?.status === 'completed' || record?.status === 'failed') return record.status;
  if (record?.status === 'running') return 'running';
  if (approved && dispatchStatus === 'running') return 'running';
  return 'pending';
}

function TodoRow({ task, owner, record, status, last }) {
  const [open, setOpen] = useState(false);
  const sty = TODO_STATUS_STYLE[status];
  const events = (record?.events || []).filter((e) => e.type === 'thinking_delta' || e.type === 'tool_use');
  const deps = Array.isArray(task?.deps) ? task.deps : [];
  const assignee = task?.assignee || '@planner';
  return (
    <div style={{ borderBottom: last ? 'none' : '1px solid var(--border)' }}>
      <button onClick={() => setOpen((v) => !v)} title="Expand task activity"
        style={{ width: '100%', display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 0',
          background: 'none', border: 'none', font: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 18, height: 18, marginTop: 3,
          borderRadius: 5, flexShrink: 0, background: alpha(sty.color, status === 'pending' ? 8 : 16), color: sty.color }}>
          {sty.icon === 'spinner' ? <Spinner size={11} color={sty.color} />
            : sty.icon ? <Icon name={sty.icon} size={11} />
            : <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', opacity: .6 }} />}
        </span>
        <Avatar agent={owner} size={24} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>{task.id}</span>
            <span style={{ fontSize: 13.5, fontWeight: 600,
              color: status === 'completed' ? 'var(--text-muted)' : 'var(--text)',
              textDecorationLine: status === 'completed' ? 'line-through' : 'none',
              textDecorationColor: alpha('var(--ok)', 50) }}>{task.title}</span>
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 3 }}>
            {assignee}{task?.parallel ? ' · parallel' : ''}{deps.length ? ` · waits on ${deps.join(', ')}` : ''}
          </div>
        </div>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: sty.color, padding: '2px 8px', borderRadius: 999,
          background: alpha(sty.color, 13), flexShrink: 0, marginTop: 3 }}>{sty.label}</span>
        <Icon name={open ? 'chevdown' : 'chevron'} size={11} style={{ color: 'var(--text-faint)', marginTop: 6, flexShrink: 0 }} />
      </button>
      {open && (
        <div style={{ margin: '0 0 9px 28px', padding: '8px 11px', borderRadius: 'var(--r-sm)',
          background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          {events.length === 0
            ? <div style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic' }}>
                {status === 'pending' ? 'Not started yet.' : 'No activity captured.'}</div>
            : events.slice(0, 6).map((e, i) => (
                <div key={i} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 12,
                  color: 'var(--text-muted)', padding: '2px 0' }}>
                  <Icon name={e.type === 'tool_use' ? 'wrench' : 'sparkle'} size={11}
                    style={{ color: 'var(--text-faint)', marginTop: 2, flexShrink: 0 }} />
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.type === 'tool_use' ? `${e.name}(${(e.input?.path || e.input?.title || '')})` : e.delta}
                  </span>
                </div>
              ))}
        </div>
      )}
    </div>
  );
}

function LocalPlanCard({ plan, intake, agents, approvalStatus, approving, approvalError, onApprove, dispatch, dispatchStatus }) {
  const [showPlan, setShowPlan] = useState(false);
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const safeIntake = intake || { intentType: 'build', risk: 'medium', clarity: 'medium' };
  const ownerFor = (task) => {
    if (task?.owner && agents[task.owner]) return agents[task.owner];
    const target = (task?.assignee || '@planning').replace(/^@/, '');
    if (agents[target]) return agents[target];
    return Object.values(agents).find((a) => a.role === target && !a.pm) || agents.orchestrator;
  };
  const approved = approvalStatus === 'approved';
  const recordFor = (taskId) => (dispatch || []).find((r) => r.taskId === taskId);
  const doneCount = tasks.filter((t) =>
    todoStatusFor(t, recordFor(t.id), approved, dispatchStatus) === 'completed').length;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-card)', background: 'var(--surface)',
      boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <Icon name="layers" size={15} style={{ color: 'var(--accent)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            Plan
            <span className="mono tnum" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-faint)', marginLeft: 8 }}>
              {doneCount}/{tasks.length} done
            </span>
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
            intent={safeIntake.intentType} · risk={safeIntake.risk} · clarity={safeIntake.clarity}
          </div>
        </div>
        <span style={{ fontSize: 11.5, color: approved ? 'var(--ok)' : 'var(--warn)', padding: '3px 8px', borderRadius: 999,
          background: alpha(approved ? 'var(--ok)' : 'var(--warn)', 14), fontWeight: 700 }}>
          {approved ? 'approved' : 'awaiting approval'}
        </span>
        {!approved && (
          <button onClick={onApprove} disabled={approving} title="Approve this plan and let the run continue"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '7px 11px', borderRadius: 'var(--r-sm)', border: 'none',
              cursor: approving ? 'default' : 'pointer', background: approving ? 'var(--surface-3)' : 'var(--accent)',
              color: approving ? 'var(--text-faint)' : '#fff', font: 'inherit', fontSize: 12.5,
              fontWeight: 700, minHeight: 30, flexShrink: 0 }}>
            {approving ? <Spinner size={13} color="var(--text-faint)" /> : <Icon name="check" size={13} />}
            Approve
          </button>
        )}
      </div>
      {approvalError && (
        <div style={{ padding: '8px 14px', background: alpha('var(--bad)', 10), color: 'var(--bad)', fontSize: 12.5,
          borderBottom: '1px solid var(--border)' }}>
          {approvalError}
        </div>
      )}
      <div style={{ padding: '4px 14px 6px' }}>
        {tasks.map((task, i) => {
          const record = recordFor(task.id);
          return (
            <TodoRow
              key={task.id}
              task={task}
              owner={ownerFor(task)}
              record={record}
              status={todoStatusFor(task, record, approved, dispatchStatus)}
              last={i === tasks.length - 1}
            />
          );
        })}
      </div>
      <button onClick={() => setShowPlan((v) => !v)} style={{ width: '100%', display: 'flex', alignItems: 'center',
        gap: 6, padding: '8px 14px', background: 'var(--surface-2)', border: 'none', borderTop: '1px solid var(--border)',
        font: 'inherit', fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer' }}>
        <Icon name={showPlan ? 'chevdown' : 'chevron'} size={11} />
        {showPlan ? 'Hide plan' : 'Show plan'}
      </button>
      {showPlan && (
        <pre className="mono" style={{ margin: 0, padding: '10px 14px', fontSize: 11, lineHeight: 1.55,
          color: 'var(--text-muted)', background: 'var(--bg)', borderTop: '1px solid var(--border)',
          overflowX: 'auto', maxHeight: 260, overflowY: 'auto' }}>
          {JSON.stringify(plan, null, 2)}
        </pre>
      )}
    </div>
  );
}

/* ---- transport ------------------------------------------------------------ */
function Transport({ scene }) {
  const pct = Math.min(100, (scene.clock / RT.SCENE_DURATION) * 100);
  const done = scene.clock >= RT.SCENE_DURATION;
  const seek = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    scene.setClock(ratio * RT.SCENE_DURATION);
    scene.setPlaying(false);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <button onClick={scene.toggle} title={scene.playing ? 'Pause' : done ? 'Replay' : 'Play'} style={{
        display: 'grid', placeItems: 'center', width: 32, height: 32, borderRadius: '50%', cursor: 'pointer',
        border: 'none', background: 'var(--accent)', color: '#fff' }}>
        <Icon name={scene.playing ? 'pause' : done ? 'replay' : 'play'} size={15} />
      </button>
      <div onClick={seek} title="Scrub" style={{ width: 150, padding: '8px 0', cursor: 'pointer' }}>
        <div style={{ height: 4, borderRadius: 4, background: 'var(--surface-3)', overflow: 'hidden' }}>
          <div style={{ width: pct + '%', height: '100%', background: 'var(--accent)', transition: 'width .1s linear' }} />
        </div>
      </div>
      <span className="mono tnum" style={{ fontSize: 11, color: 'var(--text-faint)', minWidth: 30 }}>
        {(scene.clock / 1000).toFixed(0)}s</span>
    </div>
  );
}

/* ---- ThreadHeader --------------------------------------------------------- */
function ThreadHeader({ agents, scene }) {
  const parts = ['atlas', 'beam', 'vera'];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 26px',
      borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden',
            textOverflow: 'ellipsis' }}>Waitlist landing page</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
            flexShrink: 0,
            color: 'var(--run)', padding: '2px 8px', borderRadius: 'var(--r-chip)', background: alpha('var(--run)', 12) }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--run)' }} /> the main table
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4 }}>
          <Avatar agent={agents.orchestrator} size={18} ring={false} />
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>facilitated by PM ·</span>
          <div style={{ display: 'flex' }}>
            {parts.map((p, i) => <span key={p} style={{ marginLeft: i ? -6 : 0, zIndex: 3 - i }}>
              <Avatar agent={agents[p]} size={20} /></span>)}
          </div>
        </div>
      </div>
      <Transport scene={scene} />
    </div>
  );
}

/* ---- Gallery -------------------------------------------------------------- */
function planVariant(which) {
  const t = RT.PLAN.tasks.map(x => ({ ...x }));
  if (which === 'pending') { /* all pending */ }
  if (which === 'mixed') { t[0].status = 'completed'; t[1].status = 'running'; }
  if (which === 'done') t.forEach(x => x.status = 'completed');
  if (which === 'failed') { t[0].status = 'completed'; t[1].status = 'failed'; t[2].status = 'pending'; }
  return { ...RT.PLAN, tasks: t };
}
function GalleryCard({ title, note, children, wide }) {
  return (
    <div style={{ gridColumn: wide ? '1 / -1' : 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>{title}</h3>
        {note && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{note}</span>}
      </div>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)',
        padding: 18, boxShadow: 'var(--shadow-card)' }}>{children}</div>
    </div>
  );
}
function Gallery({ agents, onOpenArtifact }) {
  const [pv, setPv] = useState('mixed');
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 60px' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 700, letterSpacing: '-.01em' }}>Component gallery</h2>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14, maxWidth: 620 }}>
            The four Batch-1 components in isolation, with their states. Each maps 1:1 to the §4 prop
            contracts — colors are driven entirely by each agent’s <code className="mono">color</code> prop.
          </p>
        </div>

        {/* legend */}
        <GalleryCard title="Per-agent color ownership" note="the signature look" wide>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            {Object.values(agents).map(a => (
              <div key={a.agentId} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <Avatar agent={a} size={30} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{a.displayName} {a.pm && '— muted'}</div>
                  <RoleTag agent={a} />
                </div>
              </div>
            ))}
          </div>
        </GalleryCard>

        <div style={{ height: 28 }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 28 }}>
          <GalleryCard title="Live TodoList card" note="#12">
            <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
              {['pending', 'mixed', 'done', 'failed'].map(k => (
                <Chip key={k} active={pv === k} onClick={() => setPv(k)} color="var(--accent)">{k}</Chip>
              ))}
            </div>
            <TodoListCard plan={planVariant(pv)} agents={agents} onRetry={() => {}} />
          </GalleryCard>

          <GalleryCard title="HandoffCard" note="#13 · click to expand">
            <HandoffCard ho={RT.HANDOFF} agents={agents} />
          </GalleryCard>

          <GalleryCard title="Artifact — file" note="#3">
            <ArtifactRenderer art={RT.ARTIFACTS.landing} agents={agents} onOpen={onOpenArtifact} />
          </GalleryCard>

          <GalleryCard title="Artifact — diff (multi-author)" note="#3">
            <ArtifactRenderer art={RT.ARTIFACTS.diff} agents={agents} onOpen={onOpenArtifact} />
          </GalleryCard>

          <GalleryCard title="Artifact — preview" note="#3" wide>
            <ArtifactRenderer art={RT.ARTIFACTS.preview} agents={agents} onOpen={onOpenArtifact} />
          </GalleryCard>

          <GalleryCard title="Breakout chip" note="a door, not a toggle — click it" wide>
            <BreakoutChip data={RT.SCRIPT.find(b => b.kind === 'breakout')} agents={agents} />
          </GalleryCard>
        </div>
      </div>
    </div>
  );
}

/* ---- top-bar segmented --------------------------------------------------- */
function MiniSeg({ value, options, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)',
      border: '1px solid var(--border)' }}>
      {options.map(o => (
        <button key={o.v} onClick={() => onChange(o.v)} title={o.label} style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 'calc(var(--r-sm) - 2px)',
          border: 'none', cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: 500,
          background: value === o.v ? 'var(--surface)' : 'transparent',
          color: value === o.v ? 'var(--text)' : 'var(--text-muted)',
          boxShadow: value === o.v ? 'var(--shadow-card)' : 'none', transition: 'all .15s ease' }}>
          {o.icon && <Icon name={o.icon} size={14} />}{o.label}
        </button>
      ))}
    </div>
  );
}

/* ---- TopBar --------------------------------------------------------------- */
function TopBar({ t, setTweak, view, setView }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px', height: 54,
      borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
      <MiniSeg value={view} onChange={setView} options={[
        { v: 'roundtable', label: 'Roundtable', icon: 'layers' },
        { v: 'workflow', label: 'Workflow', icon: 'sparkle' }]} />
      <div style={{ flex: 1 }} />
      <button onClick={() => setTweak('theme', t.theme === 'light' ? 'dark' : 'light')} title="Toggle theme"
        style={{ ...iconBtn, background: 'var(--surface-2)' }}>
        <Icon name={t.theme === 'light' ? 'moon' : 'sun'} size={16} />
      </button>
    </div>
  );
}

/* ---- Transcript sheet (clean, full scroll, no jank) ---------------------- */
function TranscriptSheet({ scene, agents, onOpenArtifact }) {
  const ref = useRef(null);
  const revealed = RT.SCRIPT.filter((b) => b.at <= scene.clock);
  useEffect(() => {
    if (scene.playing && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [revealed.length, scene.playing, scene.clock >= RT.SCENE_DURATION]);
  const line = (b) => {
    if (b.kind === 'user') return (
      <div key={b.id} style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ maxWidth: '80%', padding: '8px 12px', borderRadius: '12px 12px 3px 12px', background: 'var(--accent)',
          color: '#fff', fontSize: 13, lineHeight: 1.45 }}>{b.text}</div>
      </div>
    );
    if (b.kind === 'agent') {
      const a = agents[b.agentId];
      const text = b.events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
      const art = b.events.find((e) => e.type === 'artifact');
      return (
        <div key={b.id} style={{ display: 'flex', gap: 10 }}>
          {a.pm ? <div style={{ width: 24, textAlign: 'center', fontSize: 13, opacity: .7 }}>•</div> : <Avatar agent={a} size={24} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: a.pm ? 'var(--pm)' : a.color }}>{a.displayName}</span>
              {!a.pm && <RoleTag agent={a} />}
            </div>
            <div style={{ fontSize: 13, color: a.pm ? 'var(--text-muted)' : 'var(--text)', lineHeight: 1.5, marginTop: 2 }}>{text}</div>
            {art && RT.ARTIFACTS[art.artifactId] && (
              <button onClick={() => onOpenArtifact(RT.ARTIFACTS[art.artifactId])} style={{ marginTop: 6, display: 'inline-flex',
                alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)',
                background: 'var(--surface)', color: 'var(--text-muted)', font: 'inherit', fontSize: 11.5, cursor: 'pointer' }}>
                <Icon name="clip" size={12} /><span className="mono">{RT.ARTIFACTS[art.artifactId].title.split('/').pop()}</span>
              </button>
            )}
          </div>
        </div>
      );
    }
    const meta = { plan: ['layers', 'Plan posted — 3 tasks on the whiteboard'], handoff: ['door', 'Hand-off dispatched → @implementer'],
      breakout: ['door', `Breakout — ${b.a && agents[b.a]?.displayName} & ${b.b && agents[b.b]?.displayName}, ${b.turns} turns`],
      aggregate: ['check', 'Round complete — 3 artifacts shipped'] }[b.kind];
    if (!meta) return null;
    return (
      <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '2px 0', color: 'var(--text-faint)' }}>
        <Icon name={meta[0]} size={13} /><span style={{ fontSize: 12 }}>{meta[1]}</span>
      </div>
    );
  };
  return (
    <div ref={ref} style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {revealed.map(line)}
      </div>
    </div>
  );
}

/* ---- Now-dock (roundtable view) ------------------------------------------ */
// AI-ish workflow fit: a local heuristic (main has no backend ai.recommendWorkflow).
// Returns a better-fit builtin workflow for the active task, or null.
function recommendWorkflow(task, workflows, currentId) {
  const t = (task || '').toLowerCase();
  if (t.length < 4) return null;
  let pick = 'wf-fullstack';
  let reason = 'A full build → review → ship loop fits a feature like this.';
  if (/research|brief|spec|investigat|explore|compare|analy|gather|source|study|audit/.test(t)) {
    pick = 'wf-research'; reason = 'This reads like research — gather → synthesize → brief fits better.';
  } else if (/landing|marketing|convert|sign\s?up|wait\s?list|campaign|\bseo\b|hero|pricing page/.test(t)) {
    pick = 'wf-growth'; reason = 'This is a marketing page — brief → build → QA → launch fits better.';
  }
  const wf = (workflows || []).find((w) => w.id === pick);
  if (!wf || pick === currentId) return null;
  return { id: wf.id, name: wf.name, reason };
}

function Dock({ st, agents, scene, onAction, onOpenChat, onOpenWorkflow, onSend, liveStatus, rec, onUseWorkflow, onDismissRec, workflow, workflowRun }) {
  let dotColor = 'var(--text-faint)', body;
  if (st.decision) {
    const ag = agents[st.decision.agentId];
    dotColor = ag.color;
    body = (
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13.5 }}>
          <span style={{ fontSize: 15 }}>✋</span>
          <b style={{ color: ag.color }}>{ag.displayName}</b> needs your call:&nbsp;
          <span>{st.decision.question}</span>
        </span>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {st.decision.options.map((o, i) => (
            <button key={o.id} onClick={() => onAction('decide:' + o.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 'var(--r-sm)', font: 'inherit', fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
              border: i === 0 ? 'none' : '1px solid var(--border)', background: i === 0 ? 'var(--accent)' : 'var(--surface)',
              color: i === 0 ? '#fff' : 'var(--text)' }}>
              {o.label}{o.hint && <span style={{ fontSize: 10, opacity: .8, fontWeight: 500 }}>{o.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  } else if (st.aggregate) {
    dotColor = 'var(--ok)';
    body = (
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5 }}><b>Round complete</b> <span style={{ color: 'var(--text-faint)' }}>· 3 shipped · 1 nit</span></span>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {st.aggregate.actions.map((a) => (
            <button key={a.id} onClick={() => onAction(a.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 11px', borderRadius: 'var(--r-sm)', font: 'inherit', fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
              border: a.kind === 'primary' ? 'none' : '1px solid var(--border)',
              background: a.kind === 'primary' ? 'var(--accent)' : 'var(--surface)', color: a.kind === 'primary' ? '#fff' : 'var(--text)' }}>
              <Icon name={a.icon} size={13} />{a.label}
              {a.badge && <span className="tnum" style={{ fontSize: 10, fontWeight: 700, minWidth: 14, height: 14, padding: '0 3px',
                borderRadius: 7, display: 'grid', placeItems: 'center', background: a.kind === 'primary' ? 'rgba(255,255,255,.25)' : alpha('var(--warn)', 18),
                color: a.kind === 'primary' ? '#fff' : 'var(--warn)' }}>{a.badge}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  } else if (st.speech) {
    const a = agents[st.speech.agentId];
    dotColor = a.pm ? 'var(--pm)' : a.color;
    if (a.pm) {
      // quiet facilitator narration — show the actual line
      body = <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: 'var(--text-muted)' }}>
        <b style={{ color: 'var(--pm)' }}>{a.displayName}</b> · {st.speech.text || 'facilitating…'}</div>;
    } else {
      const verb = st.speech.mode === 'working' ? 'is working' : st.speech.mode === 'thinking' ? 'is thinking' : 'is speaking';
      body = <div style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}><b style={{ color: a.color }}>{a.displayName}</b> {verb}…</div>;
    }
  } else {
    body = (
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, fontSize: 13.5 }}>
        <span>{liveStatus === 'pending' ? 'Drafting the plan…' : !st.started ? 'Ready to begin' : 'The table is quiet'}</span>
        {!st.started && (
          <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>create a task or message the table</span>
        )}
      </div>
    );
  }
  return (
    <div style={{ borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 22px 0' }}>
        <WorkflowStrip clock={scene.clock} onOpen={onOpenWorkflow} workflow={workflow} workflowRun={workflowRun} />
        <span style={{ flex: 1 }} />
      </div>
      {rec && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 22px 0', padding: '8px 12px',
          borderRadius: 'var(--r-sm)', border: `1px solid ${alpha('var(--accent)', 30)}`, background: alpha('var(--accent)', 8) }}>
          <Icon name="sparkle" size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.45, minWidth: 0 }}>
            <span>This task fits <b>“{rec.name}”</b> better</span>
            <span style={{ color: 'var(--text-muted)' }}> — {rec.reason}</span>
          </div>
          <button onClick={() => onUseWorkflow && onUseWorkflow(rec.id)} style={{ flexShrink: 0, padding: '5px 12px', borderRadius: 'var(--r-sm)',
            border: 'none', background: 'var(--accent)', color: '#fff', font: 'inherit', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>Use it</button>
          <button onClick={() => onDismissRec && onDismissRec()} title="Dismiss" style={{ flexShrink: 0, display: 'grid', placeItems: 'center',
            width: 24, height: 24, borderRadius: 'var(--r-sm)', border: 'none', background: 'transparent', color: 'var(--text-faint)', cursor: 'pointer' }}><Icon name="x" size={13} /></button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '9px 22px 4px' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0,
          boxShadow: st.speech ? `0 0 0 4px ${alpha(dotColor, 22)}` : 'none' }} />
        {body}
      </div>
      <Composer agents={agents} onSend={onSend || (() => scene.replay())} />
    </div>
  );
}

/* ---- Inspector : tabbed Files / Notes (right, collapsible) --------------- */
// P3.2: live message thread for the selected chat (messages.list + handoffs count).
function LiveThread({ messages, handoffs, agents, onRewrite }) {
  const polish = trpc.ai.polish.useMutation();
  const [polishingId, setPolishingId] = React.useState(null);
  const [suggestions, setSuggestions] = React.useState({});

  const handleRewrite = async (m) => {
    setPolishingId(m.id);
    try {
      const result = await polish.mutateAsync({ text: m.content });
      setSuggestions(s => ({ ...s, [m.id]: result.text }));
    } finally {
      setPolishingId(null);
    }
  };
  const dismissSuggestion = (id) => setSuggestions(s => { const n = { ...s }; delete n[id]; return n; });

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {handoffs && handoffs.length > 0 && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              {handoffs.length} hand-off{handoffs.length > 1 ? 's' : ''} in this chat
            </div>
            {handoffs.map((h) => h.card && <HandoffCard key={h.id} ho={h.card} agents={agents} />)}
          </div>
        )}
        {messages.length === 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>No messages yet.</div>
        )}
        {messages.map((m) => {
          const mine = m.authorType === 'user';
          const suggestion = suggestions[m.id];
          return (
            <div key={m.id}>
              <div style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                <div style={{ maxWidth: '80%', padding: '9px 12px', borderRadius: 12, fontSize: 13.5, lineHeight: 1.5,
                  background: mine ? 'var(--accent)' : 'var(--surface-2)', color: mine ? '#fff' : 'var(--text)',
                  border: mine ? 'none' : '1px solid var(--border)' }}>
                  {!mine && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 2 }}>{m.authorId || m.authorType}</div>}
                  {m.content}
                </div>
              </div>
              {mine && !suggestion && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 3 }}>
                  <button onClick={() => handleRewrite(m)} disabled={polishingId === m.id} title="Rewrite with AI"
                    style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, borderRadius: 6,
                      border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-faint)',
                      opacity: 0.6 }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = 1; e.currentTarget.style.background = 'var(--surface-2)'; }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = 0.6; e.currentTarget.style.background = 'transparent'; }}>
                    {polishingId === m.id ? <Spinner size={11} /> : <Icon name="sparkle" size={12} />}
                  </button>
                </div>
              )}
              {mine && suggestion && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                  <div style={{ maxWidth: '80%', padding: '8px 11px', borderRadius: 10, fontSize: 13,
                    background: 'var(--surface-2)', border: '1px solid var(--accent)', color: 'var(--text)', lineHeight: 1.5 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--accent)', fontWeight: 600, marginBottom: 4 }}>✦ AI rewrite</div>
                    <div style={{ marginBottom: 8 }}>{suggestion}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => { onRewrite && onRewrite(suggestion); dismissSuggestion(m.id); }}
                        style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 5, border: 'none',
                          background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}>Resend</button>
                      <button onClick={() => dismissSuggestion(m.id)}
                        style={{ fontSize: 11.5, padding: '3px 9px', borderRadius: 5, border: '1px solid var(--border)',
                          background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>Dismiss</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
function FileRow({ art, agents, onOpen, activeChatId }) {
  const owner = agents[art.ownerAgentId];
  const icon = art.kind === 'preview' ? 'eye' : art.kind === 'diff' ? 'code' : art.kind === 'doc' ? 'clip' : 'code';
  const fromSiblingChat = activeChatId && art.createdInChatId && art.createdInChatId !== activeChatId;
  const scopeCopy = fromSiblingChat
    ? `project artifact · from chat ${art.createdInChatId.slice(0, 8)}`
    : art.workbenchId
      ? 'project artifact'
      : null;
  return (
    <button onClick={() => onOpen(art)} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)',
      color: 'var(--text)', font: 'inherit', cursor: 'pointer', marginBottom: 7 }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--surface)')}>
      <span style={{ display: 'grid', placeItems: 'center', width: 30, height: 30, borderRadius: 8, flexShrink: 0,
        background: tint(owner && !art.source.includes('upload') ? owner.color : 'var(--text-faint)', 14),
        color: owner && art.source !== 'uploaded' ? owner.color : 'var(--text-muted)' }}>
        <Icon name={icon} size={15} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {art.title.split('/').pop()}</div>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}>
          {scopeCopy || (art.source === 'uploaded' ? 'you · uploaded' : owner ? owner.displayName + ' · ' + art.kind : art.kind)}
        </div>
      </div>
      <span className="mono tnum" style={{ fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 5,
        background: 'var(--surface-3)', color: 'var(--text-muted)', flexShrink: 0 }}>v{art.version}</span>
    </button>
  );
}
function InspectorPanel({ tab, setTab, clock, agents, scene, width, onOpenArtifact, onAction, onClose, live, liveArtifacts, liveMessages, liveHandoffs, activeChatId, memory, localTurns, localStatus, onApproveLocalTurn, localTurnActions, onRewrite }) {
  const placed = sceneAt(clock).placed;
  const hasLocalTurns = localTurns && localTurns.length > 0;
  const localArtifacts = hasLocalTurns ? liveArtifactsFromTurns(localTurns, agents, localStatus) : [];
  // P3.2: in live mode show the real chat's artifacts (empty until the orchestrator runs) —
  // never fall back to scripted fixtures, which would contradict the live center stage.
  const created = hasLocalTurns
    ? localArtifacts
    : live
    ? (liveArtifacts ?? []).map((a) => ({ ...a, version: a.currentVersion, source: a.source ?? 'generated' }))
    : placed.map((p) => p.art);
  // The fixture "brief" is demo-only — in live mode there are no user-provided artifacts yet.
  const provided = live || hasLocalTurns ? [] : [RT.ARTIFACTS.brief];
  const notes = meetingNotes(clock);
  const tabBtn = (id, label) => (
    <button onClick={() => setTab(id)} style={{ flex: 1, padding: '10px 0', border: 'none', cursor: 'pointer', font: 'inherit',
      fontSize: 12.5, fontWeight: 600, background: 'transparent', color: tab === id ? 'var(--text)' : 'var(--text-faint)',
      borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}` }}>{label}</button>
  );
  return (
    <div style={{ width: width || 392, flexShrink: 0, borderLeft: '1px solid var(--border)', background: 'var(--surface)',
      display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px 0' }}>
        {tabBtn('chat', 'Chat')}
        {tabBtn('files', `Files · ${created.length + provided.length}`)}
        {tabBtn('memory', 'Memory')}
        {tabBtn('deps', 'Deps')}
        {tabBtn('notes', 'Notes')}
        <button onClick={onClose} style={{ ...iconBtn, border: 'none', background: 'transparent' }}><Icon name="x" size={15} /></button>
      </div>
      <div style={{ borderBottom: '1px solid var(--border)' }} />

      {tab === 'chat' ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>
          {hasLocalTurns
            ? <LocalLiveThread turns={localTurns} agents={agents} onApproveTurn={onApproveLocalTurn} turnActions={localTurnActions} />
            : live
            ? <LiveThread messages={liveMessages ?? []} handoffs={liveHandoffs} agents={agents} onRewrite={onRewrite} />
            : <Thread agents={agents} scene={scene} onOpenArtifact={onOpenArtifact} onAction={onAction} narrow />}
        </div>
      ) : tab === 'files' ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 24px' }}>
          {provided.length > 0 && (
            <>
              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase',
                color: 'var(--text-faint)', margin: '0 0 9px' }}>Provided by you</div>
              {provided.map((a) => <FileRow key={a.id} art={a} agents={agents} onOpen={onOpenArtifact} activeChatId={activeChatId} />)}
            </>
          )}
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase',
            color: 'var(--text-faint)', margin: provided.length > 0 ? '16px 0 9px' : '0 0 9px' }}>
            {hasLocalTurns ? 'Local model outputs' : live ? 'Project artifacts' : 'Created in this run'} · {created.length}
          </div>
          {created.length === 0
            ? <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic', padding: '4px 2px' }}>Nothing yet — artifacts land here as the team works.</div>
            : created.map((a) => <FileRow key={a.id} art={a} agents={agents} onOpen={onOpenArtifact} activeChatId={activeChatId} />)}
        </div>
      ) : tab === 'memory' ? (
        <MemoryPanel memory={memory} />
      ) : tab === 'deps' ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 24px' }}>
          {live || hasLocalTurns ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic', padding: '4px 2px' }}>
              The dependency graph isn&rsquo;t wired to live data yet — it&rsquo;ll map artifacts as the team links them.</div>
          ) : (
            <DependencyGraphSidebar
              graph={RT.DEPENDENCY_GRAPH}
              agents={agents}
              chatId={RT.WORKBENCH?.id || 'main'}
              onNodeClick={(node) => {
                const art = Object.values(RT.ARTIFACTS).find((a) => a.id === node.artifactId);
                if (art && onOpenArtifact) onOpenArtifact(art);
              }}
            />
          )}
        </div>
      ) : live || hasLocalTurns ? (
        <LiveNotes agents={agents} artifacts={created} handoffs={liveHandoffs} />
      ) : (
        <NotesContent clock={clock} agents={agents} notes={notes} />
      )}

      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-faint)',
        display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--run)', animation: 'rt-blink 1.4s infinite' }} />
        live · kept by the facilitator
      </div>
    </div>
  );
}

/* ---- live notes: real deliverables + hand-offs for the selected chat ------ */
function LiveNotes({ agents, artifacts, handoffs }) {
  const arts = artifacts || [];
  const hos = handoffs || [];
  if (arts.length === 0 && hos.length === 0) {
    return (
      <div style={{ flex: 1, padding: '16px 16px 24px' }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>
          Notes fill in as the team works — deliverables, hand-offs, and reviews land here once the orchestrator runs.</div>
      </div>
    );
  }
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 24px' }}>
      {hos.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase',
            color: 'var(--text-faint)', marginBottom: 8 }}>Activity</div>
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
              <Icon name="layers" size={13} style={{ color: 'var(--text-faint)', marginTop: 3, flexShrink: 0 }} />
              <span style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>
                {hos.length} hand-off{hos.length > 1 ? 's' : ''} coordinated by the facilitator</span>
            </div>
            {hos.map((h) => h.card && <HandoffCard key={h.id} ho={h.card} agents={agents} />)}
          </div>
        </div>
      )}
      {arts.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase',
            color: 'var(--text-faint)', marginBottom: 8 }}>Deliverables · {arts.length}</div>
          {arts.map((a) => {
            const ow = agents[a.ownerAgentId];
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
                <Avatar agent={ow} size={20} ring={false} />
                <span className="mono" style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.title.split('/').pop()}</span>
                <span className="mono tnum" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>v{a.version}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function turnToTask(turn) {
  const title = turn.message.length > 40 ? turn.message.slice(0, 40) + '...' : turn.message;
  if (turn.status === 'error') {
    return { id: turn.id, title, meta: turn.error || 'failed', status: 'queued' };
  }
  const count = turn.result?.plan?.tasks?.length || turn.plan?.tasks?.length || 0;
  const dispatchStatus = turn.result?.dispatchStatus || turn.dispatchStatus;
  const artifactCount = turn.result?.artifacts?.length || turn.artifacts?.length || 0;
  const meta = dispatchStatus === 'completed'
    ? `${artifactCount} artifacts · result ready`
    : dispatchStatus === 'failed'
      ? `${artifactCount} artifacts · failed`
      : dispatchStatus === 'running'
        ? `${count || 0} agents · running`
        : count
          ? `${count} agents · queued`
          : 'queued';
  const status = dispatchStatus === 'completed'
    ? 'done'
    : dispatchStatus === 'running' || turn.status === 'pending'
      ? 'live'
      : 'queued';
  return {
    id: turn.id,
    title,
    meta,
    status,
  };
}

function storedTurnToLiveTurn(turn) {
  return {
    id: turn.id,
    message: turn.message,
    status: turn.status,
    createdAt: turn.createdAt,
    ...(turn.status === 'done'
      ? {
          result: {
            ok: true,
            id: turn.id,
            provider: turn.provider,
            model: turn.model,
            pmMessage: turn.pmMessage,
            needsApproval: turn.needsApproval,
            approvalStatus: turn.approvalStatus,
            approvedAt: turn.approvedAt,
            dispatchStatus: turn.dispatchStatus,
            dispatchAdapter: turn.dispatchAdapter,
            dispatchedAt: turn.dispatchedAt,
            dispatchStage: turn.dispatchStage,
            dispatchError: turn.dispatchError,
            dispatchWorkspacePath: turn.dispatchWorkspacePath,
            dispatch: turn.dispatch,
            artifacts: turn.artifacts,
            intake: turn.intake,
            plan: turn.plan,
            workflow: turn.workflow,
            workflowRun: turn.workflowRun,
            needsClarification: turn.needsClarification,
            clarifyQuestions: turn.clarifyQuestions,
            clarifyAnswers: turn.clarifyAnswers,
          },
        }
      : { error: turn.error || 'orchestrator_turn_failed' }),
  };
}

function latestLiveTurn(liveTurns) {
  const turns = (liveTurns || []).filter((turn) => turn.result || turn.status === 'pending' || turn.status === 'error');
  if (turns.length === 0) return null;
  const timeOf = (turn) => {
    const fromCreatedAt = turn.createdAt ? Date.parse(turn.createdAt) : NaN;
    if (!Number.isNaN(fromCreatedAt)) return fromCreatedAt;
    const fromId = /^live-(\d+)$/.exec(turn.id);
    return fromId ? Number(fromId[1]) : 0;
  };
  return [...turns].sort((a, b) => timeOf(b) - timeOf(a))[0];
}

function preferredAgentAdapterRequest() {
  return { agentAdapter: 'local-dispatch' };
}

// #15 AC: agent color persistence across sessions. Custom agents (id `a-…`)
// live in RT.AGENTS at runtime; mirror them to localStorage and rehydrate on boot.
function persistCustomAgents() {
  if (typeof window === 'undefined') return;
  const custom = Object.values(RT.AGENTS).filter((a) => a.agentId.startsWith('a-'));
  window.localStorage.setItem('roundtableCustomAgents', JSON.stringify(custom));
}

function restoreCustomAgents() {
  if (typeof window === 'undefined') return [];
  try {
    const saved = JSON.parse(window.localStorage.getItem('roundtableCustomAgents') || '[]');
    for (const a of saved) {
      if (a?.agentId && !RT.AGENTS[a.agentId]) RT.AGENTS[a.agentId] = a;
    }
    return saved.map((a) => a.agentId).filter(Boolean);
  } catch {
    return [];
  }
}

function livePlanArtifact(liveTurns, liveStatus) {
  return {
    id: 'live-code-log',
    kind: 'code',
    title: 'roundtable-live-run.json',
    ownerAgentId: 'orchestrator',
    version: 1,
    source: 'generated',
    createdAt: new Date().toISOString(),
    code: JSON.stringify({
      server: {
        status: 'running',
        url: 'http://localhost:3000',
        currentUiStatus: liveStatus,
      },
      turns: (liveTurns || []).map((turn) => ({
        id: turn.id,
        createdAt: turn.createdAt,
        status: turn.status,
        approvalStatus: turn.result?.approvalStatus,
        dispatchStatus: turn.result?.dispatchStatus,
        dispatchAdapter: turn.result?.dispatchAdapter,
        artifactCount: turn.result?.artifacts?.length || 0,
        workspacePath: turn.result?.dispatchWorkspacePath,
        taskCount: turn.result?.plan?.tasks?.length || 0,
        message: turn.message,
        error: turn.error,
        plan: turn.result?.plan,
      })),
    }, null, 2),
  };
}

function agentForArtifact(artifact, agents) {
  if (agents[artifact.ownerAgentId]) return agents[artifact.ownerAgentId];
  const role = artifact.ownerAgentId;
  return Object.values(agents).find((agent) => agent.role === role && !agent.pm) || agents.orchestrator;
}

function normalizeLiveArtifacts(artifacts, agents) {
  return (artifacts || []).map((artifact) => {
    const owner = agentForArtifact(artifact, agents);
    return {
      ...artifact,
      ownerAgentId: owner.agentId,
      source: 'generated',
      code: artifact.kind === 'code' ? artifact.preview : undefined,
      preview: artifact.preview || '',
    };
  });
}

function liveArtifactsFromTurns(liveTurns, agents, liveStatus) {
  const turns = liveTurns || [];
  return [
    ...(turns.length > 0 ? [livePlanArtifact(turns, liveStatus)] : []),
    ...turns.flatMap((turn) => normalizeLiveArtifacts(turn.result?.artifacts || [], agents)),
  ];
}

function buildLocalScene(baseScene, liveTurns, agents) {
  const latest = latestLiveTurn(liveTurns);
  if (!latest) return baseScene;
  const status = { ...baseScene.status };
  Object.keys(status).forEach((id) => { status[id] = 'idle'; });
  const result = latest.result;
  const completed = result?.dispatchStatus === 'completed';
  status.orchestrator = latest.status === 'pending' ? 'working' : result ? 'done' : 'idle';

  const roleCursor = {};
  const ownerFor = (task) => {
    if (task?.owner && agents[task.owner]) return agents[task.owner];
    const target = String(task?.assignee || '').replace(/^@/, '');
    if (agents[target]) return agents[target];
    const candidates = Object.values(agents).filter((agent) => agent.role === target && !agent.pm);
    if (candidates.length === 0) return agents.orchestrator;
    const index = roleCursor[target] || 0;
    roleCursor[target] = index + 1;
    return candidates[index % candidates.length];
  };
  const liveTasks = result?.plan?.tasks?.map((task) => {
    const owner = ownerFor(task);
    status[owner.agentId] = completed || result?.dispatchStatus === 'running' ? 'done' : 'idle';
    return { ...task, owner: owner.agentId, status: completed ? 'completed' : result?.dispatchStatus === 'running' ? 'running' : 'pending' };
  }) || [];

  return {
    ...baseScene,
    live: true,
    started: true,
    planPosted: true,
    run: {
      phase: latest.status === 'pending' ? 'planning' : completed ? 'completed' : 'running',
      message: latest.message,
      error: latest.error,
      provider: result?.provider,
      model: result?.model,
      dispatchStatus: result?.dispatchStatus,
      artifactCount: result?.artifacts?.length || 0,
      workspacePath: result?.dispatchWorkspacePath,
    },
    status,
    tasks: liveTasks,
    placed: result?.plan ? liveArtifactsFromTurns([latest], agents, 'idle').map((art) => ({
      art,
      ownerAgentId: art.ownerAgentId,
    })) : [],
  };
}

/* ---- structured meeting notes (decisions / deliverables / review / next) - */
function NotesContent({ clock, agents, notes }) {
  const placed = sceneAt(clock).placed;
  const Section = ({ label, children }) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
  const Item = ({ children, icon }) => (
    <div style={{ display: 'flex', gap: 9, marginBottom: 8, alignItems: 'flex-start' }}>
      <Icon name={icon || 'dot'} size={13} style={{ color: 'var(--text-faint)', marginTop: 3, flexShrink: 0 }} />
      <span style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>{children}</span>
    </div>
  );
  const decisions = clock >= 2900;
  const reviewed = clock >= 19000;
  const doneR = clock >= 22400;
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 24px' }}>
      {!decisions && <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>Notes fill in as decisions are made.</div>}
      {decisions && (
        <Section label="Decisions">
          <Item icon="check">Deploy target — <b>Vercel + Postgres</b></Item>
          <Item icon="check">Server-rendered form, no client JS for submit</Item>
          <Item icon="check">Work split into <b>3 parallel tasks</b></Item>
        </Section>
      )}
      {placed.length > 0 && (
        <Section label={`Deliverables · ${placed.length}`}>
          {placed.map((p) => {
            const ow = agents[p.ownerAgentId];
            return (
              <div key={p.art.id} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
                <Avatar agent={ow} size={20} ring={false} />
                <span className="mono" style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.art.title.split('/').pop()}</span>
                <span className="mono tnum" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>v{p.art.version}</span>
              </div>
            );
          })}
        </Section>
      )}
      {reviewed && (
        <Section label="Review">
          <Item icon="eye">1 accessibility nit — email field needs a label. <b style={{ color: 'var(--warn)' }}>fix available</b></Item>
        </Section>
      )}
      {doneR && (
        <Section label="Next steps">
          <Item icon="wrench">Apply the review fix (1)</Item>
          <Item icon="rocket">Deploy to Vercel</Item>
        </Section>
      )}
    </div>
  );
}

/* ---- Breakout room (a real side room you can sit in) --------------------- */
function BreakoutModal({ data, agents, onClose, onBringBack }) {
  if (!data) return null;
  const [val, setVal] = useState('');
  const a = agents[data.a], b = agents[data.b];
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 115, background: alpha('#000', 38),
      backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="rt-zoom" style={{ width: 'min(560px, 100%)', height: 'min(600px, 88vh)',
        display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderRadius: 'var(--r-card)',
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-pop)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: 8, background: 'var(--surface-2)',
            color: 'var(--text-muted)' }}><Icon name="door" size={16} /></span>
          <span style={{ display: 'flex' }}>
            <span style={{ zIndex: 1 }}><Avatar agent={a} size={26} /></span>
            <span style={{ marginLeft: -8 }}><Avatar agent={b} size={26} /></span>
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{a.displayName} &amp; {b.displayName}</div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>breakout · side room — you’re watching</div>
          </div>
          <span className="mono" style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 5, background: 'var(--surface-3)', color: 'var(--text-faint)' }}>{data.turns} turns</span>
          <button onClick={onClose} style={{ ...iconBtn, marginLeft: 4 }}><Icon name="x" size={15} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 14, background: 'var(--bg)' }}>
          {data.transcript.map((t, i) => {
            const ag = agents[t.agentId];
            return (
              <div key={i} style={{ display: 'flex', gap: 10 }}>
                <Avatar agent={ag} size={28} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: ag.color, fontWeight: 600, marginBottom: 2 }}>{ag.displayName}</div>
                  <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '4px 12px 12px 12px',
                    padding: '9px 12px', fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>{t.text}</div>
                </div>
              </div>
            );
          })}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, alignSelf: 'center', fontSize: 11.5, color: 'var(--text-faint)',
            padding: '4px 12px', borderRadius: 999, background: 'var(--surface-2)' }}>
            <Icon name="check" size={12} style={{ color: 'var(--ok)' }} /> aligned — outcome ready to share
          </div>
        </div>
        <div style={{ padding: '11px 14px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 9 }}>
            <textarea value={val} onChange={(e) => setVal(e.target.value)} rows={1} placeholder="Join in — add a note to the room…"
              style={{ flex: 1, resize: 'none', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface-2)',
                font: 'inherit', fontSize: 13.5, color: 'var(--text)', padding: '9px 11px', outline: 'none', maxHeight: 90 }} />
            <button onClick={() => setVal('')} style={{ display: 'grid', placeItems: 'center', width: 38, height: 38, borderRadius: 'var(--r-sm)',
              border: 'none', cursor: 'pointer', background: 'var(--surface-3)', color: 'var(--text-muted)', flexShrink: 0 }}><Icon name="send" size={16} /></button>
          </div>
          <button onClick={() => { onBringBack && onBringBack(); onClose(); }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            gap: 7, padding: '10px', borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer', background: 'var(--accent)', color: '#fff',
            font: 'inherit', fontSize: 13, fontWeight: 600 }}>
            <Icon name="layers" size={15} /> Bring the outcome back to the table</button>
        </div>
      </div>
    </div>
  );
}

/* ---- BreakoutsHub : the door's panel — see & start side rooms ------------ */
function BreakoutsHub({ agents, memberIds, autoRoom, onEnterAuto, onStartDM, onClose }) {
  const members = (memberIds || []).filter((id) => id !== 'orchestrator' || true).map((id) => agents[id]).filter(Boolean);
  return (
    <Modal title="Breakout rooms" icon="door" onClose={onClose} width={500}
      sub="Pull people aside for a side conversation — two agents, or a private 1:1 with you.">
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 8 }}>Active rooms</div>
      {autoRoom ? (
        <button onClick={onEnterAuto} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px',
          borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', cursor: 'pointer', font: 'inherit',
          textAlign: 'left', marginBottom: 18 }}>
          <span style={{ display: 'flex' }}>
            <span style={{ zIndex: 1 }}><Avatar agent={agents[autoRoom.a]} size={26} /></span>
            <span style={{ marginLeft: -8 }}><Avatar agent={agents[autoRoom.b]} size={26} /></span>
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{agents[autoRoom.a].displayName} &amp; {agents[autoRoom.b].displayName}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>aligning on validation · {autoRoom.turns} turns</div>
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
            Enter <Icon name="chevron" size={12} /></span>
        </button>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic', marginBottom: 18 }}>No side rooms open right now.</div>
      )}

      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 8 }}>Talk privately with a member</div>
      <div style={{ display: 'grid', gap: 7 }}>
        {members.map((a) => (
          <button key={a.agentId} onClick={() => onStartDM(a.agentId)} style={{ display: 'flex', alignItems: 'center', gap: 10,
            padding: '9px 12px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)',
            cursor: 'pointer', font: 'inherit', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--surface)')}>
            <Avatar agent={a} size={26} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{a.displayName}</div>
              <div className="mono" style={{ fontSize: 11, color: a.color }}>{a.pm ? 'facilitator' : '@' + a.role}</div>
            </div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)' }}>
              <Icon name="send" size={13} /> Message</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/* ---- DMRoom : a private 1:1 side room (You ↔ agent), doubles as steering -- */
function DMRoom({ agent, activeTask, onClose }) {
  if (!agent) return null;
  const [val, setVal] = useState('');
  const steering = !!activeTask;
  const redirects = ['Use Postgres, not SQLite', 'Add rate limiting', 'Keep it server-rendered'];
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 115, background: alpha('#000', 34),
      backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="rt-zoom" style={{ width: 'min(460px, 100%)', height: 'min(560px, 86vh)',
        display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderRadius: 'var(--r-card)',
        border: '1px solid var(--border)', borderTop: `2.5px solid ${agent.color}`, boxShadow: 'var(--shadow-pop)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 15px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, borderRadius: 7, background: 'var(--surface-2)',
            color: 'var(--text-muted)' }}><Icon name={steering ? 'wrench' : 'door'} size={14} /></span>
          <Avatar agent={agent} size={28} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{steering ? 'Steer' : 'Private'} · {agent.displayName}</div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{steering ? 'redirect them mid-task' : 'just you two — off the main table'}</div>
          </div>
          <button onClick={onClose} style={iconBtn}><Icon name="x" size={15} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 15px', display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--bg)' }}>
          {steering && (
            <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 'var(--r-sm)',
              background: tint(agent.color, 9), border: `1px solid ${alpha(agent.color, 35)}` }}>
              <Spinner size={15} color={agent.color} />
              <div style={{ fontSize: 12.5, color: 'var(--text)' }}>
                <b>Working on {activeTask}</b> right now. A note here steers the live task without stopping the table.</div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 9 }}>
            <Avatar agent={agent} size={26} />
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '4px 12px 12px 12px',
              padding: '9px 12px', fontSize: 13.5, color: 'var(--text)', maxWidth: '80%' }}>
              {steering ? 'Mid-build — tell me what to change and I’ll fold it in.' : 'Hey — what would you like to go over, just the two of us?'}</div>
          </div>
        </div>
        {steering && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 13px 4px' }}>
            {redirects.map((r) => (
              <button key={r} onClick={() => setVal(r)} style={{ padding: '5px 10px', borderRadius: 999, cursor: 'pointer',
                border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', font: 'inherit', fontSize: 11.5 }}>{r}</button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 9, padding: '11px 13px', borderTop: '1px solid var(--border)' }}>
          <textarea value={val} onChange={(e) => setVal(e.target.value)} rows={1} placeholder={steering ? `Redirect ${agent.displayName}…` : `Message ${agent.displayName} privately…`}
            style={{ flex: 1, resize: 'none', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface-2)',
              font: 'inherit', fontSize: 13.5, color: 'var(--text)', padding: '9px 11px', outline: 'none', maxHeight: 100 }} />
          <button onClick={() => setVal('')} style={{ display: 'grid', placeItems: 'center', width: 38, height: 38, borderRadius: 'var(--r-sm)',
            border: 'none', cursor: 'pointer', background: 'var(--accent)', color: '#fff', flexShrink: 0 }}><Icon name="send" size={16} /></button>
        </div>
      </div>
    </div>
  );
}

/* ---- ResizeHandle : drag to resize the inspector ------------------------- */
function ResizeHandle({ onResize }) {
  const drag = useRef(null);
  useEffect(() => {
    const move = (e) => { if (drag.current != null) onResize(drag.current - e.clientX); };
    const up = () => { drag.current = null; document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [onResize]);
  return (
    <div onMouseDown={(e) => { drag.current = e.clientX + 0; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; }}
      title="Drag to resize" style={{ width: 7, flexShrink: 0, cursor: 'col-resize', position: 'relative', zIndex: 30,
        display: 'grid', placeItems: 'center', background: 'var(--surface)', borderLeft: '1px solid var(--border)' }}
      onMouseEnter={(e) => (e.currentTarget.firstChild.style.background = 'var(--accent)')}
      onMouseLeave={(e) => (e.currentTarget.firstChild.style.background = 'var(--border)')}>
      <div style={{ width: 2, height: 38, borderRadius: 2, background: 'var(--border)', transition: 'background .15s' }} />
    </div>
  );
}

/* ---- ResizeHandle for the inspector. The actual onResize closure lives in App. */

/* ============================================================================ */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "aesthetic": "neutral",
  "theme": "light",
  "density": "balanced",
  "palette": "soft",
  "autoplay": false,
  "speed": 1.2
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [view, setView] = useState('roundtable');
  const [drawerArt, setDrawerArt] = useState(null);
  const [breakoutOpen, setBreakoutOpen] = useState(false);
  const [hubOpen, setHubOpen] = useState(false);
  const [dmAgent, setDmAgent] = useState(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState('chat');
  const [modal, setModal] = useState(null);
  const [railOpen, setRailOpen] = useState(true);
  const [inspectorW, setInspectorW] = useState(392);
  const [zoomWB, setZoomWB] = useState(false);
  const [memberIds, setMemberIds] = useState(RT.WORKBENCH.members);
  useEffect(() => {
    const restored = restoreCustomAgents();
    if (restored.length) setMemberIds((m) => [...m, ...restored.filter((id) => !m.includes(id))]);
  }, []);
  const [localTurns, setLocalTurns] = useState([]);
  const [localStatus, setLocalStatus] = useState('idle');
  // Persisted so a page refresh restores this chat's live turns from history
  // instead of starting an empty session. Some embedded browsers can deny
  // localStorage, so use a stable dev fallback instead of a fresh random id.
  const [localChatId] = useState(() => {
    const key = 'roundtable.localChatId';
    const fallback = 'roundtable-local-dev';
    try {
      const existing = window.localStorage.getItem(key);
      if (existing) return existing;
      window.localStorage.setItem(key, fallback);
      return fallback;
    } catch {
      return fallback;
    }
  });
  // P3.2: live chats when signed in; fall back to fixtures for the logged-out demo.
  const { status: authStatus } = useSession();
  const authed = authStatus === 'authenticated';
  const chatsQ = trpc.chats.list.useQuery(undefined, { enabled: authed });
  const workbenchesQ = trpc.workbenches.list.useQuery(undefined, { enabled: authed });
  const [selectedChatId, setSelectedChatId] = useState(null);
  const [selectedWorkbenchId, setSelectedWorkbenchId] = useState(null);
  const [selectedLocalTurnId, setSelectedLocalTurnId] = useState(null);
  const trpcUtils = trpc.useUtils();
  const createWorkbench = trpc.workbenches.create.useMutation({
    onSuccess: () => trpcUtils.workbenches.list.invalidate(),
  });
  const createChat = trpc.chats.create.useMutation({
    onSuccess: (chat) => {
      trpcUtils.chats.list.invalidate();
      setSelectedChatId(chat.id);
      setSelectedWorkbenchId(chat.workbenchId);
    },
  });
  const createMessage = trpc.messages.create.useMutation({
    onSuccess: () => trpcUtils.messages.list.invalidate(),
  });
  const polishPrompt = trpc.ai.polish.useMutation();
  const deleteChat = trpc.chats.delete.useMutation({
    onSuccess: () => {
      trpcUtils.chats.list.invalidate();
    },
  });
  const updateProfile = trpc.userProfile.update.useMutation({
    onSuccess: () => trpcUtils.userProfile.get.invalidate(),
  });
  const pinWorkbench = trpc.workbenchPinned.pin.useMutation({
    onSuccess: () => trpcUtils.workbenchPinned.list.invalidate(),
  });
  const unpinWorkbench = trpc.workbenchPinned.unpin.useMutation({
    onSuccess: () => trpcUtils.workbenchPinned.list.invalidate(),
  });
  const liveWorkbenches = workbenchesQ.data ?? [];
  const activeChat =
    authed && chatsQ.data && selectedChatId
      ? chatsQ.data.find((c) => c.id === selectedChatId)
      : null;
  const firstWorkbenchId = liveWorkbenches[0]?.id ?? null;
  const activeWorkbenchId = selectedWorkbenchId ?? activeChat?.workbenchId ?? firstWorkbenchId;
  const activeChatId = selectedChatId
    ?? ((authed && chatsQ.data?.find((c) => c.workbenchId === activeWorkbenchId)?.id) || null);
  const activeWorkbench =
    authed && activeWorkbenchId
      ? liveWorkbenches.find((w) => w.id === activeWorkbenchId) ?? null
      : null;
  const localTasks = localTurns.map(turnToTask);
  const activeLocalTurn = !authed && localTurns.length > 0
    ? (localTurns.find((turn) => turn.id === selectedLocalTurnId) || localTurns[0])
    : null;
  const activeLocalTurns = activeLocalTurn ? [activeLocalTurn] : [];
  const activeLocalTaskId = activeLocalTurn?.id ?? localTasks[0]?.id ?? null;
  const tasks =
    authed && chatsQ.data
      ? chatsQ.data
          .filter((c) => !activeWorkbenchId || c.workbenchId === activeWorkbenchId)
          .map((c) => ({ id: c.id, title: c.title, meta: activeWorkbench?.name || 'workbench', status: 'idle', workbenchId: c.workbenchId }))
      : localTasks.length > 0
        ? localTasks
        : RT.TASKS;
  const profileQ = trpc.userProfile.get.useQuery(undefined, { enabled: authed });
  const pinsQ = trpc.workbenchPinned.list.useQuery(
    { workbenchId: activeWorkbenchId ?? '' },
    { enabled: authed && !!activeWorkbenchId },
  );
  const artifactsQ = trpc.artifacts.listByChat.useQuery(
    { chatId: activeChatId ?? '' },
    { enabled: authed && !!activeChatId },
  );
  const liveArtifacts = authed && artifactsQ.data ? artifactsQ.data : null;
  const messagesQ = trpc.messages.list.useQuery(
    { chatId: activeChatId ?? '' },
    { enabled: authed && !!activeChatId },
  );
  const handoffsQ = trpc.handoffs.listByChat.useQuery(
    { chatId: activeChatId ?? '' },
    { enabled: authed && !!activeChatId },
  );
  const liveMessages = authed && messagesQ.data ? messagesQ.data : null;
  const liveHandoffs = authed && handoffsQ.data ? handoffsQ.data : null;
  const agents = useMemo(() => palettize(t.palette), [t.palette, memberIds]);
  const railWorkbench = authed && activeWorkbench
    ? { ...activeWorkbench, members: RT.WORKBENCH.members }
    : RT.WORKBENCH;
  const railWorkbenches = authed && liveWorkbenches.length > 0
    ? liveWorkbenches.map((w) => ({ ...w, members: RT.WORKBENCH.members }))
    : RT.WORKBENCHES;
  const scene = useScene(t.autoplay, t.speed);
  const compact = useMediaQuery('(max-width: 760px)');
  const [decided, setDecided] = useState(false);
  const localLive = !authed && localTurns.length > 0;
  // Workflow recommendation for the active task (local heuristic; no backend on main).
  const activeTaskTitle = localLive
    ? (turnToTask(activeLocalTurn || localTurns[0] || { message: '' }).title ?? '')
    : (tasks.find((tk) => tk.id === activeChatId)?.title ?? '');
  const [recDismissed, setRecDismissed] = useState(null);
  const [, setWfTick] = useState(0);
  const workflowRec = recommendWorkflow(activeTaskTitle, RT.BUILTIN_WORKFLOWS, RT.WORKBENCH.workflowId);
  const applyWorkflow = (id) => { RT.WORKBENCH.workflowId = id; setWfTick((n) => n + 1); setRecDismissed(null); };
  const effectiveRec = workflowRec && recDismissed !== workflowRec.id ? workflowRec : null;
  const st = useMemo(() => {
    const s = sceneAt(localLive ? 0 : scene.clock);
    if (decided) s.decision = null;
    return localLive ? buildLocalScene(s, activeLocalTurns.length ? activeLocalTurns : localTurns, agents) : s;
  }, [scene.clock, decided, localLive, activeLocalTurns, localTurns, agents]);
  useEffect(() => { if (scene.clock < 200) setDecided(false); }, [scene.clock]);
  useEffect(() => {
    if (!compact) return;
    setRailOpen(false);
    setNotesOpen(false);
  }, [compact]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (dmAgent) setDmAgent(null);
      else if (breakoutOpen) setBreakoutOpen(false);
      else if (hubOpen) setHubOpen(false);
      else if (zoomWB) setZoomWB(false);
      else if (drawerArt) setDrawerArt(null);
      else if (modal) setModal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    const r = document.documentElement;
    r.dataset.aesthetic = t.aesthetic;
    r.dataset.theme = t.theme;
    r.dataset.density = t.density;
  }, [t.aesthetic, t.theme, t.density]);

  // Turns are saved in the turn store under whatever chatId was sent to
  // /api/orchestrator/turn: the real chat id when signed in, else the local
  // fallback id. Poll history under the *same* id, or we'd query an empty chat.
  const turnChatId = authed ? activeChatId : localChatId;
  const loadLocalHistory = useCallback(async () => {
    if (!turnChatId) return;
    try {
      const res = await fetch(`/api/orchestrator/history?chatId=${turnChatId}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.ok) return;
      let storedTurns = data.turns || [];
      if (!authed && storedTurns.length === 0) {
        const fallbackRes = await fetch('/api/orchestrator/history', { cache: 'no-store' });
        const fallbackData = await fallbackRes.json();
        if (fallbackRes.ok && fallbackData.ok) storedTurns = fallbackData.turns || [];
      }
      const turns = storedTurns.map(storedTurnToLiveTurn);
      setLocalTurns(turns);
      setSelectedLocalTurnId((current) => (
        current && turns.some((turn) => turn.id === current)
          ? current
          : (turns[0]?.id ?? null)
      ));
    } catch {
      // Local history is a dev convenience; a fresh turn should still work.
    }
  }, [authed, turnChatId]);

  useEffect(() => {
    if (authStatus === 'loading') return;
    loadLocalHistory();
  }, [authStatus, loadLocalHistory]);

  // Dispatch runs in the background on the server (fire-and-forget), so while a
  // turn's dispatch is 'running' we poll history to fill in artifacts as they
  // land — instead of holding a multi-minute request open and timing out.
  const localInFlight = localTurns.some(
    (turn) => turn.result?.dispatchStatus === 'running',
  );
  // Drive the homepage workflow strip from the currently selected local run.
  const latestTurnResult = (activeLocalTurn || latestLiveTurn(localTurns))?.result;
  const liveWorkflow = latestTurnResult?.workflow;
  const liveWorkflowRun = latestTurnResult?.workflowRun;
  useEffect(() => {
    if (!localInFlight) return;
    const iv = setInterval(() => { loadLocalHistory(); }, 2500);
    return () => clearInterval(iv);
  }, [localInFlight, loadLocalHistory]);

  const onAction = (id) => {
    if (id === 'preview') setDrawerArt(RT.ARTIFACTS.preview);
    if (id === 'fix') setDrawerArt(RT.ARTIFACTS.diff);
    if (id === 'deploy') setDrawerArt(RT.ARTIFACTS.preview);
    if (id.indexOf('decide:') === 0) setDecided(true);
  };
  const pickChat = (id) => {
    setSelectedChatId(id);
    const chat = chatsQ.data?.find((c) => c.id === id);
    if (chat) setSelectedWorkbenchId(chat.workbenchId);
  };
  const pickLocalTurn = (id) => {
    setSelectedLocalTurnId(id);
    setInspectorTab('chat');
    setNotesOpen(true);
  };
  const pickWorkbench = (id) => {
    setSelectedWorkbenchId(id);
    const firstChat = chatsQ.data?.find((c) => c.workbenchId === id);
    setSelectedChatId(firstChat?.id ?? null);
  };
  const ensureWorkbench = async () => {
    if (activeWorkbench?.id) return activeWorkbench;
    if (liveWorkbenches.length > 0) {
      setSelectedWorkbenchId(liveWorkbenches[0].id);
      return liveWorkbenches[0];
    }
    const created = await createWorkbench.mutateAsync({
      name: 'Product Squad',
      description: 'Default workbench created from the Roundtable UI.',
    });
    setSelectedWorkbenchId(created.id);
    return created;
  };
  const sendLocalTurn = async (message, turnId, chatIdOverride) => {
    const id = turnId || 'live-' + Date.now();
    const createdAt = new Date().toISOString();
    setInspectorTab('chat');
    setNotesOpen(true);
    setSelectedLocalTurnId(id);
    setLocalStatus('pending');
    setLocalTurns((turns) => [{ id, message, createdAt, status: 'pending' }, ...turns]);
    try {
      const res = await fetch('/api/orchestrator/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          turnId: id,
          chatId: chatIdOverride ?? localChatId,
          ...preferredAgentAdapterRequest(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'orchestrator_turn_failed');
      }
      setLocalTurns((turns) => turns.map((turn) => (
        turn.id === id ? { ...turn, status: 'done', result: data } : turn
      )));
      setLocalStatus('idle');
    } catch (error) {
      const errorText = error instanceof Error ? error.message : 'orchestrator_turn_failed';
      setLocalTurns((turns) => turns.map((turn) => (
        turn.id === id ? { ...turn, status: 'error', error: errorText } : turn
      )));
      setLocalStatus('error');
    }
  };
  // The planner parked this turn with clarifying questions; send the user's
  // picks, then auto-dispatch the now-planned turn so the table starts working.
  const answerLocalClarification = async (turnId, answers) => {
    setLocalTurns((turns) => turns.map((turn) => (
      turn.id === turnId ? { ...turn, clarifying: true, clarifyError: null } : turn
    )));
    try {
      const res = await fetch('/api/orchestrator/clarify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId, answers }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'clarify_failed');
      // Replace the parked turn with the planned one, then dispatch it.
      setLocalTurns((turns) => turns.map((turn) => (
        turn.id === turnId
          ? { ...turn, clarifying: false, status: 'done', result: data }
          : turn
      )));
      await sendDispatch(turnId);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : 'clarify_failed';
      setLocalTurns((turns) => turns.map((turn) => (
        turn.id === turnId ? { ...turn, clarifying: false, clarifyError: errorText } : turn
      )));
    }
  };
  // Kick off dispatch for an already-planned (approved) turn and poll for results.
  const sendDispatch = async (turnId) => {
    try {
      const res = await fetch('/api/orchestrator/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId, ...preferredAgentAdapterRequest() }),
      });
      const data = await res.json();
      if (res.ok && data.ok) loadLocalHistory();
    } catch {
      loadLocalHistory();
    }
  };
  const approveLocalTurn = async (turnId) => {
    setLocalTurns((turns) => turns.map((turn) => (
      turn.id === turnId ? { ...turn, approving: true, approvalError: null } : turn
    )));
    try {
      const res = await fetch('/api/orchestrator/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          turnId,
          decision: 'approve',
          autoDispatch: true,
          ...preferredAgentAdapterRequest(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'approval_failed');
      }
      setLocalTurns((turns) => turns.map((turn) => (
        turn.id === turnId
          ? {
              ...turn,
              approving: false,
              approvalError: null,
              result: {
                ...turn.result,
                needsApproval: data.needsApproval,
                approvalStatus: data.approvalStatus,
                approvedAt: data.approvedAt,
                dispatchStatus: data.dispatchStatus,
                dispatchAdapter: data.dispatchAdapter,
                dispatchedAt: data.dispatchedAt,
                dispatchStage: data.dispatchStage,
                dispatchError: data.dispatchError,
                dispatchWorkspacePath: data.workspacePath,
                dispatch: data.records,
                artifacts: data.artifacts,
                ...(data.workflowRun ? { workflowRun: data.workflowRun } : {}),
              },
            }
          : turn
      )));
    } catch (error) {
      const errorText = error instanceof Error ? error.message : 'approval_failed';
      setLocalTurns((turns) => turns.map((turn) => (
        turn.id === turnId ? { ...turn, approving: false, approvalError: errorText } : turn
      )));
    }
  };
  const interruptLocalTurn = async (turnId) => {
    setLocalTurns((turns) => turns.map((turn) => (
      turn.id === turnId ? { ...turn, interrupting: true, interruptError: null } : turn
    )));
    try {
      const res = await fetch('/api/orchestrator/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'interrupt_failed');
      }
      setLocalTurns((turns) => turns.map((turn) => (
        turn.id === turnId
          ? {
              ...turn,
              interrupting: false,
              result: { ...turn.result, dispatchStage: 'interrupting' },
            }
          : turn
      )));
    } catch (error) {
      const errorText = error instanceof Error ? error.message : 'interrupt_failed';
      setLocalTurns((turns) => turns.map((turn) => (
        turn.id === turnId ? { ...turn, interrupting: false, interruptError: errorText } : turn
      )));
    }
  };
  const redispatchLocalTurn = async (turnId, agentAdapter) => {
    setLocalTurns((turns) => turns.map((turn) => (
      turn.id === turnId
        ? {
            ...turn,
            discarded: false,
            interruptError: null,
            result: { ...turn.result, dispatchStatus: 'running', dispatchStage: 'dispatch', dispatchError: undefined },
          }
        : turn
    )));
    try {
      const res = await fetch('/api/orchestrator/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId, ...(agentAdapter ? { agentAdapter } : {}) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'dispatch_failed');
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : 'dispatch_failed';
      setLocalTurns((turns) => turns.map((turn) => (
        turn.id === turnId ? { ...turn, interruptError: errorText } : turn
      )));
      loadLocalHistory();
    }
  };
  const discardLocalTurn = (turnId) => {
    setLocalTurns((turns) => turns.map((turn) => (
      turn.id === turnId ? { ...turn, discarded: true } : turn
    )));
  };
  const createLocalTask = (goal) => {
    setModal(null);
    setView('roundtable');
    setInspectorTab('chat');
    setNotesOpen(true);
    sendLocalTurn(goal);
  };
  const sendComposerMessage = async (message) => {
    if (authed) {
      if (activeChatId) {
        createMessage.mutate({ chatId: activeChatId, content: message });
        sendLocalTurn(message, undefined, activeChatId);
      } else {
        const workbench = await ensureWorkbench();
        const chat = await createChat.mutateAsync({ title: message.slice(0, 160), workbenchId: workbench.id });
        if (chat) {
          await createMessage.mutateAsync({ chatId: chat.id, content: message });
          sendLocalTurn(message, undefined, chat.id);
        }
      }
      return;
    }
    sendLocalTurn(message);
  };
  const memory = {
    live: authed,
    workbench: activeWorkbench,
    profile: profileQ.data,
    pins: pinsQ.data ?? [],
    profileSaving: updateProfile.isPending,
    pinSaving: pinWorkbench.isPending || unpinWorkbench.isPending,
    profileError: updateProfile.error?.message,
    pinError: pinWorkbench.error?.message || unpinWorkbench.error?.message,
    onSaveProfile: (patch) => updateProfile.mutate(patch),
    onAddPin: (content) => {
      if (!activeWorkbenchId) return;
      pinWorkbench.mutate({ workbenchId: activeWorkbenchId, content });
    },
    onRemovePin: (id) => {
      if (!activeWorkbenchId) return;
      unpinWorkbench.mutate({ workbenchId: activeWorkbenchId, id });
    },
  };
  const breakoutData = RT.SCRIPT.find((b) => b.kind === 'breakout');

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <TopBar t={t} setTweak={setTweak} view={view} setView={setView} />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {railOpen && !compact && <ConversationRail workbench={railWorkbench} workbenches={railWorkbenches}
          tasks={tasks} agents={agents} activeId={authed ? activeChatId : activeLocalTaskId} onPick={authed ? pickChat : pickLocalTurn}
          memberIds={memberIds} onRemoveMember={(id) => setMemberIds((m) => m.filter((x) => x !== id))}
          onAddMember={() => setModal('agent')} onNewTask={() => setModal('task')} onNewWorkbench={() => setModal('table')}
          onPickWorkbench={pickWorkbench} onCollapse={() => setRailOpen(false)}
          onDelete={authed ? (id) => { deleteChat.mutate({ id }); if (id === selectedChatId) setSelectedChatId(null); } : undefined} />}
        {railOpen && compact && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 110, background: alpha('#000', 30), display: 'flex' }}
            onClick={() => setRailOpen(false)}>
            <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(320px, 86vw)', height: '100%' }}>
              <ConversationRail workbench={railWorkbench} workbenches={railWorkbenches}
                tasks={tasks} agents={agents} activeId={authed ? activeChatId : activeLocalTaskId} onPick={authed ? pickChat : pickLocalTurn}
                memberIds={memberIds} onRemoveMember={(id) => setMemberIds((m) => m.filter((x) => x !== id))}
                onAddMember={() => setModal('agent')} onNewTask={() => setModal('task')} onNewWorkbench={() => setModal('table')}
                onPickWorkbench={pickWorkbench} onCollapse={() => setRailOpen(false)}
                onDelete={authed ? (id) => { deleteChat.mutate({ id }); if (id === selectedChatId) setSelectedChatId(null); } : undefined} />
            </div>
          </div>
        )}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)', position: 'relative' }}>
          {!railOpen && (
            <button onClick={() => setRailOpen(true)} title="Show sidebar" style={{ position: 'absolute', top: 12, left: 12, zIndex: 60,
              display: 'grid', placeItems: 'center', width: 34, height: 34, borderRadius: 'var(--r-sm)', cursor: 'pointer',
              border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', boxShadow: 'var(--shadow-card)' }}>
              <Icon name="layers" size={16} />
            </button>
          )}
          {view === 'roundtable' && (
            <>
              <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minWidth: 0 }}>
                      <>
                        <RoundtableScene agents={agents} scene={st} onOpenArtifact={setDrawerArt}
                          onAction={onAction} onOpenBreakouts={() => setHubOpen(true)} onSeatClick={(id) => setDmAgent(id)}
                          onOpenFiles={() => { setInspectorTab('files'); setNotesOpen(true); }}
                          onZoomWhiteboard={() => setZoomWB(true)} wide={!railOpen && !notesOpen} memberIds={memberIds} />
                        {!notesOpen && (
                          <button onClick={() => { setInspectorTab('chat'); setNotesOpen(true); }} style={{ position: 'absolute', top: 14, right: 14, zIndex: 50,
                            display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 'var(--r-chip)',
                            border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)',
                            font: 'inherit', fontSize: 12.5, fontWeight: 500, cursor: 'pointer', boxShadow: 'var(--shadow-card)' }}>
                            <Icon name="messages" size={14} /> Chat
                          </button>
                        )}
                        {!st.started && !activeChatId && (
                          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 45, pointerEvents: 'none' }}>
                            <div className="rt-rise" style={{ pointerEvents: 'auto', width: 'min(420px, 84%)', textAlign: 'center',
                              background: 'color-mix(in oklab, var(--surface) 92%, transparent)', backdropFilter: 'blur(6px)',
                              border: '1px solid var(--border)', borderRadius: 'var(--r-card)', boxShadow: 'var(--shadow-pop)', padding: '22px 24px' }}>
                              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}><LogoMark size={30} /></div>
                              <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 5 }}>Product Squad is ready</div>
                              <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 14 }}>
                                A full team and a proven workflow, out of the box. Describe what to build — the facilitator plans it and the table gets to work.</div>
                              <div style={{ display: 'flex', justifyContent: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
                                {['Plan', 'Build', 'Review', 'Ship'].map((s, i) => (
                                  <React.Fragment key={s}>
                                    {i > 0 && <Icon name="chevron" size={12} style={{ color: 'var(--text-faint)', alignSelf: 'center' }} />}
                                    <span style={{ fontSize: 11.5, fontWeight: 500, padding: '3px 10px', borderRadius: 4,
                                      background: 'var(--surface-2)', color: 'var(--text-muted)' }}>{s}</span>
                                  </React.Fragment>
                                ))}
                              </div>
                              <div style={{ display: 'flex', gap: 9, justifyContent: 'center' }}>
                                <button onClick={() => setModal('task')} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 16px',
                                  borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer', background: 'var(--accent)', color: '#fff',
                                  font: 'inherit', fontSize: 13, fontWeight: 500 }}><Icon name="plus" size={15} /> Start a task</button>
                              </div>
                            </div>
                          </div>
                        )}
                      </>
                </div>
                {notesOpen && !compact && <ResizeHandle onResize={(dx) => setInspectorW((w) => Math.max(300, Math.min(640, w + dx)))} />}
                {notesOpen && <InspectorPanel tab={inspectorTab} setTab={setInspectorTab} clock={scene.clock} width={compact ? 'min(100vw, 420px)' : inspectorW}
                  agents={agents} scene={scene} live={authed && !!activeChatId} liveArtifacts={liveArtifacts} liveMessages={liveMessages}
                  liveHandoffs={liveHandoffs} activeChatId={activeChatId} memory={memory}
                  localTurns={activeLocalTurns.length ? activeLocalTurns : localTurns} localStatus={localStatus} onApproveLocalTurn={approveLocalTurn}
                  localTurnActions={{ interrupt: interruptLocalTurn, redispatch: redispatchLocalTurn, discard: discardLocalTurn, clarify: answerLocalClarification }}
                  onOpenArtifact={setDrawerArt} onAction={onAction} onClose={() => setNotesOpen(false)}
                  onRewrite={sendComposerMessage} />}
              </div>
              <Dock st={st} agents={agents} scene={scene} onAction={onAction}
                onOpenChat={() => { setInspectorTab('chat'); setNotesOpen(true); }}
                onOpenWorkflow={() => setView('workflow')}
                onSend={sendComposerMessage}
                liveStatus={localStatus}
                rec={effectiveRec} onUseWorkflow={applyWorkflow} onDismissRec={() => setRecDismissed(workflowRec?.id)}
                workflow={liveWorkflow} workflowRun={liveWorkflowRun} />
            </>
          )}
          {view === 'workflow' && <WorkflowView agents={agents} onAddAgent={() => setModal('agent')} onOpenTemplates={() => setModal('table')} />}
        </div>
      </div>

      {drawerArt && <Drawer art={drawerArt} agents={agents} onClose={() => setDrawerArt(null)} />}
      {zoomWB && <WhiteboardZoom tasks={st.tasks} agents={agents} live={st.live} run={st.run} posted={st.planPosted} onClose={() => setZoomWB(false)} />}
      {breakoutOpen && <BreakoutModal data={breakoutData} agents={agents} onClose={() => setBreakoutOpen(false)}
        onBringBack={() => { setInspectorTab('notes'); setNotesOpen(true); }} />}
      {hubOpen && <BreakoutsHub agents={agents} memberIds={memberIds} autoRoom={st.breakout ? breakoutData : null}
        onEnterAuto={() => { setHubOpen(false); setBreakoutOpen(true); }}
        onStartDM={(id) => { setHubOpen(false); setDmAgent(id); }} onClose={() => setHubOpen(false)} />}
      {dmAgent && <DMRoom agent={agents[dmAgent]}
        activeTask={(['working', 'speaking', 'thinking'].includes(st.status[dmAgent])) ? (RT.PLAN.tasks.find((tk) => tk.owner === dmAgent) || {}).id : null}
        onClose={() => setDmAgent(null)} />}
      {modal === 'task' && <NewTaskModal workbench={railWorkbench} members={memberIds} agents={agents}
        onClose={() => setModal(null)} onCreate={async (goal) => {
          setModal(null);
          if (authed) {
            const workbench = await ensureWorkbench();
            const chat = await createChat.mutateAsync({ title: goal.slice(0, 160), workbenchId: workbench.id });
            if (chat) {
              await createMessage.mutateAsync({ chatId: chat.id, content: goal });
              sendLocalTurn(goal, undefined, chat.id);
            }
          } else {
            createLocalTask(goal);
          }
        }} />}
      {modal === 'table' && <NewWorkbenchModal agents={agents} onClose={() => setModal(null)} onCreate={(input) => {
        if (authed) {
          createWorkbench.mutate({
            name: input.name,
            workspacePath: `workspaces/${Date.now()}`,
            description: `Created from ${input.workflowId}.`,
          }, {
            onSuccess: (workbench) => {
              setSelectedWorkbenchId(workbench.id);
              setSelectedChatId(null);
            },
          });
        }
        setView('workflow');
        setModal(null);
      }} />}
      {modal === 'agent' && <AddAgentModal onClose={() => setModal(null)} onAdd={({ role, name, color }) => {
        const id = 'a-' + Date.now();
        RT.AGENTS[id] = { agentId: id, role, displayName: name, color };
        setMemberIds((m) => [...m, id]);
        persistCustomAgents();
        setModal(null);
      }} />}
      {/* dev tweaks panel removed in port */}
    </div>
  );
}

export default App;
