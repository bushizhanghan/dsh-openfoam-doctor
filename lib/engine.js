// dsh-openfoam-doctor engine: an OpenFOAM dictionary parser plus the checks
// that catch the failures which do not announce themselves.
//
// The OpenFOAM dict format is not JSON and not YAML: C-style /* */ and //
// comments, nested braces, bare tokens as values, quoted keys like
// "(U|k|epsilon)", and a banner header of escaped backslashes. A generic
// parser either chokes on the banner or silently drops entries, so this one
// strips comments first, then walks braces while tracking a key stack.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// =====================================================================
// Dictionary parsing
// =====================================================================

// Remove block and line comments without touching strings or the banner.
// (The banner contains escaped backslashes, so a naive strip would eat it.)
function stripComments(text) {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      out += ' '
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
      out += '\n'
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Parse an OpenFOAM dictionary into a nested plain object.
 * Values stay strings (OpenFOAM values are tokens, not JSON scalars); lists
 * become arrays of strings; sub-dictionaries become objects.
 */
export function parseDict(text) {
  const src = stripComments(text)
  const root = {}
  // stack of {obj, key} where key is the dictionary a `{` opened under
  const stack = [{ obj: root, key: null }]
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '{') {
      // open a sub-dict under the last seen key of the current object
      const top = stack.at(-1)
      const lastKey = top.key
      if (lastKey === null) {
        // the FoamFile header block: capture nothing, push a scratch object
        stack.push({ obj: {}, key: null })
        i++
        continue
      }
      const child = {}
      top.obj[lastKey] = child
      stack.push({ obj: child, key: null })
      i++
      continue
    }
    if (c === '}') {
      if (stack.length > 1) stack.pop()
      i++
      continue
    }
    if (c === ';') {
      i++
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    // read a token: quoted key, or bare run up to whitespace/;{}
    let token = ''
    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          token += src[j + 1]
          j += 2
          continue
        }
        token += src[j]
        j++
      }
      i = j + 1
    } else {
      let j = i
      while (j < src.length && !/[\s;{}]/.test(src[j])) {
        token += src[j]
        j++
      }
      i = j
    }
    if (token === '') continue
    // after a token, either `key value`, or `key {`
    const after = src.slice(i)
    const braceAfter = /^\s*\{/.test(after)
    const semiAfter = /^\s*;/.test(after)
    if (braceAfter || semiAfter) {
      // this token is a key whose value is a dict (or an empty entry)
      stack.at(-1).key = token
      if (semiAfter) {
        // `key;` with no value — record as empty so the key exists
        stack.at(-1).obj[token] = ''
        stack.at(-1).key = null
        i = after.indexOf(';') + 1 + i
      }
      continue
    }
    // read the value token(s) up to the statement end
    let value = ''
    let j = i
    while (j < src.length) {
      // skip whitespace
      while (j < src.length && /\s/.test(src[j])) j++
      if (j >= src.length || src[j] === ';') break
      if (src[j] === '{') break // value list handled below
      let v = ''
      if (src[j] === '"') {
        let k = j + 1
        while (k < src.length && src[k] !== '"') {
          if (src[k] === '\\' && k + 1 < src.length) {
            v += src[k + 1]
            k += 2
            continue
          }
          v += src[k]
          k++
        }
        j = k + 1
      } else {
        let k = j
        while (k < src.length && !/[\s;{}]/.test(src[k])) {
          v += src[k]
          k++
        }
        j = k
      }
      value = value === '' ? v : `${value} ${v}`
    }
    const top = stack.at(-1)
    // a `( ... )` list: collect until the closing paren
    if (value.startsWith('(') && !value.endsWith(')')) {
      let raw = value
      while (j < src.length && !raw.trimEnd().endsWith(')')) {
        raw += src[j]
        j++
      }
      value = raw.trim()
      // consume the trailing ;
      while (j < src.length && src[j] !== ';') j++
    }
    top.obj[token] = value.trim()
    top.key = null
    i = j
  }
  return root
}

