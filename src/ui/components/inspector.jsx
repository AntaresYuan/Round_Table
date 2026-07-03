'use client';
/* ============================================================================
   Roundtable — inspector.jsx
   The right-hand inspector panel and its tabs: artifact Drawer, the live message
   Thread, the Files list, and the structured meeting Notes. Extracted from
   app-root.jsx so the side panel is one module.
   ============================================================================ */

import React from 'react';
import { Avatar, RoleTag, Icon, Spinner, tint, alpha } from './primitives';
import { ArtifactRenderer, CodeBlock, VChip, HandoffCard, iconBtn, normalizeArtifactForDisplay } from './cards';
import { LocalLiveThread } from './live-turn';
import { Thread } from './stage-scene';
import { sceneAt, meetingNotes } from './roundtable';
import { liveArtifactsFromTurns } from '../lib/live-scene';
import { RT } from '../lib/rt';
import { trpc } from '../lib/trpc';

const { useState, useEffect } = React;

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
function InspectorPanel({ tab, setTab, clock, agents, scene, width, onOpenArtifact, onAction, onClose, authed, live, liveArtifacts, liveMessages, liveHandoffs, activeChatId, localTurns, localStatus, onApproveLocalTurn, localTurnActions, onRewrite }) {
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
  const skillContext = [
    ...(localTurns || []).map((turn) => turn.message),
    ...(liveMessages || []).filter((message) => message.authorType === 'user').map((message) => message.content),
  ].filter(Boolean).join(' ');
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
        {tabBtn('notes', 'Notes')}
        {tabBtn('skills', 'Skills')}
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
      ) : tab === 'skills' ? (
        <SkillsPanel authed={authed} activeChatId={activeChatId} context={skillContext} />
      ) : live || hasLocalTurns ? (
        <LiveNotes agents={agents} artifacts={created} handoffs={liveHandoffs} />
      ) : (
        <NotesContent clock={clock} agents={agents} notes={notes} />
      )}
    </div>
  );
}

