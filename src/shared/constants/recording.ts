// Single source of truth für das Auto-Stop-Limit (NFR: max. 2 h Aufnahme).
// Main-Prozess (recording-handlers.ts) armiert den Timer, der Renderer
// (RecordingSessionCard) rechnet den Countdown daraus.
export const AUTO_STOP_SECONDS = 7200
