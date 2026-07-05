'use client';
/* ============================================================================
   Roundtable — app.jsx
   Top-level: timeline driver, drawer, Table scene + Gallery, controls, Tweaks.
   ============================================================================ */

import React from 'react';
import { RT } from '../lib/rt';
import { Avatar, Icon, Spinner, Md, tint, alpha } from './primitives';
import { iconBtn } from './cards';
import { ConversationRail, LogoMark } from './chat';
import { RoundtableScene, WhiteboardZoom, sceneAt } from './roundtable';
import { WorkflowView } from './workflow';
import { Modal, NewTaskModal, NewWorkbenchModal, AddAgentModal } from './modals';
import { TopBar, recommendWorkflow, Dock } from './stage-scene';
import { LiveTranscriptFeed } from './live-turn';
import { Drawer, InspectorPanel } from './inspector';
import { latestLiveTurn, buildLocalScene } from '../lib/live-scene';
import { withBundledPreview } from '../lib/preview-html';
import { signOut, useSession } from 'next-auth/react';
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

/* ---- turn → sidebar task summary ----------------------------------------- */
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
            missionId: turn.missionId,
            workflowTemplateId: turn.workflowTemplateId,
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
            mission: turn.mission,
            needsClarification: turn.needsClarification,
            clarifyQuestions: turn.clarifyQuestions,
            clarifyAnswers: turn.clarifyAnswers,
            liveActivity: turn.liveActivity,
          },
        }
      : { error: turn.error || 'orchestrator_turn_failed' }),
  };
}


// Don't force an adapter from the client. The server resolves settings/env first,
// then configured model APIs, and only falls back to local-dispatch.
// Forcing 'local-dispatch' here was overriding real-model adapters and producing
// template stubs.
function preferredAgentAdapterRequest() {
  return {};
}

function randomClientId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.().replace(/-/g, '');
  const fallback = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${(uuid || fallback).slice(0, 16)}`;
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

const YOU_ROOM_AGENT = {
  agentId: 'you',
  role: 'chair',
  displayName: 'You',
  color: 'var(--accent)',
};

function roomAgent(agents, id) {
  if (id === 'you') return YOU_ROOM_AGENT;
  return agents?.[id] || {
    agentId: id || 'agent',
    role: id || 'agent',
    displayName: id || 'Agent',
    color: 'var(--text-muted)',
  };
}

function breakoutAgentReply(text) {
  const value = text.trim();
  if (/[?？]|吗\b|么\b/.test(value)) {
    return '我看到了。我的初步判断是可以继续推进，但我会先把关键约束和可执行动作拆清楚，避免直接把半成形想法带回主桌。';
  }
  if (/好看|视觉|样式|design|ui/i.test(value)) {
    return '收到。我会从视觉一致性、可读性和是否影响现有布局这三点来看；如果要执行，会只带回明确的改动项。';
  }
  if (/可以|去做|执行|开始|ship|build/i.test(value)) {
    return '明白。如果你觉得方向已经定了，可以把这段整理成一个 handoff，再确认发送到主 chat 执行。';
  }
  return '收到。我会把这条作为 side-room context 保留；等你准备好了，可以整理成 handoff 带回主 chat。';
}

function summarizeBreakoutContextText(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 220) : undefined;
}

function chooseLocalBreakoutResponder(room, agents, text) {
  const ids = [room?.a, room?.b].filter(Boolean);
  const lower = text.toLowerCase();
  const mentioned = ids.find((id) => {
    const agent = agents[id];
    const mention = agent?.mention || id;
    const name = agent?.displayName || id;
    return new RegExp(`@${mention}\\b`, 'i').test(text) || new RegExp(`\\b${name}\\b`, 'i').test(lower);
  });
  if (mentioned) return { id: mentioned, reason: `the user explicitly mentioned ${agents[mentioned]?.displayName || mentioned}` };
  const scored = ids.map((id, index) => {
    const role = agents[id]?.role || id;
    const matched = [];
    let score = 0;
    const add = (label, value, pattern) => {
      if (!pattern.test(text)) return;
      score += value;
      matched.push(label);
    };
    if (role === 'planner') add('planning/handoff', 8, /handoff|workflow|breakout|room|agent|context|mission|plan|task|scope|规划|计划|流程|拆解|任务|分工|边界|上下文|主线|房间|带回|交接|执行/i);
    if (role === 'pm') add('product/requirements', 8, /product|requirement|user|ux|copy|value|acceptance|spec|产品|需求|用户|体验|文案|价值|验收|范围/i);
    if (role === 'architect') add('architecture/system', 8, /architecture|system|data model|schema|contract|dependency|api design|架构|系统|数据模型|表结构|接口设计|依赖|技术方案/i);
    if (role === 'implementer') {
      add('implementation', 7, /implement|build|code|component|css|react|bug|error|debug|api|database|frontend|backend|实现|代码|组件|页面|按钮|样式|报错|调试|接口|数据库|前端|后端/i);
      if (id === 'atlas') add('frontend/ui', 3, /ui|frontend|react|css|component|button|layout|visual|界面|前端|组件|按钮|布局|视觉|样式/i);
      if (id === 'beam') add('backend/api', 3, /backend|api|database|server|postgres|auth|oauth|session|后端|接口|数据库|服务端|登录|鉴权|认证/i);
    }
    if (role === 'reviewer') add('review/risk', 8, /review|risk|qa|test|quality|regression|accessibility|security|评审|风险|测试|质量|回归|可访问|安全|验收|检查/i);
    if (role === 'fixer') add('fix/debug', 8, /fix|repair|debug|failure|failing|broken|修复|修一下|debug|失败|坏了|报错/i);
    return { id, score: score - index * 0.01, matched };
  }).sort((a, b) => b.score - a.score);
  const winner = scored[0] || { id: ids[0] || 'orchestrator', score: 0, matched: [] };
  return {
    id: winner.id,
    reason: winner.score > 0
      ? `${agents[winner.id]?.displayName || winner.id}'s responsibility matched ${winner.matched.join(', ')}`
      : `${agents[winner.id]?.displayName || winner.id} is the first participant and no stronger responsibility match was found`,
  };
}

