import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Verification only: no listener, renderer, API key, cloud call, migration or ledger reset. */
const ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')
const HANDOFF = '/home/ubuntu/Documents/fury-p04-handoff'
const NODE = '/home/ubuntu/.nvm/versions/node/v24.22.0/bin/node'
const mode = process.argv[2]
if (
  ROOT !== '/home/ubuntu/Documents/fury-p04' ||
  process.execPath !== NODE ||
  process.version !== 'v24.22.0' ||
  !['focused', 'checks', 'full', 'audit'].includes(mode ?? '') ||
  process.argv.length !== 3
)
  throw new Error(
    'Use Node v24.22.0 scripts/p04-verify.ts focused|checks|full|audit in the isolated P04 lane.',
  )
if (!statSync(HANDOFF).isDirectory()) throw new Error('Expected pre-existing lane handoff.')
const output = mkdtempSync(join(HANDOFF, `integration-${mode}-`))
const tmp = join(output, 'tmp')
mkdirSync(tmp)
// Explicit environment allowlist: real session/cloud credentials are never inherited by test/build subprocesses.
const env = {
  PATH: `${dirname(NODE)}:/usr/bin:/bin`,
  HOME: output,
  TMPDIR: tmp,
  TEMP: tmp,
  TMP: tmp,
  NODE_ENV: 'test',
  NO_COLOR: '1',
}
type Result = {
  name: string
  command: string[]
  status: number | null
  signal: string | null
  durationMs: number
  log: string
}
const results: Result[] = []
async function run(name: string, args: string[], extraEnv: Record<string, string> = {}) {
  const log = join(output, `${name}.log`),
    fd = openSync(log, 'wx', 0o600),
    start = Date.now()
  const command = [NODE, ...args]
  writeFileSync(fd, `$ ${command.map((part) => JSON.stringify(part)).join(' ')}\n`)
  const result = await new Promise<Result>((resolve, reject) => {
    const child = spawn(NODE, args, {
      cwd: ROOT,
      env: { ...env, ...extraEnv },
      stdio: ['ignore', fd, fd],
    })
    child.once('error', reject)
    child.once('exit', (status, signal) =>
      resolve({ name, command, status, signal, durationMs: Date.now() - start, log }),
    )
  }).finally(() => closeSync(fd))
  results.push(result)
  console.log(JSON.stringify(result))
  writeFileSync(
    join(output, 'checks.json'),
    JSON.stringify(
      {
        node: process.version,
        root: ROOT,
        simulationOnly: true,
        environment: 'explicit allowlist; no inherited secrets',
        results,
      },
      null,
      2,
    ),
  )
}

