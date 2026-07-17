import React from 'react';
import { PreviewState } from './useTransitionPreview';

/** Floating "now auditioning" bar with a scrubber that highlights the beat-locked blend region. */
export const TransitionPreviewBar: React.FC<{ state: PreviewState | null; onStop: () => void }> = ({ state, onStop }) => {
    if (!state) return null;
    const { loading, from, to, clipDurMs, blendStartMs, blendDurMs, positionMs, error } = state;
    const pct = (ms: number) => (clipDurMs > 0 ? Math.min(100, Math.max(0, (ms / clipDurMs) * 100)) : 0);

    return (
        <div style={{
            position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
            width: 'min(680px, 92vw)', background: 'rgba(20,20,28,0.97)',
            border: '1px solid rgba(124,109,255,0.35)', borderRadius: 12, padding: '12px 16px',
            boxShadow: '0 10px 34px rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)', zIndex: 60,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 9 }}>
                <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {error ? '⚠️ Erreur' : loading ? '⏳ Rendu de la transition…' : '▶ Préécoute'}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {error ? error : (from && to ? `${from}  →  ${to}` : '…')}
                </span>
                <button onClick={onStop} style={{
                    fontSize: 11, padding: '3px 11px', borderRadius: 7, border: '1px solid rgba(255,255,255,0.15)',
                    background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)', cursor: 'pointer',
                }}>■ Stop</button>
            </div>

            <div style={{ position: 'relative', height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 100, overflow: 'hidden' }}>
                {blendDurMs > 0 && (
                    <div title="Zone de blend (beatmatch + bass-swap)" style={{
                        position: 'absolute', top: 0, bottom: 0,
                        left: `${pct(blendStartMs)}%`, width: `${pct(blendDurMs)}%`,
                        background: 'rgba(124,109,255,0.4)',
                        borderLeft: '1px solid rgba(124,109,255,0.7)', borderRight: '1px solid rgba(124,109,255,0.7)',
                    }} />
                )}
                <div style={{
                    position: 'absolute', top: 0, bottom: 0, left: 0, width: `${pct(positionMs)}%`,
                    background: 'linear-gradient(to right,#6C63FF,#22d3ee)',
                }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontSize: 10, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                <span>{(positionMs / 1000).toFixed(1)}s</span>
                <span style={{ color: 'var(--accent)' }}>◆ blend</span>
                <span>{(clipDurMs / 1000).toFixed(1)}s</span>
            </div>
        </div>
    );
};
