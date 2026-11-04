import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  num,
  parseCheckMesh,
  parseDict,
  parseRunLog,
  strayTimeDirs,
  fieldFiles,
  winToWslPath,
  wslToWinPath,
} from '../lib/engine.js'

// The OpenFOAM banner with escaped backslashes — a naive comment stripper
// destroys it and then mis-parses everything after.
const BANNER = `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
\\*---------------------------------------------------------------------------*/
`

test('parseDict reads the banner case and flat entries', () => {
  const d = parseDict(
    BANNER +
      `FoamFile
{
    format      ascii;
    class       dictionary;
    object      controlDict;
}

application     foamRun;
endTime         3000;
deltaT          1;
purgeWrite      0;
runTimeModifiable true;
`,
  )
  assert.equal(d.application, 'foamRun')
  assert.equal(d.endTime, '3000')
  assert.equal(d.deltaT, '1')
  assert.equal(d.purgeWrite, '0')
  assert.equal(d.runTimeModifiable, 'true')
  // the header block must not leak its keys into the root
  assert.equal(d.format, undefined)
})

test('parseDict handles nested sub-dicts and lists', () => {
  const d = parseDict(
    `solvers
{
    p
    {
        solver          GAMG;
        tolerance       1e-07;
        relTol          0.05;
    }
    "(U|k|epsilon)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
    }
}

divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div(phi,k)      bounded Gauss limitedLinear 1;
}
`,
  )
  assert.equal(d.solvers.p.solver, 'GAMG')
  assert.equal(d.solvers.p.tolerance, '1e-07')
  // a quoted key is a literal key, quotes stripped
  assert.ok(d.solvers['(U|k|epsilon)'], 'quoted key must survive')
  assert.equal(d.solvers['(U|k|epsilon)'].smoother, 'symGaussSeidel')
  assert.equal(d.divSchemes['div(phi,U)'], 'bounded Gauss linearUpwind grad(U)')
  assert.equal(d.divSchemes['div(phi,k)'], 'bounded Gauss limitedLinear 1')
})

test('parseDict handles paren lists and // comments', () => {
  const d = parseDict(
    `// a leading comment
functions
{
    probes
    {
        type            probes;
        fields          (U);              // trailing comment
        probeLocations
        (
            (1 0.5 0)
            (3 0.5 0)
        );
    }
}
`,
  )
  const p = d.functions.probes
  assert.equal(p.type, 'probes')
  assert.equal(p.fields, '(U)')
  assert.ok(String(p.probeLocations).includes('(1 0.5 0)'))
  assert.ok(String(p.probeLocations).includes('(3 0.5 0)'))
})

test('parseDict terminates on the inputs that used to hang it', () => {
  // Each of these blocked the event loop forever, so no timeout could fire.
  // A regression here freezes the whole host, not just this tool.
  const started = Date.now()
  assert.equal(parseDict('deltaT          ${dt};').deltaT, '${dt}')
  assert.deepEqual(parseDict('foo\n}'), { foo: '' })
  // #include as the last entry of a sub-dict must not eat the next key
  const inc = parseDict(
    `boundaryField
{
    movingWall
    {
        type            movingWallVelocity;
        value           uniform (0 0 0);
    }
    #includeEtc "caseDicts/setConstraintTypes"
    outlet
    {
        type            zeroGradient;
    }
}
`,
  )
  assert.ok(inc.boundaryField.outlet, 'the entry after #include was swallowed')
  assert.equal(inc.boundaryField.outlet.type, 'zeroGradient')
  // $NAME and ${NAME} are single tokens, not a stall
  const vars = parseDict('x $FOAM_CASE;\ny ${internalField};\n')
  assert.equal(vars.x, '$FOAM_CASE')
  assert.equal(vars.y, '${internalField}')
  assert.ok(Date.now() - started < 2_000, 'parseDict is still slow enough to hang the host')
})

test('num parses OF numeric tokens', () => {
  assert.equal(num('3000'), 3000)
  assert.equal(num('1e-07'), 1e-7)
  assert.equal(num('0.05'), 0.05)
  assert.equal(num('-2'), -2)
  assert.ok(Number.isNaN(num('steadyState')))
  assert.ok(Number.isNaN(num(undefined)))
})

test('parseCheckMesh extracts the metrics that matter', () => {
  const text = `
Mesh stats
    cells:            124800
    faces:            378912
    points:           131712
    boundary patches: 6

Check topology
    Max aspect ratio = 4.3
    Mesh non-orthogonality Max: 63.2
    Max skewness = 1.84
`
  const m = parseCheckMesh(text)
  assert.equal(m.cells, '124800')
  assert.equal(m['max aspect ratio'], '4.3')
  assert.equal(m['max non-orthogonality'], '63.2')
  assert.equal(m.failed, false)
  assert.deepEqual(m.problems, [])
})

