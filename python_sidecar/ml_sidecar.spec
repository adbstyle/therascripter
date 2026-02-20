# -*- mode: python ; coding: utf-8 -*-
"""
Merged PyInstaller spec: builds diarize + ner_service into a single shared bundle.

Two executables share one _internal/ directory, eliminating ~566 MB of duplication.
Output: dist/ml_sidecar/{diarize, ner_service, _internal/}

Usage: pyinstaller ml_sidecar.spec
"""

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

# --- Hidden imports -----------------------------------------------------------

# pyannote.audio has many lazy imports that PyInstaller misses
pyannote_hiddenimports = collect_submodules('pyannote') + [
    'pyannote.audio',
    'pyannote.audio.pipelines',
    'pyannote.audio.pipelines.speaker_diarization',
    'pyannote.core',
    'pyannote.database',
    'pyannote.pipeline',
    'pytorch_metric_learning',
    'asteroid_filterbanks',
    'speechbrain',
    'speechbrain.processing',
    'speechbrain.processing.signal_processing',
]

# flair has deep dependency chains
flair_hiddenimports = collect_submodules('flair') + [
    'flair',
    'flair.data',
    'flair.nn',
    'flair.models',
    'flair.models.sequence_tagger_model',
    'flair.embeddings',
    'gensim',
    'deprecated',
    'conllu',
    'segtok',
    'segtok.tokenizer',
    'segtok.segmenter',
    'janome',
    'janome.tokenizer',
    'langdetect',
    'ftfy',
    'bpemb',
    'konoha',
    'tabulate',
]

# Shared torch/torchaudio imports
torch_hiddenimports = [
    'torch',
    'torch.nn',
    'torch.nn.functional',
    'torch.utils',
    'torch.utils.data',
    'torch.backends',
    'torch.backends.mps',
    'torchaudio',
    'torchaudio.backend',
    'torchaudio.backend.sox_io_backend',
    'torchaudio.transforms',
    'torchaudio.functional',
    'soundfile',
    'librosa',
]

# Additional transitive imports
extra_hiddenimports = [
    'yaml',
    'sklearn',
    'sklearn.cluster',
    'sklearn.cluster._agglomerative',
    'scipy',
    'scipy.signal',
    'scipy.optimize',
    'scipy.special',
    'scipy.linalg',
    'scipy.sparse',
    'huggingface_hub',
    'safetensors',
    'tokenizers',
    'transformers',
    'transformers.models',
    'tqdm',
    'filelock',
    'regex',
    'requests',
    'urllib3',
    'certifi',
    'charset_normalizer',
    'idna',
    'packaging',
    'psutil',
    'numpy',
    'pandas',
]

all_hiddenimports = list(set(
    pyannote_hiddenimports
    + flair_hiddenimports
    + torch_hiddenimports
    + extra_hiddenimports
))

# --- Data files ---------------------------------------------------------------

pyannote_datas = collect_data_files('pyannote')
flair_datas = collect_data_files('flair')
lightning_datas = collect_data_files('lightning_fabric', include_py_files=True)
torchaudio_datas = collect_data_files('torchaudio')
transformers_datas = collect_data_files('transformers')

all_datas = pyannote_datas + flair_datas + lightning_datas + torchaudio_datas + transformers_datas

# --- Excludes (save ~97+ MB) -------------------------------------------------

excludes = [
    # torchcodec — blocked by runtime hook, exclude stubs too
    'torchcodec',
    # torch bloat (headers, inductor, testing)
    'torch._inductor',
    # NOTE: torch.distributed must NOT be excluded — flair imports it top-level
    # (flair.trainers → flair.distributed_utils → torch.distributed)
    'torch.testing',
    'torch.utils.benchmark',
    'torch.utils.tensorboard',
    'torch.utils.data.datapipes',
    # AWS SDK (pulled in transitively by huggingface_hub, not needed at runtime)
    'botocore',
    'boto3',
    'aiobotocore',
    's3transfer',
    # gRPC (not needed)
    'grpc',
    'grpcio',
    # GUI/notebook (not needed in CLI)
    'matplotlib',
    'tkinter',
    'IPython',
    'jupyter',
    'notebook',
    'nbformat',
    'nbconvert',
    # Test frameworks
    'pytest',
    'unittest',
    '_pytest',
]

# --- Analysis: diarize --------------------------------------------------------

a_diarize = Analysis(
    ['diarize.py'],
    pathex=[],
    binaries=[],
    datas=all_datas,
    hiddenimports=all_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=['runtime_hook_no_torchcodec.py'],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)

# --- Analysis: ner_service ----------------------------------------------------

a_ner = Analysis(
    ['ner_service.py'],
    pathex=[],
    binaries=[],
    datas=all_datas,
    hiddenimports=all_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=['runtime_hook_no_torchcodec.py'],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)

# --- Merge analyses (deduplicate shared modules) ------------------------------

MERGE(
    (a_diarize, 'diarize', 'diarize'),
    (a_ner, 'ner_service', 'ner_service'),
)

# --- PYZ (bytecode archives) -------------------------------------------------

pyz_diarize = PYZ(a_diarize.pure)
pyz_ner = PYZ(a_ner.pure)

# --- EXE (executables) -------------------------------------------------------

exe_diarize = EXE(
    pyz_diarize,
    a_diarize.scripts,
    [],
    exclude_binaries=True,
    name='diarize',
    debug=False,
    bootloader_ignore_signals=False,
    strip=True,
    upx=False,
    console=True,
    target_arch='arm64',
)

exe_ner = EXE(
    pyz_ner,
    a_ner.scripts,
    [],
    exclude_binaries=True,
    name='ner_service',
    debug=False,
    bootloader_ignore_signals=False,
    strip=True,
    upx=False,
    console=True,
    target_arch='arm64',
)

# --- Shared COLLECT (single _internal/ for both executables) ------------------

coll = COLLECT(
    exe_diarize,
    a_diarize.binaries,
    a_diarize.datas,
    exe_ner,
    a_ner.binaries,
    a_ner.datas,
    strip=True,
    upx=False,
    name='ml_sidecar',
)
