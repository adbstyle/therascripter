# Audio Recording

## Overview

Therascript captures therapy sessions as mono WAV audio using the Web Audio API in the renderer process. Audio data is streamed to the main process via IPC, where it is written incrementally to disk. When the user stops the recording (or the auto-stop limit is reached), the WAV file is finalized and the ML processing pipeline begins automatically.

## Recording Flow

1. **Start** -- User clicks the record button on the session dashboard. The main process creates a new session (status `recording`), initializes a WAV file at `~/.therascript/audio/<sessionId>.wav`, writes a placeholder header, activates the power save blocker, starts a 1 Hz duration timer, arms the 2-hour auto-stop timeout, and switches the system tray to recording state.
2. **Recording active** -- The renderer captures audio via Web Audio API and sends PCM Float32 chunks to the main process over the `recording:data` IPC channel. The main process converts each chunk from Float32 to Int16 and appends it to the open WAV file descriptor. The duration timer sends `recording:duration` events back to the renderer every second.
3. **Stop** -- The user clicks "Aufnahme stoppen" (in the UI or system tray menu). The main process finalizes the WAV header with the correct data size, updates the session status to `transcribing`, enqueues the audio ML pipeline (ASR, diarization, NER), and resets tray state.
4. **Processing begins** -- The task queue picks up the session for sequential ML processing.

## Audio Format

| Property | Value |
|---|---|
| Container | WAV (RIFF) |
| Encoding | PCM (AudioFormat = 1) |
| Sample rate | 48,000 Hz |
| Bit depth | 16-bit signed integer |
| Channels | 1 (mono) |
| Header size | 44 bytes (standard WAV) |

The renderer captures Float32 samples from the AudioWorklet; conversion to 16-bit PCM happens in `AudioFileService.appendChunk()` on the main process side.

## VU Meter

The `VUMeter` component provides real-time audio level feedback during recording.

- **Input**: RMS level (0.0 -- 1.0) from the AudioWorklet.
- **Visualization**: 16 vertical bars arranged symmetrically -- center bars are taller, edge bars shorter, all scaled by the current audio level.
- **dB normalization**: Raw RMS is converted to dB (`20 * log10(level)`), then normalized to a 0--1 range between -60 dB (silence) and -6 dBFS (loud speech). This provides perceptually correct scaling across different microphones.
- **Smoothing**: Exponential smoothing (0.5 attack / 0.5 decay) for visual continuity without sluggishness.
- **Color coding**:
  - Green (`#16a34a`) -- normal speech levels (height <= 0.5)
  - Orange (`#ea580c`) -- loud (height > 0.5)
  - Red (`#dc2626`) -- clipping risk (height > 0.8)
- **Accessibility**: Uses `role="meter"` with `aria-label="Audiopegel"` and `aria-valuenow` reporting the smoothed percentage.

The recording view also displays a large monospace duration timer in `HH:MM:SS` format, updated every second.

## Consent Banner

The `ConsentBanner` is a warning shown inside the recording view on the user's first-ever recording. It reminds the therapist to obtain patient consent before recording.

- **When shown**: On every recording start until the user dismisses it with the "Nicht mehr anzeigen" checkbox checked.
- **Content**: "Bitte stellen Sie sicher, dass die aufgenommene Person der Aufnahme zugestimmt hat (StGB Art. 179bis)." -- a reference to the Swiss criminal code provision on unauthorized audio recording.
- **Persistence**: Controlled by the `consentReminderShown` key in electron-store. When the user checks "Nicht mehr anzeigen" and dismisses the banner, the key is set to `true` and the banner never appears again.
- **Dismissal without checkbox**: If the user closes the banner without checking the checkbox, it will reappear on the next recording.

## System Tray

`TrayService` provides a macOS menu bar icon with recording-aware behavior.

**Icon states:**
- **Idle** -- Default icon, tooltip reads "Therascript", no title text.
- **Recording** -- Recording icon (red), tooltip reads "Therascript -- Aufnahme lauft HH:MM:SS", title displays the running duration next to the icon.

**Context menu items:**
- During recording: "Aufnahme stoppen" (triggers `stopRecordingFromTray()`), separator, "Fenster anzeigen", separator, "Beenden".
- When idle: "Fenster anzeigen", separator, "Beenden".

The duration displayed in the tray title is updated every second via `updateDuration()`, driven by the same 1 Hz interval in the recording handlers.

## Auto-Stop

Recording is automatically stopped after **2 hours** (7,200 seconds).

- A `setTimeout` is armed in the main process when recording starts (`AUTO_STOP_MS = 7200 * 1000`).
- When triggered, `autoStopRecording()` finalizes the WAV file, enqueues ML processing, notifies the renderer via `recording:auto-stopped`, and shows a macOS system notification: "Aufnahme gestoppt -- Die Aufnahme wurde automatisch nach 2 Stunden gestoppt."
- The renderer displays a live countdown ("Auto-Stop nach HH:MM:SS") below the stop button so the user always knows how much time remains.

## Background Behavior

- The recording view displays a hint: "Die App kann minimiert werden -- die Aufnahme lauft im Hintergrund weiter."
- When the window is minimized or loses focus, audio capture continues uninterrupted because the Web Audio API stream and the main-process file writer operate independently of window visibility.
- The app stays running in the background when the window is closed (managed by the system tray).

## Power Save Blocker

The main process activates Electron's `powerSaveBlocker` with type `prevent-app-suspension` when recording starts. This prevents macOS from suspending the app or putting the system to sleep during an active recording. The blocker is stopped when recording ends (normal stop, auto-stop, or app quit).

## Navigation Blocking

While a recording is active, the sidebar navigation is disabled to prevent the user from accidentally leaving the recording view. Navigation is re-enabled after the recording stops.

## Crash Recovery

`AudioFileService` maintains a recovery buffer that is dumped to a separate `.pcm` file every 60 seconds (at `~/.therascript/recovery/<sessionId>.pcm`), retaining the last 60 seconds of PCM data. On startup, `checkForRecovery()` detects sessions stuck in `recording` status and `recoverSession()` can reconstruct the WAV from the recovery file. If the app is quit during recording, `cleanupRecordingOnQuit()` finalizes the WAV and marks the session status as `error`.

## Source Files

| File | Purpose |
|---|---|
| `src/renderer/src/components/RecordingView.tsx` | Recording UI: timer, VU meter, stop button, auto-stop countdown |
| `src/renderer/src/components/VUMeter.tsx` | Audio level visualization (16-bar symmetric meter) |
| `src/renderer/src/components/ConsentBanner.tsx` | First-recording consent reminder |
| `src/main/ipc/recording-handlers.ts` | IPC handlers: start, stop, data streaming, auto-stop, recovery |
| `src/main/services/AudioFileService.ts` | WAV file creation, chunk writing, header finalization, crash recovery |
| `src/main/services/TrayService.ts` | System tray icon, menu, duration display |