function SkillsPanel({ authed, activeChatId, context }) {
  const [showManage, setShowManage] = useState(false);
  const utils = trpc.useUtils();
  const skillsQ = trpc.userSkills.list.useQuery(undefined, { enabled: !!authed });
  const suggestionsQ = trpc.userSkills.suggestions.useQuery(undefined, { enabled: !!authed });
  const recommendedQ = trpc.userSkills.recommended.useQuery({ context }, { enabled: !!authed });
  const upsertSkill = trpc.userSkills.upsert.useMutation({
    onSuccess: () => {
      utils.userSkills.list.invalidate();
      utils.userSkills.suggestions.invalidate();
    },
  });
  const setEnabled = trpc.userSkills.setEnabled.useMutation({
    onSuccess: () => {
      utils.userSkills.list.invalidate();
      utils.userSkills.suggestions.invalidate();
    },
  });
  const deleteSkill = trpc.userSkills.delete.useMutation({
    onSuccess: () => {
      utils.userSkills.list.invalidate();
      utils.userSkills.suggestions.invalidate();
    },
  });

  if (!authed) {
    return (
      <div style={{ flex: 1, padding: '16px 16px 24px' }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>
          Sign in to manage skills and persistent working style.
        </div>
      </div>
    );
  }

  const active = skillsQ.data || [];
  const enabledKeys = new Set(active.filter((skill) => skill.enabled).map((skill) => skill.key));
  const existingPersonalKeys = new Set(active.filter((skill) => skill.scope !== 'mission').map((skill) => skill.key));
  const suggested = (suggestionsQ.data || []).filter((skill) => !existingPersonalKeys.has(skill.key));
  const recommended = (recommendedQ.data || []).filter((skill) => !enabledKeys.has(skill.key));
  const enabled = active.filter((skill) => skill.enabled);
  const alwaysOn = enabled.filter((skill) => skill.scope !== 'mission');
  const missionOnly = enabled.filter((skill) => skill.scope === 'mission' && skill.targetChatId === activeChatId);
  const missionLead = activeChatId ? recommended[0] : null;
  const busy = upsertSkill.isPending || setEnabled.isPending || deleteSkill.isPending;
  const accept = (skill, scope = skill.scope || 'personal') => {
    upsertSkill.mutate({
      key: skill.key,
      label: skill.label,
      description: skill.description,
      source: skill.source,
      scope,
      targetChatId: scope === 'mission' ? activeChatId : null,
      evidence: skill.evidence,
      enabled: true,
    });
  };
  const acceptSetup = () => {
    suggested.slice(0, 3).forEach((skill) => accept(skill, 'personal'));
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 24px', display: 'grid', gap: 14 }}>
      <section style={{ padding: 15, borderRadius: 'var(--r-card)', border: '1px solid var(--border)',
        background: 'linear-gradient(180deg, color-mix(in oklab, var(--surface) 94%, var(--accent)), var(--surface))',
        boxShadow: 'var(--shadow-card)', display: 'grid', gap: 13 }}>
        <div style={{ display: 'grid', gap: 11 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 850, color: 'var(--text)' }}>Working style</div>
            <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.45 }}>
              {enabled.length > 0
                ? `${enabled.length} skill${enabled.length === 1 ? '' : 's'} guiding this workspace.`
                : 'Roundtable is not using any skills yet.'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <SkillMetric value={alwaysOn.length} label="Always" />
            <SkillMetric value={missionOnly.length} label="Mission" />
            <SkillMetric value={suggested.length} label="Ideas" />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', minHeight: 28, alignItems: 'center' }}>
          {enabled.length === 0 ? (
            <>
              <GhostSkillChip label="Plan first" />
              <GhostSkillChip label="Visual review" />
              <GhostSkillChip label="Verify" />
            </>
          ) : enabled.slice(0, 5).map((skill) => <ActiveSkillChip key={skill.id || skill.key} skill={skill} />)}
        </div>

        <div style={{ display: 'grid', gap: 9, justifyItems: 'start' }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.35 }}>
            {missionOnly.length > 0 ? 'Mission-only rules are active for this chat.' : 'Suggestions stay off until you choose them.'}
          </div>
          {enabled.length === 0 && suggested.length > 0 ? (
            <button disabled={busy} onClick={acceptSetup} style={{ ...smallButton('primary'), width: '100%', justifyContent: 'center' }}>Use recommended setup</button>
          ) : (
            <button onClick={() => setShowManage((value) => !value)} style={smallButton('neutral')}>
              {showManage ? 'Hide details' : 'Manage'}
            </button>
          )}
        </div>
      </section>

      <SkillSection title="For this mission" meta={activeChatId ? 'Context-aware' : 'Open a mission'}>
        {missionOnly.length > 0 ? (
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            {missionOnly.map((skill) => <ActiveSkillChip key={skill.id || skill.key} skill={skill} tone="mission" />)}
          </div>
        ) : missionLead ? (
          <MissionSkillCard skill={missionLead} busy={busy} onEnable={() => accept(missionLead, 'mission')} />
        ) : (
          <SkillEmpty>Open a mission chat to enable mission-only skills.</SkillEmpty>
        )}
      </SkillSection>

      <SkillSection title="Suggested always-on" meta="Quiet defaults">
        {suggested.length === 0 ? (
          <SkillEmpty>No new suggestions right now.</SkillEmpty>
        ) : suggested.slice(0, 3).map((skill) => (
          <SkillRow key={skill.key} skill={skill} busy={busy} onAccept={() => accept(skill, 'personal')} />
        ))}
      </SkillSection>

      <button onClick={() => setShowManage((value) => !value)} style={{ border: 'none', background: 'transparent',
        color: 'var(--text-muted)', font: 'inherit', fontSize: 12.5, fontWeight: 750, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 6, justifySelf: 'start', padding: '2px 0' }}>
        <Icon name="layers" size={13} /> {showManage ? 'Hide full skill controls' : 'Show full skill controls'}
      </button>

      {showManage && (
        <SkillSection title="Full controls" meta={`${active.length} saved`}>
          {skillsQ.isLoading ? (
            <SkillEmpty>Loading skills...</SkillEmpty>
          ) : active.length === 0 ? (
            <SkillEmpty>No saved skills yet.</SkillEmpty>
          ) : active.map((skill) => (
            <SkillCard key={skill.id || skill.key} skill={skill}
              action={
                <div style={{ display: 'flex', gap: 6 }}>
                  <button disabled={busy} onClick={() => setEnabled.mutate({
                    key: skill.key,
                    enabled: !skill.enabled,
                    scope: skill.scope,
                    targetChatId: skill.targetChatId,
                  })}
                    style={smallButton(skill.enabled ? 'neutral' : 'primary')}>
                    {skill.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button disabled={busy} onClick={() => deleteSkill.mutate({
                    key: skill.key,
                    scope: skill.scope,
                    targetChatId: skill.targetChatId,
                  })} style={smallButton('ghost')}>
                    Remove
                  </button>
                </div>
              } />
          ))}
        </SkillSection>
      )}
    </div>
  );
}

function SkillMetric({ value, label }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 'var(--r-chip)', border: '1px solid var(--border)',
      background: 'color-mix(in oklab, var(--surface) 88%, transparent)', padding: '5px 8px' }}>
      <span className="mono tnum" style={{ fontSize: 12, fontWeight: 850, color: 'var(--text)' }}>{value}</span>
      <span style={{ fontSize: 10.5, color: 'var(--text-faint)', fontWeight: 750, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</span>
    </div>
  );
}

