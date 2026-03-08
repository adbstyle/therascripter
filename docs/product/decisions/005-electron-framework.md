# ADR-005: Electron als Desktop-Framework

**Status:** Accepted
**Datum:** 2025-02

## Kontext

Therascript braucht ein Desktop-Framework für eine macOS-App, die lokale ML-Inferenz (whisper.cpp, Python-Sidecar), Dateisystem-Zugriff, SQLite-Datenbank, System Tray und einen Rich-Text-Editor mit Custom Nodes (Platzhalter-Chips, Speaker-Labels, Zeitstempel) unterstützt. Die App ist macOS-only (Apple Silicon), was die Framework-Wahl vereinfacht.

## Entscheidung

Electron mit React + TypeScript als UI-Framework, electron-vite als Build-Tooling, und TipTap (ProseMirror) als Review-Editor.

| Komponente | Technologie | Begründung |
|------------|-------------|------------|
| Framework | Electron | macOS Desktop, reifes Ökosystem |
| UI | React + TypeScript | Modernes Ökosystem, starke Typisierung |
| Build | electron-vite (Vite) | Schnelle Builds, HMR |
| Packaging | electron-builder | macOS DMG, Code Signing |
| Review Editor | TipTap (ProseMirror) | Atomare Node Views, Undo/Redo |
| Daten | better-sqlite3 + electron-store | SQLite für Sessions/Blocklist, Key-Value für Settings |
| IPC-Validierung | Zod | Schema-basierte Validierung aller IPC-Channels (NFR-15) |

## Begründung

- **Reifes Ökosystem:** Electron bietet stabile APIs für System Tray, BrowserWindow, child_process (Subprocesses), powerSaveBlocker (Aufnahme), native Dialoge, Auto-Deletion und Notifications.
- **TipTap/ProseMirror-Integration:** Der Review-Editor benötigt atomare Custom Nodes (Platzhalter-Chips, Speaker-Labels, Zeitstempel), Transaction-basiertes Undo/Redo und JSON-Persistenz. TipTap bietet dies mit erstklassiger React-Integration und MIT-Lizenz.
- **Security-Hardening:** Electron bietet `contextIsolation`, `sandbox`, Fuses (RunAsNode disabled, Cookie Encryption) und CSP-Injection — bewährte Mechanismen für eine App, die hochsensible Daten verarbeitet.
- **macOS-only:** Da nur macOS unterstützt wird, entfällt der grösste Nachteil von Electron (Cross-Platform-Komplexität). Bundle-Grösse (~180 MB Runtime) ist akzeptabel für eine Desktop-App mit ~4 GB ML-Modellen.
- **Alternative verworfen — Tauri (Rust):** Kleineres Bundle, aber keine reife ProseMirror/TipTap-Integration im WebView2-Kontext. Noch junges Ökosystem für komplexe Desktop-Apps mit nativen Subprocesses.
- **Alternative verworfen — Native Swift (AppKit/SwiftUI):** Kleinstes Bundle, beste macOS-Integration, aber enormer Entwicklungsaufwand für einen Solo-Entwickler. Kein Äquivalent zu TipTap/ProseMirror im Swift-Ökosystem. React-Expertise kann nicht genutzt werden.
- **Alternative verworfen — Flutter:** Cross-Platform-Fokus, kein natives ProseMirror. Desktop-Support auf macOS weniger ausgereift als Electron.

## Konsequenzen

- **Bundle-Grösse:** ~180 MB für Electron Runtime allein — akzeptabel im Kontext der ~4 GB ML-Modelle.
- **RAM-Overhead:** Chromium-Renderer braucht ~600-800 MB Baseline. Bei 8 GB RAM-Budget ist das knapp, daher strikt sequenzielle ML-Pipeline.
- **3-Prozess-Architektur:** Main Process (Node.js), Renderer (Chromium/React), Preload (Context Bridge). Alle IPC-Channels mit Zod-Schema-Validierung.
- **Electron Fuses:** Build-Time-Hardening (RunAsNode disabled, EnableCookieEncryption, kein Node CLI Inspect). Ad-hoc Code Signing da kein Apple Developer Certificate.
- **Kein Auto-Updater:** Electron Auto-Updater deaktiviert (Entscheidung #155). Updates via manuelle DMG-Installation von GitHub Releases.
- **TipTap-Performance:** Bei ~15'000 Wörtern (typische Sitzung) performant. Lazy Rendering als Fallback bei Bedarf.