function buildHandoffDraft(data, targetAgentId, agents) {
  const transcript = (data?.transcript || []).filter((item) => !item.pending);
  const meaningfulTranscript = transcript.filter((item) => !isTrivialHandoffText(item.text));
  const latestUser = [...meaningfulTranscript].reverse().find((item) => item.agentId === 'you');
  const targetAgent = roomAgent(agents, targetAgentId);
  const latestTargetReply = [...meaningfulTranscript].reverse().find((item) => item.agentId === targetAgentId);
  const latestAgentReply = [...meaningfulTranscript].reverse().find((item) => item.agentId !== 'you');
  const relevant = transcript.slice(-4).map((item, index) => ({
    id: item.id,
    label: item.agentId === 'you' ? 'You' : roomAgent(agents, item.agentId).displayName,
    text: item.text,
    fallbackId: `room-msg-${Math.max(1, transcript.length - 3 + index)}`,
  }));
  const constraints = transcript
    .map((item) => item.text)
    .filter((text) => /(must|keep|don't|do not|不能|不要|必须|保留|约束|边界|只|不可以)/i.test(text))
    .slice(-3)
    .map((text) => summarizeBreakoutContextText(text))
    .filter(Boolean);
  const taskText = latestUser?.text || latestAgentReply?.text || `Follow up from this breakout with ${targetAgent.displayName}.`;
  const whyText = latestTargetReply?.text || latestAgentReply?.text || latestUser?.text || 'The breakout discussion reached an action-ready decision.';
  return {
    targetAgentId,
    task: taskText,
    constraints,
    why: summarizeBreakoutContextText(whyText) || '',
    summary: transcript.slice(-3).map((item) => item.text).join(' '),
    relevantMessageIds: relevant.map((item) => item.id).filter(Boolean),
    references: relevant,
  };
}

function isTrivialHandoffText(text) {
  const cleaned = String(text || '').replace(/\s+/g, '').trim().toLowerCase();
  if (!cleaned) return true;
  if (cleaned.length <= 8 && /^(ok|okay|好|好的|可以|好的可以|行|嗯|收到|明白|yes|yep|sure)$/.test(cleaned)) return true;
  return false;
}



/* ---- Breakout room (a real side room you can sit in) --------------------- */
function BreakoutModal({ data, agents, onClose, onSend, onSendHandoff, handoffBusy }) {
  const [val, setVal] = useState('');
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [task, setTask] = useState('');
  const [constraint, setConstraint] = useState('');
  const [why, setWhy] = useState('');
  if (!data) return null;
  const a = roomAgent(agents, data.a), b = roomAgent(agents, data.b);
  const transcript = data.transcript || [];
  const lastMessage = transcript[transcript.length - 1];
  const waitingForReply = lastMessage?.agentId === 'you' || lastMessage?.pending;
  const latestProposal = (data.proposals || []).find((proposal) => proposal.status === 'draft') || null;
  const targetAgentId = data.a === 'you' ? data.b : data.a;
  const targetAgent = roomAgent(agents, targetAgentId);
  const contextLabel = `${a.displayName} & ${b.displayName} · ${transcript.length} messages`;
  const generatedDraft = buildHandoffDraft(data, targetAgentId, agents);
  const draftTask = task || latestProposal?.task || '';
  const draftWhy = why || latestProposal?.why || '';
  const draftConstraint = constraint || (latestProposal?.constraints || [])[0] || '';
  const openHandoff = () => {
    setTask((current) => current || latestProposal?.task || generatedDraft.task);
    setConstraint((current) => current || (latestProposal?.constraints || generatedDraft.constraints)[0] || '');
    setWhy((current) => current || latestProposal?.why || generatedDraft.why);
    setHandoffOpen(true);
  };
  const handoffPayload = () => {
    const nextTask = (task || latestProposal?.task || generatedDraft.task).trim();
    const nextConstraint = draftConstraint.trim();
    return {
      roomId: data.id,
      targetAgentId,
      task: nextTask,
      constraints: nextConstraint ? [nextConstraint] : (latestProposal?.constraints || generatedDraft.constraints),
      summary: generatedDraft.summary,
      why: draftWhy.trim() || generatedDraft.why,
      relevantMessageIds: generatedDraft.relevantMessageIds,
    };
  };
  const sendHandoff = () => {
    const payload = handoffPayload();
    if (!payload.task) return;
    if (latestProposal) {
      onSendHandoff && onSendHandoff(latestProposal.id, {
        task: payload.task,
        constraints: payload.constraints,
        why: payload.why,
      });
      return;
    }
    onSendHandoff && onSendHandoff(null, payload);
  };
  const sendNote = () => {
    const text = val.trim();
    if (!text) return;
    onSend && onSend(data.id, text);
    setVal('');
  };
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
          {transcript.map((t, i) => {
            const ag = roomAgent(agents, t.agentId);
            return (
              <div key={i} style={{ display: 'flex', gap: 10 }}>
                <Avatar agent={ag} size={28} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: ag.color, fontWeight: 600, marginBottom: 2 }}>{ag.displayName}</div>
                  <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '4px 12px 12px 12px',
                    padding: '9px 12px', fontSize: 13.5, color: t.pending ? 'var(--text-faint)' : 'var(--text)', lineHeight: 1.5 }}>
                    {t.pending ? <span className="rt-shimmer">{t.text}</span> : t.text}</div>
                </div>
              </div>
            );
          })}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, alignSelf: 'center', fontSize: 11.5, color: 'var(--text-faint)',
            padding: '4px 12px', borderRadius: 999, background: 'var(--surface-2)' }}>
            {waitingForReply
              ? <><Spinner size={12} color="var(--accent)" /> waiting for room reply</>
              : <><Icon name="check" size={12} style={{ color: 'var(--ok)' }} /> aligned — outcome ready to share</>}
          </div>
        </div>
        <div style={{ padding: '11px 14px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {handoffOpen && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface-2)',
              padding: 12, display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="send" size={14} style={{ color: 'var(--accent)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>Handoff card</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Send to {targetAgent.displayName} when you confirm</div>
                </div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 7px', borderRadius: 999,
                  background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 11.5, color: 'var(--text-muted)' }}>
                  <Avatar agent={targetAgent} size={16} /> {targetAgent.displayName}
                </span>
                <button onClick={() => setHandoffOpen(false)} style={{ ...iconBtn, width: 24, height: 24, border: 'none', background: 'transparent' }}>
                  <Icon name="x" size={13} />
                </button>
              </div>
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Do</span>
                <textarea value={draftTask} onChange={(e) => setTask(e.target.value)} rows={2}
                  placeholder={`What should ${targetAgent.displayName} do?`}
                  style={{ resize: 'vertical', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface)',
                    font: 'inherit', fontSize: 13, color: 'var(--text)', padding: '8px 10px', outline: 'none' }} />
              </label>
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Why</span>
                <textarea value={draftWhy} onChange={(e) => setWhy(e.target.value)} rows={2}
                  placeholder="Why this is ready to bring back"
                  style={{ resize: 'vertical', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface)',
                    font: 'inherit', fontSize: 13, color: 'var(--text)', padding: '8px 10px', outline: 'none' }} />
              </label>
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Must keep</span>
                <input value={draftConstraint} onChange={(e) => setConstraint(e.target.value)}
                  placeholder="Optional constraint"
                  style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface)',
                    font: 'inherit', fontSize: 13, color: 'var(--text)', padding: '8px 10px', outline: 'none' }} />
              </label>
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface)',
                padding: '8px 10px', display: 'grid', gap: 5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700,
                  color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  <Icon name="door" size={12} /> References
                </div>
                {(generatedDraft.references || []).length ? (
                  generatedDraft.references.slice(-3).map((ref) => (
                    <div key={ref.id || ref.fallbackId} style={{ display: 'grid', gap: 2 }}>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600 }}>{ref.label}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.35 }}>{summarizeBreakoutContextText(ref.text)}</div>
                    </div>
                  ))
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>No room messages selected yet.</div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-faint)', paddingTop: 2 }}>
                  <Icon name="layers" size={12} /> Uses {contextLabel}; private transcript stays here.
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={sendHandoff} disabled={!draftTask.trim() || handoffBusy}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 'var(--r-sm)',
                    border: 'none', background: draftTask.trim() && !handoffBusy ? 'var(--accent)' : 'var(--surface-3)',
                    color: draftTask.trim() && !handoffBusy ? '#fff' : 'var(--text-faint)', font: 'inherit', fontSize: 12.5,
                    fontWeight: 700, cursor: draftTask.trim() && !handoffBusy ? 'pointer' : 'default' }}>
                  {handoffBusy ? <Spinner size={13} color="currentColor" /> : <Icon name="send" size={13} />}
                  {handoffBusy ? 'Sending' : 'Send to main chat'}
                </button>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 9 }}>
            <textarea value={val} onChange={(e) => setVal(e.target.value)} rows={1} placeholder="Join in — add a note to the room…"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendNote();
                }
              }}
              style={{ flex: 1, resize: 'none', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface-2)',
                font: 'inherit', fontSize: 13.5, color: 'var(--text)', padding: '9px 11px', outline: 'none', maxHeight: 90 }} />
            <button onClick={sendNote} style={{ display: 'grid', placeItems: 'center', width: 38, height: 38, borderRadius: 'var(--r-sm)',
              border: 'none', cursor: val.trim() ? 'pointer' : 'default', background: val.trim() ? 'var(--accent)' : 'var(--surface-3)',
              color: val.trim() ? '#fff' : 'var(--text-muted)', flexShrink: 0 }}><Icon name="send" size={16} /></button>
          </div>
          <button onClick={openHandoff} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            gap: 7, padding: '10px', borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer', background: 'var(--accent)', color: '#fff',
            font: 'inherit', fontSize: 13, fontWeight: 600 }}>
            <Icon name="layers" size={15} /> Ready to send to main chat</button>
        </div>
      </div>
    </div>
  );
}

