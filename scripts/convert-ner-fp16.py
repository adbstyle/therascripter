#!/usr/bin/env python3
"""
Schreibt den flair-NER-Checkpoint als fp16 in ein Staging-Verzeichnis (Issue #131).

Usage (mit dem Dev-venv, flair muss importierbar sein):
    python_sidecar/venv/bin/python scripts/convert-ner-fp16.py <quell-ner-dir> <ziel-ner-dir>

Das Ziel muss die HF-Cache-Struktur des Originals bereits enthalten (refs/,
snapshots/ mit dem Symlink, hf/-Tokenizer-Subtree) — package-models.sh kopiert
sie ohne die Blobs dorthin. Dieses Script schreibt den einen fehlenden Blob.

Warum an die Stelle des Originals statt als eigene Datei: das Manifest erreicht
JEDE App-Version, auch die bis v0.8.9, die ausschliesslich über
Classifier.load('flair/ner-german-large') laden. Diese Versionen finden den
Checkpoint nur über die HF-Cache-Struktur; ihr flair-Loader liest das moderne
Format über ein File-Objekt problemlos und castet beim Laden auf fp32 hoch.

Warum der Blob den Namen des fp32-Originals behält, obwohl HF Blobs nach ihrem
Inhalts-Hash benennt: v1-Installationen (App bis v0.8.5) bekommen das Artefakt
per tar-Merge über ihr bestehendes ner/ (siehe checkPath in model-catalog.ts).
Mit gleichem Namen überschreibt der Merge den 2.2-GB-fp32-Blob; mit eigenem
Namen bliebe er verwaist liegen. Der Preis: der Cache ist nicht mehr
inhaltsadressiert. Endnutzer laufen ausschliesslich offline (HF_HUB_OFFLINE)
und merken davon nichts — aber Online-HF-Werkzeuge (scan-cache --verify,
setup-ner.sh) gehören nie auf ein entpacktes v3-Verzeichnis.

Warum über flair statt direkt über torch.load + .half(): der HF-Original-Checkpoint
enthält neben dem state_dict die kompletten Embeddings als fp32-Objekt.
Ein Cast nur des state_dict ergab 3.4 GB statt 1.1 GB. tagger.save() legt die
Embeddings dagegen ohne Gewichte ab — die Gewichte stecken dann ausschliesslich
im state_dict, und genau das wird anschliessend nach fp16 gecastet.
"""

import os
import sys

# Erkennung und Modell-ID aus dem ausgelieferten Sidecar — die Gegenprobe soll
# beweisen, dass GENAU dieser Code das Artefakt als kompakt einstuft. Der Import
# ist nebenwirkungsfrei (stdlib) und setzt HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "python_sidecar"))
from ner_service import NER_MODEL_ID, is_zip_checkpoint, needs_fast_checkpoint  # noqa: E402


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    source_dir, target_dir = (os.path.realpath(p) for p in sys.argv[1:])

    # Vor dem Import setzen: flair und huggingface_hub binden beides beim Import.
    # Der Tokenizer kommt für beide Loads aus der Quelle — ob das Ziel-hf/
    # vollständig ist, prüft smoke-packaged.sh am entpackten Artefakt.
    os.environ["FLAIR_CACHE_ROOT"] = source_dir
    os.environ["HF_HOME"] = os.path.join(source_dir, "hf")

    from pathlib import Path

    import flair
    import torch
    from flair.file_utils import hf_download
    from flair.nn import Classifier

    def resolved_blob():
        return os.path.realpath(hf_download(NER_MODEL_ID))

    source_blob = resolved_blob()
    target_blob = os.path.join(target_dir, os.path.relpath(source_blob, source_dir))
    if not os.path.isdir(os.path.dirname(target_blob)):
        sys.exit(f"Zielstruktur fehlt: {os.path.dirname(target_blob)}")

    # Über die öffentliche API (Model.save) in das kompakte Layout bringen,
    # erst danach casten — kein Griff in flair-Interna wie _get_state_dict.
    fp32_blob = f"{target_blob}.fp32.tmp"
    Classifier.load(NER_MODEL_ID).save(fp32_blob)
    state = torch.load(fp32_blob, map_location="cpu", weights_only=False, mmap=True)
    state["state_dict"] = {
        key: value.half() if value.dtype == torch.float32 else value
        for key, value in state["state_dict"].items()
    }
    tmp_blob = f"{target_blob}.tmp"
    torch.save(state, tmp_blob, pickle_protocol=4)
    os.replace(tmp_blob, target_blob)
    del state
    os.remove(fp32_blob)

    # Gegenprobe aus dem ZIEL über dieselbe HF-Auflösung, die die App nutzt:
    # Zip-Format, vom Sidecar als kompakt erkannt (sonst legte jede v3-
    # Installation eine 2.1 GB grosse fp32-Kopie an), Parameter wieder fp32.
    flair.cache_root = Path(target_dir)
    if resolved_blob() != target_blob:
        sys.exit("Ziel-Snapshot zeigt nicht auf den geschriebenen Blob")
    if not is_zip_checkpoint(target_blob) or needs_fast_checkpoint(target_blob):
        sys.exit("Geschriebener Blob gilt für ner_service.py nicht als kompakt")
    dtypes = {p.dtype for p in Classifier.load(NER_MODEL_ID).parameters()}
    if dtypes != {torch.float32}:
        sys.exit(f"Unerwartete Parameter-dtypes nach dem Laden: {dtypes}")

    size_gb = os.path.getsize(target_blob) / 1024**3
    print(f"fp16-Checkpoint geschrieben: {target_blob} ({size_gb:.2f} GB)")


if __name__ == "__main__":
    main()