if (mode === 'focused' || mode === 'full') {
  const options = {
    root: ROOT,
    config: false,
    watch: false,
    cache: false,
    maxWorkers: 1,
    reporters: ['default', 'json'],
    outputFile: { json: join(output, 'vitest.json') },
    ...(mode === 'focused' ? { include: ['src/image-service/control-plane/*.test.ts'] } : {}),
  }
  // No config bundling/shared .vite-temp, listeners, render plugins or source watchers.
  // The full suite needs the REAL read-only virtual manifest resolver from the app config.
  // Calling config with command:'build' excludes all DEV service imports. Retain only its
  // config/resolve/load hooks, not configureServer; do not replace it with a passing stub.
  const manifestPlugin =
    mode === 'full'
      ? `const { default: config } = await import('./vite.config.ts'); const settings = await config({ command: 'build', mode: 'production', isPreview: false }); const candidates = settings.plugins.flat(Infinity).filter(p => p?.name === 'fury-baked-stills'); if (candidates.length !== 1) throw new Error('Expected real virtual stills resolver'); const source = candidates[0]; const plugins = [{ name: source.name, config: source.config, resolveId: source.resolveId, load: source.load }];`
      : 'const plugins = [];'
  const code = `import { startVitest } from 'vitest/node'; ${manifestPlugin} const ctx = await startVitest('test', [], ${JSON.stringify(options)}, { cacheDir: ${JSON.stringify(join(output, 'vite-cache'))}, plugins, esbuild: { jsx: 'automatic' }, define: { __RENDER_VERSION__: JSON.stringify('test') } }); if (!ctx) process.exitCode = 1; else { if (ctx.state.getUnhandledErrors().length || ctx.state.getFiles().some(f => f.result?.state === 'fail')) process.exitCode = 1; await ctx.close(); }`
  await run('vitest', ['--input-type=module', '-e', code], { VITEST: 'true' })
}
if (mode === 'checks') {
  await run('typecheck', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'])
  await run('eslint', ['node_modules/eslint/bin/eslint.js', '.'])
  await run('prettier', ['node_modules/prettier/bin/prettier.cjs', '--check', '.'])
  const buildCode = `import { build } from 'vite'; const { default: config } = await import('./vite.config.ts'); const settings = await config({ command: 'build', mode: 'production', isPreview: false }); await build({ ...settings, root: ${JSON.stringify(ROOT)}, configFile: false, envFile: false, cacheDir: ${JSON.stringify(join(output, 'build-cache'))}, build: { ...settings.build, outDir: ${JSON.stringify(join(output, 'dist'))} }, plugins: [...settings.plugins, { name: 'p04-control-boundary', generateBundle(_options, bundle) { for (const value of Object.values(bundle)) if (value.type === 'chunk' && Object.keys(value.modules).some(id => id.includes('/image-service/control-plane/'))) throw new Error('Private control plane in public build'); } }] });`
  await run('build', ['--experimental-strip-types', '--input-type=module', '-e', buildCode], {
    NODE_ENV: 'production',
  })
}
if (mode === 'audit') {
  const baseline = JSON.parse(
    readFileSync(join(HANDOFF, 'prior-source-manifest.json'), 'utf8'),
  ) as Record<string, string>
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
  const compare = (root: string) =>
    Object.entries(baseline).flatMap(([file, digest]) =>
      !existsSync(join(root, file)) || hash(join(root, file)) !== digest ? [file] : [],
    )
  const existingChanges = compare(ROOT)
  const protectedP03Changes = compare('/home/ubuntu/Documents/fury-p03')
  const additions: string[] = []
  const visit = (path: string) => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist'].includes(item.name)) continue
      const full = join(path, item.name)
      if (item.isDirectory()) visit(full)
      else if (item.isFile() && !Object.hasOwn(baseline, relative(ROOT, full)))
        additions.push(relative(ROOT, full))
    }
  }
  visit(ROOT)
  const unauthorizedChanges = existingChanges.filter((name) => name !== 'README.md')
  const unauthorizedAdditions = additions.filter(
    (name) =>
      !name.startsWith('src/image-service/control-plane/') &&
      ![
        'docs/p04-contract.md',
        'docs/p04-provider-decision.md',
        'docs/p04-safe-image-service.md',
        'docs/p04-independent-review.md',
        'scripts/p04-watchdog.ts',
        'scripts/p04-verify.ts',
      ].includes(name),
  )
  const audit = {
    baselineFiles: Object.keys(baseline).length,
    existingChanges,
    additions: additions.sort(),
    protectedP03Changes,
    unauthorizedChanges,
    unauthorizedAdditions,
    scope:
      'P03 452-file source manifest; full protected handoff/capture history remains parent audit responsibility',
  }
  writeFileSync(join(output, 'source-audit.json'), JSON.stringify(audit, null, 2))
  console.log(JSON.stringify(audit))
  if (protectedP03Changes.length || unauthorizedChanges.length || unauthorizedAdditions.length)
    process.exitCode = 1
}
console.log(`Evidence: ${output}`)
if (results.some((result) => result.status !== 0)) process.exitCode = 1
