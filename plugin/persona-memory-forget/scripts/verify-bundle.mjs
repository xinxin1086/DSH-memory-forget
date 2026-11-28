/**
 * Mountability check: a downloaded copy must install without a build step and
 * without any third-party package. Fails loudly on the two things that break a
 * fresh machine: a missing manifest field, and an import the Host cannot resolve.
 *
 * Usage: node plugin/persona-memory-forget/scripts/verify-bundle.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []
const notes = []

const fail = (message) => problems.push(message)
const ok = (message) => notes.push(message)

// 1. Manifest
const manifestPath = join(root, 'package.json')
if (!existsSync(manifestPath)) fail('package.json is missing')
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
if (!manifest.name) fail('package.json has no name')
if (!manifest.version) fail('package.json has no version')
if (manifest.type !== 'module') fail('package.json type must be "module"')
const entry = manifest.exports?.['.']
if (typeof entry !== 'string' || !existsSync(join(root, entry))) fail('exports["."] must point at an existing file')
if (!manifest.dsh?.bundle?.patch) fail('dsh.bundle.patch is missing')
else if (!existsSync(join(root, manifest.dsh.bundle.patch))) fail('dsh.bundle.patch points at a missing file')
if (!manifest.dependencies || Object.keys(manifest.dependencies).length === 0) ok('no dependencies')
else fail(`unexpected dependencies: ${Object.keys(manifest.dependencies).join(', ')}`)

// 2. Patch row
const patchPath = join(root, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8')
  if (!/^\s*-\s*insert:/m.test(patch)) fail('cordis.patch.yml has no insert row')
  if (!patch.includes(manifest.name)) fail(`cordis.patch.yml does not name ${manifest.name}`)
  if (!/^\s*- id:/m.test(patch)) fail('cordis.patch.yml insert row has no id')
}

// 3. Runtime imports must resolve on a fresh machine
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name)
  return statSync(full).isDirectory() ? walk(full) : [full]
})
const sources = walk(root).filter((file) => /\.(js|mjs)$/.test(file))
const allowed = (specifier) => specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../')
for (const file of sources) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/^import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
    if (!allowed(match[1])) fail(`${relative(root, file)} imports ${match[1]} (bundle must stay dependency-free)`)
  }
  for (const match of text.matchAll(/^import\s+['"]([^'"]+)['"]/gm)) {
    if (!allowed(match[1])) fail(`${relative(root, file)} imports ${match[1]}`)
  }
}

// 4. Entry exports apply()
const entryPath = join(root, typeof entry === 'string' ? entry : 'index.js')
if (existsSync(entryPath)) {
  const text = readFileSync(entryPath, 'utf8')
  if (!/export\s+(async\s+)?function\s+apply\b/.test(text)) fail('index.js does not export apply(ctx, config)')
  if (!/export\s+const\s+inject\s*=/.test(text)) notes.push('index.js declares inject by a non-literal form; check manually')
  else ok('index.js exports apply() and inject')
}

ok(`scanned ${sources.length} source files`)
if (problems.length > 0) {
  console.error(`FAIL (${problems.length})`)
  for (const problem of problems) console.error(`- ${problem}`)
  process.exitCode = 1
} else {
  console.log(`OK: ${manifest.name}@${manifest.version} can be installed from this directory`)
  for (const note of notes) console.log(`- ${note}`)
}

