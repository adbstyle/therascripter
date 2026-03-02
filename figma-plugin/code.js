// Therascript Screens — Figma Plugin
// Auto-generated from source code
// Creates all app screens as Figma frames on the current page

;(async () => {
  try {
    // ─── Font loading ────────────────────────────────────────────────────────
    await Promise.all([
      figma.loadFontAsync({ family: 'Inter', style: 'Regular' }),
      figma.loadFontAsync({ family: 'Inter', style: 'Medium' }),
      figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' }),
      figma.loadFontAsync({ family: 'Inter', style: 'Bold' })
    ])

    // ─── Design tokens (dark mode) ───────────────────────────────────────────
    const C = {
      surface0: hex('#0f1117'),
      surface1: hex('#1a1d27'),
      surface2: hex('#252836'),
      surface3: hex('#2d3148'),
      textPrimary: hex('#f0f1f5'),
      textSecondary: hex('#9da3b4'),
      textTertiary: hex('#6b7186'),
      border: hex('#2d3148'),
      borderStrong: hex('#3d4260'),
      primary: hex('#60a5fa'),
      primaryLight: hex('#1e3a5f'),
      recording: hex('#ef4444'),
      success: hex('#22c55e'),
      white: hex('#ffffff'),
      overlay: { r: 0, g: 0, b: 0 },
      chipPersonBg: hex('#1e3a5f'),
      chipPersonText: hex('#93c5fd'),
      chipOrtBg: hex('#14432a'),
      chipOrtText: hex('#86efac'),
      chipDatumBg: hex('#431407'),
      chipDatumText: hex('#fdba74'),
      warning: hex('#f97316')
    }

    function hex(h) {
      return {
        r: parseInt(h.slice(1, 3), 16) / 255,
        g: parseInt(h.slice(3, 5), 16) / 255,
        b: parseInt(h.slice(5, 7), 16) / 255
      }
    }
    const fill = (c, o = 1) => [{ type: 'SOLID', color: c, opacity: o }]
    const noFill = () => []

    // ─── Layout constants ────────────────────────────────────────────────────
    const W = 900,
      H = 560
    const SIDEBAR_W = 200
    const HEADER_H = 71
    const GAP = 80
    const COLS = 3

    let idx = 0
    function pos() {
      const col = idx % COLS
      const row = Math.floor(idx / COLS)
      idx++
      return { x: col * (W + GAP), y: row * (H + GAP) }
    }

    // ─── Primitives ──────────────────────────────────────────────────────────
    function frame(w, h, color, name = 'Frame') {
      const f = figma.createFrame()
      f.resize(w, h)
      f.name = name
      f.fills = color ? fill(color) : noFill()
      f.clipsContent = true
      return f
    }

    function rect(w, h, color, radius = 0) {
      const r = figma.createRectangle()
      r.resize(w, h)
      r.fills = fill(color)
      if (radius) r.cornerRadius = radius
      return r
    }

    function border(w, h, color, radius = 0) {
      const r = figma.createRectangle()
      r.resize(w, h)
      r.fills = noFill()
      r.strokes = fill(color)
      r.strokeWeight = 1
      r.strokeAlign = 'INSIDE'
      if (radius) r.cornerRadius = radius
      return r
    }

    function text(str, size, color, weight = 'Regular', maxW = null) {
      const t = figma.createText()
      t.fontName = { family: 'Inter', style: weight }
      t.fontSize = size
      t.fills = fill(color)
      if (maxW) {
        t.textAutoResize = 'HEIGHT'
        t.resize(maxW, 20)
      }
      t.characters = str
      return t
    }

    function place(parent, child, x, y) {
      parent.appendChild(child)
      child.x = x
      child.y = y
    }

    // ─── Reusable components ─────────────────────────────────────────────────
    function makeSidebar(active = 'sessions', disabled = false) {
      const sb = frame(SIDEBAR_W, H, C.surface0, 'Sidebar')
      if (disabled) sb.opacity = 0.5

      // Nav items
      const items = [
        { id: 'sessions', label: 'Sitzungen', y: 56 },
        { id: 'settings', label: 'Einstellungen', y: 88 }
      ]
      for (const item of items) {
        const isActive = active === item.id
        const bg = rect(SIDEBAR_W - 16, 32, isActive ? C.surface2 : C.surface0, 6)
        place(sb, bg, 8, item.y)
        const lbl = text(item.label, 13, isActive ? C.textPrimary : C.textSecondary, 'Medium')
        place(sb, lbl, 20, item.y + 8)
      }

      // 🔒 Lokal
      const localTxt = text('🔒  Lokal', 11, C.textTertiary)
      place(sb, localTxt, 16, H - 28)

      // Right border
      const brd = rect(1, H, C.border)
      place(sb, brd, SIDEBAR_W - 1, 0)

      return sb
    }

    function makeHeader(title, mainW, rightFn = null) {
      const h = frame(mainW, HEADER_H, C.surface0, 'Header')
      const t = text(title, 22, C.textPrimary, 'Bold')
      place(h, t, 24, (HEADER_H - 28) / 2)
      const brd = rect(mainW, 1, C.border)
      place(h, brd, 0, HEADER_H - 1)
      if (rightFn) rightFn(h, mainW)
      return h
    }

    function makeScreenBase(name, active = 'sessions') {
      const p = pos()
      const s = frame(W, H, C.surface0, name)
      s.x = p.x
      s.y = p.y
      const sidebar = makeSidebar(active)
      place(s, sidebar, 0, 0)
      const mainArea = frame(W - SIDEBAR_W, H, C.surface0, 'Main')
      place(s, mainArea, SIDEBAR_W, 0)
      return { screen: s, main: mainArea }
    }

    function makeBtn(label, w, h, bgColor, textColor, radius = 8) {
      const g = figma.createFrame()
      g.resize(w, h)
      g.name = label
      g.fills = fill(bgColor)
      g.cornerRadius = radius
      g.clipsContent = true
      const t = text(label, 13, textColor, 'Semi Bold')
      t.textAlignHorizontal = 'CENTER'
      t.textAlignVertical = 'CENTER'
      t.resize(w, h)
      t.textAutoResize = 'NONE'
      g.appendChild(t)
      return g
    }

    function makeOutlineBtn(label, w, h) {
      const g = figma.createFrame()
      g.resize(w, h)
      g.name = label
      g.fills = fill(C.surface0)
      g.strokes = fill(C.borderStrong)
      g.strokeWeight = 1
      g.strokeAlign = 'INSIDE'
      g.cornerRadius = 8
      g.clipsContent = true
      const t = text(label, 13, C.textSecondary, 'Semi Bold')
      t.textAlignHorizontal = 'CENTER'
      t.textAlignVertical = 'CENTER'
      t.resize(w, h)
      t.textAutoResize = 'NONE'
      g.appendChild(t)
      return g
    }

    function makeChip(label, bg, fg) {
      const g = figma.createFrame()
      g.name = label
      g.fills = fill(bg)
      g.cornerRadius = 4
      g.clipsContent = true
      const t = text(label, 12, fg, 'Medium')
      g.resize(t.width + 12, 22)
      t.x = 6
      t.y = 4
      g.appendChild(t)
      return g
    }

    function makeSessionCard(title, status, statusColor, icon, w) {
      const card = frame(w, 52, C.surface0, title)
      card.strokes = fill(C.border)
      card.strokeWeight = 1
      card.strokeAlign = 'INSIDE'
      card.cornerRadius = 8
      const ic = text(icon, 16, C.textPrimary)
      place(card, ic, 12, 14)
      const ti = text(title, 13, C.textPrimary, 'Medium', w - 60)
      place(card, ti, 40, 10)
      const st = text(status, 11, statusColor, 'Medium')
      place(card, st, 40, 28)
      return card
    }

    // ════════════════════════════════════════════════════════════════════════
    // SCREEN 1 — Sitzungen (Sessions Dashboard)
    // ════════════════════════════════════════════════════════════════════════
    {
      const { screen, main } = makeScreenBase('01 — Sitzungen', 'sessions')
      const mainW = W - SIDEBAR_W

      const header = makeHeader('Sitzungen', mainW, (h, mW) => {
        const pdfBtn = makeOutlineBtn('PDF importieren', 128, 34)
        place(h, pdfBtn, mW - 280, (HEADER_H - 34) / 2)
        const recBtn = makeBtn('● Aufnahme starten', 158, 34, C.recording, C.white)
        place(h, recBtn, mW - 174, (HEADER_H - 34) / 2 + 2)
      })
      place(main, header, 0, 0)

      // Session list content
      const content = frame(mainW, H - HEADER_H, null, 'Content')
      place(main, content, 0, HEADER_H)

      // Group header: HEUTE
      const grpToday = text('HEUTE', 11, C.textTertiary, 'Semi Bold')
      place(content, grpToday, 24, 16)

      const cardW = mainW - 48
      const sessions = [
        { title: 'Sitzung 28.02.2026 14:47', status: 'Review', color: C.success, icon: '🎤' },
        { title: 'myInsel – Briefdetails', status: 'Review', color: C.success, icon: '📄' },
        { title: 'Sitzung 28.02.2026 09:30', status: 'Review', color: C.success, icon: '🎤' },
        {
          title: 'Sitzung 28.02.2026 09:29',
          status: 'Transkription 45%',
          color: C.primary,
          icon: '🎤'
        },
        {
          title: 'Sitzung 28.02.2026 09:25',
          status: 'Sprechererkennung',
          color: C.primary,
          icon: '🎤'
        }
      ]
      let cardY = 36
      for (const s of sessions) {
        const card = makeSessionCard(s.title, s.status, s.color, s.icon, cardW)
        place(content, card, 24, cardY)
        cardY += 60
      }

      // Group header: GESTERN
      const grpYes = text('GESTERN', 11, C.textTertiary, 'Semi Bold')
      place(content, grpYes, 24, cardY + 8)
      cardY += 28

      const yesterdayCards = [
        { title: 'Sitzung 27.02.2026 22:48', status: 'Review', color: C.success, icon: '🎤' },
        { title: 'Sitzung 27.02.2026 22:24', status: 'Review', color: C.success, icon: '🎤' }
      ]
      for (const s of yesterdayCards) {
        const card = makeSessionCard(s.title, s.status, s.color, s.icon, cardW)
        place(content, card, 24, cardY)
        cardY += 60
      }

      figma.currentPage.appendChild(screen)
    }

    // ════════════════════════════════════════════════════════════════════════
    // SCREEN 2 — Aufnahme läuft (Recording View)
    // ════════════════════════════════════════════════════════════════════════
    {
      const { screen, main } = makeScreenBase('02 — Aufnahme', 'sessions')
      const mainW = W - SIDEBAR_W

      // Override sidebar opacity (disabled during recording)
      screen.children[0].opacity = 0.5

      const header = makeHeader('Aufnahme läuft', mainW)
      place(main, header, 0, 0)

      // Consent banner
      const banner = rect(mainW, 40, C.surface2)
      banner.name = 'Consent Banner'
      place(main, banner, 0, HEADER_H)
      const bannerTxt = text(
        '⚠  Die aufgenommenen Personen wurden über die Aufnahme informiert.',
        11,
        C.textSecondary
      )
      place(main, bannerTxt, 16, HEADER_H + 13)

      const cx = mainW / 2

      // REC indicator
      const recDot = rect(10, 10, C.recording, 5)
      place(main, recDot, cx - 28, 152)
      const recLbl = text('REC', 15, C.recording, 'Semi Bold')
      place(main, recLbl, cx - 10, 150)

      // Timer
      const timer = text('00:12:34', 48, C.textPrimary, 'Bold')
      timer.fontName = { family: 'Inter', style: 'Bold' }
      place(main, timer, cx - 76, 178)

      // VU Meter bars
      const barW = 5,
        barGap = 3
      const barHeights = [
        6, 10, 14, 18, 24, 28, 34, 38, 34, 28, 22, 18, 22, 28, 20, 16, 12, 10, 8, 6
      ]
      const totalBarW = barHeights.length * (barW + barGap) - barGap
      let bx = cx - totalBarW / 2
      for (const bh of barHeights) {
        const bar = rect(barW, bh, C.primary, 2)
        place(main, bar, bx, 248 + (38 - bh))
        bx += barW + barGap
      }

      // Stop button
      const stopBtn = makeBtn('■  Aufnahme stoppen', 188, 48, C.recording, C.white)
      place(main, stopBtn, cx - 94, 305)

      // Hint texts
      const autoStop = text('Auto-Stop nach 01:47:26', 12, C.textTertiary)
      place(main, autoStop, cx - 60, 365)
      const hint = text(
        'Die App kann minimiert werden — die Aufnahme läuft im Hintergrund weiter.',
        11,
        C.textTertiary,
        'Regular',
        mainW - 100
      )
      hint.textAlignHorizontal = 'CENTER'
      place(main, hint, 50, 390)

      figma.currentPage.appendChild(screen)
    }

    // ════════════════════════════════════════════════════════════════════════
    // SCREEN 3 — Review Editor
    // ════════════════════════════════════════════════════════════════════════
    {
      const p = pos()
      const screen = frame(W, H, C.surface0, '03 — Review Editor')
      screen.x = p.x
      screen.y = p.y

      // Review Editor has NO standard sidebar/header — full width
      // Custom header bar
      const headerBar = frame(W, HEADER_H, C.surface0, 'Header')
      const backBtn = text('← Sitzungen', 13, C.primary, 'Medium')
      place(headerBar, backBtn, 16, (HEADER_H - 18) / 2)
      const titleTxt = text('myInsel – Briefdetails', 17, C.textPrimary, 'Semi Bold')
      titleTxt.textAlignHorizontal = 'CENTER'
      titleTxt.resize(300, 24)
      place(headerBar, titleTxt, W / 2 - 150, (HEADER_H - 24) / 2)
      const copyBtn = makeBtn('In Zwischenablage kopieren', 196, 34, C.surface2, C.textPrimary)
      place(headerBar, copyBtn, W - 212, (HEADER_H - 34) / 2)
      const hBrd = rect(W, 1, C.border)
      place(headerBar, hBrd, 0, HEADER_H - 1)
      place(screen, headerBar, 0, 0)

      // Editor area
      const editorArea = frame(W, H - HEADER_H, C.surface0, 'Editor')
      place(screen, editorArea, 0, HEADER_H)

      // Sample content with speaker labels and chips
      let ty = 24
      const speakerY = ty
      const spkLabel = text('Therapeutin   00:00:12', 11, C.textTertiary)
      place(editorArea, spkLabel, 24, speakerY)
      ty += 22

      // Paragraph with chips
      const para1a = text('Guten Morgen, ', 14, C.textPrimary)
      place(editorArea, para1a, 24, ty)
      const chip1 = makeChip('PERSON 1', C.chipPersonBg, C.chipPersonText)
      place(editorArea, chip1, 24 + para1a.width + 4, ty - 1)
      const para1b = text('. Wie geht es Ihnen heute?', 14, C.textPrimary)
      place(editorArea, para1b, 24 + para1a.width + chip1.width + 8, ty)
      ty += 28

      const spkLabel2 = text('Patient/in   00:00:21', 11, C.textTertiary)
      place(editorArea, spkLabel2, 24, ty + 8)
      ty += 30

      const para2a = text('Danke, mir geht es besser. Ich wohne jetzt in ', 14, C.textPrimary)
      place(editorArea, para2a, 24, ty)
      const chip2 = makeChip('ORT 1', C.chipOrtBg, C.chipOrtText)
      place(editorArea, chip2, 24 + para2a.width + 4, ty - 1)
      const para2b = text(', das gefällt mir sehr.', 14, C.textPrimary)
      place(editorArea, para2b, 24 + para2a.width + chip2.width + 8, ty)
      ty += 28

      const para3a = text('Wir haben uns am ', 14, C.textPrimary)
      place(editorArea, para3a, 24, ty)
      const chip3 = makeChip('DATUM 1', C.chipDatumBg, C.chipDatumText)
      place(editorArea, chip3, 24 + para3a.width + 4, ty - 1)
      const para3b = text(' das letzte Mal gesehen.', 14, C.textPrimary)
      place(editorArea, para3b, 24 + para3a.width + chip3.width + 8, ty)
      ty += 28

      const spkLabel3 = text('Therapeutin   00:01:05', 11, C.textTertiary)
      place(editorArea, spkLabel3, 24, ty + 8)
      ty += 30

      const para4 = text(
        'Das freut mich zu hören. Ich habe Ihre Notizen von letzter Woche durchgesehen.',
        14,
        C.textPrimary,
        'Regular',
        W - 48
      )
      place(editorArea, para4, 24, ty)

      figma.currentPage.appendChild(screen)
    }

    // ════════════════════════════════════════════════════════════════════════
    // SCREEN 4 — Einstellungen / Sperrliste
    // ════════════════════════════════════════════════════════════════════════
    {
      const { screen, main } = makeScreenBase('04 — Einstellungen: Sperrliste', 'settings')
      const mainW = W - SIDEBAR_W

      const header = makeHeader('Einstellungen', mainW)
      place(main, header, 0, 0)

      // Tabs
      const tabsBar = frame(mainW, 44, C.surface0, 'Tabs')
      const brdBottom = rect(mainW, 1, C.border)
      place(tabsBar, brdBottom, 0, 43)
      place(main, tabsBar, 0, HEADER_H)

      const tabs = [
        { id: 'sperrliste', label: 'Sperrliste', active: true },
        { id: 'darstellung', label: 'Darstellung', active: false },
        { id: 'modelle', label: 'Modelle', active: false },
        { id: 'ueber', label: 'Über', active: false }
      ]
      let tx = 24
      for (const tab of tabs) {
        const tabTxt = text(tab.label, 13, tab.active ? C.primary : C.textTertiary, 'Medium')
        place(tabsBar, tabTxt, tx, 12)
        if (tab.active) {
          const indicator = rect(tabTxt.width, 2, C.primary)
          place(tabsBar, indicator, tx, 42)
        }
        tx += tabTxt.width + 24
      }

      // Sperrliste content
      const contentTop = HEADER_H + 44
      const content = frame(mainW, H - contentTop, null, 'Blocklist Content')
      place(main, content, 0, contentTop)

      // Add entry row
      const inputBg = rect(mainW - 48 - 100, 36, C.surface1, 8)
      inputBg.strokes = fill(C.border)
      inputBg.strokeWeight = 1
      inputBg.strokeAlign = 'INSIDE'
      place(content, inputBg, 24, 16)
      const inputPlaceholder = text('Begriff hinzufügen …', 13, C.textTertiary)
      place(content, inputPlaceholder, 36, 25)
      const addBtn = makeBtn('Hinzufügen', 96, 36, C.primary, C.white)
      place(content, addBtn, mainW - 120, 16)

      // Blocklist entries
      const entries = ['Müller', 'Zürich', 'Seestrasse 12', 'Dr. Hoffmann', 'Huber']
      let ey = 68
      for (const entry of entries) {
        const entryRow = frame(mainW - 48, 40, C.surface0, entry)
        entryRow.strokes = fill(C.border)
        entryRow.strokeWeight = 1
        entryRow.strokeAlign = 'INSIDE'
        entryRow.cornerRadius = 6
        place(content, entryRow, 24, ey)
        const entryTxt = text(entry, 13, C.textPrimary, 'Medium')
        place(entryRow, entryTxt, 12, 12)
        const delBtn = text('✕', 13, C.textTertiary)
        place(entryRow, delBtn, mainW - 48 - 28, 14)
        ey += 48
      }

      figma.currentPage.appendChild(screen)
    }

    // ════════════════════════════════════════════════════════════════════════
    // SCREEN 5 — Einstellungen / Über
    // ════════════════════════════════════════════════════════════════════════
    {
      const { screen, main } = makeScreenBase('05 — Einstellungen: Über', 'settings')
      const mainW = W - SIDEBAR_W

      const header = makeHeader('Einstellungen', mainW)
      place(main, header, 0, 0)

      // Tabs (Über active)
      const tabsBar = frame(mainW, 44, C.surface0, 'Tabs')
      const brdBottom2 = rect(mainW, 1, C.border)
      place(tabsBar, brdBottom2, 0, 43)
      place(main, tabsBar, 0, HEADER_H)
      const tabs2 = ['Sperrliste', 'Darstellung', 'Modelle', 'Über']
      let tx2 = 24
      for (const t of tabs2) {
        const isActive = t === 'Über'
        const tabT = text(t, 13, isActive ? C.primary : C.textTertiary, 'Medium')
        place(tabsBar, tabT, tx2, 12)
        if (isActive) {
          const ind = rect(tabT.width, 2, C.primary)
          place(tabsBar, ind, tx2, 42)
        }
        tx2 += tabT.width + 24
      }

      // About content
      const contentY = HEADER_H + 44
      const cx = mainW / 2

      // App logo placeholder
      const logoBox = rect(64, 64, C.surface2, 16)
      place(main, logoBox, cx - 32, contentY + 28)
      const logoT = text('T', 28, C.primary, 'Bold')
      place(main, logoT, cx - 10, contentY + 42)

      const appName = text('Therascript', 20, C.textPrimary, 'Bold')
      appName.textAlignHorizontal = 'CENTER'
      appName.resize(mainW, 26)
      place(main, appName, 0, contentY + 102)

      const version = text('Version 1.0.0', 13, C.textTertiary)
      version.textAlignHorizontal = 'CENTER'
      version.resize(mainW, 20)
      place(main, version, 0, contentY + 134)

      const tagline = text(
        'Lokale Transkription und Anonymisierung für Therapiesitzungen.',
        13,
        C.textSecondary,
        'Regular',
        mainW - 80
      )
      tagline.textAlignHorizontal = 'CENTER'
      place(main, tagline, 40, contentY + 162)

      const badge = makeChip('🔒  Vollständig lokal — keine Cloud', C.surface2, C.textSecondary)
      place(main, badge, cx - badge.width / 2, contentY + 210)

      figma.currentPage.appendChild(screen)
    }

    // ════════════════════════════════════════════════════════════════════════
    // SCREEN 6 — First Launch Screen
    // ════════════════════════════════════════════════════════════════════════
    {
      const p = pos()
      const screen = frame(W, H, C.surface0, '06 — First Launch')
      screen.x = p.x
      screen.y = p.y

      const cx = W / 2

      // Logo
      const logoBox = rect(72, 72, C.surface2, 18)
      place(screen, logoBox, cx - 36, 48)
      const logoTxt = text('T', 32, C.primary, 'Bold')
      place(screen, logoTxt, cx - 12, 64)

      // Title
      const title = text('Therascript', 24, C.textPrimary, 'Bold')
      title.textAlignHorizontal = 'CENTER'
      title.resize(W, 30)
      place(screen, title, 0, 132)

      const subtitle = text('ML-Modelle werden benötigt', 15, C.textSecondary)
      subtitle.textAlignHorizontal = 'CENTER'
      subtitle.resize(W, 22)
      place(screen, subtitle, 0, 170)

      // Model list
      const models = [
        { name: 'Spracherkennung (Whisper)', size: '1.7 GB', icon: '🎙' },
        { name: 'Sprechererkennung (Pyannote)', size: '0.2 GB', icon: '👥' },
        { name: 'Anonymisierung (flair NER)', size: '2.2 GB', icon: '🔒' }
      ]
      let my = 208
      for (const m of models) {
        const row = frame(340, 44, C.surface1, m.name)
        row.cornerRadius = 8
        const ic = text(m.icon, 16, C.textPrimary)
        place(row, ic, 12, 14)
        const nm = text(m.name, 13, C.textPrimary, 'Medium')
        place(row, nm, 40, 10)
        const sz = text(m.size, 11, C.textTertiary)
        place(row, sz, 40, 26)
        place(screen, row, cx - 170, my)
        my += 52
      }

      // Total & disk note
      const total = text('Gesamt: ~4.1 GB  ·  Benötigter Speicher: 5 GB', 12, C.textTertiary)
      total.textAlignHorizontal = 'CENTER'
      total.resize(W, 18)
      place(screen, total, 0, my + 4)

      // Download button
      const dlBtn = makeBtn('Modelle herunterladen', 220, 44, C.primary, C.white)
      place(screen, dlBtn, cx - 110, my + 30)

      figma.currentPage.appendChild(screen)
    }

    // ════════════════════════════════════════════════════════════════════════
    // SCREEN 7 — First Launch: Downloading (progress state)
    // ════════════════════════════════════════════════════════════════════════
    {
      const p = pos()
      const screen = frame(W, H, C.surface0, '07 — First Launch: Downloading')
      screen.x = p.x
      screen.y = p.y

      const cx = W / 2

      const logoBox2 = rect(72, 72, C.surface2, 18)
      place(screen, logoBox2, cx - 36, 48)
      const logoTxt2 = text('T', 32, C.primary, 'Bold')
      place(screen, logoTxt2, cx - 12, 64)

      const title2 = text('Therascript', 24, C.textPrimary, 'Bold')
      title2.textAlignHorizontal = 'CENTER'
      title2.resize(W, 30)
      place(screen, title2, 0, 132)

      // Model rows with status
      const models2 = [
        { name: 'Spracherkennung (Whisper)', status: 'abgeschlossen', done: true },
        { name: 'Sprechererkennung (Pyannote)', status: 'Herunterladen 63%', active: true },
        { name: 'Anonymisierung (flair NER)', status: 'ausstehend', done: false }
      ]
      let my2 = 180
      for (const m of models2) {
        const row = frame(340, 44, m.active ? C.surface1 : C.surface0, m.name)
        row.cornerRadius = 8
        if (m.active) {
          row.strokes = fill(C.primary)
          row.strokeWeight = 1
          row.strokeAlign = 'INSIDE'
        }
        const ic2 = text(
          m.done ? '✓' : m.active ? '⬇' : '○',
          14,
          m.done ? C.success : m.active ? C.primary : C.textTertiary,
          'Bold'
        )
        place(row, ic2, 12, 15)
        const nm2 = text(m.name, 13, m.done || m.active ? C.textPrimary : C.textTertiary, 'Medium')
        place(row, nm2, 36, 10)
        const st2 = text(m.status, 11, m.done ? C.success : m.active ? C.primary : C.textTertiary)
        place(row, st2, 36, 26)
        place(screen, row, cx - 170, my2)
        my2 += 52
      }

      // Overall progress bar
      const progressBg = rect(340, 8, C.surface2, 4)
      place(screen, progressBg, cx - 170, my2 + 12)
      const progressFill = rect(214, 8, C.primary, 4) // 63%
      place(screen, progressFill, cx - 170, my2 + 12)
      const progressLbl = text('Gesamt: 63%  ·  1.2 GB / 4.1 GB', 11, C.textTertiary)
      progressLbl.textAlignHorizontal = 'CENTER'
      progressLbl.resize(W, 16)
      place(screen, progressLbl, 0, my2 + 28)

      figma.currentPage.appendChild(screen)
    }

    // ════════════════════════════════════════════════════════════════════════
    // SCREEN 8 — Confirm Dialog (Delete Session)
    // ════════════════════════════════════════════════════════════════════════
    {
      const p = pos()
      const screen = frame(W, H, C.surface0, '08 — Dialog: Löschen bestätigen')
      screen.x = p.x
      screen.y = p.y

      // Background (sessions dashboard, dimmed)
      const bg = rect(W, H, C.surface0)
      place(screen, bg, 0, 0)
      const overlay = rect(W, H, C.overlay, 0)
      overlay.fills = [{ type: 'SOLID', color: C.overlay, opacity: 0.45 }]
      place(screen, overlay, 0, 0)

      // Modal
      const modal = frame(400, 240, C.surface1, 'Modal')
      modal.cornerRadius = 12
      place(screen, modal, W / 2 - 200, H / 2 - 120)

      const dialogTitle = text('Sitzung löschen', 15, C.textPrimary, 'Semi Bold')
      place(modal, dialogTitle, 24, 24)

      const dialogMsg = text(
        '„Sitzung 28.02.2026 14:47" und alle zugehörigen Daten unwiderruflich löschen?',
        13,
        C.textSecondary,
        'Regular',
        352
      )
      place(modal, dialogMsg, 24, 52)

      const deletedLbl = text('Gelöscht werden:', 11, C.textTertiary, 'Medium')
      place(modal, deletedLbl, 24, 96)
      const items = ['Audiodatei', 'Originaltext', 'Anonymisierter Text', 'Platzhalter-Mapping']
      let iy = 114
      for (const item of items) {
        const dot = text('•  ' + item, 11, C.textTertiary)
        place(modal, dot, 32, iy)
        iy += 16
      }

      const warn = text('Diese Aktion kann nicht rückgängig gemacht werden.', 11, C.textTertiary)
      place(modal, warn, 24, iy + 4)

      const cancelBtn2 = makeBtn('Abbrechen', 96, 34, C.surface0, C.textSecondary)
      place(modal, cancelBtn2, 400 - 220, 240 - 50)
      const delBtn2 = makeBtn('Löschen', 96, 34, C.recording, C.white)
      place(modal, delBtn2, 400 - 116, 240 - 50)

      figma.currentPage.appendChild(screen)
    }

    // ════════════════════════════════════════════════════════════════════════
    // SCREEN 9 — Rename Dialog
    // ════════════════════════════════════════════════════════════════════════
    {
      const p = pos()
      const screen = frame(W, H, C.surface0, '09 — Dialog: Umbenennen')
      screen.x = p.x
      screen.y = p.y

      const overlay2 = rect(W, H, C.overlay, 0)
      overlay2.fills = [{ type: 'SOLID', color: C.overlay, opacity: 0.45 }]
      place(screen, overlay2, 0, 0)

      // Modal
      const modal2 = frame(400, 164, C.surface1, 'Modal')
      modal2.cornerRadius = 12
      place(screen, modal2, W / 2 - 200, H / 2 - 82)

      const renTitle = text('Sitzung umbenennen', 15, C.textPrimary, 'Semi Bold')
      place(modal2, renTitle, 24, 24)

      // Input field
      const inputF = rect(352, 36, C.surface0, 8)
      inputF.strokes = fill(C.primary)
      inputF.strokeWeight = 1
      inputF.strokeAlign = 'INSIDE'
      place(modal2, inputF, 24, 54)
      const inputVal = text('Sitzung 28.02.2026 14:47', 13, C.textPrimary)
      place(modal2, inputVal, 36, 63)

      const cancelBtn3 = makeBtn('Abbrechen', 96, 34, C.surface0, C.textSecondary)
      place(modal2, cancelBtn3, 400 - 220, 164 - 50)
      const renameBtn = makeBtn('Umbenennen', 110, 34, C.primary, C.white)
      place(modal2, renameBtn, 400 - 122, 164 - 50)

      figma.currentPage.appendChild(screen)
    }

    // ─── Zoom to fit ─────────────────────────────────────────────────────────
    figma.viewport.scrollAndZoomIntoView(figma.currentPage.children)

    figma.closePlugin(`✅ ${figma.currentPage.children.length} Screens erstellt!`)
  } catch (err) {
    figma.closePlugin('❌ Fehler: ' + (err.message || err))
  }
})()
