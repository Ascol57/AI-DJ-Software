import React, { useEffect, useRef, useState } from 'react';
import { WaveformData } from '../../types';
import WaveformCanvas from '../Waveform/WaveformCanvas';

const ipc = (window as any).electron;
const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const W = 288;

const CueEditorDrawer: React.FC<{ trackId: string; title: string; onClose: () => void; onSaved?: () => void }> = ({ trackId, title, onClose, onSaved }) => {
    const [wave, setWave] = useState<WaveformData | null>(null);
    const [dur, setDur] = useState(0);
    const [start, setStart] = useState(0);
    const [end, setEnd] = useState(0);
    const [intro, setIntro] = useState<number | null>(null);
    const [outro, setOutro] = useState<number | null>(null);
    const [msg, setMsg] = useState('');
    const [playing, setPlaying] = useState<'start' | 'end' | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const urlRef = useRef<string | null>(null);

    useEffect(() => {
        ipc.invoke('waveform:get', trackId).then((w: WaveformData) => setWave(w)).catch(() => { });
        ipc.invoke('track:get-cues', trackId).then((r: any) => {
            const d = r?.duration_ms ?? 0; setDur(d);
            setStart(r?.user_start_ms ?? 0);
            setEnd(r?.user_end_ms ?? d);
            setIntro(r?.intro_end_ms ?? null); setOutro(r?.outro_start_ms ?? null);
        });
        return () => stop();
    }, [trackId]);

    const stop = () => {
        if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
        if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
        setPlaying(null);
    };

    const listen = async (which: 'start' | 'end') => {
        if (playing === which) { stop(); return; }
        stop();
        setPlaying(which);
        // ~1.5s before the marker, ~4s after → hear the cut in context.
        const center = which === 'start' ? start : end;
        const from = Math.max(0, center - 1500);
        const to = Math.min(dur || center + 4000, center + 4000);
        try {
            const res = await ipc.invoke('track:preview-region', { trackId, start_ms: from, end_ms: to });
            const bin = atob(res.wavBase64); const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
            urlRef.current = url;
            const a = new Audio(url); audioRef.current = a;
            a.onended = () => stop();
            await a.play();
        } catch { setPlaying(null); }
    };

    const save = async () => {
        await ipc.invoke('track:set-cues', { trackId, start_ms: start, end_ms: end });
        setMsg('Enregistré ✓'); onSaved?.();
    };
    const reset = async () => {
        await ipc.invoke('track:set-cues', { trackId, start_ms: null, end_ms: null });
        setStart(0); setEnd(dur); setMsg('Réinitialisé (auto)'); onSaved?.();
    };

    const pct = (ms: number) => (dur > 0 ? (ms / dur) * 100 : 0);
    const listenBtn = (which: 'start' | 'end', color: string) => (
        <button onClick={() => listen(which)} style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${color}55`, background: playing === which ? `${color}33` : `${color}18`, color, fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {playing === which ? '⏹ Stop' : `▶ Écouter ${which === 'start' ? 'le début' : 'la fin'}`}
        </button>
    );

    return (
        <div style={{ position: 'absolute', right: 0, top: 0, height: '100%', width: 320, background: 'var(--bg-surface)', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', zIndex: 25, boxShadow: '-8px 0 32px rgba(0,0,0,0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Début / Fin du morceau</div>
                <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
            </div>
            <div style={{ padding: 16, overflowY: 'auto' }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>

                <div style={{ position: 'relative', height: 80, marginBottom: 14, background: 'rgba(0,0,0,0.2)', borderRadius: 6, overflow: 'hidden' }}>
                    {wave && <WaveformCanvas data={wave} width={W} height={80} playheadMs={-1} />}
                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${pct(start)}%`, background: 'rgba(0,0,0,0.55)' }} />
                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${pct(end)}%`, right: 0, background: 'rgba(0,0,0,0.55)' }} />
                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: `calc(${pct(start)}% - 1px)`, width: 2, background: '#22c55e' }} />
                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: `calc(${pct(end)}% - 1px)`, width: 2, background: '#ef4444' }} />
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#22c55e' }}>Début · {fmt(start)}</span>
                    {listenBtn('start', '#22c55e')}
                </div>
                <input type="range" min={0} max={dur} step={250} value={start} onChange={e => setStart(Math.min(parseInt(e.target.value, 10), end - 1000))} style={{ width: '100%', accentColor: '#22c55e', marginBottom: 12 }} />

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#ef4444' }}>Fin · {fmt(end)}</span>
                    {listenBtn('end', '#ef4444')}
                </div>
                <input type="range" min={0} max={dur} step={250} value={end} onChange={e => setEnd(Math.max(parseInt(e.target.value, 10), start + 1000))} style={{ width: '100%', accentColor: '#ef4444', marginBottom: 10 }} />

                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 14 }}>Auto détecté · intro {intro != null ? fmt(intro) : '—'} · outro {outro != null ? fmt(outro) : '—'}</div>

                <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={reset} style={{ flex: 1, padding: '8px 0', borderRadius: 7, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}>Auto</button>
                    <button onClick={save} style={{ flex: 2, padding: '8px 0', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>💾 Enregistrer</button>
                </div>
                {msg && <p style={{ fontSize: 11, color: 'var(--success)', marginTop: 8 }}>{msg}</p>}
            </div>
        </div>
    );
};

export default CueEditorDrawer;
