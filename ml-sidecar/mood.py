"""
Mood classification. ONNX model if available, else valence/arousal heuristic.
SOC2 Rule 2: fully local — no data leaves device.
"""
import os

MOOD_CLASSES = [
    "Euphoric", "Energetic", "Happy", "Uplifting", "Dreamy", "Melancholic",
    "Dark", "Aggressive", "Tense", "Calm", "Relaxed", "Spiritual",
]

_onnx_session = None
_model_loaded = False

# --- CLAP zero-shot mood (real model path) ---------------------------------
# The shipped mood_hubert ONNX is a 199-byte stub, so instead we classify mood
# by comparing a track's CLAP audio embedding against precomputed CLAP text
# embeddings for each mood (cosine similarity in the joint space).
# Prototypes are built by build_mood_prototypes.py → models/mood_clap_prototypes.npz
_proto_vecs = None          # np.ndarray [12, 512], L2-normalized
_proto_names = None         # list[str], mood class names
_proto_scale = 1.0          # CLAP logit_scale
_proto_loaded = False


def _load_prototypes() -> bool:
    global _proto_vecs, _proto_names, _proto_scale, _proto_loaded
    if _proto_loaded:
        return _proto_vecs is not None
    _proto_loaded = True
    proto_path = os.path.join(os.path.dirname(__file__), "models", "mood_clap_prototypes.npz")
    if not os.path.exists(proto_path):
        print("[ML] mood_clap_prototypes.npz not found — mood using heuristic")
        return False
    try:
        import numpy as np
        data = np.load(proto_path, allow_pickle=True)
        _proto_vecs = data["vectors"].astype(np.float32)
        _proto_names = [str(n) for n in data["names"].tolist()]
        _proto_scale = float(data["logit_scale"]) if "logit_scale" in data else 1.0
        print(f"[ML] CLAP mood prototypes loaded ({_proto_vecs.shape[0]} classes)")
        return True
    except Exception as e:
        print(f"[ML] Failed to load mood prototypes: {e}")
        _proto_vecs = None
        return False


def _clap_classify(embedding) -> dict:
    """Zero-shot mood from a track's CLAP audio embedding vs mood text prototypes."""
    import numpy as np
    a = np.asarray(embedding, dtype=np.float32)
    a = a / (np.linalg.norm(a) + 1e-9)
    sims = _proto_vecs @ a                      # cosine sim (both L2-normalized)
    logits = _proto_scale * sims
    logits -= logits.max()
    probs = np.exp(logits)
    probs /= probs.sum()
    order = np.argsort(-probs)
    return {
        "mood_primary": _proto_names[int(order[0])],
        "mood_secondary": _proto_names[int(order[1])],
        "mood_confidence": float(probs[order[0]]),
        "backend": "clap_zero_shot",
    }


def _load_model() -> bool:
    global _onnx_session, _model_loaded
    if _model_loaded:
        return _onnx_session is not None
    _model_loaded = True
    model_path = os.path.join(os.path.dirname(__file__), "models", "mood.onnx")
    if not os.path.exists(model_path):
        print("[ML] mood.onnx not found — using heuristic classifier")
        return False
    try:
        import onnxruntime as ort
        _onnx_session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        print("[ML] Mood model loaded from ONNX")
        return True
    except Exception as e:
        print(f"[ML] Failed to load mood model: {e}")
        return False


def classify_mood(file_path: str, y=None, sr=None, embedding=None) -> dict:
    """Classify mood from audio.
    Priority: CLAP zero-shot (real model, needs the track's CLAP embedding) →
    legacy mel ONNX (if a real mood.onnx is ever added) → valence/arousal heuristic.
    """
    if not os.path.exists(file_path):
        return _unknown_mood()

    # 1. CLAP zero-shot — the real-model path
    if embedding is not None and _load_prototypes() and _proto_vecs is not None:
        try:
            import numpy as np
            if float(np.linalg.norm(np.asarray(embedding, dtype=np.float32))) > 1e-6:
                return _clap_classify(embedding)
        except Exception as e:
            print(f"[ML] CLAP mood inference error: {e}")

    # 2. Legacy mel-spectrogram ONNX (mood.onnx), if present and valid
    if _load_model() and _onnx_session is not None:
        return _onnx_classify(file_path, y, sr)

    # 3. Heuristic fallback
    return _heuristic_mood(file_path, y, sr)


def _onnx_classify(file_path: str, y=None, sr=None) -> dict:
    try:
        import librosa
        import numpy as np

        if y is None or sr is None:
            y, sr = librosa.load(file_path, sr=22050, mono=True, duration=30.0)
        else:
            y = y[:int(sr * 30.0)]
        mel = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=128, fmax=8000)
        mel_db = librosa.power_to_db(mel, ref=np.max)
        mel_norm = (mel_db - mel_db.mean()) / (mel_db.std() + 1e-9)

        target_frames = 1292
        if mel_norm.shape[1] < target_frames:
            mel_norm = np.pad(mel_norm, ((0, 0), (0, target_frames - mel_norm.shape[1])))
        else:
            mel_norm = mel_norm[:, :target_frames]

        inp = mel_norm[np.newaxis, np.newaxis, :, :].astype(np.float32)
        outputs = _onnx_session.run(None, {_onnx_session.get_inputs()[0].name: inp})
        probs = outputs[0][0]

        top2 = sorted(enumerate(probs), key=lambda x: -x[1])[:2]
        return {
            "mood_primary": MOOD_CLASSES[top2[0][0]],
            "mood_secondary": MOOD_CLASSES[top2[1][0]],
            "mood_confidence": float(top2[0][1]),
        }
    except Exception as e:
        print(f"[ML] ONNX mood inference error: {e}")
        return _unknown_mood()


def _heuristic_mood(file_path: str, y=None, sr=None) -> dict:
    """Estimate mood from valence/arousal proxies derived from audio features."""
    try:
        import librosa
        import numpy as np

        if y is None or sr is None:
            y, sr = librosa.load(file_path, sr=22050, mono=True, duration=30.0)
        else:
            y = y[:int(sr * 30.0)]
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(tempo[0] if hasattr(tempo, '__len__') else tempo)

        rms = float(np.mean(librosa.feature.rms(y=y)))
        # High-frequency energy proxy for brightness (valence)
        spec = np.abs(librosa.stft(y))
        freqs = librosa.fft_frequencies(sr=sr)
        high_energy = float(np.mean(spec[freqs > 4000, :]))
        low_energy = float(np.mean(spec[freqs < 500, :]))
        brightness = high_energy / (low_energy + 1e-9)

        # Map to moods
        arousal = min(1.0, bpm / 160.0)
        valence = min(1.0, brightness * 5)

        if arousal > 0.8 and valence > 0.6:
            mood = "Euphoric"
        elif arousal > 0.75:
            mood = "Energetic"
        elif arousal > 0.6 and valence > 0.5:
            mood = "Happy"
        elif arousal < 0.4 and valence < 0.4:
            mood = "Melancholic"
        elif arousal > 0.7 and valence < 0.4:
            mood = "Aggressive"
        elif arousal < 0.5:
            mood = "Calm"
        else:
            mood = "Uplifting"

        return {"mood_primary": mood, "mood_secondary": "Energetic", "mood_confidence": 0.4}
    except Exception:
        return _unknown_mood()


def _unknown_mood() -> dict:
    return {"mood_primary": "Unknown", "mood_secondary": None, "mood_confidence": 0.0}


def is_model_loaded() -> bool:
    return _load_model() and _onnx_session is not None