/* ---- BreakoutsHub : the door's panel — see & start side rooms ------------ */
function BreakoutsHub({ agents, memberIds, rooms, onEnterRoom, onStartRoom, onStartDM, onClose }) {
  const [picked, setPicked] = useState([]);
  const members = (memberIds || []).filter((id) => id !== 'orchestrator' || true).map((id) => agents[id]).filter(Boolean);
  const pickedSet = new Set(picked);
  const togglePick = (id) => {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  };
  const startRoom = () => {
    if (picked.length !== 2) return;
    onStartRoom && onStartRoom(picked[0], picked[1]);
    setPicked([]);
  };
  return (
    <Modal title="Breakout rooms" icon="door" onClose={onClose} width={500}
      sub="Pull people aside for a side conversation — two agents, or a private 1:1 with you.">
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 8 }}>Active rooms</div>
      {rooms && rooms.length ? (
        <div style={{ display: 'grid', gap: 7, marginBottom: 18 }}>
          {rooms.map((room) => {
            const a = roomAgent(agents, room.a), b = roomAgent(agents, room.b);
            return (
              <button key={room.id} onClick={() => onEnterRoom && onEnterRoom(room.id)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px',
                borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', cursor: 'pointer', font: 'inherit',
                textAlign: 'left' }}>
                <span style={{ display: 'flex' }}>
                  <span style={{ zIndex: 1 }}><Avatar agent={a} size={26} /></span>
                  <span style={{ marginLeft: -8 }}><Avatar agent={b} size={26} /></span>
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{a.displayName} &amp; {b.displayName}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{room.summary || 'side conversation'} · {room.turns} turns</div>
                </div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
                  Enter <Icon name="chevron" size={12} /></span>
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic', marginBottom: 18 }}>No side rooms open right now.</div>
      )}

      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 8 }}>Start a breakout</div>
      <div style={{ display: 'grid', gap: 7 }}>
        {members.map((a) => (
          <div key={a.agentId} style={{ display: 'flex', alignItems: 'stretch', gap: 7 }}>
            <button onClick={() => togglePick(a.agentId)} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 12px', borderRadius: 'var(--r-sm)', border: pickedSet.has(a.agentId) ? `1px solid ${a.color}` : '1px solid var(--border)',
              background: pickedSet.has(a.agentId) ? tint(a.color, 10) : 'var(--surface)', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
              <Avatar agent={a} size={26} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{a.displayName}</div>
                <div className="mono" style={{ fontSize: 11, color: a.color }}>{a.pm ? 'facilitator' : '@' + a.role}</div>
              </div>
              <span style={{ display: 'grid', placeItems: 'center', width: 20, height: 20, borderRadius: 999,
                border: pickedSet.has(a.agentId) ? 'none' : '1px solid var(--border-strong)',
                background: pickedSet.has(a.agentId) ? a.color : 'transparent',
                color: pickedSet.has(a.agentId) ? '#fff' : 'transparent' }}>
                <Icon name="check" size={12} />
              </span>
            </button>
            <button onClick={() => onStartDM(a.agentId)} title={`Message ${a.displayName}`} style={{ display: 'grid', placeItems: 'center',
              width: 40, borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)',
              color: 'var(--text-muted)', cursor: 'pointer' }}>
              <Icon name="send" size={14} />
            </button>
          </div>
        ))}
      </div>
      <button onClick={startRoom} disabled={picked.length !== 2} style={{ marginTop: 12, width: '100%', display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center', gap: 7, padding: '10px', borderRadius: 'var(--r-sm)',
        border: 'none', background: picked.length === 2 ? 'var(--accent)' : 'var(--surface-3)',
        color: picked.length === 2 ? '#fff' : 'var(--text-faint)', font: 'inherit', fontSize: 13, fontWeight: 600,
        cursor: picked.length === 2 ? 'pointer' : 'default' }}>
        <Icon name="door" size={15} />
        {picked.length === 2 ? 'Start breakout room' : 'Select two members'}
      </button>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 9, lineHeight: 1.45 }}>
        Use the message button for a private 1:1, or select two members to open a shared side room.
      </div>
    </Modal>
  );
}

/* ---- agentWorkFor : collect one agent's tasks + produced artifacts from the
   latest run, so DMRoom's "Work" tab shows what they actually did (not a mock).
   Owner match is by agentId on both the plan task and the artifact. -------- */
function agentWorkFor(agentId, turnResult) {
  if (!agentId || !turnResult) return { tasks: [], artifacts: [], adapter: null };
  const tasks = (turnResult.plan?.tasks || []).filter((task) => task.owner === agentId);
  const ownedTaskIds = new Set(tasks.map((task) => task.id));
  const records = new Map((turnResult.dispatch || []).map((rec) => [rec.taskId, rec]));
  const artifacts = (turnResult.artifacts || []).filter((art) =>
    art.ownerAgentId === agentId
    || [...ownedTaskIds].some((taskId) => art.id.startsWith(`${taskId}_`)),
  );
  return {
    // Dispatch records are the final per-task truth but only land at end of
    // run; while the agent works, liveActivity carries status + the streaming
    // runtime transcript, so the Work tab can show the process, not a title.
    tasks: tasks.map((task) => {
      const activity = turnResult.liveActivity?.[task.id] || null;
      return {
        ...task,
        activity,
        status: records.get(task.id)?.status || activity?.status || 'pending',
      };
    }),
    artifacts,
    adapter: turnResult.dispatchAdapter || null,
  };
}

const DM_WORK_STATUS = {
  completed: { label: 'done', color: 'var(--ok)' },
  failed: { label: 'failed', color: 'var(--bad)' },
  blocked: { label: 'blocked', color: 'var(--warn)' },
  running: { label: 'working', color: 'var(--run)' },
  stopped: { label: 'stopped', color: 'var(--text-faint)' },
  pending: { label: 'queued', color: 'var(--text-faint)' },
};

// The "Work" tab: this agent's task(s) and the deliverables they produced, each
// expandable to read the real content (HTML renders in an iframe, text as md).
function DMWorkPanel({ agent, work }) {
  const { tasks, artifacts, adapter } = work;
  if (tasks.length === 0 && artifacts.length === 0) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic', padding: '4px 2px' }}>
        {agent.displayName} hasn’t produced anything on this run yet.
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {tasks.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {tasks.map((task) => {
            const st = DM_WORK_STATUS[task.status] || DM_WORK_STATUS.pending;
            return (
              <div key={task.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px',
                borderRadius: 'var(--r-sm)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <span style={{ marginTop: 2, width: 8, height: 8, borderRadius: '50%', background: st.color, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{task.title}</div>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
                    {/* The live feed header below already names the runtime. */}
                    {!task.activity && adapter && <MetaChip label={`via ${adapter}`} />}
                    {(task.deps || []).map((dep) => <MetaChip key={dep} label={`input ${dep}`} />)}
                  </div>
                  {/* Once the runtime is streaming, the live transcript IS the
                      story of this task — the static brief only matters before
                      there is anything real to show. */}
                  {task.activity
                    ? <div style={{ marginTop: 7 }}>
                        <LiveTranscriptFeed activity={task.activity} agents={{ [agent.id]: agent, orchestrator: agent }} compact />
                      </div>
                    : task.brief && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>{task.brief}</div>}
                </div>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: st.color }}>{st.label}</span>
              </div>
            );
          })}
        </div>
      )}
      {artifacts.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase',
            color: 'var(--text-faint)' }}>Deliverables</div>
          {artifacts.map((art) => <DMArtifact key={`${art.id}-${art.version}`} artifact={art} agent={agent} />)}
        </div>
      )}
    </div>
  );
}

