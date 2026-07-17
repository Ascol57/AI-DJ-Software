/**
 * Mix Pre-Render — FFmpeg-based offline rendering of a full playlist mix.
 * Each transition uses FFmpeg's `acrossfade` filter to smoothly blend tracks.
 * SOC2 Rule 2: runs fully locally, never uploads audio data.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';

export type RenderFormat = 'wav' | 'mp3' | 'flac';
export type RenderQuality = 'high' | 'standard' | 'compressed';

export interface RenderTrack {
    file_path: string;
    cue_in_ms: number;
    cue_out_ms: number;
    transition_duration_ms: number;
    title: string;
    artist: string;
    bpm: number;
    /** First detected beat (ms) — anchor for the constant-tempo beat grid used for phase-locking. */
    first_beat_ms?: number;
    transition_type?: string;
}

export interface RenderOptions {
    tracks: RenderTrack[];
    output_path: string;
    format: RenderFormat;
    quality: RenderQuality;
    sample_rate?: number;
    onProgress?: (percent: number, currentTrack: string) => void;
    onError?: (msg: string) => void;
}

const QUALITY_SETTINGS: Record<RenderFormat, Record<RenderQuality, string[]>> = {
    wav: {
        high: ['-acodec', 'pcm_s24le'],
        standard: ['-acodec', 'pcm_s16le'],
        compressed: ['-acodec', 'pcm_s16le'],
    },
    mp3: {
        high: ['-codec:a', 'libmp3lame', '-q:a', '0'],
        standard: ['-codec:a', 'libmp3lame', '-b:a', '192k'],
        compressed: ['-codec:a', 'libmp3lame', '-b:a', '128k'],
    },
    flac: {
        high: ['-codec:a', 'flac', '-compression_level', '8'],
        standard: ['-codec:a', 'flac', '-compression_level', '5'],
        compressed: ['-codec:a', 'flac', '-compression_level', '3'],
    },
};

/** Phase-locked blend window for one A→B pair (shared by the renderer and the preview). */
export interface BlendPlan { aOutStart: number; aOutEnd: number; bInStart: number; bInEnd: number; warp: number; }

// FFmpeg audio filters can panic on micro-transitions (<1s); cap the duration.
const clampD = (ms: number) => (ms < 1000 ? 0 : Math.min(ms, 45000));
// Constant-tempo beat grid anchored on each track's first detected beat.
const beatPeriod = (bpm: number) => (bpm && bpm > 0 ? 60000 / bpm : 0);
const snapToGrid = (ms: number, anchor: number, period: number, multiple = 1) => {
    if (period <= 0) return ms;
    const step = period * multiple;
    return anchor + Math.round((ms - anchor) / step) * step;
};
const warpOf = (bpmA: number, bpmB: number) =>
    Math.max(0.5, Math.min(bpmA && bpmB ? bpmA / bpmB : 1.0, 2.0));

/**
 * Compute a phase-locked blend window for an A→B pair (null = hard cut, td=0).
 * aOut* = A's exit window snapped to its bar grid; bIn* = B's entry window. B gets
 * `td*warp` of input so after atempo it is exactly `td` long → beat grids stay locked.
 */
export function computeBlendPlan(A: RenderTrack, B: RenderTrack): BlendPlan | null {
    const td = clampD(A.transition_duration_ms);
    if (td === 0) return null;
    const pA = beatPeriod(A.bpm), pB = beatPeriod(B.bpm);
    let aOutStart = snapToGrid(A.cue_out_ms - td, A.first_beat_ms ?? 0, pA, 4);
    aOutStart = Math.max(A.cue_in_ms, Math.min(aOutStart, A.cue_out_ms - (pA || td)));
    let bInStart = snapToGrid(B.cue_in_ms, B.first_beat_ms ?? 0, pB, 4);
    bInStart = Math.max(0, bInStart);
    const warp = warpOf(A.bpm, B.bpm);
    return { aOutStart, aOutEnd: aOutStart + td, bInStart, bInEnd: bInStart + td * warp, warp };
}

/**
 * Render a single A→B transition for auditioning: `preRollMs` of A leading into the
 * beat-locked blend, then `postRollMs` of B leading out. Returns a WAV buffer.
 * Reuses renderMix on a 2-track sub-playlist, so the preview is byte-identical to what
 * the full mix produces for this transition. Also returns where the blend sits in the clip.
 */
