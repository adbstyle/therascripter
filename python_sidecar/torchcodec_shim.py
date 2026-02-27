"""
torchcodec shim: Provide soundfile-based fallback for torchcodec.

pyannote.audio 4.0.4+ requires torchcodec for audio I/O (AudioDecoder, AudioSamples,
AudioStreamMetadata). torchcodec's native .dylib uses importlib.machinery.FileFinder
which doesn't work reliably in relocatable Python environments.

torchaudio 2.10.0 also delegates to torchcodec internally, so it can't be used either.

This module registers fake torchcodec modules that implement the required API surface
using soundfile + torch directly. pyannote's `from torchcodec.decoders import AudioDecoder`
then gets our soundfile-based shim instead of the real torchcodec.

Loaded automatically via sitecustomize.py in the standalone Python environment.
"""
import importlib.machinery
import sys
import types
from dataclasses import dataclass


@dataclass
class AudioStreamMetadata:
    """Minimal shim matching torchcodec.decoders.AudioStreamMetadata."""
    sample_rate: int
    num_channels: int
    duration_seconds_from_header: float


@dataclass
class AudioSamples:
    """Minimal shim matching torchcodec.AudioSamples."""
    data: object  # torch.Tensor (channel, time)
    sample_rate: int


class AudioDecoder:
    """soundfile-based shim matching torchcodec.decoders.AudioDecoder API.

    Implements the subset used by pyannote.audio.core.io:
    - AudioDecoder(path).metadata -> AudioStreamMetadata
    - AudioDecoder(path).get_all_samples() -> AudioSamples
    - AudioDecoder(path).get_samples_played_in_range(start, end) -> AudioSamples
    """

    def __init__(self, source):
        import soundfile as sf

        self._source = source
        info = sf.info(source)
        self._sample_rate = info.samplerate
        self._num_channels = info.channels
        self._num_frames = info.frames
        self._duration = info.duration

    @property
    def metadata(self) -> AudioStreamMetadata:
        return AudioStreamMetadata(
            sample_rate=self._sample_rate,
            num_channels=self._num_channels,
            duration_seconds_from_header=self._duration,
        )

    def get_all_samples(self) -> AudioSamples:
        import soundfile as sf
        import torch

        data, sr = sf.read(self._source, dtype='float32', always_2d=True)
        # soundfile returns (frames, channels), torchcodec returns (channels, frames)
        waveform = torch.from_numpy(data.T)
        return AudioSamples(data=waveform, sample_rate=sr)

    def get_samples_played_in_range(self, start: float, end: float) -> AudioSamples:
        import soundfile as sf
        import torch

        frame_offset = int(start * self._sample_rate)
        num_frames = int((end - start) * self._sample_rate)
        data, sr = sf.read(
            self._source, start=frame_offset, stop=frame_offset + num_frames,
            dtype='float32', always_2d=True
        )
        # soundfile returns (frames, channels), torchcodec returns (channels, frames)
        waveform = torch.from_numpy(data.T)
        return AudioSamples(data=waveform, sample_rate=sr)


# --- Register fake torchcodec modules in sys.modules ---
# Each module needs __spec__ set so importlib.util.find_spec() doesn't raise ValueError.
# transformers' import_utils.py calls find_spec("torchcodec") during init.

def _make_fake_module(name, attrs=None, is_package=False):
    """Create a fake module with proper __spec__ for importlib compatibility."""
    mod = types.ModuleType(name)
    mod.__spec__ = importlib.machinery.ModuleSpec(name, None, is_package=is_package)
    if is_package:
        mod.__path__ = []
    if attrs:
        for k, v in attrs.items():
            setattr(mod, k, v)
    return mod

mod_torchcodec = _make_fake_module('torchcodec', {'AudioSamples': AudioSamples}, is_package=True)
mod_decoders = _make_fake_module('torchcodec.decoders', {
    'AudioDecoder': AudioDecoder,
    'AudioStreamMetadata': AudioStreamMetadata,
}, is_package=True)

sys.modules['torchcodec'] = mod_torchcodec
sys.modules['torchcodec.decoders'] = mod_decoders
# Block the native _core to prevent any accidental real import
sys.modules['torchcodec.decoders._core'] = _make_fake_module('torchcodec.decoders._core')
sys.modules['torchcodec._core'] = _make_fake_module('torchcodec._core')
