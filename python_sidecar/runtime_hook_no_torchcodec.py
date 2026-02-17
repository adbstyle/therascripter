"""
Runtime hook: Block torchcodec before any imports.

torchcodec's Python stubs get bundled by PyInstaller (via collect_submodules('pyannote')),
but the native .dylib cannot be bundled. This causes a crash when pyannote tries to use
torchcodec internally — the Python modules load, but the native call fails.

By pre-populating sys.modules with None, any `import torchcodec` raises ImportError,
which pyannote handles gracefully by falling back to torchaudio/soundfile.
"""
import sys

sys.modules['torchcodec'] = None
sys.modules['torchcodec.decoders'] = None
sys.modules['torchcodec.decoders._core'] = None
