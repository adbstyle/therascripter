import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// Der Suchdienst lebt im Python-Sidecar (python_sidecar/search_service.py). Wie
// ner-packing.test.ts spawnt dieser Test das System-python3: Protokoll, Bucketing,
// base64 und der OOM-Rückzug sind ohne torch importierbar, damit sie im normalen
// `npm test` laufen. Der Teil mit dem echten Modell läuft nur, wenn
// THERASCRIPT_SEARCH_MODEL_DIR (entpacktes Text-Artefakt) und
// THERASCRIPT_SEARCH_PYTHON (Interpreter mit torch, z. B. das Standalone) gesetzt sind.
const repoRoot = join(__dirname, '..', '..', '..', '..')
const sidecarDir = join(repoRoot, 'python_sidecar')
const script = join(sidecarDir, 'search_service.py')
const golden = join(repoRoot, 'tests', 'fixtures', 'search-golden', 'golden.json')

const PY_PROGRAM = `
import io
import json
import sys

sys.path.insert(0, sys.argv[1])

import search_service as ss

payload = json.loads(sys.argv[2])
out = {"torchImported": "torch" in sys.modules}

def parse(line):
    try:
        return {"ok": ss.parse_request(line)}
    except ss.RequestError as e:
        return {"error": {"code": e.code, "id": e.request_id}}

out["parsed"] = [parse(line) for line in payload.get("lines", [])]

stream = io.BytesIO(payload.get("stream", "").encode("utf-8"))
out["read"] = [
    "TOO_LARGE" if line is ss.TOO_LARGE else line.decode("utf-8")
    for line in ss.read_lines(stream, payload.get("maxBytes", 64))
]

out["encoded"] = [ss.encode_float32(v) for v in payload.get("vectors", [])]
out["decoded"] = [ss.decode_float32(ss.encode_float32(v)) for v in payload.get("vectors", [])]

out["plans"] = [ss.plan_batches(**case) for case in payload.get("plans", [])]
out["padded"] = [ss.pad_batch(**case) for case in payload.get("pads", [])]

def run_oom(case):
    state = ss.EncoderState("mps", "bfloat16", case["batchSize"], case.get("tokenBudget"))
    calls = {"forward": [], "toCpu": 0, "release": 0}

    def forward(ids, mask):
        calls["forward"].append({"device": state.device, "rows": len(ids), "len": len(ids[0])})
        if state.device == "mps" and len(ids) > case["mpsMaxRows"]:
            raise RuntimeError(case.get("error", "MPS backend out of memory (MPS allocated: 1 GiB)"))
        # Vektor = erste Token-ID, damit die Reihenfolge prüfbar bleibt
        return [[row[0]] for row in ids]

    def release():
        calls["release"] += 1

    def to_cpu():
        calls["toCpu"] += 1
        if case.get("toCpuFails"):
            raise RuntimeError("MPS-Gerät verloren")

    devices = [None] * len(case["sequences"])
    try:
        result = ss.embed_tokens(
            case["sequences"], state, forward, release, to_cpu, 128, 1024, 0, devices
        )
    except Exception as e:
        return {"raised": str(e), "raisedType": type(e).__name__, "calls": calls}
    return {
        "result": [r[0] for r in result],
        "devices": devices,
        "state": {
            "device": state.device,
            "dtype": state.dtype,
            "batchSize": state.batch_size,
            "tokenBudget": state.token_budget,
        },
        "calls": calls,
    }

out["cleaned"] = [ss.parse_request(line)["text"] for line in payload.get("surrogates", [])]
out["clipped"] = [len(ss.clip_text("x" * n, 1024)) for n in payload.get("clipLengths", [])]

out["oom"] = [run_oom(case) for case in payload.get("oom", [])]
out["constants"] = {
    "padMultiple": ss.DEFAULT_PAD_MULTIPLE,
    "batchSize": ss.DEFAULT_BATCH_SIZE,
    "tokenBudget": ss.DEFAULT_TOKEN_BUDGET,
    "maxTokens": ss.DEFAULT_MAX_TOKENS,
    "queryPrompt": ss.DEFAULT_QUERY_PROMPT,
    "documentPrompt": ss.DEFAULT_DOCUMENT_PROMPT,
    "minCosine": ss.MIN_COSINE,
    "minTokenBudget": ss.MIN_TOKEN_BUDGET,
}
out["torchImportedAfter"] = "torch" in sys.modules
print(json.dumps(out))
`

