// Integration test: boot the plugin against a fake ctx and drive the tools
// against the real SWR fixtures (no WSL needed for the read-only checks).
import { apply } from '../lib/index.js'

const registry = new Map()
const fakeCtx = { tools: { register: (t) => registry.set(t.name, t) } }

const results = []
try {
  apply(fakeCtx, { distro: 'Ubuntu-24.04', timeoutMs: 5000 })
  const call = async (name, args = {}) => registry.get(name).execute(args, { signal: undefined })

  const expected = ['of_check', 'of_read_dict', 'of_list_cases', 'of_run', 'of_log', 'of_env']
  results.push([`${expected.length} tools registered`, expected.every((n) => registry.has(n))])

  const dir = new URL('../fixtures/SWR/', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')

  // 1. of_check on the real case
  const check = await call('of_check', { casePath: dir })
  results.push(['of_check returns findings + report', check.ok === true && check.findings.length > 0 && typeof check.report === 'string'])
  const rules = check.findings.map((f) => f.rule)
  results.push(['of_check finds the limiter issue', rules.includes('limiter-wide-open')])

  // 2. single-file scoping
  const schemes = await call('of_check', { casePath: dir, file: 'fvSchemes' })
  results.push(['of_check file=fvSchemes is scoped', schemes.ok === true && schemes.findings.every((f) => f.rule !== 'no-purge')])

  // 3. of_read_dict
  const dict = await call('of_read_dict', { casePath: dir, file: 'controlDict' })
  results.push(['of_read_dict parses controlDict', dict.ok === true && dict.dict.application === 'foamRun' && dict.dict.endTime === '3000'])
  const u = await call('of_read_dict', { casePath: dir, file: '0/U' })
  results.push(['of_read_dict reads 0/U boundaries', u.ok === true && Array.isArray(Object.keys(u.dict.boundaryField)) && Object.keys(u.dict.boundaryField).includes('inlet')])

  // 4. of_list_cases on the fixtures root
  const list = await call('of_list_cases', { root: new URL('../fixtures/', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:') })
  results.push(['of_list_cases finds the fixture case', list.ok === true && list.cases.some((c) => c.name === 'SWR')])
  const swr = list.cases.find((c) => c.name === 'SWR')
  results.push(['case summary is correct', swr && swr.solver === 'foamRun' && swr.fields.includes('U') && swr.steady === true])

  // 5. of_log on the real run log
  const log = await call('of_log', { path: dir + 'log.foamRun' })
  results.push(['of_log parses the run log', log.ok === true && log.kind === 'run' && log.summary.finished === true])

  // 6. of_run refuses an unknown command without touching WSL
  const bad = await call('of_run', { casePath: dir, command: 'rm -rf /' })
  results.push(['of_run has an allow-list', bad.ok === false && /allow-list/.test(bad.error)])

  // 7. missing directory is an honest error
  const missing = await call('of_check', { casePath: 'Z:\\nope\\nothing' })
  results.push(['missing dir is an error', missing.ok === false])
} catch (error) {
  console.error('UNEXPECTED THROW:', error)
  results.push(['no-throw', false])
}

let pass = 0
for (const [name, ok] of results) {
  console.log(`${ok ? '✔' : '✖'} ${name}`)
  if (ok) pass += 1
}
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