test('parseCheckMesh flags a failed mesh', () => {
  const m = parseCheckMesh('Max aspect ratio: 2400\nMesh non-orthogonality Max: 82\nFailed 2 mesh checks.\n')
  assert.equal(m.failed, true)
  assert.equal(m.problems.length, 2)
})

test('parseRunLog reports finish, iterations and residual floor', () => {
  const text = `Starting time loop
smoothSolver:  Solving for Ux, Initial residual = 0.01, Final residual = 0.001, No Iterations 2
Time = 635
smoothSolver:  Solving for k, Initial residual = 5.92713e-05, Final residual = 1.3681e-06, No Iterations 4
ExecutionTime = 635.237 s  ClockTime = 635 s

End
`
  const r = parseRunLog(text)
  assert.equal(r.finished, true)
  assert.equal(r.iterations, '635')
  assert.equal(r.residualFloor, '5.92713e-05')
  assert.deepEqual(r.errors, [])
})

test('parseRunLog catches a fatal error', () => {
  const r = parseRunLog('--> FOAM FATAL ERROR:\nCannot find file "U"\n')
  assert.equal(r.finished, false)
  assert.ok(r.errors.length > 0)
})

test('strayTimeDirs ignores 0 and uniform', () => {
  // fixtures/SWR carries 0/ but no stray dirs, so it should be empty
  const dir = fileURLToPath(new URL('../fixtures/SWR/', import.meta.url))
  const stray = strayTimeDirs(dir)
  assert.ok(Array.isArray(stray))
  assert.ok(!stray.includes('0'))
})

test('fieldFiles lists the scalar/vector fields in 0/', () => {
  const dir = fileURLToPath(new URL('../fixtures/SWR/', import.meta.url))
  const fields = fieldFiles(dir)
  assert.ok(fields.includes('U'))
  assert.ok(fields.includes('k'))
  assert.ok(fields.includes('epsilon'))
  assert.ok(fields.includes('p'))
})

test('path conversion round-trips', () => {
  assert.equal(winToWslPath('E:\\dsh-openfoam-doctor'), '/mnt/e/dsh-openfoam-doctor')
  assert.equal(winToWslPath('C:/Users/1'), '/mnt/c/Users/1')
  assert.equal(wslToWinPath('/mnt/e/dsh-openfoam-doctor'), 'E:\\dsh-openfoam-doctor')
  assert.equal(wslToWinPath('/home/user'), '/home/user')
})

test('the real SWR fixtures parse and yield the expected findings', async () => {
  const { checkCase } = await import('../lib/engine.js')
  const dir = fileURLToPath(new URL('../fixtures/SWR/', import.meta.url))
  const findings = checkCase(dir)
  const rules = findings.map((f) => f.rule)
  // the limiter finding is the whole point of the plugin
  assert.ok(rules.includes('limiter-wide-open'), `expected limiter-wide-open, got ${rules.join(',')}`)
  // unbounded-viscous is advice, not a defect: every stock OF11 tutorial uses
  // the unbounded form, so it must stay at info and must not inflate the
  // warning count on a reference case.
  const viscous = findings.find((f) => f.rule === 'unbounded-viscous')
  assert.ok(viscous, 'expected the unbounded-viscous note')
  assert.equal(viscous.severity, 'info')
  assert.ok(rules.includes('no-purge'))
  // and it must NOT cry wolf on a standard outlet fixedValue
  assert.ok(!rules.includes('p-fixed-value'), 'outlet fixedValue is legitimate')
})

test('the real checkMesh log is parsed into the metrics that matter', () => {
  // captured from `checkMesh` on the SWR case inside WSL (OpenFOAM 11)
  const text = readFileSync(new URL('../fixtures/log.checkMesh.sample', import.meta.url), 'utf8')
  const m = parseCheckMesh(text)
  assert.equal(m.cells, '82238')
  assert.equal(m['boundary patches'], '6')
  assert.equal(m['max non-orthogonality'], '69.9787')
  assert.equal(m['max skewness'], '22.2796')
  assert.equal(m.skewFaces, '734')
  assert.equal(m.failed, true)
  assert.deepEqual(m.problems, ['skewness 22.2796 (want < 4)'])
  // volumes must not carry the trailing period of "Min volume = 1.4e-07. Max volume"
  assert.equal(num(m['min volume']), 1.3951e-7)
  assert.equal(num(m['max volume']), 0.00223393)
})
