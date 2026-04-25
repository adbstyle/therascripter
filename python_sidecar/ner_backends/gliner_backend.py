"""GLiNER NER backend — zero-shot multilingual entity recognition.

Uses urchade/gliner_multi-v2.1 by default (~209M params, ~1.16 GB on disk).
Zero-shot: native entity types are the labels we hand the model at inference
time. The label list below is intentionally narrow (5 labels) to mirror the
canonical PlaceholderType values that the TypeScript merger emits — EMAIL/
PHONE/DATE are deliberately excluded because the regex pipeline covers those
deterministically with Swiss-format calibration.

The TypeScript-side `mapGlinerType` maps these labels to canonical
PlaceholderType values (see entity-merger.ts).
"""

from typing import Callable

# Zero-shot label set — must match the keys in the TS-side mapGlinerType
# switch. Keep these labels in sync with that mapping.
GLINER_LABELS_DE = [
    "Person",
    "Ort",
    "Organisation",
    "Krankheit",
    "Medikament",
]

# Confidence threshold for emitted entities — GLiNER's `predict_entities`
# accepts a threshold parameter; below this score the prediction is dropped.
# 0.5 is the library default; we set it explicitly so behavior is independent
# of upstream defaults changing.
DEFAULT_THRESHOLD = 0.5


def predict(
    segments: list[dict],
    hf_id: str,
    model_dir: str,
    progress_cb: Callable[[int], None],
) -> list[dict]:
    # Heavy imports inside predict() — only loaded when this backend is selected.
    from gliner import GLiNER

    progress_cb(10)

    # GLiNER.from_pretrained respects HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE
    # (set by the dispatcher) plus its own local_files_only kwarg.
    model = GLiNER.from_pretrained(
        hf_id,
        cache_dir=model_dir,
        local_files_only=True,
    )

    progress_cb(25)

    entities: list[dict] = []
    total = len(segments)
    for idx, segment in enumerate(segments):
        text = segment.get("text", "")
        if not text.strip():
            continue

        spans = model.predict_entities(text, GLINER_LABELS_DE, threshold=DEFAULT_THRESHOLD)

        # GLiNER returns dicts with: start, end, text, label, score
        for span in spans:
            entities.append(
                {
                    "text": span.get("text", text[int(span["start"]) : int(span["end"])]),
                    "type": span["label"],
                    "segmentIndex": idx,
                    "charStart": int(span["start"]),
                    "charEnd": int(span["end"]),
                    "confidence": round(float(span["score"]), 4),
                }
            )

        # Progress: 25-95% mapped to segment processing
        pct = 25 + int((idx + 1) / total * 70)
        progress_cb(min(pct, 95))

    return entities