function MetaChip({ label }) {
  return (
    <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)', padding: '1px 5px',
      borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>{label}</span>
  );
}

function DMArtifact({ artifact, agent }) {
  const [open, setOpen] = useState(false);
  const content = artifact.preview || artifact.code || '';
  const isHtml = artifact.kind === 'html' || artifact.kind === 'preview';
  return (
    <div style={{ borderRadius: 'var(--r-sm)', background: tint(agent.color, 7),
      border: `1px solid ${alpha(agent.color, 22)}`, overflow: 'hidden' }}>
      <button onClick={() => setOpen((v) => !v)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 10px', background: 'transparent', border: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
        <Icon name={open ? 'chevdown' : 'chevron'} size={12} style={{ color: agent.color }} />
        <Icon name={artifact.kind === 'preview' ? 'eye' : artifact.kind === 'markdown' ? 'clip' : 'code'} size={13}
          style={{ color: agent.color }} />
        <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text)', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifact.title}</span>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${alpha(agent.color, 22)}`, background: 'var(--bg)', padding: '10px 12px',
          maxHeight: 300, overflowY: 'auto' }}>
          {!content
            ? <div style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic' }}>No content captured.</div>
            : isHtml
            ? <iframe title={artifact.title} srcDoc={content} sandbox="allow-scripts"
                style={{ width: '100%', height: 260, border: 'none', background: '#fff', borderRadius: 6 }} />
            : <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text)' }}><Md text={content} /></div>}
        </div>
      )}
    </div>
  );
}

/* ---- DMRoom : click an agent to open their 1:1 room. Two tabs — Chat (steer /
   private note) and Work (what they actually produced on this run). --------- */
function DMRoom({ agent, activeTask, work, onClose }) {
  if (!agent) return null;
  const [tab, setTab] = useState('chat');
  const [val, setVal] = useState('');
  const [messages, setMessages] = useState(() => [
    {
      id: 'intro',
      agentId: agent.agentId,
      text: activeTask
        ? 'Mid-build — tell me what to change and I’ll fold it in.'
        : 'Hey — what would you like to go over, just the two of us?',
    },
  ]);
  const scrollRef = useRef(null);
  const steering = !!activeTask;
  const redirects = ['Use Postgres, not SQLite', 'Add rate limiting', 'Keep it server-rendered'];
  const workCount = (work?.tasks?.length || 0) + (work?.artifacts?.length || 0);
  const tabBtn = (id, label, count) => (
    <button onClick={() => setTab(id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
      borderRadius: 999, cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: 700,
      border: '1px solid ' + (tab === id ? alpha(agent.color, 40) : 'var(--border)'),
      background: tab === id ? tint(agent.color, 12) : 'var(--surface)',
      color: tab === id ? agent.color : 'var(--text-muted)' }}>
      {label}
      {count > 0 && <span style={{ fontSize: 10.5, fontWeight: 800, padding: '0 6px', borderRadius: 999,
        background: tab === id ? alpha(agent.color, 22) : 'var(--surface-3)', color: tab === id ? agent.color : 'var(--text-faint)' }}>{count}</span>}
    </button>
  );
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);
  const sendPrivateMessage = () => {
    const text = val.trim();
    if (!text) return;
    setMessages((prev) => [
      ...prev,
      { id: `you-${Date.now()}`, agentId: 'you', text },
      {
        id: `ack-${Date.now()}`,
        agentId: agent.agentId,
        text: steering
          ? 'Got it — I’ll use that direction for the active task.'
          : 'Got it. I’ll keep this side context here until you bring it back to the table.',
      },
    ]);
    setVal('');
  };
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 115, background: alpha('#000', 34),
      backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="rt-zoom" style={{ width: 'min(480px, 100%)', height: 'min(600px, 88vh)',
        display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderRadius: 'var(--r-card)',
        border: '1px solid var(--border)', borderTop: `2.5px solid ${agent.color}`, boxShadow: 'var(--shadow-pop)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 15px', borderBottom: '1px solid var(--border)' }}>
          <Avatar agent={agent} size={28} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{agent.displayName}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>@{agent.role || agent.id}</div>
          </div>
          <button onClick={onClose} style={iconBtn}><Icon name="x" size={15} /></button>
        </div>
        <div style={{ display: 'flex', gap: 7, padding: '10px 15px 4px' }}>
          {tabBtn('chat', steering ? 'Steer' : 'Chat')}
          {tabBtn('work', 'Work', workCount)}
        </div>
        {tab === 'work' ? (
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 15px 16px', background: 'var(--bg)' }}>
            <DMWorkPanel agent={agent} work={work || { tasks: [], artifacts: [] }} />
          </div>
        ) : (
          <>
            <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 15px', display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--bg)' }}>
              {steering && (
                <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 'var(--r-sm)',
                  background: tint(agent.color, 9), border: `1px solid ${alpha(agent.color, 35)}` }}>
                  <Spinner size={15} color={agent.color} />
                  <div style={{ fontSize: 12.5, color: 'var(--text)' }}>
                    <b>Working on {activeTask}</b> right now. A note here steers the live task without stopping the table.</div>
                </div>
              )}
              {messages.map((message) => {
                const isYou = message.agentId === 'you';
                const speaker = isYou ? YOU_ROOM_AGENT : agent;
                return (
                  <div key={message.id} style={{ display: 'flex', gap: 9, justifyContent: isYou ? 'flex-end' : 'flex-start' }}>
                    {!isYou && <Avatar agent={speaker} size={26} />}
                    <div style={{ background: isYou ? 'var(--accent)' : 'var(--surface)', border: isYou ? 'none' : '1px solid var(--border)',
                      borderRadius: isYou ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
                      padding: '9px 12px', fontSize: 13.5, color: isYou ? '#fff' : 'var(--text)', maxWidth: '80%', lineHeight: 1.5 }}>
                      {message.text}</div>
                    {isYou && <Avatar agent={speaker} size={26} />}
                  </div>
                );
              })}
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
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendPrivateMessage();
                  }
                }}
                style={{ flex: 1, resize: 'none', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface-2)',
                  font: 'inherit', fontSize: 13.5, color: 'var(--text)', padding: '9px 11px', outline: 'none', maxHeight: 100 }} />
              <button onClick={sendPrivateMessage} style={{ display: 'grid', placeItems: 'center', width: 38, height: 38, borderRadius: 'var(--r-sm)',
                border: 'none', cursor: val.trim() ? 'pointer' : 'default', background: val.trim() ? 'var(--accent)' : 'var(--surface-3)',
                color: val.trim() ? '#fff' : 'var(--text-muted)', flexShrink: 0 }}><Icon name="send" size={16} /></button>
            </div>
          </>
        )}
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

