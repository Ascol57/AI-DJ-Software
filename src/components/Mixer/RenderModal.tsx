import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

const ipc = (window as any).electron;

type RenderFormat = 'wav' | 'mp3' | 'flac';
type RenderQuality = 'high' | 'standard' | 'compressed';

interface Props {
    playlistId?: string;
    onClose: () => void;
}

interface FormatOption {
    id: RenderFormat;
    label: string;
    description: string;
    size: string;
}

interface QualityOption {
    id: RenderQuality;
    label: string;
    description: string;
}

const FORMATS: FormatOption[] = [
    { id: 'wav', label: 'WAV', description: 'Lossless, maximum quality', size: '~600 MB/hr' },
    { id: 'flac', label: 'FLAC', description: 'Lossless compressed', size: '~200 MB/hr' },
    { id: 'mp3', label: 'MP3', description: 'Lossy, universal compatibility', size: '~80 MB/hr' },
];

const QUALITIES: QualityOption[] = [
    { id: 'high', label: 'Studio', description: 'WAV 24-bit / FLAC 8 / MP3 VBR0' },
    { id: 'standard', label: 'Standard', description: 'WAV 16-bit / FLAC 5 / MP3 192k' },
    { id: 'compressed', label: 'Compact', description: 'WAV 16-bit / FLAC 3 / MP3 128k' },
];

