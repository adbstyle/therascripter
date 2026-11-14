#!/usr/bin/env python3
"""
Text-Artefakt des Suchmodells aus einem Hugging-Face-Snapshot erzeugen.

google/embeddinggemma-2 ist multimodal (Text, Bild, Audio; 1.49 GB). Der
Suchdienst (python_sidecar/search_service.py) braucht nur den Text-Zweig. Dieses
Skript schreibt in <ausgabe>:

    config.json        Original, vision_config/audio_config = null
    model.safetensors  nur die Tensoren `language_model.*` (413), Originalnamen, bf16
    tokenizer.json     unverändert
    LICENSE            Apache 2.0 (Modell von Google) mit Herkunftsangabe
    READY              Marker; im Tar die LETZTE Datei (checkPath im Katalog)

Gepackt wird danach mit `scripts/package-models.sh search <ausgabe>`.
Die Ausgabe ist bytegleich reproduzierbar (feste Tensor-Reihenfolge, feste
JSON-Formatierung), damit zwei Läufe denselben Tarball-Hash ergeben.

Ausführen mit einer Python-Umgebung, die torch und safetensors hat — der
ausgelieferte Standalone-Interpreter genügt, nur LESEND:

    HF_HOME=<hf-cache> PYTHONDONTWRITEBYTECODE=1 \\
        python_sidecar/standalone/bin/python3 scripts/export-search-model.py \\
        <snapshot-verzeichnis> <ausgabe-verzeichnis>

Das Snapshot-Verzeichnis ist z. B.
<hf-cache>/hub/models--google--embeddinggemma-2/snapshots/<revision>/ (vorher
`hf download google/embeddinggemma-2`). Das Skript selbst lädt nichts herunter
und nichts hoch. Erzeugt und geprüft mit Revision f9972ac22e696a105c482202646979e33e4b5a1e.
"""

import json
import os
import shutil
import sys

PREFIX = "language_model."
EXPECTED_TENSORS = 413
# Dieselbe Kopie, die electron-builder als ml_sidecar/LICENSE-Apache-2.0.txt
# neben search_service.py bündelt.
LICENSE_TEMPLATE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "python_sidecar",
    "LICENSE-Apache-2.0.txt",
)

LICENSE_HEADER = """EmbeddingGemma 2 (google/embeddinggemma-2), Text-Encoder
Copyright Google LLC. Licensed under the Apache License, Version 2.0 (below).

Geändert von Therascript: nur die Text-Gewichte (language_model.*) übernommen,
Bild- und Audio-Teil entfernt; Gewichte sonst unverändert (bfloat16).

"""

# Die Text-Konfiguration bleibt vollständig; nur die Teile der anderen
# Modalitäten werden entfernt (wie beim Laden mit vision_config/audio_config=None).
NULLED_CONFIG_KEYS = ("vision_config", "audio_config")


def export(snapshot, out_dir):
    import torch
    from safetensors import safe_open
    from safetensors.torch import save_file

    os.makedirs(out_dir, exist_ok=True)
    if os.listdir(out_dir):
        sys.exit(f"Ausgabeverzeichnis ist nicht leer: {out_dir}")

    with open(os.path.join(snapshot, "config.json"), encoding="utf-8") as f:
        config = json.load(f)
    for key in NULLED_CONFIG_KEYS:
        config[key] = None
    if config.get("text_config", {}).get("model_type") != "embedding_gemma2_text":
        sys.exit("Unerwartete config.json: text_config.model_type ist nicht embedding_gemma2_text")
    with open(os.path.join(out_dir, "config.json"), "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
        f.write("\n")

    tensors = {}
    with safe_open(os.path.join(snapshot, "model.safetensors"), framework="pt") as source:
        for key in sorted(source.keys()):
            if key.startswith(PREFIX):
                tensor = source.get_tensor(key)
                if tensor.dtype != torch.bfloat16:
                    tensor = tensor.to(torch.bfloat16)
                tensors[key] = tensor.contiguous()
    if len(tensors) != EXPECTED_TENSORS:
        sys.exit(f"{len(tensors)} Text-Tensoren statt {EXPECTED_TENSORS} — anderes Modell?")
    # save_file ordnet den Header selbst deterministisch (nach dtype, dann Name).
    save_file(tensors, os.path.join(out_dir, "model.safetensors"), metadata={"format": "pt"})

    shutil.copyfile(os.path.join(snapshot, "tokenizer.json"), os.path.join(out_dir, "tokenizer.json"))

    with open(LICENSE_TEMPLATE, encoding="utf-8") as f:
        license_text = f.read()
    with open(os.path.join(out_dir, "LICENSE"), "w", encoding="utf-8") as f:
        f.write(LICENSE_HEADER + license_text)

    with open(os.path.join(out_dir, "READY"), "w", encoding="utf-8") as f:
        f.write("embeddinggemma-2-text-v1\n")

    parameters = sum(t.numel() for t in tensors.values())
    print(f"{len(tensors)} Tensoren, {parameters / 1e6:.1f} M Parameter → {out_dir}")
    for name in ("config.json", "model.safetensors", "tokenizer.json", "LICENSE", "READY"):
        print(f"  {name}: {os.path.getsize(os.path.join(out_dir, name))} Bytes")


def main():
    if len(sys.argv) != 3:
        sys.exit("Usage: export-search-model.py <hf-snapshot-verzeichnis> <ausgabe-verzeichnis>")
    export(sys.argv[1], sys.argv[2])


if __name__ == "__main__":
    main()
