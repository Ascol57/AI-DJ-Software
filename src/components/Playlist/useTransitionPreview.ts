import { useRef, useState, useCallback, useEffect } from 'react';

const el = (window as any).electron;

export interface PreviewState {
    idx: number;
    from: string;
    to: string;
    loading: boolean;
    playing: boolean;
    clipDurMs: number;
    blendStartMs: number;
    blendDurMs: number;
    positionMs: number;
    error?: string;
}

/**
 * Audition a single beat-locked transition. Asks the main process to render just the
 * A→B blend (pre-roll + blend + post-roll) to a WAV, then plays it via a Blob URL.
 * The rendered clip is identical to what the full mix will produce for that transition.
 */
export function useTransitionPreview(playlistId?: string) {
    const [state, setState] = useState<PreviewState | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const urlRef = useRef<string | null>(null);
    const rafRef = useRef<number | null>(null);
    const stateRef = useRef<PreviewState | null>(null);
    stateRef.current = state;

    const cleanup = useCallback(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; audioRef.current = null; }
        if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    }, []);

    const stop = useCallback(() => { cleanup(); setState(null); }, [cleanup]);

    const tick = useCallback(() => {
        const a = audioRef.current;
        if (!a) return;
        setState(s => (s ? { ...s, positionMs: a.currentTime * 1000 } : s));
        rafRef.current = requestAnimationFrame(tick);
    }, []);

    const preview = useCallback(async (idx: number) => {
        if (!playlistId) return;
        // Clicking the transition that is already loaded toggles it off.
        if (stateRef.current && stateRef.current.idx === idx) { stop(); return; }
        cleanup();
        setState({ idx, from: '', to: '', loading: true, playing: false, clipDurMs: 0, blendStartMs: 0, blendDurMs: 0, positionMs: 0 });
        try {
            const res = await el.invoke('mixer:preview-transition', { playlistId, index: idx });
            const bin = atob(res.wavBase64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
            urlRef.current = url;
            const a = new Audio(url);
            audioRef.current = a;
            a.onended = () => stop();
            a.onloadedmetadata = () => setState(s => (s ? { ...s, clipDurMs: a.duration * 1000 } : s));
            await a.play();
            setState(s => (s ? { ...s, from: res.from, to: res.to, loading: false, playing: true, blendStartMs: res.blendStartMs, blendDurMs: res.blendDurMs } : s));
            rafRef.current = requestAnimationFrame(tick);
        } catch (e: any) {
            setState({ idx, from: '', to: '', loading: false, playing: false, clipDurMs: 0, blendStartMs: 0, blendDurMs: 0, positionMs: 0, error: e?.message ?? 'Échec de la préécoute' });
        }
    }, [playlistId, cleanup, stop, tick]);

    useEffect(() => cleanup, [cleanup]);            // stop on unmount
    useEffect(() => { stop(); }, [playlistId, stop]); // stop when the active playlist changes

    return { state, preview, stop };
}
