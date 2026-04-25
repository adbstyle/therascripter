"""Abstract base / shared types for NER backends.

Backends are plain functions (no class hierarchy needed) that conform to:

    predict(
        segments: list[dict],   # transcript segments with .text, .start, .end
        hf_id: str,             # HuggingFace identifier (e.g. "flair/ner-german-large")
        model_dir: str,         # local cache root
        progress_cb: Callable[[int], None],   # progress 0-100 to stderr
    ) -> list[dict]              # native entities — backend-specific .type strings

Each entity dict has the shape:

    {
        "text": str,
        "type": str,            # native type (PER/LOC/MISC for flair, etc.)
        "segmentIndex": int,
        "charStart": int,
        "charEnd": int,
        "confidence": float,    # 0-1
    }
"""

from typing import Callable, Protocol


class BackendPredictFn(Protocol):
    def __call__(
        self,
        segments: list[dict],
        hf_id: str,
        model_dir: str,
        progress_cb: Callable[[int], None],
    ) -> list[dict]: ...