interface Plan {
  indices: number[]
  padded: number
}

interface OomRun {
  result?: number[]
  raised?: string
  raisedType?: string
  devices?: string[]
  state?: { device: string; dtype: string; batchSize: number; tokenBudget: number | null }
  calls: {
    forward: { device: string; rows: number; len: number }[]
    toCpu: number
    release: number
  }
}

interface ProgramResult {
  torchImported: boolean
  torchImportedAfter: boolean
  parsed: { ok?: Record<string, unknown>; error?: { code: string; id: unknown } }[]
  read: string[]
  encoded: string[]
  decoded: number[][]
  plans: Plan[][]
  padded: [number[][], number[][]][]
  oom: OomRun[]
  cleaned: string[]
  clipped: number[]
  constants: {
    padMultiple: number
    batchSize: number
    tokenBudget: number
    maxTokens: number
    queryPrompt: string
    documentPrompt: string
    minCosine: Record<string, number>
    minTokenBudget: number
  }
}

function run(payload: Record<string, unknown>): ProgramResult {
  const stdout = execFileSync('python3', ['-c', PY_PROGRAM, sidecarDir, JSON.stringify(payload)], {
    encoding: 'utf-8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  return JSON.parse(stdout) as ProgramResult
}

function hasPython3(): boolean {
  try {
    execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const describeIfPython3 = hasPython3() ? describe : describe.skip

describeIfPython3('search_service.py ohne torch', () => {
  it('importiert torch weder beim Laden noch in der reinen Logik', () => {
    const result = run({
      lines: ['{"id":1,"op":"ping"}'],
      plans: [{ lengths: [5, 300], batch_size: 4, pad_multiple: 128, max_tokens: 1024 }],
      oom: [{ sequences: [[1], [2]], batchSize: 4, mpsMaxRows: 4 }]
    })
    expect(result.torchImported).toBe(false)
    expect(result.torchImportedAfter).toBe(false)
  })

  it('zeigt die Hilfe ohne torch und ohne Modell', () => {
    const help = spawnSync('python3', [script, '--help'], { encoding: 'utf-8' })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('serve')
    expect(help.stdout).toContain('selftest')
    const serveHelp = spawnSync('python3', [script, 'serve', '--help'], { encoding: 'utf-8' })
    expect(serveHelp.status).toBe(0)
    expect(serveHelp.stdout).toContain('--model-dir')
    expect(serveHelp.stdout).toContain('--token-budget')
  })

  it('endet mit Exit 2, wenn im Modellverzeichnis kein Modell liegt', () => {
    const missing = spawnSync('python3', [script, 'serve', '--model-dir', '/nonexistent-search'], {
      encoding: 'utf-8'
    })
    expect(missing.status).toBe(2)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain('kein Suchmodell')
  })

  it('lehnt ungültige Argumente mit Exit 1 ab', () => {
    const bad = spawnSync(
      'python3',
      [script, 'serve', '--model-dir', '/nonexistent-search', '--batch-size', '0'],
      { encoding: 'utf-8' }
    )
    expect(bad.status).toBe(1)
  })

  it('kennt die Vorgaben aus dem Bauplan', () => {
    const { constants } = run({})
    expect(constants).toEqual({
      padMultiple: 128,
      batchSize: 2,
      tokenBudget: 2048,
      maxTokens: 1024,
      queryPrompt: 'task: search result | query: ',
      documentPrompt: 'title: none | text: ',
      minCosine: { mps: 0.999, cpu: 0.9999995 },
      minTokenBudget: 128
    })
  })

  it('parst gültige Anfragen', () => {
    const { parsed } = run({
      lines: [
        '{"id":1,"op":"ping"}',
        '{"id":"a","op":"embed_query","text":"Schlafprobleme"}',
        '{"id":3,"op":"embed_documents","texts":["eins","zwei"]}',
        '{"id":4,"op":"shutdown","extra":true}'
      ]
    })
    expect(parsed).toEqual([
      { ok: { id: 1, op: 'ping' } },
      { ok: { id: 'a', op: 'embed_query', text: 'Schlafprobleme' } },
      { ok: { id: 3, op: 'embed_documents', texts: ['eins', 'zwei'] } },
      { ok: { id: 4, op: 'shutdown' } }
    ])
  })

  it('beantwortet fehlerhafte Anfragen mit Code und, wenn lesbar, mit der ID', () => {
    const tooMany = JSON.stringify({ id: 9, op: 'embed_documents', texts: Array(257).fill('x') })
    const { parsed } = run({
      lines: [
        'kein json',
        '[1,2]',
        '{"op":"ping"}',
        '{"id":true,"op":"ping"}',
        '{"id":5}',
        '{"id":6,"op":"embed"}',
        '{"id":7,"op":"embed_query","text":42}',
        '{"id":8,"op":"embed_documents","texts":["ok",3]}',
        tooMany
      ]
    })
    expect(parsed.map((p) => p.error)).toEqual([
      { code: 'bad_json', id: null },
      { code: 'bad_request', id: null },
      { code: 'bad_request', id: null },
      { code: 'bad_request', id: null },
      { code: 'bad_request', id: 5 },
      { code: 'unknown_op', id: 6 },
      { code: 'bad_request', id: 7 },
      { code: 'bad_request', id: 8 },
      { code: 'too_large', id: 9 }
    ])
  })

  it('liest Zeilen, überspringt Leerzeilen und verwirft übergrosse Zeilen ganz', () => {
    const { read } = run({
      stream: `{"id":1}\n\n   \n${'x'.repeat(200)}\n{"id":2}\r\n{"id":3}`,
      maxBytes: 64
    })
    expect(read).toEqual(['{"id":1}', 'TOO_LARGE', '{"id":2}', '{"id":3}'])
  })

  it('kodiert Vektoren als float32 little-endian in base64', () => {
    const { encoded, decoded } = run({
      vectors: [
        [1, -2],
        [0.5, 0.25, -0.125]
      ]
    })
    expect(encoded[0]).toBe(Buffer.from(new Float32Array([1, -2]).buffer).toString('base64'))
    const buf = Buffer.from(encoded[1], 'base64')
    expect(Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4))).toEqual([
      0.5, 0.25, -0.125
    ])
    expect(decoded).toEqual([
      [1, -2],
      [0.5, 0.25, -0.125]
    ])
  })

  it('sortiert nach Länge, füllt auf Vielfache von 128 auf und deckelt bei max_tokens', () => {
    const { plans } = run({
      plans: [
        {
          lengths: [10, 700, 130, 128, 1100, 20],
          batch_size: 2,
          pad_multiple: 128,
          max_tokens: 1024
        },
        { lengths: [5, 5, 5, 9], batch_size: 4, pad_multiple: 1, max_tokens: 1024 }
      ]
    })
    expect(plans[0]).toEqual([
      { indices: [4, 1], padded: 1024 },
      { indices: [2, 3], padded: 256 },
      { indices: [5, 0], padded: 128 }
    ])
    // gleich lange Texte behalten ihre Reihenfolge (stabil)
    expect(plans[1]).toEqual([{ indices: [3, 0, 1, 2], padded: 9 }])
  })

  it('begrenzt Batches mit langen Texten über das Token-Budget', () => {
    const lengths = [1000, 1000, 1000, 400, 400, 400, 400, 400, 100]
    const { plans } = run({
      plans: [
        { lengths, batch_size: 4, pad_multiple: 128, max_tokens: 1024, token_budget: 2048 },
        { lengths: [5000], batch_size: 4, pad_multiple: 128, max_tokens: 4096, token_budget: 2048 }
      ]
    })
    expect(plans[0]).toEqual([
      { indices: [0, 1], padded: 1024 },
      { indices: [2, 3], padded: 1024 },
      { indices: [4, 5, 6, 7], padded: 512 },
      { indices: [8], padded: 128 }
    ])
    // ein einzelner Text passt immer, auch über dem Budget
    expect(plans[1]).toEqual([{ indices: [0], padded: 4096 }])
    const all = plans[0].flatMap((batch) => batch.indices).sort((a, b) => a - b)
    expect(all).toEqual(lengths.map((_, i) => i))
  })

  it('füllt rechts mit der Pad-ID auf und baut die Maske', () => {
    const { padded } = run({
      pads: [
        {
          sequences: [
            [2, 7, 1],
            [2, 1]
          ],
          padded: 4,
          pad_id: 0
        }
      ]
    })
    expect(padded[0]).toEqual([
      [
        [2, 7, 1, 0],
        [2, 1, 0, 0]
      ],
      [
        [1, 1, 1, 0],
        [1, 1, 0, 0]
      ]
    ])
  })

  it('halbiert bei MPS-OOM das Token-Budget und behält die Reihenfolge', () => {
    const sequences = [[10], [11, 1], [12], [13, 1, 1], [14], [15]]
    const { oom } = run({ oom: [{ sequences, batchSize: 4, tokenBudget: 2048, mpsMaxRows: 2 }] })
    const [first] = oom
    expect(first.result).toEqual([10, 11, 12, 13, 14, 15])
    // gescheitert: 4 × 128 = 512 Slots → Budget 256 = 2 Texte; batch_size bleibt
    expect(first.state).toEqual({
      device: 'mps',
      dtype: 'bfloat16',
      batchSize: 4,
      tokenBudget: 256
    })
    expect(first.calls.toCpu).toBe(0)
    expect(first.calls.forward[0]).toEqual({ device: 'mps', rows: 4, len: 128 })
    expect(first.calls.forward.slice(1).every((call) => call.rows === 2)).toBe(true)
    expect(first.devices).toEqual(Array(6).fill('mps'))
    // nach JEDEM Forward-Pass wird der Cache freigegeben, auch nach dem OOM
    expect(first.calls.release).toBe(first.calls.forward.length)
  })

  it('teilt 2 × 1024 Tokens nach einem OOM in Einzeltexte, ohne auf die CPU zu wechseln', () => {
    const long = Array(1000).fill(7)
    const { oom } = run({
      oom: [{ sequences: [long, long], batchSize: 2, tokenBudget: 2048, mpsMaxRows: 1 }]
    })
    const [first] = oom
    expect(first.state).toEqual({
      device: 'mps',
      dtype: 'bfloat16',
      batchSize: 2,
      tokenBudget: 1024
    })
    const calls = first.calls.forward.map((call) => `${call.device}:${call.rows}x${call.len}`)
    expect(calls).toEqual(['mps:2x1024', 'mps:1x1024', 'mps:1x1024'])
  })

  it('wechselt erst bei einem einzelnen Text auf die CPU und merkt sich das Gerät pro Vektor', () => {
    const { oom } = run({
      oom: [{ sequences: [[1], [2], [3]], batchSize: 4, tokenBudget: 2048, mpsMaxRows: 0 }]
    })
    const [first] = oom
    expect(first.result).toEqual([1, 2, 3])
    expect(first.state).toMatchObject({ device: 'cpu', dtype: 'float32', tokenBudget: 192 })
    expect(first.calls.toCpu).toBe(1)
    const devices = first.calls.forward.map((call) => `${call.device}:${call.rows}`)
    expect(devices).toEqual(['mps:3', 'mps:1', 'cpu:1', 'cpu:1', 'cpu:1'])
    expect(first.devices).toEqual(['cpu', 'cpu', 'cpu'])
  })

  it('bricht mit FatalError ab, wenn der Umzug auf die CPU selbst scheitert', () => {
    const { oom } = run({
      oom: [{ sequences: [[1]], batchSize: 2, mpsMaxRows: 0, toCpuFails: true }]
    })
    expect(oom[0].raisedType).toBe('FatalError')
    expect(oom[0].raised).toContain('Umzug auf die CPU fehlgeschlagen')
  })

  it('ersetzt ungepaarte Surrogate durch U+FFFD und lässt gültige Paare stehen', () => {
    const { cleaned } = run({
      surrogates: [
        '{"id":1,"op":"embed_query","text":"\\ud800 lone"}',
        '{"id":2,"op":"embed_query","text":"ok \\ud83d\\ude00 \\udc00"}'
      ]
    })
    expect(cleaned).toEqual(['\ufffd lone', 'ok \u{1F600} \ufffd'])
  })

  it('kürzt riesige Texte vor dem Tokenisieren auf max_tokens × 32 Zeichen', () => {
    const { clipped } = run({ clipLengths: [10, 32768, 1_000_000] })
    expect(clipped).toEqual([10, 32768, 32768])
  })

  it('reicht andere Fehler durch statt sie als OOM zu behandeln', () => {
    const { oom } = run({
      oom: [{ sequences: [[1], [2]], batchSize: 4, mpsMaxRows: 0, error: 'shape mismatch' }]
    })
    expect(oom[0].raised).toBe('shape mismatch')
    expect(oom[0].calls.toCpu).toBe(0)
  })
})

// ── Mit echtem Modell ───────────────────────────────────────────────────────
const modelDir = process.env.THERASCRIPT_SEARCH_MODEL_DIR
const modelPython = process.env.THERASCRIPT_SEARCH_PYTHON
const describeWithModel = modelDir && modelPython ? describe : describe.skip

interface Ready {
  ready: boolean
  device: string
  dtype: string
  load_ms: number
  dim: number
  phys_footprint_bytes: number
}

interface GoldenFile {
  texts: { id: string; text: string; document: string }[]
}

function cosineOf(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / Math.sqrt(na * nb)
}

const modelEnv = (): NodeJS.ProcessEnv => ({
  PATH: '/usr/bin:/bin',
  HOME: process.env.HOME ?? '',
  PYTHONDONTWRITEBYTECODE: '1'
})

function decodeVector(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
}

describeWithModel('search_service.py mit Modell', () => {
  beforeAll(() => {
    expect(existsSync(join(modelDir!, 'model.safetensors'))).toBe(true)
  })

  it('startet, beantwortet Anfragen und endet bei stdin-EOF binnen 2 s', async () => {
    const child = spawn(modelPython!, [script, 'serve', '--model-dir', modelDir!], {
      env: modelEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    const next = async (): Promise<Record<string, unknown>> => {
      const { value } = await lines.next()
      return JSON.parse(value as string) as Record<string, unknown>
    }

    const ready = (await next()) as unknown as Ready
    expect(ready.ready).toBe(true)
    expect(ready.dim).toBe(768)
    expect(ready.phys_footprint_bytes).toBeGreaterThan(0)
    expect(stderr).toContain(`Gewichte: torch.${ready.dtype} auf ${ready.device}`)

    child.stdin.write('{"id":1,"op":"embed_query","text":"Schlafprobleme wegen der Arbeit"}\n')
    const query = await next()
    expect(query.id).toBe(1)
    const vector = decodeVector(query.vector as string)
    expect(vector.length).toBe(768)
    expect(Math.hypot(...vector)).toBeCloseTo(1, 3)

    expect(query.phys_footprint_bytes).toBeGreaterThan(0)

    child.stdin.write('{"id":2,"op":"embed_documents","texts":["Erster Abschnitt","Zweiter"]}\n')
    const docs = await next()
    expect((docs.vectors as string[]).length).toBe(2)

    // ungepaartes Surrogat: kein internal-Fehler, der Batch wird gerechnet
    child.stdin.write('{"id":3,"op":"embed_documents","texts":["\\ud800 lone","gut"]}\n')
    const surrogate = await next()
    expect(surrogate.error).toBeUndefined()
    expect((surrogate.vectors as string[]).length).toBe(2)

    // Kürzung auf Zeichen vor dem Tokenisieren ändert nichts: der > 1024-Token-
    // Goldtext, fünfmal hintereinander (> 32'768 Zeichen), hat dieselben ersten
    // 1024 Tokens wie der Goldtext selbst.
    const goldenFile = JSON.parse(readFileSync(golden, 'utf-8')) as GoldenFile
    const longEntry = goldenFile.texts.find((t) => t.id === 'lang-ueber-1024')!
    const huge = Array(5).fill(longEntry.text).join('\n')
    expect(huge.length).toBeGreaterThan(32_768)
    child.stdin.write(JSON.stringify({ id: 4, op: 'embed_documents', texts: [huge] }) + '\n')
    const clipped = await next()
    const cos = cosineOf(
      decodeVector((clipped.vectors as string[])[0]),
      decodeVector(longEntry.document)
    )
    expect(cos).toBeGreaterThanOrEqual(0.999)

    child.stdin.write('kein json\n')
    expect(await next()).toMatchObject({ id: null, error: { code: 'bad_json' } })

    const exited = new Promise<{ code: number | null; ms: number }>((resolve) => {
      const started = Date.now()
      child.on('exit', (code) => resolve({ code, ms: Date.now() - started }))
    })
    child.stdin.end()
    const { code, ms } = await exited
    console.log(
      `[search] serve: ${ready.device}/${ready.dtype}, load_ms=${ready.load_ms}, EOF→Exit ${ms} ms`
    )
    expect(code).toBe(0)
    expect(ms).toBeLessThan(2000)
  }, 180_000)

  it('trifft die Goldvektoren und bleibt beim Aufbereiten unter 2.5 GiB', () => {
    const result = spawnSync(
      modelPython!,
      [script, 'selftest', '--model-dir', modelDir!, '--golden', golden, '--bench', '40'],
      { encoding: 'utf-8', env: modelEnv(), timeout: 300_000 }
    )
    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout) as {
      device: string
      dtype: string
      load_ms: number
      min_cosine: number
      threshold: number
      bench: { chunks: number; ms_per_chunk: number; phys_footprint_peak_bytes: number }
    }
    const gib = report.bench.phys_footprint_peak_bytes / 1024 ** 3
    console.log(
      `[search] selftest: ${report.device}/${report.dtype}, min. Kosinus ${report.min_cosine}, ` +
        `load_ms=${report.load_ms}, phys_footprint nach ${report.bench.chunks} Abschnitten ` +
        `${gib.toFixed(2)} GiB, ${report.bench.ms_per_chunk} ms pro Abschnitt`
    )
    expect(report.min_cosine).toBeGreaterThanOrEqual(report.threshold)
    expect(gib).toBeLessThan(2.5)
  }, 300_000)

  // Nur in fp32 auf der CPU fallen Off-by-one-Fehler im Encoder auf (Sliding
  // Window 511/513, Kürzung auf 1023): auf MPS verdeckt sie das bf16-Rauschen.
  it('trifft die Goldvektoren in fp32 auf der CPU mit Kosinus ≥ 0.9999995', () => {
    const result = spawnSync(
      modelPython!,
      [script, 'selftest', '--model-dir', modelDir!, '--golden', golden],
      {
        encoding: 'utf-8',
        env: { ...modelEnv(), THERASCRIPT_SEARCH_DEVICE: 'cpu' },
        timeout: 300_000
      }
    )
    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout) as {
      device: string
      min_cosine: number
      threshold: number
    }
    console.log(`[search] selftest cpu: min. Kosinus ${report.min_cosine}`)
    expect(report.device).toBe('cpu')
    expect(report.threshold).toBe(0.9999995)
    expect(report.min_cosine).toBeGreaterThanOrEqual(0.9999995)
  }, 300_000)
})