// Full center-stage preview of the generated site: takes over the roundtable
// area so the user can see the finished page large, with a browser chrome and a
// close button back to the table.
function CenterPreview({ artifact, onClose }) {
  const html = artifact.preview || artifact.code || '';
  return (
    <div className="rt-rise" style={{ position: 'absolute', inset: 0, zIndex: 48, display: 'flex', flexDirection: 'column',
      background: 'var(--surface-3)', padding: 16 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRadius: 'var(--r-card)', overflow: 'hidden',
        border: '1px solid var(--border)', background: '#fff', boxShadow: 'var(--shadow-pop)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', flexShrink: 0,
          background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          {['#e5687a', '#e6a23c', '#4cc38a'].map((c) => (
            <span key={c} style={{ width: 10, height: 10, borderRadius: '50%', background: c, opacity: .85 }} />
          ))}
          <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--text-faint)', marginLeft: 6,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifact.title}</span>
          <button onClick={onClose} title="Back to the roundtable" style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 10px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text-muted)', font: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            <Icon name="x" size={13} /> Close
          </button>
        </div>
        <iframe title={artifact.title} srcDoc={html} sandbox="allow-scripts allow-forms allow-modals allow-popups"
          style={{ flex: 1, width: '100%', border: 'none', display: 'block', background: '#fff' }} />
      </div>
    </div>
  );
}

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
  const [activeBreakoutId, setActiveBreakoutId] = useState(null);
  const [sideRooms, setSideRooms] = useState([]);
  const [roomNotes, setRoomNotes] = useState({});
  const [hubOpen, setHubOpen] = useState(false);
  const [dmAgent, setDmAgent] = useState(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState('chat');
  const [modal, setModal] = useState(null);
  const [railOpen, setRailOpen] = useState(true);
  const [inspectorW, setInspectorW] = useState(392);
  const [zoomWB, setZoomWB] = useState(false);
  // When on, the center stage shows the generated site full-size instead of the
  // roundtable. Toggled by the "Preview" button once a preview artifact exists.
  const [centerPreview, setCenterPreview] = useState(false);
  const [memberIds, setMemberIds] = useState(RT.WORKBENCH.members);
  useEffect(() => {
    const restored = restoreCustomAgents();
    if (restored.length) setMemberIds((m) => [...m, ...restored.filter((id) => !m.includes(id))]);
  }, []);
  const [localTurns, setLocalTurns] = useState([]);
  const [localStatus, setLocalStatus] = useState('idle');
  // Persisted so a page refresh restores this chat's live turns from history
  // instead of starting an empty session.
  const [localChatId] = useState(() => {
    const key = 'roundtable.localChatId';
    try {
      const existing = window.localStorage.getItem(key);
      if (existing) return existing;
      const next = randomClientId('roundtable-local');
      window.localStorage.setItem(key, next);
      return next;
    } catch {
      return randomClientId('roundtable-local');
    }
  });
  // P3.2: live chats when signed in; fall back to fixtures for the logged-out demo.
  const { data: session, status: authStatus } = useSession();
  const authed = authStatus === 'authenticated';
  const handleSignIn = useCallback(() => {
    window.location.assign(`/signin?callbackUrl=${encodeURIComponent(window.location.href)}`);
  }, []);
  const handleSignUp = useCallback(() => {
    window.location.assign(`/signup?callbackUrl=${encodeURIComponent(window.location.href)}`);
  }, []);
  const handleSignOut = useCallback(() => {
    void signOut({ callbackUrl: window.location.href });
  }, []);
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
  // Workflow templates are the orchestrator's source of truth for the default
  // task chain — the editor reads and writes these (not a client-only copy).
  const workflowTemplatesQ = trpc.missions.templates.useQuery(undefined, { enabled: authed });
  const saveWorkflowTemplate = trpc.missions.saveTemplate.useMutation({
    onSuccess: () => trpcUtils.missions.templates.invalidate(),
  });
  const deleteWorkflowTemplate = trpc.missions.deleteTemplate.useMutation({
    onSuccess: () => trpcUtils.missions.templates.invalidate(),
  });
  const deleteChat = trpc.chats.delete.useMutation({
    onSuccess: () => {
      trpcUtils.chats.list.invalidate();
    },
  });
  const liveWorkbenches = workbenchesQ.data ?? [];
  const seededSignupWorkbench = useRef(false);
  useEffect(() => {
    if (!authed || !workbenchesQ.isSuccess || liveWorkbenches.length > 0 || seededSignupWorkbench.current) return;
    let name = '';
    try {
      name = window.localStorage.getItem('roundtable.pendingWorkbenchName')?.trim() || '';
    } catch {
      name = '';
    }
    if (!name) return;

    seededSignupWorkbench.current = true;
    createWorkbench.mutate({
      name,
      description: 'Created during sign up.',
    }, {
      onSuccess: (workbench) => {
        try { window.localStorage.removeItem('roundtable.pendingWorkbenchName'); } catch {}
        setSelectedWorkbenchId(workbench.id);
        setSelectedChatId(null);
      },
      onError: () => {
        seededSignupWorkbench.current = false;
      },
    });
  }, [authed, workbenchesQ.isSuccess, liveWorkbenches.length, createWorkbench]);
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
  // Turns exist for signed-in users too (loaded per active chat): the selected
  // one drives the roundtable scene, so the table shows the REAL run — not the
  // demo script — whenever there is one.
  const activeLocalTurn = localTurns.length > 0
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
  const breakoutRoomsQ = trpc.breakouts.listRooms.useQuery(
    { chatId: activeChatId ?? '' },
    { enabled: authed && !!activeChatId },
  );
  const refreshBreakouts = () => {
    if (activeChatId) trpcUtils.breakouts.listRooms.invalidate({ chatId: activeChatId });
  };
  const createBreakoutRoomMutation = trpc.breakouts.createRoom.useMutation({
    onSuccess: (room) => {
      refreshBreakouts();
      setActiveBreakoutId(room.id);
      setHubOpen(false);
      setBreakoutOpen(true);
    },
  });
  const postBreakoutMessageMutation = trpc.breakouts.postMessage.useMutation({
    onSuccess: () => refreshBreakouts(),
  });
  const createBreakoutProposalMutation = trpc.breakouts.createProposal.useMutation({
    onSuccess: () => refreshBreakouts(),
  });
  const sendBreakoutProposalMutation = trpc.breakouts.sendProposal.useMutation({
    onSuccess: () => {
      refreshBreakouts();
      trpcUtils.messages.list.invalidate();
      trpcUtils.chats.list.invalidate();
      setBreakoutOpen(false);
      setActiveBreakoutId(null);
      setInspectorTab('chat');
      setNotesOpen(true);
    },
  });
  const localBreakoutReplyMutation = trpc.ai.breakoutReply.useMutation({
    onSuccess: (reply, variables) => {
      const pendingId = variables.pendingMessageId;
      setRoomNotes((prev) => {
        const notes = prev[variables.roomId] || [];
        return {
          ...prev,
          [variables.roomId]: notes.map((note) =>
            note.id === pendingId ? { ...note, text: reply, pending: false } : note,
          ),
        };
      });
    },
    onError: (_error, variables) => {
      const pendingId = variables.pendingMessageId;
      const lastUserText = variables.transcript.filter((item) => item.authorType === 'user').at(-1)?.content || '';
      setRoomNotes((prev) => {
        const notes = prev[variables.roomId] || [];
        return {
          ...prev,
          [variables.roomId]: notes.map((note) =>
            note.id === pendingId ? { ...note, text: breakoutAgentReply(lastUserText), pending: false } : note,
          ),
        };
      });
    },
  });
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
  const localLive = localTurns.length > 0;
  // Workflow recommendation for the active task (local heuristic; no backend on main).
  const activeTaskTitle = localLive
    ? (turnToTask(activeLocalTurn || localTurns[0] || { message: '' }).title ?? '')
    : (tasks.find((tk) => tk.id === activeChatId)?.title ?? '');
  const missionSuggestionContext = useMemo(() => {
    const recentLocalText = localTurns
      .slice(0, 5)
      .map((turn) => turn.message)
      .filter(Boolean)
      .join(' ');
    const recentTaskText = tasks
      .slice(0, 5)
      .map((task) => task.title)
      .filter(Boolean)
      .join(' ');
    return [activeTaskTitle, localLive ? recentLocalText : recentTaskText]
      .filter(Boolean)
      .join(' ');
  }, [activeTaskTitle, localLive, localTurns, tasks]);
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
  // The finished, renderable site for the active run (if any): a preview artifact
  // with HTML content. Drives the center-stage "Preview" toggle.
  const centerPreviewArtifact = useMemo(() => {
    // Prefer the homepage over whatever page happens to sit first in the array —
    // mirrors the backend's `primary` pick in artifactsFromRun.
    const indexFirst = (list, match) => {
      const candidates = (list || []).filter(match);
      return candidates.find((a) => /(^|\/)index\.html?$/i.test(a.title || '')) ?? candidates[0] ?? null;
    };
    const fromTurn = indexFirst(
      activeLocalTurn?.result?.artifacts,
      (a) => a.kind === 'preview' && (a.preview || '').trim(),
    );
    const turnArtifacts = activeLocalTurn?.result?.artifacts || [];
    if (fromTurn) return withBundledPreview(fromTurn, turnArtifacts);
    const fromLive = indexFirst(
      liveArtifacts,
      (a) => (a.kind === 'preview' || a.kind === 'html') && (a.preview || a.code || '').trim(),
    );
    return fromLive ? withBundledPreview(fromLive, liveArtifacts || []) : null;
  }, [activeLocalTurn, liveArtifacts]);
  // Don't keep showing the preview after switching to a run that has none.
  useEffect(() => { if (!centerPreviewArtifact) setCenterPreview(false); }, [centerPreviewArtifact]);
  useEffect(() => {
    if (!compact) return;
    setRailOpen(false);
    setNotesOpen(false);
  }, [compact]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (dmAgent) setDmAgent(null);
      else if (breakoutOpen) {
        setBreakoutOpen(false);
        setActiveBreakoutId(null);
      }
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
    if (!authed) {
      setLocalTurns([]);
      return;
    }
    if (!turnChatId) return;
    try {
      const params = new URLSearchParams({ chatId: turnChatId });
      const res = await fetch(`/api/orchestrator/history?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.ok) return;
      const storedTurns = data.turns || [];
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
  }, [turnChatId]);

  useEffect(() => {
    if (authStatus === 'loading') return;
    loadLocalHistory();
  }, [authStatus, loadLocalHistory]);

  // Deleting a session removes the turn AND its workspace code on disk (the
  // backend keeps workbench-linked project dirs safe — runs/ output only), so
  // ask before doing something that can't be undone.
  const deleteLocalTurn = useCallback(async (turnId) => {
    const sure = window.confirm('Delete this session? Its generated workspace code is deleted with it.');
    if (!sure) return;
    try {
      await fetch('/api/orchestrator/turn/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId }),
      });
    } catch {
      // Best-effort: reload below reflects whatever actually happened.
    }
    setLocalTurns((turns) => turns.filter((turn) => turn.id !== turnId));
    setSelectedLocalTurnId((current) => (current === turnId ? null : current));
    loadLocalHistory();
  }, [loadLocalHistory]);

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
  const breakoutContext = useMemo(() => {
    const activeTask = tasks.find((task) => task.id === activeChatId || task.id === activeLocalTaskId);
    const mission = latestTurnResult?.mission;
    const currentStage = mission?.stages?.find((stage) => stage.id === mission.currentStageId)?.name
      || liveWorkflowRun?.activeStageId
      || latestTurnResult?.dispatchStage
      || liveWorkflow?.name;
    const planTasks = mission?.tasks?.length
      ? mission.tasks
      : (latestTurnResult?.plan?.tasks || []);
    const activeTasks = planTasks
      .filter((task) => !task.status || ['pending', 'running', 'blocked'].includes(task.status))
      .slice(0, 5)
      .map((task) => {
        const title = task.title || task.id || 'Task';
        const detail = task.brief || task.status;
        return detail ? `${title}: ${detail}` : title;
      });
    const recentMainMessages = authed
      ? (liveMessages || [])
          .slice(-5)
          .map((message) => `${message.authorType}:${message.content}`)
      : (activeLocalTurns.length ? activeLocalTurns : localTurns)
          .slice(0, 5)
          .map((turn) => `user:${turn.message}`);
    const artifactSource = liveArtifacts?.length
      ? liveArtifacts
      : (latestTurnResult?.artifacts || []);
    const artifacts = artifactSource
      .slice(0, 6)
      .map((artifact) => ({
        id: artifact.id || artifact.uri || artifact.title || 'artifact',
        title: artifact.title || artifact.kind || 'Artifact',
        kind: artifact.kind || 'file',
        ownerAgentId: artifact.ownerAgentId || artifact.owner || artifact.agentId || 'agent',
        version: typeof artifact.version === 'number' ? artifact.version : undefined,
        summary: summarizeBreakoutContextText(artifact.preview || artifact.code || artifact.content || artifact.uri),
      }));
    const detailSnippets = [
      ...(mission ? [{
        source: 'mission',
        id: mission.id,
        label: mission.goal || activeTaskTitle || 'Current mission',
        text: [mission.goal, currentStage ? `Current stage: ${currentStage}` : null].filter(Boolean).join(' '),
      }] : []),
      ...planTasks.slice(0, 8).map((task) => ({
        source: 'task',
        id: task.id,
        label: `${task.title || task.id || 'Task'} (${task.status || 'planned'})`,
        text: [
          task.title,
          task.brief,
          task.assignee ? `assignee:${task.assignee}` : null,
          task.deps?.length ? `depends on ${task.deps.join(', ')}` : null,
        ].filter(Boolean).join(' '),
      })),
      ...(authed ? (liveMessages || []).slice(-20) : (activeLocalTurns.length ? activeLocalTurns : localTurns).slice(0, 20))
        .map((item) => ({
          source: 'main_message',
          id: item.id,
          label: authed ? `${item.authorType}:${item.authorId}` : 'user',
          text: authed ? item.content : item.message,
        })),
      ...artifactSource.slice(0, 10).map((artifact) => ({
        source: 'artifact',
        id: artifact.id || artifact.uri || artifact.title || 'artifact',
        label: `${artifact.kind || 'file'}: ${artifact.title || artifact.uri || 'Artifact'}`,
        text: summarizeBreakoutContextText(artifact.preview || artifact.code || artifact.content || artifact.uri) || '',
      })),
    ].filter((snippet) => (snippet.text || '').trim());
    return {
      chatTitle: activeChat?.title || activeTask?.title || activeTaskTitle || undefined,
      recentMainMessages: recentMainMessages.filter(Boolean),
      missionGoal: mission?.goal || latestTurnResult?.plan?.summary || activeLocalTurn?.message || activeTaskTitle || undefined,
      currentStage,
      activeTasks: activeTasks.length ? activeTasks : tasks.slice(0, 5).map((task) => `${task.title} (${task.status || 'idle'})`),
      detailSnippets,
      artifacts,
    };
  }, [
    activeChat?.title,
    activeChatId,
    activeLocalTaskId,
    activeLocalTurn,
    activeLocalTurns,
    activeTaskTitle,
    authed,
    latestTurnResult,
    liveArtifacts,
    liveMessages,
    liveWorkflow,
    liveWorkflowRun,
    localTurns,
    tasks,
  ]);
  useEffect(() => {
    if (!localInFlight) return;
    // Poll briskly while a run is live so the roundtable reflects who's working
    // (planner → implementer → reviewer) close to real time, not in 2.5s jumps.
    loadLocalHistory();
    const iv = setInterval(() => { loadLocalHistory(); }, 1200);
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
  const sendLocalTurn = async (message, turnId, chatIdOverride, workflowTemplateId) => {
    const id = turnId || randomClientId('live');
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
          ...(workflowTemplateId ? { workflowTemplateId } : {}),
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
  // picks to get a real plan. We DON'T auto-dispatch — the plan now waits for
  // the user to review it and click Approve before any agent runs.
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
      // Replace the parked turn with the planned one. It now sits at
      // "awaiting approval" — the user reviews the plan and starts it manually.
      setLocalTurns((turns) => turns.map((turn) => (
        turn.id === turnId
          ? { ...turn, clarifying: false, status: 'done', result: data }
          : turn
      )));
    } catch (error) {
      const errorText = error instanceof Error ? error.message : 'clarify_failed';
      setLocalTurns((turns) => turns.map((turn) => (
        turn.id === turnId ? { ...turn, clarifying: false, clarifyError: errorText } : turn
      )));
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
                mission: data.mission,
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
  const decideLocalDelivery = async (turnId, decision) => {
    try {
      const res = await fetch('/api/orchestrator/delivery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId, decision }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'delivery_decision_failed');
      setLocalTurns((turns) => turns.map((turn) => (
        turn.id === turnId
          ? {
              ...turn,
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
                mission: data.mission,
                workflowRun: data.workflowRun,
              },
            }
          : turn
      )));
    } catch {
      loadLocalHistory();
    }
  };
  const createLocalTask = (goal, workflowTemplateId) => {
    setModal(null);
    if (!authed) {
      handleSignUp();
      return;
    }
    setView('roundtable');
    setInspectorTab('chat');
    setNotesOpen(true);
    sendLocalTurn(goal, undefined, undefined, workflowTemplateId);
  };
  const sendComposerMessage = async (message, workflowTemplateId) => {
    if (authed) {
      if (activeChatId) {
        createMessage.mutate({ chatId: activeChatId, content: message });
        sendLocalTurn(message, undefined, activeChatId, workflowTemplateId);
      } else {
        const workbench = await ensureWorkbench();
        const chat = await createChat.mutateAsync({ title: message.slice(0, 160), workbenchId: workbench.id });
        if (chat) {
          await createMessage.mutateAsync({ chatId: chat.id, content: message });
          sendLocalTurn(message, undefined, chat.id, workflowTemplateId);
        }
      }
      return;
    }
    handleSignIn();
  };
  const breakoutData = RT.SCRIPT.find((b) => b.kind === 'breakout');
  const autoBreakoutRoom = st.breakout && breakoutData
    ? { ...breakoutData, id: breakoutData.id || 'auto-breakout' }
    : null;
  const persistedBreakoutRooms = useMemo(() => (
    authed && breakoutRoomsQ.data
      ? breakoutRoomsQ.data.map((room) => {
          const [a, b] = room.participantAgentIds || [];
          return {
            id: room.id,
            a,
            b,
            status: room.status,
            proposals: room.proposals || [],
            summary: room.status === 'closed' ? 'sent to main chat' : 'side conversation',
            turns: room.messages?.length || 0,
            transcript: (room.messages || []).map((message) => ({
              id: message.id,
              agentId: message.authorType === 'user' ? 'you' : message.authorId,
              text: message.content,
            })),
          };
        })
      : []
  ), [authed, breakoutRoomsQ.data]);
  const breakoutRooms = useMemo(() => {
    const rawRooms = [
      ...(autoBreakoutRoom ? [autoBreakoutRoom] : []),
      ...(authed ? persistedBreakoutRooms : sideRooms),
    ];
    return rawRooms.map((room) => {
      const notes = roomNotes[room.id] || [];
      const transcript = [...(room.transcript || []), ...notes];
      return {
        ...room,
        transcript,
        turns: (room.turns || (room.transcript || []).length) + notes.length,
      };
    });
  }, [autoBreakoutRoom, authed, persistedBreakoutRooms, sideRooms, roomNotes]);
  const activeBreakout = breakoutRooms.find((room) => room.id === activeBreakoutId) || null;
  const openBreakoutRoom = (id) => {
    setActiveBreakoutId(id);
    setBreakoutOpen(true);
  };
  const closeBreakoutRoom = () => {
    setBreakoutOpen(false);
    setActiveBreakoutId(null);
  };
  const startBreakoutRoom = (a, b) => {
    if (authed && activeChatId) {
      createBreakoutRoomMutation.mutate({ chatId: activeChatId, participantAgentIds: [a, b] });
      return;
    }
    const aName = agents[a]?.displayName || a;
    const bName = agents[b]?.displayName || b;
    const id = `room-${Date.now()}-${a}-${b}`;
    const room = {
      id,
      a,
      b,
      turns: 1,
      summary: 'user-started breakout',
      transcript: [
        { agentId: 'you', text: `Started a side room with ${aName} and ${bName}.` },
      ],
    };
    setSideRooms((prev) => [room, ...prev]);
    setActiveBreakoutId(id);
    setHubOpen(false);
    setBreakoutOpen(true);
  };
  const sendBreakoutNote = (roomId, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (authed && !roomId.startsWith('b-')) {
      postBreakoutMessageMutation.mutate({ roomId, content: trimmed });
      return;
    }
    const room = breakoutRooms.find((item) => item.id === roomId);
    const responder = chooseLocalBreakoutResponder(room, agents, trimmed);
    const replyAgentId = responder.id;
    const userMessage = { id: `local-user-${Date.now()}`, agentId: 'you', text: trimmed };
    const pendingMessage = { id: `local-agent-${Date.now()}`, agentId: replyAgentId || 'orchestrator', text: 'thinking…', pending: true };
    setRoomNotes((prev) => ({
      ...prev,
      [roomId]: [
        ...(prev[roomId] || []),
        userMessage,
        pendingMessage,
      ],
    }));
    const transcript = [
      ...(room?.transcript || []),
      userMessage,
    ].map((item) => ({
      authorType: item.agentId === 'you' ? 'user' : 'agent',
      authorId: item.agentId === 'you' ? 'user' : item.agentId,
      content: item.text,
    }));
    localBreakoutReplyMutation.mutate({
      roomId,
      pendingMessageId: pendingMessage.id,
      participantAgentIds: [room?.a, room?.b].filter(Boolean),
      replyAuthorId: replyAgentId || 'orchestrator',
      responderReason: responder.reason,
      transcript,
      context: breakoutContext,
    });
  };
  const sendBreakoutHandoff = async (proposalId, draft) => {
    if (!authed) return;
    let nextProposalId = proposalId;
    if (!nextProposalId) {
      const task = draft.task?.trim();
      if (!task || !draft.roomId || draft.roomId.startsWith('b-')) return;
      const proposal = await createBreakoutProposalMutation.mutateAsync({
        roomId: draft.roomId,
        targetAgentId: draft.targetAgentId,
        task,
        constraints: draft.constraints,
        summary: draft.summary,
        why: draft.why,
        relevantMessageIds: draft.relevantMessageIds,
      });
      nextProposalId = proposal.id;
    }
    sendBreakoutProposalMutation.mutate({
      proposalId: nextProposalId,
      task: draft.task,
      constraints: draft.constraints,
      why: draft.why,
    });
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <TopBar t={t} setTweak={setTweak} view={view} setView={setView}
        authStatus={authStatus} user={session?.user}
        onSignIn={handleSignIn} onSignUp={handleSignUp} onSignOut={handleSignOut} />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {railOpen && !compact && <ConversationRail workbench={railWorkbench} workbenches={railWorkbenches}
          tasks={tasks} agents={agents} activeId={authed ? activeChatId : activeLocalTaskId} onPick={authed ? pickChat : pickLocalTurn}
          memberIds={memberIds} onRemoveMember={(id) => setMemberIds((m) => m.filter((x) => x !== id))}
          onAddMember={() => setModal('agent')} onNewTask={() => setModal('task')} onNewWorkbench={() => setModal('table')}
          onPickWorkbench={pickWorkbench} onCollapse={() => setRailOpen(false)}
          onDelete={authed
            ? (id) => {
                if (!window.confirm('Delete this session? Its generated workspace code is deleted with it.')) return;
                deleteChat.mutate({ id });
                if (id === selectedChatId) setSelectedChatId(null);
              }
            : deleteLocalTurn} />}
        {railOpen && compact && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 110, background: alpha('#000', 30), display: 'flex' }}
            onClick={() => setRailOpen(false)}>
            <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(320px, 86vw)', height: '100%' }}>
              <ConversationRail workbench={railWorkbench} workbenches={railWorkbenches}
                tasks={tasks} agents={agents} activeId={authed ? activeChatId : activeLocalTaskId} onPick={authed ? pickChat : pickLocalTurn}
                memberIds={memberIds} onRemoveMember={(id) => setMemberIds((m) => m.filter((x) => x !== id))}
                onAddMember={() => setModal('agent')} onNewTask={() => setModal('task')} onNewWorkbench={() => setModal('table')}
                onPickWorkbench={pickWorkbench} onCollapse={() => setRailOpen(false)}
                onDelete={authed
            ? (id) => {
                if (!window.confirm('Delete this session? Its generated workspace code is deleted with it.')) return;
                deleteChat.mutate({ id });
                if (id === selectedChatId) setSelectedChatId(null);
              }
            : deleteLocalTurn} />
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
                        {centerPreview && centerPreviewArtifact ? (
                          <CenterPreview artifact={centerPreviewArtifact} onClose={() => setCenterPreview(false)} />
                        ) : (
                          <RoundtableScene agents={agents} scene={st} onOpenArtifact={setDrawerArt}
                            onAction={onAction} onOpenBreakouts={() => setHubOpen(true)} onSeatClick={(id) => setDmAgent(id)}
                            onOpenFiles={() => { setInspectorTab('files'); setNotesOpen(true); }}
                            onZoomWhiteboard={() => setZoomWB(true)} wide={!railOpen && !notesOpen} memberIds={memberIds}
                            activityByAgent={st.work ? Object.fromEntries(Object.entries(st.work).map(([agentId, now]) => [agentId, { now }])) : null}
                            breakoutCount={breakoutRooms.length} />
                        )}
                        <div style={{ position: 'absolute', top: 14, right: 14, zIndex: 50, display: 'flex', gap: 8 }}>
                          {centerPreviewArtifact && (
                            <button onClick={() => setCenterPreview((v) => !v)}
                              title={centerPreview ? 'Back to the roundtable' : 'Preview the generated site in the center'}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 'var(--r-chip)',
                                border: centerPreview ? 'none' : '1px solid var(--border)',
                                background: centerPreview ? 'var(--accent)' : 'var(--surface)',
                                color: centerPreview ? '#fff' : 'var(--text-muted)',
                                font: 'inherit', fontSize: 12.5, fontWeight: 500, cursor: 'pointer', boxShadow: 'var(--shadow-card)' }}>
                              <Icon name={centerPreview ? 'layers' : 'eye'} size={14} /> {centerPreview ? 'Roundtable' : 'Preview'}
                            </button>
                          )}
                          {!notesOpen && (
                            <button onClick={() => { setInspectorTab('chat'); setNotesOpen(true); }} style={{
                              display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 'var(--r-chip)',
                              border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)',
                              font: 'inherit', fontSize: 12.5, fontWeight: 500, cursor: 'pointer', boxShadow: 'var(--shadow-card)' }}>
                              <Icon name="messages" size={14} /> Chat
                            </button>
                          )}
                        </div>
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
                                  font: 'inherit', fontSize: 13, fontWeight: 500 }}><Icon name="plus" size={15} /> Start a Mission</button>
                              </div>
                            </div>
                          </div>
                        )}
                      </>
                </div>
                {notesOpen && !compact && <ResizeHandle onResize={(dx) => setInspectorW((w) => Math.max(300, Math.min(640, w + dx)))} />}
                {notesOpen && <InspectorPanel tab={inspectorTab} setTab={setInspectorTab} clock={scene.clock} width={compact ? 'min(100vw, 420px)' : inspectorW}
                  agents={agents} scene={scene} authed={authed} live={authed && !!activeChatId} liveArtifacts={liveArtifacts} liveMessages={liveMessages}
                  liveHandoffs={liveHandoffs} activeChatId={activeChatId}
                  localTurns={activeLocalTurns.length ? activeLocalTurns : localTurns} allLocalTurns={localTurns} localStatus={localStatus} onApproveLocalTurn={approveLocalTurn}
                  localTurnActions={{ interrupt: interruptLocalTurn, redispatch: redispatchLocalTurn, discard: discardLocalTurn, clarify: answerLocalClarification, approve: approveLocalTurn, delivery: decideLocalDelivery }}
                  onOpenArtifact={setDrawerArt} onAction={onAction} onClose={() => setNotesOpen(false)}
                  onRewrite={sendComposerMessage} onOpenBreakout={openBreakoutRoom} />}
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
          {view === 'workflow' && <WorkflowView agents={agents} onAddAgent={() => setModal('agent')} onOpenTemplates={() => setModal('table')}
            serverTemplates={authed ? workflowTemplatesQ.data : null}
            onSaveTemplate={(template) => saveWorkflowTemplate.mutate(template)}
            onDeleteTemplate={(id) => deleteWorkflowTemplate.mutate({ id })} />}
        </div>
      </div>

      {drawerArt && <Drawer art={drawerArt} agents={agents} onClose={() => setDrawerArt(null)} />}
      {zoomWB && <WhiteboardZoom tasks={st.tasks} agents={agents} live={st.live} run={st.run} posted={st.planPosted} onClose={() => setZoomWB(false)} />}
      {breakoutOpen && activeBreakout && <BreakoutModal data={activeBreakout} agents={agents} onClose={closeBreakoutRoom}
        onSend={sendBreakoutNote} onSendHandoff={sendBreakoutHandoff}
        handoffBusy={createBreakoutProposalMutation.isPending || sendBreakoutProposalMutation.isPending} />}
      {hubOpen && <BreakoutsHub agents={agents} memberIds={memberIds} rooms={breakoutRooms}
        onEnterRoom={(id) => { setHubOpen(false); openBreakoutRoom(id); }}
        onStartRoom={startBreakoutRoom}
        onStartDM={(id) => { setHubOpen(false); setDmAgent(id); }} onClose={() => setHubOpen(false)} />}
      {dmAgent && <DMRoom agent={agents[dmAgent]}
        activeTask={(['working', 'speaking', 'thinking'].includes(st.status[dmAgent])) ? (RT.PLAN.tasks.find((tk) => tk.owner === dmAgent) || {}).id : null}
        work={agentWorkFor(dmAgent, latestTurnResult)}
        onClose={() => setDmAgent(null)} />}
      {modal === 'task' && <NewTaskModal workbench={railWorkbench} members={memberIds} agents={agents}
        suggestionContext={missionSuggestionContext}
        onClose={() => setModal(null)} onCreate={async ({ goal, workflowTemplateId }) => {
          setModal(null);
          if (authed) {
            const workbench = await ensureWorkbench();
            const chat = await createChat.mutateAsync({ title: goal.slice(0, 160), workbenchId: workbench.id });
            if (chat) {
              await createMessage.mutateAsync({ chatId: chat.id, content: goal });
              sendLocalTurn(goal, undefined, chat.id, workflowTemplateId);
            }
          } else {
            createLocalTask(goal, workflowTemplateId);
          }
        }} />}
      {modal === 'table' && <NewWorkbenchModal agents={agents} onClose={() => setModal(null)} onCreate={(input) => {
        if (authed) {
          createWorkbench.mutate({
            name: input.name,
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
