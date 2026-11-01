/**
 * Bare-specifier bridge for the acceptance tests.
 *
 * The plugin imports Harness packages (`@deepseek-ai/dsh-llm`, and so on) that
 * are carried by the dsh installation; when dsh boots a profile it installs
 * exactly this resolution. A plain `node --test` run has no such anchor, so
 * this preload registers one: every `@deepseek-ai/*` bare specifier resolves
 * from the installation's own node_modules, through the package's own exports
 * map (the ESM `import` condition first).
 *
 * Usage: `node --import ./test/dsh-resolve.js --test test/acceptance.js`
 * Override the installation with DSH_INSTALL when dsh lives elsewhere.
 */
import { createRequire, registerHooks } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Anchors derived from the running node binary itself. A tar-installed node keeps
 * its global modules under its own prefix (`<prefix>/lib/node_modules`), which is
 * *not* `/usr/local/lib/node_modules` — that is exactly the case on the migrated
 * server, where dsh lives in `/usr/local/lib/nodejs/node-v24.22.1-linux-x64/lib`.
 */
function nodePrefixCandidates() {
	let real = process.execPath
	try {
		real = realpathSync(real)
	} catch {
		// 保持原样：路径解析不了就按 execPath 猜。
	}
	const bin = dirname(real)
	const out = []
	for (const root of [dirname(bin), bin, process.env.npm_config_prefix]) {
		if (typeof root !== 'string' || root === '') continue
		out.push(join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
		out.push(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
	}
	return out
}

/**
 * Installation anchors, tried in order. dsh is installed globally and the prefix
 * differs per platform and per machine, so this file must not hardcode one: it
 * runs both on the Windows dev box and on the Linux server.
 */
const ANCHOR_CANDIDATES = [
	process.env.DSH_INSTALL,
	...nodePrefixCandidates(),
	'/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
	'/usr/lib/node_modules/@deepseek-ai/dsh/package.json',
	'C:/Users/lenovo/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json',
].filter((candidate) => typeof candidate === 'string' && candidate !== '')
const anchor = ANCHOR_CANDIDATES.find((candidate) => existsSync(candidate))
if (anchor === undefined) {
	throw new Error(`dsh-resolve: no dsh installation found; tried ${ANCHOR_CANDIDATES.join(', ')}. Set DSH_INSTALL to the path of @deepseek-ai/dsh/package.json`)
}
const installRoot = join(anchor, '..')
const require = createRequire(anchor)
const cache = new Map()

function entryOf(directory, subpath) {
	const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
	let target = manifest.exports?.[subpath === undefined ? '.' : `./${subpath}`]
	if (target !== undefined && typeof target === 'object' && target !== null) {
		target = target.import ?? target.module ?? target.default ?? target.require
	}
	if (typeof target !== 'string') target = subpath === undefined ? (manifest.module ?? manifest.main ?? 'index.js') : subpath
	return join(directory, target)
}

function resolveHarnessPackage(specifier) {
	if (cache.has(specifier)) return cache.get(specifier)
	const [scope, name, ...rest] = specifier.split('/')
	let url
	try {
		url = pathToFileURL(require.resolve(specifier)).href
	} catch {
		const directory = join(installRoot, 'node_modules', scope, name)
		url = pathToFileURL(entryOf(directory, rest.length === 0 ? undefined : rest.join('/'))).href
	}
	cache.set(specifier, url)
	return url
}

registerHooks({
	resolve(specifier, context, next) {
		if (specifier.startsWith('@deepseek-ai/')) {
			try {
				return { url: resolveHarnessPackage(specifier), shortCircuit: true }
			} catch {
				// Fall through: a package missing from the installation keeps normal resolution.
			}
		}
		return next(specifier, context)
	},
})

void dirname