// =====================================================================
// Case layout discovery
// =====================================================================
export const CASE_FILES = {
  control: 'system/controlDict',
  schemes: 'system/fvSchemes',
  solution: 'system/fvSolution',
  blockMesh: 'system/blockMeshDict',
  snappyMesh: 'system/snappyHexMeshDict',
  decompose: 'system/decomposeParDict',
  surfaceFeatures: 'system/surfaceFeatureExtractDict',
}

const safeRead = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export function readCaseDict(caseDir, rel) {
  const text = safeRead(join(caseDir, rel))
  return text === null ? null : parseDict(text)
}

/** Numeric-looking tokens: "3000" -> 3000, "1e-07" -> 1e-7, else NaN. */
export function num(value) {
  if (value === undefined || value === null) return NaN
  const s = String(value).trim()
  if (s === '') return NaN
  const m = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.exec(s)
  return m ? Number(s) : NaN
}

/** Time directories that are not the expected start (stray run state). */
export function strayTimeDirs(caseDir) {
  if (!existsSync(caseDir)) return []
  const out = []
  for (const e of readdirSyncSafe(caseDir)) {
    if (!/^\d+(\.\d+)?$/.test(e)) continue
    // a time dir that holds field data rather than being the uniform start
    if (e === '0' || e === 'uniform') continue
    const p = join(caseDir, e)
    try {
      if (!statSync(p).isDirectory()) continue
    } catch {
      continue
    }
    out.push(e)
  }
  return out.sort((a, b) => Number(a) - Number(b))
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Which field files exist under 0/ (or the first time dir). */
export function fieldFiles(caseDir) {
  const zero = join(caseDir, '0')
  const dir = existsSync(zero) ? zero : caseDir
  return readdirSyncSafe(dir).filter((f) => /^(U|k|epsilon|p|p_rgh|T|nut|nuTilda|omega|phi)$/.test(f))
}

// =====================================================================
// Checks. Each returns findings: {rule, severity, title, detail, fix}
// =====================================================================

const F = (rule, severity, title, detail, fix) => ({ rule, severity, title, detail, fix })

export function checkControlDict(caseDir) {
  const d = readCaseDict(caseDir, CASE_FILES.control)
  const out = []
  if (d === null) return [F('missing-file', 'error', 'system/controlDict not found', 'A case without controlDict cannot run.', 'Restore it from a working case or the tutorial.')]
  const schemes = readCaseDict(caseDir, CASE_FILES.schemes)
  const ddt = schemes?.ddtSchemes?.default ?? ''
  const isSteady = /steadyState/.test(ddt)
  const writeControl = String(d.writeControl ?? '')
  const writeInterval = String(d.writeInterval ?? '')
  const endTime = num(d.endTime)
  const deltaT = num(d.deltaT)
  const startTime = num(d.startTime)
  const stopAt = String(d.stopAt ?? '')
  const purgeWrite = num(d.purgeWrite)

  // 1. steadyState + timeStep writeInterval: writes are per iteration, so a
  //    steady case silently produces a huge number of time dirs.
  if (isSteady && writeControl === 'timeStep' && num(writeInterval) > 0 && endTime / num(writeInterval) > 20) {
    out.push(
      F(
        'steady-write-flood',
        'warn',
        `steady case writes ${Math.round(endTime / num(writeInterval))} time directories`,
        `ddtSchemes is steadyState but writeControl is timeStep with writeInterval ${writeInterval} over endTime ${endTime}. Every write becomes a time directory, so disk grows by that factor and foamToVTK/converting takes just as long.`,
        'For a steady run prefer writeControl runTime/writeInterval, or a much larger writeInterval (e.g. 500).',
      ),
    )
  }

  // 2. writeInterval not a multiple of the step: skipped writes look like lost data.
  if (writeControl === 'timeStep' && num(writeInterval) > 0 && Number.isFinite(deltaT) && deltaT > 0) {
    const perWrite = num(writeInterval)
    if (!Number.isInteger(perWrite)) {
      out.push(
        F(
          'write-interval-fractional',
          'error',
          `writeInterval ${writeInterval} is not an integer step count`,
          'writeControl timeStep interprets writeInterval as a number of time steps, so a fractional value is silently truncated and writes land where you do not expect.',
          'Use an integer number of steps.',
        ),
      )
    }
  }

  // 3. purgeWrite 0 with a long run: unbounded disk growth.
  if (purgeWrite === 0 && Number.isFinite(endTime) && endTime > 0 && num(writeInterval) > 0 && endTime / num(writeInterval) > 10) {
    out.push(
      F(
        'no-purge',
        'warn',
        'purgeWrite is 0 on a run that writes many times',
        'Nothing is ever deleted, so a long parameter sweep fills the disk. purgeWrite 2 keeps only the last two.',
        'Set purgeWrite 2 (or more) once you no longer need every step.',
      ),
    )
  }

  // 4. startTime/stopAt mismatch: restarting from the wrong time is silent.
  if (stopAt === 'endTime' && Number.isFinite(startTime) && Number.isFinite(endTime) && startTime > endTime) {
    out.push(F('start-after-end', 'error', `startTime ${startTime} is after endTime ${endTime}`, 'The solver exits immediately with nothing written.', 'Fix the times.'))
  }

  // 5. functions referencing probeLocations on a case with no field files.
  const funcs = d.functions && typeof d.functions === 'object' ? Object.keys(d.functions) : []
  if (funcs.includes('probes')) {
    const fields = fieldFiles(caseDir)
    if (fields.length === 0) {
      out.push(
        F(
          'probes-no-fields',
          'warn',
          'controlDict defines a probes functionObject but 0/ has no field files',
          'probes reads the fields named in its `fields` entry; without them it writes empty or fails at the first write step.',
          'Ensure 0/ contains U, k, epsilon, p (or adjust the probes `fields` list).',
        ),
      )
    }
  }
  return out
}

export function checkFvSchemes(caseDir) {
  const d = readCaseDict(caseDir, CASE_FILES.schemes)
  const out = []
  if (d === null) return [F('missing-file', 'error', 'system/fvSchemes not found', 'The solver cannot start without numerical schemes.', 'Copy one from a tutorial and adapt it.')]
  if (!d.ddtSchemes?.default) {
    out.push(F('no-ddt', 'error', 'fvSchemes has no ddtSchemes default', 'The solver aborts with "no ddtSchemes" on the first iteration.', 'Add ddtSchemes { default steadyState; } for steady, or Euler for transient.'))
  }
  if (!d.gradSchemes?.default) {
    out.push(F('no-grad', 'error', 'fvSchemes has no gradSchemes default', 'Gradients are required by every convection term.', 'Add gradSchemes { default Gauss linear; }.'))
  }
  const div = d.divSchemes && typeof d.divSchemes === 'object' ? d.divSchemes : {}
  for (const [term, scheme] of Object.entries(div)) {
    const s = String(scheme)
    // limitedLinear 1 == no limiting: negative k/epsilon and oscillations
    const lim = /limitedLinear\s+(\S+)/.exec(s)
    if (lim && num(lim[1]) >= 1) {
      out.push(
        F(
          'limiter-wide-open',
          'warn',
          `${term} uses limitedLinear ${lim[1]} (limiter effectively disabled)`,
          'A limiter coefficient of 1 imposes no bound, so the high-Reynolds wall region can produce negative k/epsilon and wavy contours. This is the classic cause of "it ran but the plot looks wrong".',
          'Use limitedLinear 0.5, or switch to limitedLinearV 1 with a velocity field.',
        ),
      )
    }
    // unbounded linear advection of a transport scalar
    if (/Gauss linear;/.test(s) && /div\(phi,(k|epsilon|h|T)\)/.test(term)) {
      out.push(
        F(
          'unbounded-scalar-advection',
          'warn',
          `${term} uses unbounded Gauss linear`,
          'Transport scalars advected with plain Gauss linear overshoot near steep gradients, which for k/epsilon means negative values that then break the turbulence model.',
          'Prefer bounded Gauss linearUpwind grad(<field>) or a limited scheme.',
        ),
      )
    }
    if (/dev2\(T\(grad\(U\)\)\)/.test(term) && !/bounded/.test(s)) {
      out.push(
        F(
          'unbounded-viscous',
          'warn',
          `${term} is not bounded`,
          'The viscous term without `bounded` can overshoot on skewed cells, showing up as velocity spikes at the wall.',
          'Use bounded Gauss linear.',
        ),
      )
    }
  }
  if (!d.laplacianSchemes?.default) {
    out.push(F('no-laplacian', 'error', 'fvSchemes has no laplacianSchemes default', 'Diffusion terms cannot be assembled.', 'Add laplacianSchemes { default Gauss linear corrected; }.'))
  }
  return out
}

export function checkFvSolution(caseDir) {
  const d = readCaseDict(caseDir, CASE_FILES.solution)
  const out = []
  if (d === null) return [F('missing-file', 'error', 'system/fvSolution not found', 'The solver cannot start without linear solvers.', 'Copy one from a tutorial and adapt it.')]
  const blockMesh = readCaseDict(caseDir, CASE_FILES.blockMesh)
  const nNonOrtho = num(d.SIMPLE?.nNonOrthogonalCorrectors ?? d.PIMPLE?.nNonOrthogonalCorrectors ?? d.PISO?.nNonOrthogonalCorrectors)
  const mesh = readCaseDict(caseDir, CASE_FILES.snappyMesh)
  // non-orthogonality comes from the mesh; snappy with high castellatin, or
  // a hand-built skewed blockMesh, both raise it.
  const skewLikely = Boolean(mesh?.castellatedMesh) || (blockMesh?.blocks && Object.keys(blockMesh.blocks).length > 8)
  if (nNonOrtho === 0 && skewLikely) {
    out.push(
      F(
        'no-nonortho-correctors',
        'warn',
        'nNonOrthogonalCorrectors is 0 on a mesh that is likely non-orthogonal',
        'On skewed cells the face-interpolation correction is what keeps the diffusion term second-order; skipping it makes SIMPLE stall at a residual plateau that looks like convergence trouble but is discretisation error.',
        'Set nNonOrthogonalCorrectors 1 (2 for strongly skewed meshes).',
      ),
    )
  }
  const solvers = d.solvers && typeof d.solvers === 'object' ? d.solvers : {}
  for (const [field, s] of Object.entries(solvers)) {
    if (!s || typeof s !== 'object') continue
    const tol = num(s.tolerance)
    const relTol = num(s.relTol)
    if (Number.isFinite(tol) && tol > 1e-3) {
      out.push(
        F(
          'loose-tolerance',
          'warn',
          `solver for ${field} has tolerance ${s.tolerance}`,
          'A loose linear tolerance leaves algebraic error in every iteration, which for pressure in SIMPLE shows up as a residual that will not drop further no matter how many iterations you run.',
          'Tighten to 1e-07 (pressure) / 1e-08 (transport fields).',
        ),
      )
    }
    if (Number.isFinite(relTol) && relTol > 0.2) {
      out.push(
        F(
          'loose-reltol',
          'warn',
          `solver for ${field} has relTol ${s.relTol}`,
          'A large relative tolerance stops the linear solve early. Steady sweeps tolerate it; transient runs do not, because the error accumulates in time.',
          'Use relTol 0 (absolute) or 0.01-0.05.',
        ),
      )
    }
  }
  // PIMPLE/pimple consistency
  if (d.PIMPLE && !d.PIMPLE.nOuterCorrectors) {
    out.push(F('pimple-no-outer', 'warn', 'PIMPLE has no nOuterCorrectors', 'Defaults to 1, which makes PIMPLE behave like PISO with a large Courant limit — the run diverges instead of complaining.', 'Set nOuterCorrectors explicitly.'))
  }
  return out
}

export function checkBlockMeshDict(caseDir) {
  const d = readCaseDict(caseDir, CASE_FILES.blockMesh)
  const out = []
  if (d === null) return out // many cases use snappy or an imported mesh only
  const scale = num(d.scale)
  if (Number.isFinite(scale) && scale !== 1) {
    out.push(
      F(
        'non-unit-scale',
        'info',
        `blockMeshDict scale is ${d.scale}`,
        'Every coordinate is multiplied by it, so a scale of 0.001 means your "metres" are millimetres. If you imported geometry in another unit and forgot, velocities and areas are wrong by the square of it.',
        'Keep scale 1 and convert geometry explicitly.',
      ),
    )
  }
  const vertices = String(d.vertices ?? '')
  const vertexCount = (vertices.match(/\(/g) || []).length
  if (vertexCount > 0 && vertexCount % 8 !== 0) {
    out.push(
      F(
        'vertex-count',
        'error',
        `blockMeshDict lists ${vertexCount} vertices, not a multiple of 8`,
        'Every hex block needs exactly 8 vertices; a count that is not a multiple of 8 means a block references a vertex that does not exist and blockMesh aborts.',
        'Check the vertices list against the blocks.',
      ),
    )
  }
  const blocks = String(d.blocks ?? '')
  const hexMatches = blocks.match(/hex/g) || []
  if (hexMatches.length * 8 > vertexCount && vertexCount > 0) {
    out.push(
      F(
        'block-vertex-mismatch',
        'error',
        `${hexMatches.length} hex blocks need ${hexMatches.length * 8} vertices but only ${vertexCount} are listed`,
        'blockMesh will fail on the first block that references a missing vertex.',
        'Add the missing vertices or fix the block vertex labels.',
      ),
    )
  }
  return out
}

/** Stray time directories left by a previous run inside the case. */
export function checkStrayTimes(caseDir) {
  const stray = strayTimeDirs(caseDir)
  if (stray.length === 0) return []
  return [
    F(
      'stray-time-dirs',
      'warn',
      `case carries ${stray.length} time directories from an earlier run (${stray.slice(0, 6).join(', ')}${stray.length > 6 ? '…' : ''})`,
      'foamRun picks startFrom startTime/lt;startTime from controlDict, but a case littered with time dirs makes it easy to restart from the wrong one, and foamToVTK converts every directory it finds — turning a 30 s post-process into minutes.',
      'Keep the sweep results elsewhere (or archive them) and leave only 0/ and uniform/ in the working case.',
    ),
  ]
}

/** Boundary-condition sanity for the common fields. */
export function checkBoundaryFields(caseDir) {
  const out = []
  const zero = join(caseDir, '0')
  if (!existsSync(zero)) return out
  for (const field of fieldFiles(caseDir)) {
    const text = safeRead(join(zero, field))
    if (text === null) continue
    const d = parseDict(text)
    const bf = d.boundaryField && typeof d.boundaryField === 'object' ? d.boundaryField : {}
    const patches = Object.keys(bf)
    if (patches.length === 0) {
      out.push(F('no-boundary-field', 'error', `0/${field} declares no boundaryField`, 'The solver cannot map the initial field onto the mesh.', 'Add a boundaryField block with one entry per patch.'))
      continue
    }
    for (const patch of patches) {
      const entry = bf[patch]
      const type = entry && typeof entry === 'object' ? String(entry.type ?? '') : ''
      if (field === 'p' && /fixedValue/.test(type)) {
        // An outlet fixing pressure is the standard way to set the pressure
        // level in a duct; only a *wall* doing it is the mistake, because it
        // pins the reference where the flow cannot adjust.
        const wallish = /wall|solid|building|geometry/i.test(patch)
        if (wallish) {
          out.push(
            F(
              'p-fixed-value',
              'warn',
              `0/p sets wall patch ${patch} to fixedValue`,
              'Pressure level in an incompressible closed domain is floating; fixing it at a wall pins the reference and shifts every reported pressure by a constant.',
              'Use zeroGradient on walls and fix the level at the outlet only.',
            ),
          )
        }
      }
      if (field === 'U' && /empty/.test(type)) {
        out.push(F('u-empty-patch', 'info', `0/U has ${patch} as empty`, 'An empty patch means 2D — fine if intended, but it also means the case is not 3D and blockMesh must match.', 'No action if the case is 2D.'))
      }
    }
    // internalField must exist
    if (d.internalField === undefined) {
      out.push(F('no-internal-field', 'error', `0/${field} has no internalField`, 'The field cannot be initialised.', 'Add internalField uniform <value>;.'))
    }
  }
  return out
}

export function checkCase(caseDir) {
  return [
    ...checkControlDict(caseDir),
    ...checkFvSchemes(caseDir),
    ...checkFvSolution(caseDir),
    ...checkBlockMeshDict(caseDir),
    ...checkStrayTimes(caseDir),
    ...checkBoundaryFields(caseDir),
  ]
}

// =====================================================================
// log parsing
// =====================================================================

/**
 * checkMesh output -> the metrics that decide whether a mesh is usable.
 * OpenFOAM prints them as `Name: value` lines inside the report.
 */
export function parseCheckMesh(text) {
  const out = {}
  const grab = (label, re) => {
    const m = re.exec(text)
    if (m) out[label] = m[1]
  }
  grab('cells', /^\s*cells:\s*(\d+)/m)
  grab('faces', /^\s*faces:\s*(\d+)/m)
  grab('points', /^\s*points:\s*(\d+)/m)
  grab('boundary patches', /^\s*boundary patches:\s*(\d+)/m)
  grab('max aspect ratio', /Max aspect ratio:\s*([\d.]+)/)
  grab('max non-orthogonality', /Mesh non-orthogonality Max:\s*([\d.]+)/)
  // OpenFOAM prefixes out-of-range metrics with ***, e.g.
  //   ***Max skewness = 22.2796, 734 highly skew faces detected
  grab('max skewness', /\**\s*Max skewness\s*=\s*([\d.eE+-]+)/)
  grab('min volume', /Min volume\s*=\s*([\d.eE+-]+?)\.(?=\s)/)
  grab('max volume', /Max volume\s*=\s*([\d.eE+-]+?)\.(?=\s)/)
  const failed = /^\s*Failed \d+ mesh checks\./m.test(text) || /FAILED/.test(text)
  out.failed = failed
  const bad = []
  if (out['max aspect ratio'] && Number(out['max aspect ratio']) > 1000) bad.push(`aspect ratio ${out['max aspect ratio']} (want < 1000)`)
  if (out['max non-orthogonality'] && Number(out['max non-orthogonality']) > 70) bad.push(`non-orthogonality ${out['max non-orthogonality']}° (want < 70°)`)
  if (out['max skewness'] && Number(out['max skewness']) > 4) bad.push(`skewness ${out['max skewness']} (want < 4)`)
  // the count of offending faces, when OpenFOAM reports one
  const skewCount = /(\d+)\s+highly skew faces/.exec(text)
  if (skewCount) out.skewFaces = skewCount[1]
  out.problems = bad
  return out
}

/** A run log -> the things worth telling a human about. */
export function parseRunLog(text) {
  const out = { errors: [], warnings: [], residualFloor: null, diverged: false, finished: false, iterations: null }
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (/^--> FOAM FATAL ERROR/.test(line.trim())) out.errors.push(line.trim())
    if (/ERROR:/.test(line) && !/FOAM FATAL/.test(line)) out.errors.push(line.trim())
    if (/Foam::error::printStack/.test(line)) out.errors.push('stack trace printed (see log head)')
    if (/bounding box|negative.*determinant|face not found/.test(line)) out.diverged = true
  }
  const final = /^End\s*$/m.test(text)
  out.finished = final
  const itMatch = /Time = (\d+)/g
  let last = null
  let m
  while ((m = itMatch.exec(text))) last = m[1]
  out.iterations = last
  // residual floor: last residual line's max initial residual
  const resLines = lines.filter((l) => /Solving for \w+/.test(l))
  if (resLines.length) {
    const lastLine = resLines.at(-1)
    const rm = /Initial residual = ([\d.eE+-]+)/.exec(lastLine)
    if (rm) out.residualFloor = rm[1]
  }
  return out
}

// =====================================================================
// WSL bridge
// =====================================================================
export function winToWslPath(p) {
  const m = /^([A-Za-z]):[\\/]/.exec(p)
  if (!m) return p.replace(/\\/g, '/')
  const drive = m[1].toLowerCase()
  return `/mnt/${drive}/${p.slice(m[0].length).replace(/\\/g, '/')}`
}

export function wslToWinPath(p) {
  const m = /^\/mnt\/([a-z])\/(.*)$/.exec(p)
  if (!m) return p
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`
}

/** OpenFOAM installations under WSL, most likely first. */
export const OPENFOAM_ROOTS = ['/opt/openfoam', '/opt/openfoam11', '/usr/lib/openfoam', '/usr/local/openfoam']

export function sourceScript(root, version) {
  return version ? `source ${root}${version}/etc/bashrc` : `source ${root}/etc/bashrc`
}