function GhostSkillChip({ label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 'var(--r-chip)',
      border: '1px dashed var(--border)', color: 'var(--text-faint)', background: 'var(--surface-2)', fontSize: 11.5, fontWeight: 750 }}>
      <Icon name="dot" size={9} /> {label}
    </span>
  );
}

function ActiveSkillChip({ skill, tone = 'default' }) {
  const mission = tone === 'mission' || skill.scope === 'mission';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 'var(--r-chip)',
      background: mission ? tint('var(--ok)', 13) : tint('var(--accent)', 13),
      color: mission ? 'var(--ok)' : 'var(--accent)', fontSize: 11.5, fontWeight: 800 }}>
      <Icon name={mission ? 'pin' : 'sparkle'} size={12} /> {shortSkillLabel(skill.label)}
    </span>
  );
}

function MissionSkillCard({ skill, busy, onEnable }) {
  return (
    <div style={{ padding: 13, borderRadius: 'var(--r-card)', border: '1px solid color-mix(in oklab, var(--accent) 38%, var(--border))',
      background: 'color-mix(in oklab, var(--accent) 7%, var(--surface))', display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 30, height: 30, borderRadius: 8,
          background: tint('var(--accent)', 14), color: 'var(--accent)', flexShrink: 0 }}>
          <Icon name="pin" size={14} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 850, color: 'var(--text)' }}>{skill.label}</div>
          <div style={{ marginTop: 4, fontSize: 12.2, color: 'var(--text-muted)', lineHeight: 1.45 }}>{skill.description}</div>
          <div style={{ marginTop: 5, fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.4 }}>{skill.reason}</div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button disabled={busy} onClick={onEnable} style={smallButton('primary')}>Enable for mission</button>
      </div>
    </div>
  );
}

function SkillRow({ skill, busy, onAccept }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 11px', borderRadius: 'var(--r-sm)',
      border: '1px solid var(--border)', background: 'var(--surface)' }}>
      <span style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, borderRadius: 7,
        background: tint('var(--accent)', 11), color: 'var(--accent)', flexShrink: 0 }}>
        <Icon name="sparkle" size={12} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.7, fontWeight: 800, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{skill.label}</div>
        <div style={{ marginTop: 2, fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{skill.description}</div>
      </div>
      <button disabled={busy} onClick={onAccept} style={smallButton('neutral')}>Accept</button>
    </div>
  );
}

function SkillSection({ title, meta, children }) {
  return (
    <section style={{ display: 'grid', gap: 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontSize: 13.5, fontWeight: 800 }}>{title}</div>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{meta}</span>
      </div>
      {children}
    </section>
  );
}

function shortSkillLabel(label) {
  return String(label || '').replace(' before implementation', ' first').replace(' required', '').replace(' before push', '');
}

function SkillCard({ skill, reason, action }) {
  const enabled = skill.enabled !== false;
  return (
    <div style={{ padding: '10px 11px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)',
      background: enabled ? 'var(--surface)' : 'var(--surface-2)', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 26, height: 26, borderRadius: 7,
          background: enabled ? tint('var(--accent)', 14) : 'var(--surface-3)', color: enabled ? 'var(--accent)' : 'var(--text-faint)', flexShrink: 0 }}>
          <Icon name={enabled ? 'sparkle' : 'pause'} size={13} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>{skill.label}</div>
            <SkillBadge>{skill.scope || 'personal'}</SkillBadge>
            <SkillBadge>{skill.source || 'user'}</SkillBadge>
          </div>
          <div style={{ marginTop: 3, fontSize: 12.2, color: 'var(--text-muted)', lineHeight: 1.45 }}>{skill.description}</div>
          {reason && <div style={{ marginTop: 5, fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.4 }}>{reason}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>{action}</div>
    </div>
  );
}

function SkillBadge({ children }) {
  return (
    <span style={{ padding: '1px 6px', borderRadius: 5, background: 'var(--surface-3)', color: 'var(--text-faint)',
      fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>{children}</span>
  );
}

function SkillEmpty({ children }) {
  return (
    <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic', padding: '8px 2px' }}>{children}</div>
  );
}

function smallButton(kind) {
  const primary = kind === 'primary';
  const ghost = kind === 'ghost';
  return {
    padding: '5px 9px',
    borderRadius: 'var(--r-sm)',
    border: primary ? 'none' : '1px solid var(--border)',
    background: primary ? 'var(--accent)' : ghost ? 'transparent' : 'var(--surface-2)',
    color: primary ? '#fff' : 'var(--text-muted)',
    font: 'inherit',
    fontSize: 11.5,
    fontWeight: 700,
    cursor: 'pointer',
  };
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

export { Drawer, InspectorPanel };
