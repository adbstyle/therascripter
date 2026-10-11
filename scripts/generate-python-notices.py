#!/usr/bin/env python3
"""Lizenzhinweise der Python-Laufzeit im gebundelten Sidecar erzeugen.

Liest CPython-Lizenz und alle Pakete aus dem Standalone-Sidecar (genau das,
was ins DMG kommt — nach dem Prune in build-sidecar.sh) und schreibt:

  src/renderer/src/assets/licenses/python-notices.txt   — alle Lizenztexte
  src/renderer/src/assets/licenses/python-packages.json — Name/Version/Lizenz

Beide Dateien sind eingecheckt; die Über-Seite zeigt die Liste und lädt den
Volltext erst beim Aufklappen. build-sidecar.sh ruft dieses Skript am Ende
auf, damit die Hinweise nach jedem Sidecar-Rebuild zum Bundle passen.

Aufruf: python3 -I scripts/generate-python-notices.py [<standalone-dir>]
"""

import importlib.metadata as md
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / 'src' / 'renderer' / 'src' / 'assets' / 'licenses'
LICENSE_FILE_HINTS = ('licen', 'copying', 'notice')

# Pakete ohne Lizenz-Metadaten und ohne Lizenzdatei im Wheel — Lizenz aus dem
# Upstream-Repo (per GitHub-API verifiziert, 2026-10-11).
UPSTREAM_LICENSES = {
    'pptree': 'MIT (laut Upstream-Repo clemtoy/pptree)',
    'sentencepiece': 'Apache-2.0 (laut Upstream-Repo google/sentencepiece)',
}


def license_name(meta: md.PackageMetadata, texts: list[str]) -> str:
    if meta['Name'] in UPSTREAM_LICENSES:
        return UPSTREAM_LICENSES[meta['Name']]
    expr = meta.get('License-Expression')
    if expr:
        return expr.strip()
    lic = (meta.get('License') or '').strip()
    # Manche Pakete stopfen den kompletten Lizenztext ins License-Feld.
    if lic and '\n' not in lic and len(lic) <= 60 and lic.upper() != 'UNKNOWN':
        return lic
    classifiers = [
        c.split('::')[-1].strip()
        for c in meta.get_all('Classifier') or []
        if c.startswith('License ::') and c.count('::') >= 2
    ]
    if classifiers:
        return ', '.join(classifiers)
    if texts:
        first = texts[0].strip().splitlines()[0].strip()
        if len(first) <= 60:
            return first
    return 'nicht angegeben'


def license_texts(dist: md.Distribution) -> list[str]:
    texts = []
    for f in sorted(dist.files or [], key=str):
        p = str(f)
        name = p.rsplit('/', 1)[-1].lower()
        if '.dist-info/' not in p or not name.startswith(LICENSE_FILE_HINTS):
            continue
        try:
            texts.append(Path(dist.locate_file(f)).read_text(encoding='utf-8', errors='replace'))
        except OSError:
            continue
    return texts


def main() -> None:
    standalone = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / 'python_sidecar' / 'standalone'
    lib = next((standalone / 'lib').glob('python3.*'))
    site_packages = lib / 'site-packages'
    python_version = lib.name.removeprefix('python')

    packages = [
        {
            'name': 'Python (CPython)',
            'version': python_version,
            'license': 'PSF-2.0',
            'texts': [(lib / 'LICENSE.txt').read_text(encoding='utf-8')],
        }
    ]
    for dist in md.distributions(path=[str(site_packages)]):
        texts = license_texts(dist)
        packages.append(
            {
                'name': dist.metadata['Name'],
                'version': dist.version,
                'license': license_name(dist.metadata, texts),
                'texts': texts,
            }
        )
    packages.sort(key=lambda p: (p['name'] != 'Python (CPython)', p['name'].lower()))

    # Apache 2.0 verlangt den Lizenztext — für Pakete, deren Wheel ihn nicht
    # mitliefert, den Standardtext anhängen.
    apache_text = (OUT_DIR / 'apache-2.0.txt').read_text(encoding='utf-8')
    for p in packages:
        if not p['texts'] and 'apache' in p['license'].lower():
            p['texts'] = [apache_text]

    chunks = [
        'Lizenzhinweise der Python-Laufzeit im TheraScript-Sidecar\n'
        f'({len(packages)} Komponenten, erzeugt von scripts/generate-python-notices.py)\n'
    ]
    for p in packages:
        body = '\n\n'.join(t.strip() for t in p['texts']) or (
            'Das Paket enthält keinen Lizenztext. Lizenz: ' + p['license']
        )
        chunks.append(f"{'=' * 72}\n{p['name']} {p['version']} — {p['license']}\n{'=' * 72}\n\n{body}\n")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / 'python-notices.txt').write_text('\n'.join(chunks), encoding='utf-8')
    summary = [{k: p[k] for k in ('name', 'version', 'license')} for p in packages]
    (OUT_DIR / 'python-packages.json').write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )
    print(f'{len(packages)} Komponenten → {OUT_DIR.relative_to(REPO)}/python-notices.txt')


if __name__ == '__main__':
    main()
