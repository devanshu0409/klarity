/**
 * Packages Klarity into a runnable Windows folder without electron-builder.
 *
 * Why this exists: electron-builder fetches its Windows vendor tools (winCodeSign
 * and friends) from GitHub even for `--dir`, and this network's TLS interception
 * breaks that with `unable to get local issuer certificate` — see PLAN.md §10a.
 * The Electron runtime itself is already in the local @electron/get cache, so a
 * plain unzip-and-copy produces what electron-builder's `--dir` would: an
 * unsigned, unpacked app.
 *
 * Real installers (NSIS, signing, auto-update) stay a CI job on a network that
 * can reach GitHub. This is the "run it on my own laptop" path.
 *
 * Usage: npm run pack:local
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const PRODUCT = 'Klarity'
const ARCH = 'win32-x64'
const ELECTRON_VERSION = pkg.devDependencies.electron.replace(/^[^\d]*/, '')
const outDir = join(root, 'dist', `${PRODUCT}-${ARCH}`)

const step = (message) => console.log(`\n▸ ${message}`)

/** @electron/get keys its cache by a hash directory, so search for the zip. */
function findCachedElectron() {
  const cacheRoot = join(
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    'electron',
    'Cache'
  )
  const zipName = `electron-v${ELECTRON_VERSION}-${ARCH}.zip`
  if (!existsSync(cacheRoot)) return null

  for (const entry of readdirSync(cacheRoot)) {
    const candidate = join(cacheRoot, entry, zipName)
    if (existsSync(candidate)) return candidate
  }
  return null
}

const zip = findCachedElectron()
if (!zip) {
  console.error(
    `\nNo cached Electron v${ELECTRON_VERSION} for ${ARCH}.\n` +
      'Run `npm run dev` once on a network that can download it, or drop the zip\n' +
      'into %LOCALAPPDATA%\\electron\\Cache\\<hash>\\, then re-run this script.'
  )
  process.exit(1)
}
console.log(`Electron runtime: ${zip}`)

step('Building main, preload and renderer')
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true })

step(`Unpacking Electron ${ELECTRON_VERSION}`)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${outDir}" -Force`
  ],
  { stdio: 'inherit' }
)

// Electron loads `resources/app` when there is no asar. Leaving it unpacked
// means a fix can be dropped in without repackaging.
step('Copying app files')
const appDir = join(outDir, 'resources', 'app')
mkdirSync(appDir, { recursive: true })
cpSync(join(root, 'out'), join(appDir, 'out'), { recursive: true })
cpSync(join(root, 'resources'), join(appDir, 'resources'), { recursive: true })
// The window icon is read from build/ at runtime: nothing embeds it in the exe
// here, because that is rcedit's job and rcedit is part of the vendor download.
cpSync(join(root, 'build'), join(appDir, 'build'), { recursive: true })

// A trimmed manifest: the packaged app never runs a script, and the dev deps
// would only mislead anyone reading it.
writeFileSync(
  join(appDir, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      productName: PRODUCT,
      version: pkg.version,
      description: pkg.description,
      main: pkg.main,
      author: pkg.author,
      license: pkg.license,
      type: pkg.type,
      dependencies: pkg.dependencies
    },
    null,
    2
  ) + '\n'
)

// Renderer dependencies are already bundled by Vite; main and preload are
// externalized, so their runtime tree has to ship. `npm ls` resolves the real
// deduped layout, including transitive packages hoisted to the root.
step('Copying production dependencies')
const listed = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
  cwd: root,
  encoding: 'utf8',
  shell: true,
  maxBuffer: 64 * 1024 * 1024
})

const packages = listed
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.includes(`${'node_modules'}`))

let copied = 0
for (const source of packages) {
  const target = join(appDir, relative(root, source))
  if (existsSync(target)) continue
  cpSync(source, target, {
    recursive: true,
    // Skip what bloats a package folder without ever being loaded.
    filter: (src) => !/[\\/](test|tests|docs|examples?|\.github|\.bin)[\\/]/i.test(src)
  })
  copied += 1
}
console.log(`  ${copied} packages`)

// Only a rename: setting the exe icon needs rcedit, which comes from the vendor
// download this script exists to avoid. The window and taskbar icons are set by
// the app at runtime, so the default Electron icon shows only on the .exe file
// itself in Explorer.
step('Renaming electron.exe')
renameSync(join(outDir, 'electron.exe'), join(outDir, `${PRODUCT}.exe`))

console.log(`\n✓ Packaged: ${join(outDir, `${PRODUCT}.exe`)}\n`)