export async function renderTransitionPreview(
    A: RenderTrack,
    B: RenderTrack,
    opts: { preRollMs?: number; postRollMs?: number; sample_rate?: number } = {}
): Promise<{ wav: Buffer; blendStartMs: number; blendDurMs: number }> {
    const preRoll = opts.preRollMs ?? 5000;
    const postRoll = opts.postRollMs ?? 5000;
    const sr = opts.sample_rate ?? 44100;
    const plan = computeBlendPlan(A, B);

    let Ap: RenderTrack, Bp: RenderTrack, blendStartMs: number, blendDurMs: number;
    if (plan) {
        const aCueIn = Math.max(A.cue_in_ms, plan.aOutStart - preRoll);
        Ap = { ...A, cue_in_ms: aCueIn };
        Bp = { ...B, cue_out_ms: plan.bInEnd + postRoll, transition_duration_ms: 0 };
        blendStartMs = plan.aOutStart - aCueIn;               // where the blend begins in the clip
        blendDurMs = plan.aOutEnd - plan.aOutStart;
    } else {
        // Hard cut: audition a window either side of the cut, no blend.
        const aCueIn = Math.max(A.cue_in_ms, A.cue_out_ms - preRoll);
        Ap = { ...A, cue_in_ms: aCueIn, transition_duration_ms: 0 };
        Bp = { ...B, cue_out_ms: B.cue_in_ms + postRoll, transition_duration_ms: 0 };
        blendStartMs = A.cue_out_ms - aCueIn;
        blendDurMs = 0;
    }

    const out = path.join(os.tmpdir(), `aidj-preview-${process.pid}-${Math.round(process.hrtime()[1])}.wav`);
    try {
        await renderMix({ tracks: [Ap, Bp], output_path: out, format: 'wav', quality: 'standard', sample_rate: sr });
        return { wav: fs.readFileSync(out), blendStartMs, blendDurMs };
    } finally {
        try { fs.unlinkSync(out); } catch { /* ignore */ }
    }
}

/** Probe total duration of an audio file using ffprobe. */
async function probeDuration(filePath: string): Promise<number> {
    return new Promise((resolve) => {
        const proc = spawn('ffprobe', [
            '-v', 'quiet', '-print_format', 'json', '-show_format', filePath,
        ]);
        let out = '';
        proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        proc.on('close', () => {
            try {
                const data = JSON.parse(out);
                resolve(parseFloat(data.format?.duration ?? '0') * 1000);
            } catch {
                resolve(0);
            }
        });
        proc.on('error', () => resolve(0));
    });
}

