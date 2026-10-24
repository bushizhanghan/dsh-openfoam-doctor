// dsh-openfoam-doctor: agent tools over OpenFOAM cases.
//
// Cases usually live inside WSL on a Windows host, so every path is converted
// at the boundary and every check runs on the file the solver would read.
// Checks are deterministic text analysis — no LLM, so a wrong answer is a bug
// in a rule, not a hallucination.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import {
  checkBlockMeshDict,
  checkBoundaryFields,
  checkCase,
  checkControlDict,
  checkFvSchemes,
  checkFvSolution,
  checkStrayTimes,
  fieldFiles,
  num,
  parseCheckMesh,
  parseDict,
  parseRunLog,
  readCaseDict,
  strayTimeDirs,
  winToWslPath,
  wslToWinPath,
  CASE_FILES,
} from './engine.js'

export const name = 'openfoam-doctor'
export const inject = ['tools']

const Config = {
  // WSL distro that holds the OpenFOAM install.
  distro: 'Ubuntu-24.04',
  // Solver commands run with this budget; a hung mesh gets killed.
  timeoutMs: 600_000,
  // Where case check logs land when a tool runs a command.
  logDir: '',
}

/** A Windows path to a case, or a WSL path we can read through /mnt. */
function localCaseDir(casePath) {
  if (/^\/mnt\/[a-z]\//i.test(casePath)) return wslToWinPath(casePath)
  return casePath
}

export function apply(ctx, config = {}) {
  const cfg = { ...Config, ...config }

  async function wsl(args, { timeoutMs = cfg.timeoutMs } = {}) {
    return new Promise((resolvePromise) => {
      const child = spawn('wsl.exe', ['-d', cfg.distro, '--', 'bash', '-lc', args], { windowsHide: true })
      let out = ''
      let err = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          child.kill()
        } catch {}
        resolvePromise({ ok: false, timedOut: true, code: null, stdout: out, stderr: err })
      }, timeoutMs)
      child.stdout.on('data', (d) => {
        out += d.toString()
      })
      child.stderr.on('data', (d) => {
        err += d.toString()
      })
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ ok: false, timedOut: false, code: null, stdout: out, stderr: String(e.message || e) })
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ ok: code === 0, timedOut: false, code, stdout: out, stderr: err })
      })
    })
  }

  /** Locate an OpenFOAM install inside the distro. */
  async function findOpenfoam() {
    const roots = ['/opt/openfoam', '/opt/openfoam11', '/usr/lib/openfoam', '/usr/local/openfoam']
    for (const root of roots) {
      const probe = await wsl(`ls -d ${root} ${root}*/ 2>/dev/null | head -3`, { timeoutMs: 30_000 })
      if (probe.stdout.trim()) {
        const dirs = probe.stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean)
        // prefer a versioned dir (openfoam11) over the base
        const versioned = dirs.find((d) => /openfoam\d+/.test(d)) || dirs[0]
        return { root: versioned.replace(/\/$/, '') }
      }
    }
    return null
  }

  const RULE_ORDER = [
    'missing-file', 'no-ddt', 'no-grad', 'no-laplacian', 'no-internal-field', 'no-boundary-field',
    'block-vertex-mismatch', 'vertex-count', 'start-after-end', 'write-interval-fractional',
    'limiter-wide-open', 'unbounded-scalar-advection', 'unbounded-viscous', 'no-nonortho-correctors',
    'loose-tolerance', 'loose-reltol', 'pimple-no-outer', 'p-fixed-value', 'probes-no-fields',
    'steady-write-flood', 'no-purge', 'stray-time-dirs', 'non-unit-scale', 'u-empty-patch',
  ]
  const MARK = { error: '✗', warn: '!', info: '·' }

  function render(findings) {
    if (findings.length === 0) return '  算例没有发现已知模式的静默错误。'
    const ordered = [...findings].sort((a, b) => {
      const sa = RULE_ORDER.indexOf(a.rule)
      const sb = RULE_ORDER.indexOf(b.rule)
      return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb)
    })
    const lines = []
    for (const f of ordered) {
      lines.push(`${MARK[f.severity] ?? '·'} ${f.title}  [${f.rule}]`)
      lines.push(`    ${f.detail}`)
      if (f.fix) lines.push(`    fix ${f.fix}`)
      lines.push('')
    }
    return lines.join('\n')
  }

  const OUTPUT_SCHEMA = { type: 'json' }
  const outRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

  const tools = [
    {
      name: 'of_check',
      description:
        'Audit an OpenFOAM case for the failures that do not announce themselves: steadyState paired with timeStep writes, limiters set to 1 (the classic cause of negative k/epsilon and "it ran but the plot is wrong"), unbounded advection of transport scalars, missing ddtSchemes/gradSchemes, nNonOrthogonalCorrectors 0 on a skewed mesh, loose solver tolerances, blockMesh vertex/block mismatch, stray time directories from a previous run, purgeWrite 0, and boundary-field mistakes. Deterministic text analysis of the files the solver actually reads — no LLM, so a wrong answer is a rule bug you can report. Returns {ok, findings:[{rule,severity,title,detail,fix}], report}.',
      parameters: {
        type: 'object',
        properties: {
          casePath: { type: 'string', description: 'Case directory (Windows path or WSL /mnt/... path).' },
          file: {
            type: 'string',
            description: 'Optional: check only one dictionary — controlDict, fvSchemes, fvSolution, blockMeshDict, boundaries, times.',
          },
        },
        required: ['casePath'],
      },
      async execute(args) {
        const dir = localCaseDir(args.casePath)
        if (!existsSync(dir)) return { ok: false, error: `case directory not found: ${dir}` }
        let findings
        if (args.file === 'controlDict') findings = checkControlDict(dir)
        else if (args.file === 'fvSchemes') findings = checkFvSchemes(dir)
        else if (args.file === 'fvSolution') findings = checkFvSolution(dir)
        else if (args.file === 'blockMeshDict') findings = checkBlockMeshDict(dir)
        else if (args.file === 'boundaries') findings = checkBoundaryFields(dir)
        else if (args.file === 'times') findings = checkStrayTimes(dir)
        else findings = checkCase(dir)
        return { ok: true, findings, report: render(findings) }
      },
    },
    {
      name: 'of_read_dict',
      description:
        'Read one OpenFOAM dictionary and return it as plain JSON: controlDict, fvSchemes, fvSolution, blockMeshDict, snappyHexMeshDict, decomposeParDict, or a boundary field under 0/. Use it to answer questions like "what is my writeInterval", "which boundary conditions does inlet use", or "how many cells does blockMesh want" without opening WSL. Returns {ok, file, dict}.',
      parameters: {
        type: 'object',
        properties: {
          casePath: { type: 'string', description: 'Case directory.' },
          file: {
            type: 'string',
            description: 'Dictionary name: controlDict, fvSchemes, fvSolution, blockMeshDict, snappyHexMeshDict, decomposeParDict, or 0/<field> (e.g. 0/U).',
          },
        },
        required: ['casePath', 'file'],
      },
      async execute(args) {
        const dir = localCaseDir(args.casePath)
        if (!existsSync(dir)) return { ok: false, error: `case directory not found: ${dir}` }
        const rel = args.file.startsWith('0/') ? args.file : `system/${args.file}`
        const text = (() => {
          try {
            return readFileSync(join(dir, rel), 'utf8')
          } catch {
            return null
          }
        })()
        if (text === null) return { ok: false, error: `not found: ${rel} under ${dir}` }
        return { ok: true, file: rel, dict: parseDict(text) }
      },
    },
    {
      name: 'of_list_cases',
      description:
        'List OpenFOAM cases under a directory: each case with its solver, steady/transient, endTime, field files, stray time directories, and whether the key dictionaries exist. Use it to survey a sweep (e.g. ~/OpenFOAM/run) before choosing which case to inspect or run. Returns {ok, cases:[{path,name,solver,steady,endTime,fields,strayTimes,hasBlockMesh,hasSnappy}]}.',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Directory to scan (Windows path or WSL /mnt/... path).' },
          depth: { type: 'integer', description: 'How deep to look, default 2.' },
        },
        required: ['root'],
      },
      async execute(args) {
        const root = localCaseDir(args.root)
        if (!existsSync(root)) return { ok: false, error: `not found: ${root}` }
        const { readdirSync, statSync } = await import('node:fs')
        const cases = []
        const walk = (dir, depth) => {
          let entries
          try {
            entries = readdirSync(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of entries) {
            if (!e.isDirectory()) continue
            if (e.name === '0' || e.name === 'constant' || e.name === 'system' || e.name.startsWith('.')) continue
            const full = join(dir, e.name)
            const cd = readCaseDict(full, CASE_FILES.control)
            if (cd) {
              const schemes = readCaseDict(full, CASE_FILES.schemes)
              cases.push({
                path: full,
                name: e.name,
                solver: cd.application ?? null,
                steady: /steadyState/.test(String(schemes?.ddtSchemes?.default ?? '')),
                endTime: cd.endTime ?? null,
                fields: fieldFiles(full),
                strayTimes: strayTimeDirs(full),
                hasBlockMesh: existsSync(join(full, CASE_FILES.blockMesh)),
                hasSnappy: existsSync(join(full, CASE_FILES.snappyMesh)),
              })
              continue
            }
            if (depth > 1) walk(full, depth - 1)
          }
        }
        walk(root, Math.max(1, Number(args.depth) || 2))
        return { ok: true, cases }
      },
    },
    {
      name: 'of_run',
      description:
        'Run an OpenFOAM command inside WSL on a case: checkMesh, blockMesh, snappyHexMesh, foamRun (or any solver named in controlDict), or a postProcess utility. Streams the log, parses it, and reports the outcome — checkMesh metrics for meshes, residual floor and fatal errors for runs. Use of_check first when something looks off. Returns {ok, command, exitCode, timedOut, summary, logTail, logFile}.',
      parameters: {
        type: 'object',
        properties: {
          casePath: { type: 'string', description: 'Case directory (Windows or WSL path).' },
          command: {
            type: 'string',
            description: 'What to run: checkMesh, blockMesh, snappyHexMesh, foamRun, or a utility name (decomposePar, reconstructPar, foamToVTK, postProcess).',
          },
          parallel: { type: 'integer', description: 'Optional: run in parallel with this many processes (decomposePar + mpirun).' },
          timeoutMs: { type: 'integer', description: 'Optional: override the run budget (default 600000).' },
        },
        required: ['casePath', 'command'],
      },
      async execute(args) {
        const dir = localCaseDir(args.casePath)
        if (!existsSync(dir)) return { ok: false, error: `case directory not found: ${dir}` }
        const of = await findOpenfoam()
        if (!of) return { ok: false, error: `no OpenFOAM installation found in ${cfg.distro} (looked in /opt, /usr/lib, /usr/local)` }
        const wslDir = /^\/mnt\//i.test(dir) ? dir : winToWslPath(dir)
        const command = String(args.command)
        const allowed = /^(checkMesh|blockMesh|snappyHexMesh|foamRun|decomposePar|reconstructPar|foamToVTK|postProcess|renumberMesh|potentialFoam)$/.test(command)
        if (!allowed) {
          return { ok: false, error: `command "${command}" is not in the allow-list (checkMesh, blockMesh, snappyHexMesh, foamRun, decomposePar, reconstructPar, foamToVTK, postProcess, renumberMesh, potentialFoam)` }
        }
        const script = [
          `source ${of.root}/etc/bashrc >/dev/null 2>&1`,
          `cd "${wslDir}" || exit 2`,
          command === 'foamRun' && args.parallel > 1 ? `mpirun -np ${Math.floor(args.parallel)} foamRun -parallel` : command,
        ]
          .filter(Boolean)
          .join(' && ')
        const run = await wsl(script, { timeoutMs: Number(args.timeoutMs) || cfg.timeoutMs })
        const combined = `${run.stdout}\n${run.stderr}`
        const summary =
          command === 'checkMesh'
            ? parseCheckMesh(combined)
            : parseRunLog(combined)
        const logFile = join(dir, `log.${command}${args.parallel > 1 ? '.parallel' : ''}`)
        try {
          const { writeFileSync, mkdirSync } = await import('node:fs')
          mkdirSync(dir, { recursive: true })
          writeFileSync(logFile, combined, 'utf8')
        } catch {}
        return {
          ok: run.ok && !run.timedOut,
          command,
          exitCode: run.code,
          timedOut: run.timedOut,
          summary,
          logTail: combined.slice(-3000),
          logFile,
          hint: run.timedOut ? 'timed out — raise timeoutMs, or check whether the case is waiting on a solver that never converges.' : undefined,
        }
      },
    },
    {
      name: 'of_log',
      description:
        'Parse an OpenFOAM log file (log.checkMesh, log.foamRun, log.snappyHexMesh…) and report what matters: for checkMesh the metrics and whether any are out of range (aspect ratio > 1000, non-orthogonality > 70°, skewness > 4); for a run log the last iteration, residual floor, fatal errors and divergence signals. Returns {ok, kind, summary}.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Log file path (Windows or WSL).' },
        },
        required: ['path'],
      },
      async execute(args) {
        const p = localCaseDir(args.path)
        let text
        try {
          text = readFileSync(p, 'utf8')
        } catch {
          return { ok: false, error: `cannot read ${p}` }
        }
        const isMesh = /checkMesh|Mesh stats|non-orthogonality|aspect ratio/i.test(text)
        return {
          ok: true,
          kind: isMesh ? 'checkMesh' : 'run',
          summary: isMesh ? parseCheckMesh(text) : parseRunLog(text),
        }
      },
    },
    {
      name: 'of_env',
      description:
        'Report the OpenFOAM environment inside the WSL distro: which installation was found, its version, whether the case path is reachable, and the WSL/Windows path conversion for it. Use this first when a run fails for reasons that are not about the case itself. Returns {ok, distro, installation, version, wslAvailable, paths}.',
      parameters: {
        type: 'object',
        properties: {
          casePath: { type: 'string', description: 'Optional: a case path to convert and verify.' },
        },
      },
      async execute(args) {
        const probe = await wsl('echo ok; uname -r', { timeoutMs: 30_000 })
        const of = probe.ok ? await findOpenfoam() : null
        let version = null
        if (of) {
          const v = await wsl(`cat ${of.root}/etc/bashrc 2>/dev/null | grep -oE 'wm_project_version|export WM_PROJECT_VERSION=.*' | head -1; grep -oE 'foamVersion=[^;]*' ${of.root}/etc/bashrc 2>/dev/null | head -1`, { timeoutMs: 30_000 })
          version = v.stdout.trim() || null
        }
        const out = {
          ok: probe.ok,
          distro: cfg.distro,
          wslAvailable: probe.ok,
          installation: of ? of.root : null,
          version,
          paths: {},
        }
        if (args.casePath) {
          const dir = localCaseDir(args.casePath)
          out.paths = {
            given: args.casePath,
            windows: dir,
            wsl: /^\/mnt\//i.test(dir) ? dir : winToWslPath(dir),
            reachableFromWsl: (await wsl(`test -d "${/^\/mnt\//i.test(dir) ? dir : winToWslPath(dir)}" && echo yes`, { timeoutMs: 30_000 })).stdout.trim() === 'yes',
            existsOnWindows: existsSync(dir),
          }
        }
        return out
      },
    },
  ]

  for (const t of tools) {
    try {
      ctx.tools.register({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        output: { schema: OUTPUT_SCHEMA, render: outRender },
        timeoutMs: 700_000,
        isConcurrencySafe: () => false,
        presentCall: (args) => ({ card: 'generic', title: t.name, kind: 'tool', rawInput: args }),
        execute: t.execute,
      })
    } catch (error) {
      console.error(`[openfoam-doctor] ${t.name} registration skipped: ${error}`)
    }
  }
}
