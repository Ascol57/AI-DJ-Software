"""
build_mood_prototypes.py — Precompute CLAP text embeddings ("prototypes") for
each mood class, so mood can be classified zero-shot by comparing a track's CLAP
audio embedding against these fixed text anchors (cosine similarity in the CLAP
joint space). This is the real-model path: the shipped mood_hubert ONNX is only a
199-byte stub, so we reuse the CLAP model we already depend on.

One-time. Output: models/mood_clap_prototypes.npz
Usage:  python ml-sidecar/build_mood_prototypes.py
"""
import os
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(SCRIPT_DIR, "models")
OUT_PATH = os.path.join(MODELS_DIR, "mood_clap_prototypes.npz")
REPO_ID = "laion/clap-htsat-unfused"  # same CLAP used for clap_audio.onnx

# Must stay in the same order as MOOD_CLASSES in mood.py
MOOD_PROMPTS = {
    "Euphoric":    "euphoric uplifting festival anthem with soaring ecstatic melodies",
    "Energetic":   "high energy fast upbeat driving dance track",
    "Happy":       "happy cheerful feel-good sunny music",
    "Uplifting":   "uplifting positive inspiring hopeful melody",
    "Dreamy":      "dreamy ethereal atmospheric floating ambient music",
    "Melancholic": "melancholic sad wistful emotional melody",
    "Dark":        "dark brooding ominous menacing music",
    "Aggressive":  "aggressive intense hard-hitting heavy pounding track",
    "Tense":       "tense suspenseful anxious uneasy music",
    "Calm":        "calm peaceful gentle soft soothing music",
    "Relaxed":     "relaxed laid-back chill mellow groove",
    "Spiritual":   "spiritual meditative transcendent sacred music",
}


def main():
    import torch
    from transformers import ClapModel, ClapProcessor

    names = list(MOOD_PROMPTS.keys())
    prompts = [MOOD_PROMPTS[n] for n in names]

    print(f"[mood-proto] Loading {REPO_ID} ...")
    model = ClapModel.from_pretrained(REPO_ID).eval()
    processor = ClapProcessor.from_pretrained(REPO_ID)

    print(f"[mood-proto] Encoding {len(prompts)} mood prompts ...")
    inputs = processor(text=prompts, return_tensors="pt", padding=True)
    with torch.no_grad():
        text_features = model.get_text_features(**inputs)  # [12, 512] projected joint space
    vecs = text_features.cpu().numpy().astype(np.float32)
    # L2-normalize so runtime only needs to normalize the audio vector
    vecs /= (np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-9)

    # CLAP's learned temperature for audio-text logits
    logit_scale = float(model.logit_scale_a.exp().detach().cpu().numpy())

    np.savez(
        OUT_PATH,
        names=np.array(names),
        vectors=vecs,
        logit_scale=np.float32(logit_scale),
    )
    print(f"[mood-proto] Saved {OUT_PATH}  (vectors {vecs.shape}, logit_scale {logit_scale:.2f})")


if __name__ == "__main__":
    main()