export async function renderMix(opts: RenderOptions): Promise<void> {
    const { tracks, output_path, format, quality, sample_rate = 44100, onProgress, onError } = opts;

    if (tracks.length === 0) throw new Error('No tracks to render');
    if (tracks.length === 1) {
        await renderSingleTrack(tracks[0], output_path, format, quality, sample_rate, onProgress);
        return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidj-render-'));

    try {
        interface RenderTask {
            filename: string;
            title: string;
            weight: number;
            args: string[];
        }

        const tasks: (RenderTask & { success?: boolean })[] = [];
        let totalWeight = 0;

        const safePaths = new Map<string, string>();

        const getSafePath = (originalPath: string, index: number, prefix: string): string | null => {
            if (safePaths.has(originalPath)) return safePaths.get(originalPath)!;

            // Aggressive Windows FFmpeg Path Sanitizer:
            // FFmpeg crashes on Windows with code 4294967294 if the path contains ANY special
            // symbols, parentheses, Unicode '｜', emoji, or @ characters inside a filtergraph string.
            // We forcefully whitelist to strictly alphanumeric + hyphens + underscores.
            if (/[^a-zA-Z0-9_\-\.\/\\:]/.test(originalPath)) {
                const safeName = path.join(tmpDir, `safe_${prefix}_${index}${path.extname(originalPath)}`);

                // Layer 1: Try Node.js native copy (works for most special chars)
                try {
                    fs.copyFileSync(originalPath, safeName);
                    safePaths.set(originalPath, safeName);
                    return safeName;
                } catch (_e1) {
                    // Layer 2: PowerShell Copy-Item -LiteralPath handles emoji/Unicode that Node.js can't
                    try {
                        const psSource = originalPath.replace(/'/g, "''");
                        const psDest = safeName.replace(/'/g, "''");
                        execSync(
                            `powershell -NoProfile -Command "Copy-Item -LiteralPath '${psSource}' -Destination '${psDest}'"`,
                            { stdio: 'ignore', timeout: 10000 }
                        );
                        if (fs.existsSync(safeName)) {
                            safePaths.set(originalPath, safeName);
                            return safeName;
                        }
                    } catch (_e2) {
                        // Both methods failed — this file is truly inaccessible
                    }
                    console.warn(`[getSafePath] SKIPPING inaccessible file: ${originalPath}`);
                    return null; // Signal caller to skip this track
                }
            }
            return originalPath;
        };

        // ─── Pass 1: phase-locked blend window for each adjacent pair ──
        // (shared with the transition preview via computeBlendPlan → identical output.)
        const trans: (BlendPlan | null)[] = tracks
            .slice(0, -1)
            .map((A, i) => computeBlendPlan(A, tracks[i + 1]));

        for (let i = 0; i < tracks.length; i++) {
            const t = tracks[i];
            const td_curr = i < tracks.length - 1 ? clampD(tracks[i].transition_duration_ms) : 0;

            const safeTrackPath = getSafePath(t.file_path, i, 'track');
            if (!safeTrackPath) {
                console.warn(`[Render] Skipping inaccessible track ${i}: ${t.title}`);
                continue;
            }

            // 1. Solo Portion
            // Plays from where the previous blend released this track (its incoming
            // entry end) to where the next blend grabs it (its outgoing exit start),
            // so bodies and beat-locked blends butt together with no gap or overlap.
            const soloStart = (i > 0 && trans[i - 1]) ? trans[i - 1]!.bInEnd : t.cue_in_ms;
            const soloEnd = (i < tracks.length - 1 && trans[i]) ? trans[i]!.aOutStart : t.cue_out_ms;
            const soloDur = soloEnd - soloStart;

            if (soloDur > 0) {
                const file = path.join(tmpDir, `solo_${i}.wav`);
                // Format decimal sec
                const ss = (soloStart / 1000).toFixed(3);
                const se = (soloEnd / 1000).toFixed(3);

                const filterSoloStr = `[0:a]atrim=start=${ss}:end=${se},asetpts=PTS-STARTPTS,aresample=${sample_rate},aformat=sample_fmts=s16:channel_layouts=stereo[out]`;

                tasks.push({
                    filename: file,
                    title: t.title,
                    weight: soloDur,
                    args: [
                        '-y', '-i', safeTrackPath,
                        '-filter_complex', filterSoloStr,
                        '-map', '[out]', '-ar', String(sample_rate), '-ac', '2', '-acodec', 'pcm_s16le', file
                    ]
                });
                totalWeight += soloDur;
            }

            // 2. Transition Portion (beat/phase-locked window from Pass 1)
            const plan = i < tracks.length - 1 ? trans[i] : null;
            if (plan && td_curr > 0) {
                const next = tracks[i + 1];
                const safeNextPath = getSafePath(next.file_path, i + 1, 'next');
                if (!safeNextPath) {
                    console.warn(`[Render] Skipping transition ${i}->${i + 1}: next track inaccessible`);
                    continue;
                }
                const outStart = plan.aOutStart;
                const outEnd = plan.aOutEnd;
                const inStart = plan.bInStart;
                const inEnd = plan.bInEnd;

                const file = path.join(tmpDir, `trans_${i}.wav`);

                const osS = (outStart / 1000).toFixed(3);
                const osE = (outEnd / 1000).toFixed(3);
                const isS = (inStart / 1000).toFixed(3);
                const isE = (inEnd / 1000).toFixed(3);
                const dS = (td_curr / 1000).toFixed(3);

                // EQ Swap parameters:
                let rawRatio = t.bpm && next.bpm ? (t.bpm / next.bpm) : 1.0;
                // FFmpeg atempo strictly requires values >= 0.5 and <= 100.0, or it crashes with 4294967262!
                // We'll realistically clamp the warp effect between 0.5 (half speed) and 2.0 (double speed).
                rawRatio = Math.max(0.5, Math.min(rawRatio, 2.0));
                const warpRatio = rawRatio.toFixed(4);

                let filterGraphA = '';
                let filterGraphB = '';
                const transType = (t as any).transition_type ?? 'equal_power';

                if (transType === 'echo_out') {
                    filterGraphA = `[0:a]atrim=start=${osS}:end=${osE},asetpts=PTS-STARTPTS,aresample=${sample_rate},aformat=sample_fmts=s16:channel_layouts=stereo,afade=t=out:st=0:d=${Number(dS) / 4}:curve=nofade,aecho=1.0:0.7:400:0.5[a0];`;
                    filterGraphB = `[1:a]atrim=start=${isS}:end=${isE},asetpts=PTS-STARTPTS,aresample=${sample_rate},aformat=sample_fmts=s16:channel_layouts=stereo,atempo=${warpRatio}[a1];`;
                } else if (transType === 'backspin') {
                    const stopDur = Math.min(1.0, Number(dS));
                    filterGraphA = `[0:a]atrim=start=${osS}:end=${osE},asetpts=PTS-STARTPTS,aresample=${sample_rate},aformat=sample_fmts=s16:channel_layouts=stereo,afade=t=out:st=0:d=${stopDur}:curve=exp[a0];`;
                    filterGraphB = `[1:a]atrim=start=${isS}:end=${isE},asetpts=PTS-STARTPTS,aresample=${sample_rate},aformat=sample_fmts=s16:channel_layouts=stereo,atempo=${warpRatio}[a1];`;
                } else {
                    // Default Transition: beatmatched equal-power crossfade + bass swap.
                    // B is tempo-warped to A's BPM (atempo); Pass-1 boundaries put both beat
                    // grids on the same phase, so the blend is phase-locked. qsin fades give a
                    // constant-power (no dip) crossfade for the mids/highs.
                    //
                    // Bass swap: a swept high-pass whose cutoff RISES on the outgoing track
                    // (bass leaves) and FALLS on the incoming track (bass enters), so the two
                    // kicks/basslines never stack. FFmpeg's highpass frequency can't take a
                    // `t` expression, so we drive it at runtime with asendcmd on a *named*
                    // filter instance (highpass@hpa / highpass@hpb) — a series of timed steps
                    // interpolated across the blend. (This is why the old `highpass=f=200*t/…`
                    // was invalid and silently dropped every transition.)
                    const BASS_HZ = 240;        // how high we lift the low-cut at the swap peak
                    const sweep = (inst: string, fromHz: number, toHz: number, durS: number, steps = 12) => {
                        const parts: string[] = [];
                        for (let k = 0; k <= steps; k++) {
                            const frac = k / steps;
                            const tSec = (frac * durS).toFixed(3);
                            const f = Math.round(fromHz + (toHz - fromHz) * frac);
                            parts.push(`${tSec} ${inst} frequency ${f}`);
                        }
                        return parts.join('; ');
                    };
                    const cmdsA = sweep('highpass@hpa', 20, BASS_HZ, Number(dS));   // A: bass sweeps OUT
                    const cmdsB = sweep('highpass@hpb', BASS_HZ, 20, Number(dS));   // B: bass sweeps IN

                    filterGraphA = `[0:a]atrim=start=${osS}:end=${osE},asetpts=PTS-STARTPTS,aresample=${sample_rate},aformat=sample_fmts=s16:channel_layouts=stereo,asendcmd=c='${cmdsA}',highpass@hpa=f=20,afade=t=out:st=0:d=${dS}:curve=qsin[a0];`;
                    filterGraphB = `[1:a]atrim=start=${isS}:end=${isE},asetpts=PTS-STARTPTS,aresample=${sample_rate},aformat=sample_fmts=s16:channel_layouts=stereo,atempo=${warpRatio},asendcmd=c='${cmdsB}',highpass@hpb=f=${BASS_HZ},afade=t=in:st=0:d=${dS}:curve=qsin[a1];`;
                }

                const filterComplexStr = filterGraphA + filterGraphB + `[a0][a1]amix=inputs=2:duration=longest:normalize=0,aformat=sample_fmts=s16:channel_layouts=stereo[out]`;

                tasks.push({
                    filename: file,
                    title: `Mixing: ${t.artist} -> ${next.artist}`,
                    weight: td_curr,
                    args: [
                        '-y', '-i', safeTrackPath, '-i', safeNextPath,
                        '-filter_complex', filterComplexStr,
                        '-map', '[out]', '-ar', String(sample_rate), '-ac', '2', '-acodec', 'pcm_s16le', file
                    ]
                });
                totalWeight += td_curr;
            }
        }

        let completedWeight = 0;
        let currentIndex = 0;
        onProgress?.(0, 'Preparing audio segments...');

        const worker = async () => {
            while (currentIndex < tasks.length) {
                const task = tasks[currentIndex++];
                await new Promise<void>((resolve, reject) => {
                    // Force shell: false directly (which is default). Node natively arrays arguments safely on Windows if no shell is present.
                    const proc = spawn('ffmpeg', task.args, { stdio: ['ignore', 'ignore', 'pipe'] });
                    let stderrData = '';
                    proc.stderr?.on('data', (chunk: Buffer) => { stderrData += chunk.toString(); });
                    if (proc.pid) {
                        try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW); } catch (e) { }
                    }
                    proc.on('close', (code) => {
                        if (code === 0) {
                            task.success = true;
                            completedWeight += task.weight;
                            // Reserve last 5% for the fast concat stage
                            const pct = Math.round((completedWeight / totalWeight) * 95);
                            onProgress?.(pct, task.title);
                            resolve();
                        } else {
                            console.error(`Render error with code ${code} for: ${task.title}`);
                            if (stderrData) console.error(`FFmpeg stderr: ${stderrData.slice(-500)}`);
                            // DO NOT reject — skip this segment gracefully to prevent process crash
                            console.warn(`[Render] Skipping failed segment: ${task.title}`);
                            task.success = false;
                            resolve();
                        }
                    });
                    proc.on('error', (err) => {
                        console.warn(`[Render] Process error for ${task.title}:`, err.message);
                        resolve(); // Skip gracefully
                    });
                });
            }
        };

        // Fall back to sequential encoding or max 2 parallel on Windows to prevent `atempo`/amix thread exhaustion OOM crashes
        const NUM_WORKERS = process.platform === 'win32' ? 1 : Math.min(tasks.length, 4);
        await Promise.all(Array.from({ length: NUM_WORKERS }).map(() => worker()));

        // --- CONCATENATE ALL SEGMENTS ---
        onProgress?.(95, 'Stitching mix together...');

        const concatListPath = path.join(tmpDir, 'concat.txt');
        let concatContent = '';
        for (const task of tasks) {
            if (!task.success || !fs.existsSync(task.filename)) continue;

            // FFmpeg Concat Demuxer Escaping Rules:
            // 1. Path MUST be in single quotes
            // 2. Any internal single quotes MUST be escaped as '''' (four single quotes) or similar
            // 3. Backslashes MUST be escaped or converted to forward slashes.
            const escapedPath = task.filename
                .replace(/\\/g, '/')   // Convert to forward slash
                .replace(/'/g, "\\'"); // Escape single quote for FFmpeg demuxer spec
            concatContent += `file '${escapedPath}'\n`;
        }
        if (!concatContent) throw new Error('No audio segments were successfully rendered.');
        fs.writeFileSync(concatListPath, concatContent);

        const qualArgs = QUALITY_SETTINGS[format][quality];
        const finalArgs = [
            '-y', '-f', 'concat', '-safe', '0', '-i', concatListPath,
            '-ar', String(sample_rate), ...qualArgs, output_path
        ];

        await new Promise<void>((resolve, reject) => {
            const proc = spawn('ffmpeg', finalArgs, { stdio: 'ignore', shell: false });
            if (proc.pid) {
                try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW); } catch (e) { }
            }
            proc.on('close', (code) => {
                if (code === 0) {
                    onProgress?.(100, '');
                    resolve();
                } else {
                    reject(new Error(`Final track assembly failed with code ${code}`));
                }
            });
            proc.on('error', reject);
        });

    } catch (err: any) {
        console.error('[Render] Fatal Error:', err);
        onError?.(err.message);
        throw err;
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
    }
}

async function renderSingleTrack(
    track: RenderTrack,
    outputPath: string,
    format: RenderFormat,
    quality: RenderQuality,
    sampleRate: number,
    onProgress?: (pct: number, title: string) => void
): Promise<void> {
    const startSec = (track.cue_in_ms / 1000).toFixed(3);
    const endSec = (track.cue_out_ms / 1000).toFixed(3);
    const qualArgs = QUALITY_SETTINGS[format][quality];

    const args = ['-y', '-i', track.file_path, '-ss', startSec, '-to', endSec, '-ar', String(sampleRate), ...qualArgs, outputPath];

    onProgress?.(0, track.title);
    await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
        proc.on('close', (code) => {
            if (code === 0) { onProgress?.(100, ''); resolve(); }
            else reject(new Error(`FFmpeg exited ${code}`));
        });
        proc.on('error', reject);
    });
}
