/* ============================================================================
   Roundtable — dep-graph.jsx
   Read-only sidebar visualizing the artifact dependency graph (specs/060).
   No React Flow / Dagre dep — custom SVG layered layout, capped at 20 nodes.
   ============================================================================ */
import React from 'react';
import { Icon, alpha } from './primitives';
const { useState, useMemo, useEffect } = React;

const KIND_COLOR = {
  imports:    '#5eb0ef',
  calls:      '#5a9e8c',
  extends:    '#9579b0',
  references: '#bd9a55',
};
const CYCLE_COLOR = '#d04a4a';

function kindColor(kind) { return KIND_COLOR[kind] || 'var(--text-faint)'; }

/* ---- cycle detection (DFS coloring) -------------------------------------- */
function findCycleEdges(nodes, edges) {
  const out = new Map();   // node → adjacency [{ to, kind }]
  for (const n of nodes) out.set(n.artifactId, []);
  for (const e of edges) {
    if (!out.has(e.from) || !out.has(e.to)) continue;
    out.get(e.from).push(e);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const n of nodes) color.set(n.artifactId, WHITE);
  const cycleEdges = new Set();
  const visit = (id) => {
    color.set(id, GRAY);
    for (const e of out.get(id) || []) {
      const c = color.get(e.to);
      if (c === GRAY) cycleEdges.add(edgeKey(e));        // back edge → cycle
      else if (c === WHITE) visit(e.to);
    }
    color.set(id, BLACK);
  };
  for (const n of nodes) if (color.get(n.artifactId) === WHITE) visit(n.artifactId);
  return cycleEdges;
}
function edgeKey(e) { return `${e.from}→${e.to}:${e.kind}`; }

/* ---- layered layout (longest-path layering on the DAG, ignoring cycles) -- */
function layout(nodes, edges, cycleEdges) {
  const incoming = new Map();
  const outgoing = new Map();
  for (const n of nodes) { incoming.set(n.artifactId, []); outgoing.set(n.artifactId, []); }
  for (const e of edges) {
    if (cycleEdges.has(edgeKey(e))) continue;
    if (!incoming.has(e.to) || !outgoing.has(e.from)) continue;
    incoming.get(e.to).push(e.from);
    outgoing.get(e.from).push(e.to);
  }
  // depth = longest path from any sink (node with no outgoing); orient left→right
  const depth = new Map();
  const computeDepth = (id) => {
    if (depth.has(id)) return depth.get(id);
    const outs = outgoing.get(id) || [];
    if (outs.length === 0) { depth.set(id, 0); return 0; }
    let max = 0;
    for (const o of outs) max = Math.max(max, computeDepth(o) + 1);
    depth.set(id, max);
    return max;
  };
  for (const n of nodes) computeDepth(n.artifactId);

  // group by depth
  const layers = new Map();
  for (const n of nodes) {
    const d = depth.get(n.artifactId) || 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(n);
  }
  const sortedDepths = Array.from(layers.keys()).sort((a, b) => b - a); // sources left

  // positions
  const COL_W = 150, ROW_H = 64, PAD_X = 24, PAD_Y = 18;
  const pos = new Map();
  let maxRows = 0;
  sortedDepths.forEach((d, colIdx) => {
    const layer = layers.get(d);
    maxRows = Math.max(maxRows, layer.length);
    layer.forEach((n, rowIdx) => {
      pos.set(n.artifactId, {
        x: PAD_X + colIdx * COL_W,
        y: PAD_Y + rowIdx * ROW_H,
      });
    });
  });
  const width  = PAD_X * 2 + Math.max(1, sortedDepths.length) * COL_W;
  const height = PAD_Y * 2 + Math.max(1, maxRows) * ROW_H;
  return { pos, width, height };
}

