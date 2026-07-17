import React, { useState, useEffect } from 'react';

const ipc = (window as any).electron;

interface Props {
    playlistId: string;
    position: number;          // outgoing track position (1-based)
    idx: number;               // 0-based index for the preview call
    cueOutMs: number;          // outgoing track mix-out point
    transitionMs: number;      // blend length
    nextCueInMs: number;       // incoming track mix-in point
    outDurationMs: number;     // outgoing track duration
    nextDurationMs: number;    // incoming track duration
    fromTitle: string;
    toTitle: string;
    onPreview: (idx: number) => void;
    onSaved: () => void;
}

const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

const Row: React.FC<{ label: string; hint: string; min: number; max: number; value: number; onChange: (v: number) => void; display: string }> =
    ({ label, hint, min, max, value, onChange, display }) => (
        <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 600 }}>{label} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {hint}</span></span>
                <span style={{ fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent)' }}>{display}</span>
            </div>
            <input type="range" min={min} max={max} step={250} value={value}
                onChange={e => onChange(parseInt(e.target.value, 10))}
                style={{ width: '100%', accentColor: 'var(--accent)' }} />
        </div>
    );

const TransitionEditor: React.FC<Props> = (p) => {
    const [cueOut, setCueOut] = useState(p.cueOutMs);
    const [dur, setDur] = useState(p.transitionMs);
    const [cueIn, setCueIn] = useState(p.nextCueInMs);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => { setCueOut(p.cueOutMs); setDur(p.transitionMs); setCueIn(p.nextCueInMs); }, [p.cueOutMs, p.transitionMs, p.nextCueInMs]);

    const dirty = cueOut !== p.cueOutMs || dur !== p.transitionMs || cueIn !== p.nextCueInMs;

    const save = async () => {
        setSaving(true); setSaved(false);
        try {
            await ipc.invoke('playlist:update-transition', {
                playlistId: p.playlistId, position: p.position,
                cue_out_ms: cueOut, transition_duration_ms: dur, next_cue_in_ms: cueIn,
            });
            setSaved(true);
            p.onSaved();
        } finally { setSaving(false); }
    };

    // Preview reads from the DB, so persist the current slider values first.
    const previewNow = async () => {
        if (dirty) await save();
        p.onPreview(p.idx);
    };

    return (
        <div style={{ padding: '14px 16px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>
                Transition · {p.fromTitle} → {p.toTitle}
            </div>
            <Row label="Sortie de ce morceau" hint="où il part" min={0} max={p.outDurationMs}
                value={cueOut} onChange={setCueOut} display={fmt(cueOut)} />
            <Row label="Durée du fondu" hint="longueur du blend" min={1000} max={45000}
                value={dur} onChange={setDur} display={`${(dur / 1000).toFixed(1)}s`} />
            <Row label="Entrée du suivant" hint="où il démarre" min={0} max={Math.round(p.nextDurationMs * 0.6)}
                value={cueIn} onChange={setCueIn} display={fmt(cueIn)} />
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button onClick={previewNow}
                    style={{ flex: 1, padding: '7px 0', borderRadius: 7, border: '1px solid rgba(124,109,255,0.35)', background: 'rgba(124,109,255,0.1)', color: 'var(--accent)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                    ▶ Préécouter
                </button>
                <button onClick={save} disabled={!dirty || saving}
                    style={{ flex: 1, padding: '7px 0', borderRadius: 7, border: 'none', background: (!dirty || saving) ? 'rgba(124,109,255,0.25)' : 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: (!dirty || saving) ? 'default' : 'pointer' }}>
                    {saving ? '…' : saved && !dirty ? '✓ Enregistré' : '💾 Enregistrer'}
                </button>
            </div>
        </div>
    );
};

export default TransitionEditor;
