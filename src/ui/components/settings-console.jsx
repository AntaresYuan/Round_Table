'use client';

import React from 'react';
import { Icon } from './primitives';

const { useEffect, useMemo, useState } = React;

const shell = {
  minHeight: '100vh',
  background: 'var(--bg)',
  color: 'var(--text)',
  display: 'flex',
  flexDirection: 'column',
};

const btn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--surface)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 12.5,
  padding: '7px 11px',
  cursor: 'pointer',
};

const field = {
  width: '100%',
  height: 36,
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--surface-2)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 12.5,
  padding: '0 10px',
  outline: 'none',
  boxSizing: 'border-box',
};

const panel = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  boxShadow: 'var(--shadow-card)',
};

function SettingsConsole() {
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'settings_load_failed');
      setState(data.state);
      setDraft(toDraft(data.state));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const providers = draft?.providers || [];
  const adapterOptions = state?.adapters || [];
  const activeAdapter = adapterOptions.find((option) => option.value === state?.effectiveAgentAdapter);
  const selectedAdapter = adapterOptions.find((option) => option.value === draft?.defaultAgentAdapter);
  const dirty = useMemo(() => Boolean(draft && state), [draft, state]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultAgentAdapter: draft.defaultAgentAdapter || null,
          providers: draft.providers.map((provider) => ({
            provider: provider.provider,
            enabled: provider.enabled,
            label: provider.label,
            baseUrl: provider.baseUrl,
            model: provider.model,
            ...(provider.apiKeyDraft.trim() ? { apiKey: provider.apiKeyDraft.trim() } : {}),
            ...(provider.clearApiKey ? { clearApiKey: true } : {}),
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'settings_save_failed');
      setState(data.state);
      setDraft(toDraft(data.state));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const patchProvider = (provider, patch) => {
    setDraft((current) => ({
      ...current,
      providers: current.providers.map((item) => (
        item.provider === provider ? { ...item, ...patch } : item
      )),
    }));
  };

  return (
    <main style={shell}>
      <header style={{ height: 54, display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px',
        borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
        <a href="/" style={{ ...btn, textDecoration: 'none' }}>
          <Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} /> Roundtable
        </a>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 15, fontWeight: 750 }}>Settings</h1>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Model APIs and workflow defaults</div>
        </div>
        <div style={{ flex: 1 }} />
        <a href="/agents" style={{ ...btn, textDecoration: 'none' }}><Icon name="code" size={14} /> Agent CLIs</a>
        <button disabled={!dirty || saving} onClick={save} style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 'none',
          opacity: saving ? 0.72 : 1 }}>
          <Icon name="check" size={14} /> {saving ? 'Saving' : 'Save'}
        </button>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 16, padding: 16, flex: 1 }}>
        <aside style={{ ...panel, alignSelf: 'start', padding: 8, display: 'grid', gap: 4 }}>
          <NavItem active icon="wrench" label="Model APIs" />
          <NavItem icon="layers" label="Workflow" />
        </aside>

        <section style={{ display: 'grid', gap: 16, minWidth: 0 }}>
          <div style={{ ...panel, overflow: 'hidden' }}>
            <SectionHead title="Workflow" />
            <div style={{ padding: 14, display: 'grid', gridTemplateColumns: 'minmax(220px, 360px) minmax(0, 1fr)', gap: 14,
              alignItems: 'start' }}>
              <div>
                <label style={labelStyle}>Default execution</label>
                <select value={draft?.defaultAgentAdapter || ''} onChange={(e) => setDraft((current) => ({
                  ...current,
                  defaultAgentAdapter: e.target.value,
                }))} style={field}>
                  <option value="">Auto: configured model API</option>
                  {adapterOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <div className="mono" style={{ marginTop: 6, fontSize: 10.5, color: 'var(--text-faint)' }}>
                  active: {activeAdapter?.label || state?.effectiveAgentAdapter || 'Local Dispatch'} · {sourceLabel(state?.effectiveAgentAdapterSource)}
                </div>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {selectedAdapter?.description
                  || 'Use the first configured model API by default. Agent CLI settings stay available for explicit per-agent overrides.'}
              </div>
            </div>
          </div>

          <div style={{ ...panel, overflow: 'hidden' }}>
            <SectionHead title="Model APIs" />
            <div style={{ padding: 14, display: 'grid', gap: 12 }}>
              {!draft && <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>Loading settings.</div>}
              {providers.map((provider) => (
                <ProviderCard key={provider.provider} provider={provider} onPatch={patchProvider} />
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

function ProviderCard({ provider, onPatch }) {
  const keyState = provider.clearApiKey
    ? 'will clear'
    : provider.apiKeySet
      ? `configured${provider.apiKeySource ? ` via ${provider.apiKeySource}` : ''}`
      : 'not set';
  return (
    <article style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2)', padding: 12,
      display: 'grid', gap: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <input type="checkbox" checked={provider.enabled} onChange={(e) => onPatch(provider.provider, { enabled: e.target.checked })} />
          <span style={{ fontSize: 14, fontWeight: 760 }}>{provider.label}</span>
        </label>
        <span className="mono" style={{ fontSize: 10.5, color: provider.apiKeySet && !provider.clearApiKey ? 'var(--ok)' : 'var(--text-faint)' }}>
          key {keyState}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 1fr', gap: 8 }}>
        <div>
          <label style={labelStyle}>Preset</label>
          <select value="" onChange={(e) => {
            const preset = provider.presets.find((item) => item.label === e.target.value);
            if (preset) onPatch(provider.provider, { baseUrl: preset.baseUrl, model: preset.model });
          }} style={field}>
            <option value="">Custom</option>
            {provider.presets.map((preset) => (
              <option key={preset.label} value={preset.label}>{preset.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Base URL</label>
          <input value={provider.baseUrl} onChange={(e) => onPatch(provider.provider, { baseUrl: e.target.value })} style={field}
            placeholder="https://provider.example/v1" />
        </div>
        <div>
          <label style={labelStyle}>Model</label>
          <input value={provider.model} onChange={(e) => onPatch(provider.provider, { model: e.target.value })} style={field}
            placeholder="model name" />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'end' }}>
        <div>
          <label style={labelStyle}>API key</label>
          <input type="password" value={provider.apiKeyDraft} onChange={(e) => onPatch(provider.provider, {
            apiKeyDraft: e.target.value,
            clearApiKey: false,
          })} style={field} placeholder={provider.apiKeySet ? 'Leave blank to keep current key' : 'Paste API key'} />
        </div>
        <button onClick={() => onPatch(provider.provider, { apiKeyDraft: '', clearApiKey: true, apiKeySet: false })}
          style={{ ...btn, color: 'var(--bad)' }}>
          <Icon name="x" size={13} /> Clear key
        </button>
      </div>
    </article>
  );
}

function SectionHead({ title }) {
  return (
    <div style={{ height: 40, display: 'flex', alignItems: 'center', padding: '0 12px',
      borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 800,
      letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{title}</div>
  );
}

function NavItem({ active, icon, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px', borderRadius: 7,
      background: active ? 'var(--surface-2)' : 'transparent', color: active ? 'var(--text)' : 'var(--text-muted)',
      fontSize: 12.5, fontWeight: 650 }}>
      <Icon name={icon} size={14} /> {label}
    </div>
  );
}

function toDraft(state) {
  return {
    defaultAgentAdapter: state.defaultAgentAdapter || '',
    providers: (state.providers || []).map((provider) => ({
      ...provider,
      apiKeyDraft: '',
      clearApiKey: false,
    })),
  };
}

function sourceLabel(source) {
  return {
    settings: 'settings',
    env: 'env',
    'runtime-config': 'runtime config',
    'model-provider': 'model API',
    'built-in': 'built in',
  }[source] || 'auto';
}

const labelStyle = {
  display: 'block',
  marginBottom: 5,
  fontSize: 11,
  fontWeight: 720,
  color: 'var(--text-muted)',
};

export default SettingsConsole;