const RenderModal: React.FC<Props> = ({ playlistId, onClose }) => {
    const [format, setFormat] = useState<RenderFormat>('wav');
    const [quality, setQuality] = useState<RenderQuality>('high');
    const [normLoud, setNormLoud] = useState(true);
    const [tempoSlope, setTempoSlope] = useState(3);      // BPM/s (max)
    const [pitchSlope, setPitchSlope] = useState(0.15);   // semitones/s (max)
    const [rendering, setRendering] = useState(false);
    const [progress, setProgress] = useState(0);
    const [currentTrack, setCurrentTrack] = useState('');
    const [error, setError] = useState('');
    const [done, setDone] = useState<{ filePath: string; tracks: number } | null>(null);

    // Listen for render progress events from main process
    useEffect(() => {
        const handler = (data: { percent: number; track?: string; error?: string }) => {
            if (data.error) {
                setError(data.error);
                setRendering(false);
                return;
            }
            setProgress(data.percent);
            if (data.track) setCurrentTrack(data.track);
        };
        ipc.on?.('mixer:render-progress', handler);
        return () => ipc.off?.('mixer:render-progress', handler);
    }, []);

    const handleRender = async () => {
        if (!playlistId) {
            setError('No playlist selected. Load a playlist onto the decks first.');
            return;
        }
        setRendering(true);
        setProgress(0);
        setError('');
        setCurrentTrack('');

        try {
            const result = await ipc.invoke('mixer:render', {
                playlistId, format, quality,
                normalizeLoudness: normLoud,
                maxTempoSlope: tempoSlope,
                maxPitchSlope: pitchSlope,
            });
            if (result.canceled) {
                setRendering(false);
                return;
            }
            setDone({ filePath: result.filePath, tracks: result.tracks });
            setProgress(100);
        } catch (e: any) {
            setError(e.message ?? 'Render failed.');
        } finally {
            setRendering(false);
        }
    };

    const openFolder = () => {
        if (done?.filePath) {
            ipc.invoke('dialog:show-item-in-folder', done.filePath).catch(() => { });
        }
    };

    return createPortal(
        <div
            className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50"
            onClick={!rendering ? onClose : undefined}
        >
            <div
                className="bg-bg-surface-2 border border-white/10 rounded-2xl p-8 w-[480px] shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-xl font-bold">Render Mix to File</h2>
                    {!rendering && (
                        <button onClick={onClose} className="text-text-muted hover:text-white transition text-xl">×</button>
                    )}
                </div>

                {!done ? (
                    <>
                        {/* Format selector */}
                        <div className="mb-5">
                            <label className="text-xs font-bold text-text-muted uppercase tracking-widest mb-3 block">Output Format</label>
                            <div className="grid grid-cols-3 gap-2">
                                {FORMATS.map(f => (
                                    <button
                                        key={f.id}
                                        id={`render-format-${f.id}`}
                                        disabled={rendering}
                                        onClick={() => setFormat(f.id)}
                                        className={`rounded-xl p-3 text-left border transition ${format === f.id
                                            ? 'border-accent bg-accent/10'
                                            : 'border-white/5 bg-white/3 hover:border-white/15'
                                            }`}
                                    >
                                        <div className="text-sm font-bold mb-0.5">{f.label}</div>
                                        <div className="text-[10px] text-text-muted leading-tight">{f.description}</div>
                                        <div className="text-[10px] text-text-muted/60 mt-1">{f.size}</div>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Quality selector */}
                        <div className="mb-6">
                            <label className="text-xs font-bold text-text-muted uppercase tracking-widest mb-3 block">Quality</label>
                            <div className="space-y-2">
                                {QUALITIES.map(q => (
                                    <button
                                        key={q.id}
                                        id={`render-quality-${q.id}`}
                                        disabled={rendering}
                                        onClick={() => setQuality(q.id)}
                                        className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition ${quality === q.id
                                            ? 'border-accent bg-accent/10'
                                            : 'border-white/5 bg-white/3 hover:border-white/15'
                                            }`}
                                    >
                                        <div
                                            className="w-3.5 h-3.5 rounded-full border-2 shrink-0 transition"
                                            style={{
                                                borderColor: quality === q.id ? '#6C63FF' : 'rgba(255,255,255,0.2)',
                                                background: quality === q.id ? '#6C63FF' : 'transparent'
                                            }}
                                        />
                                        <div>
                                            <div className="text-sm font-semibold">{q.label}</div>
                                            <div className="text-xs text-text-muted">{q.description}</div>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Mix settings (applied at render — no need to regenerate) */}
                        <div className="mb-6">
                            <label className="text-xs font-bold text-text-muted uppercase tracking-widest mb-3 block">Rendu</label>

                            <button
                                type="button"
                                disabled={rendering}
                                onClick={() => setNormLoud(v => !v)}
                                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.03)', cursor: 'pointer', marginBottom: 12 }}>
                                <div style={{ textAlign: 'left' }}>
                                    <div style={{ fontSize: 13, fontWeight: 600 }}>Égaliser le volume</div>
                                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Aucun morceau beaucoup plus fort qu'un autre</div>
                                </div>
                                <span style={{ width: 40, height: 22, borderRadius: 100, background: normLoud ? 'var(--accent)' : 'rgba(255,255,255,0.12)', position: 'relative', flexShrink: 0, transition: 'all .2s' }}>
                                    <span style={{ position: 'absolute', top: 2, left: normLoud ? 20 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left .2s' }} />
                                </span>
                            </button>

                            <div style={{ marginBottom: 10 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                                    <span style={{ fontWeight: 600 }}>Pente tempo · max</span>
                                    <span style={{ color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace' }}>{tempoSlope.toFixed(1)} BPM/s</span>
                                </div>
                                <input type="range" min={0.5} max={12} step={0.5} value={tempoSlope} disabled={rendering} onChange={e => setTempoSlope(+e.target.value)} style={{ width: '100%', accentColor: 'var(--accent)' }} />
                            </div>
                            <div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                                    <span style={{ fontWeight: 600 }}>Pente pitch · max</span>
                                    <span style={{ color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace' }}>{pitchSlope.toFixed(2)} ½ton/s</span>
                                </div>
                                <input type="range" min={0.02} max={1} step={0.01} value={pitchSlope} disabled={rendering} onChange={e => setPitchSlope(+e.target.value)} style={{ width: '100%', accentColor: 'var(--accent)' }} />
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>Plus bas = pentes plus douces. Appliqué au rendu (pas besoin de régénérer).</div>
                        </div>

                        {/* Progress */}
                        {rendering && (
                            <div className="mb-5 space-y-2">
                                <div className="flex justify-between text-xs text-text-muted">
                                    <span className="truncate max-w-[260px]">{currentTrack || 'Preparing…'}</span>
                                    <span className="font-bold font-mono">{progress}%</span>
                                </div>
                                <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                                    <div
                                        className="h-full rounded-full transition-all"
                                        style={{ width: `${progress}%`, background: 'linear-gradient(to right, #6C63FF, #22d3ee)' }}
                                    />
                                </div>
                            </div>
                        )}

                        {error && (
                            <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-sm text-red-400">
                                ⚠️ {error}
                            </div>
                        )}

                        <button
                            id="render-start-btn"
                            onClick={handleRender}
                            disabled={rendering}
                            className="w-full py-3 rounded-xl font-bold text-sm transition disabled:opacity-50"
                            style={{ background: rendering ? 'rgba(108,99,255,0.3)' : '#6C63FF' }}
                        >
                            {rendering ? `Rendering… ${progress}%` : '⬇ Start Render'}
                        </button>
                    </>
                ) : (
                    /* Done state */
                    <div className="text-center space-y-5 py-4">
                        <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center text-2xl mx-auto">✓</div>
                        <div>
                            <h3 className="text-lg font-bold mb-1">Render Complete!</h3>
                            <p className="text-sm text-text-muted">Successfully mixed {done.tracks} tracks to a continuous {format.toUpperCase()} file.</p>
                        </div>
                        <div className="flex gap-3">
                            <button onClick={onClose} className="btn bg-white/5 border-white/10 flex-1 justify-center py-2.5">Close</button>
                            <button onClick={openFolder} className="btn flex-1 justify-center py-2.5" style={{ background: '#6C63FF' }}>Show File</button>
                        </div>
                    </div>
                )}
            </div>
        </div>,
        document.body
    );
};

export default RenderModal;