/* ---- main component ------------------------------------------------------ */
export function DependencyGraphSidebar({ graph, agents, chatId, onNodeClick }) {
  const storageKey = `rt.depGraph.open.${chatId || 'global'}`;
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return true;
    const v = window.localStorage?.getItem(storageKey);
    return v === null ? true : v === 'true';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage?.setItem(storageKey, String(open));
    }
  }, [open, storageKey]);

  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const staleSet = useMemo(() => new Set(graph?.staleNodeIds ?? []), [graph?.staleNodeIds]);
  const cycleEdges = useMemo(() => findCycleEdges(nodes, edges), [nodes, edges]);
  const { pos, width, height } = useMemo(
    () => layout(nodes, edges, cycleEdges),
    [nodes, edges, cycleEdges],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px',
          borderRadius: 'var(--r-sm)', border: '1px solid var(--border)',
          background: 'var(--surface-2)', color: 'var(--text)', font: 'inherit',
          fontSize: 12.5, fontWeight: 500, cursor: 'pointer', width: '100%', textAlign: 'left',
        }}
        title={open ? 'Hide dependency graph' : 'Show dependency graph'}
      >
        <Icon name="layers" size={13} style={{ color: 'var(--accent)' }} />
        <span style={{ flex: 1 }}>Dependency graph</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          {nodes.length} node{nodes.length === 1 ? '' : 's'}
        </span>
        <Icon
          name="chevron"
          size={13}
          style={{ color: 'var(--text-faint)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}
        />
      </button>

      {open && nodes.length === 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic', padding: '8px 4px' }}>
          No artifact dependencies declared yet — agents fill this in as they call <code>declare_dependency</code>.
        </div>
      )}

      {open && nodes.length > 0 && (
        <>
          <Legend cycleVisible={cycleEdges.size > 0} />
          <div style={{
            border: '1px solid var(--border)', borderRadius: 'var(--r-card)',
            background: 'var(--surface)', padding: 6, overflow: 'auto',
          }}>
            <svg
              width={width}
              height={height}
              style={{ display: 'block', minWidth: '100%' }}
              role="img"
              aria-label="Artifact dependency graph"
            >
              <defs>
                {Object.entries(KIND_COLOR).map(([kind, color]) => (
                  <marker
                    key={kind}
                    id={`arrow-${kind}`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
                  </marker>
                ))}
                <marker
                  id="arrow-cycle"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={CYCLE_COLOR} />
                </marker>
              </defs>

              {edges.map((e) => {
                const a = pos.get(e.from); const b = pos.get(e.to);
                if (!a || !b) return null;
                const cyclic = cycleEdges.has(edgeKey(e));
                const color = cyclic ? CYCLE_COLOR : kindColor(e.kind);
                const x1 = a.x + 120; const y1 = a.y + 22;
                const x2 = b.x;       const y2 = b.y + 22;
                return (
                  <g key={edgeKey(e)}>
                    <title>
                      {cyclic
                        ? `⚠️ cyclic edge — ${e.from} ${e.kind} ${e.to}`
                        : `${e.from} ${e.kind} ${e.to}`}
                    </title>
                    <line
                      x1={x1} y1={y1} x2={x2} y2={y2}
                      stroke={color}
                      strokeWidth={cyclic ? 2.2 : 1.5}
                      strokeDasharray={cyclic ? '4 3' : '0'}
                      markerEnd={`url(#arrow-${cyclic ? 'cycle' : e.kind})`}
                    />
                  </g>
                );
              })}

              {nodes.map((n) => {
                const p = pos.get(n.artifactId); if (!p) return null;
                const owner = agents?.[n.ownerAgentId];
                const ownerColor = owner?.color || 'var(--text-faint)';
                const stale = staleSet.has(n.artifactId);
                return (
                  <g
                    key={n.artifactId}
                    transform={`translate(${p.x}, ${p.y})`}
                    onClick={() => onNodeClick && onNodeClick(n)}
                    style={{ cursor: onNodeClick ? 'pointer' : 'default' }}
                  >
                    <title>
                      {`${n.title || n.artifactId} · v${n.version} · @${owner?.role || n.ownerAgentId}` +
                        (stale ? '\n⚠️ upstream changed' : '')}
                    </title>
                    <rect
                      width={120}
                      height={44}
                      rx={8}
                      fill="var(--surface-2)"
                      stroke={stale ? CYCLE_COLOR : alpha(ownerColor, 60)}
                      strokeWidth={stale ? 1.8 : 1.2}
                    />
                    <rect width={4} height={44} rx={2} fill={ownerColor} />
                    <text
                      x={11}
                      y={18}
                      style={{ fontSize: 11.5, fontWeight: 600, fill: 'var(--text)' }}
                    >
                      {truncate(n.title || n.artifactId, 16)}
                    </text>
                    <text
                      x={11}
                      y={34}
                      style={{ fontSize: 10, fill: 'var(--text-faint)' }}
                      className="mono"
                    >
                      v{n.version} · @{owner?.role || n.ownerAgentId}
                    </text>
                    {stale && (
                      <text x={104} y={14} style={{ fontSize: 12, fill: CYCLE_COLOR }}>⚠</text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        </>
      )}
    </div>
  );
}

function Legend({ cycleVisible }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--text-faint)' }}>
      {Object.entries(KIND_COLOR).map(([kind, color]) => (
        <span key={kind} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 16, height: 2, background: color, borderRadius: 1 }} />
          {kind}
        </span>
      ))}
      {cycleVisible && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: CYCLE_COLOR, fontWeight: 600 }}>
          <span style={{ width: 16, height: 2, background: CYCLE_COLOR, borderRadius: 1,
            backgroundImage: `linear-gradient(90deg, ${CYCLE_COLOR} 50%, transparent 50%)`,
            backgroundSize: '6px 2px' }} />
          cycle
        </span>
      )}
    </div>
  );
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
