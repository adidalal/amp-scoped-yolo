// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now
/**
 * scoped-yolo — minimal permissions plugin for Amp.
 *
 * Policies:
 *   1. Always rewrite `rm` / `rmdir` to `trash` so deletions are reversible.
 *   2. If a deletion targets a path outside the workspace, ask the user once
 *      per folder (per thread). Subsequent deletions inside an approved folder
 *      proceed silently.
 */

import type { PluginAPI, ToolCallResult } from '@ampcode/plugin'
import { lstat, realpath } from 'node:fs/promises'
import * as path from 'node:path'

export default function scopedYolo(amp: PluginAPI) {
	// Per-thread set of folders the user has approved for outside-workspace deletes.
	const approvedFolders = new Map<string, Set<string>>()

	let workspaceRootPromise: Promise<string> | null = null
	const getWorkspaceRoot = (): Promise<string> => {
		if (!workspaceRootPromise) {
			workspaceRootPromise = amp.$`pwd`
				.then((result) => result.stdout.toString().trim())
				.catch((err) => {
					// Don't cache a failed lookup forever — let the next call retry.
					workspaceRootPromise = null
					throw err
				})
		}
		return workspaceRootPromise
	}

	// Rewritten commands we want to follow up on in tool.result, so we can give
	// the user a clearer message if `trash` is missing or fails for some reason.
	const rewrittenCalls = new Map<string, { original: string; rewritten: string }>()

	amp.on('session.start', () => {
		amp.logger.log('scoped-yolo loaded — rm→trash + ask-before-outside-delete')
	})

	/**
	 * Ask the user once per outside-workspace folder before allowing a delete
	 * that targets it. Returns a reject result, or undefined to proceed.
	 */
	const requireApprovalForOutsidePaths = async (
		event: { thread: { id: string }; input: unknown },
		ctx: { ui: { confirm: (o: any) => Promise<boolean> } },
		paths: string[],
		cmdCwd: string,
		root: string,
		canonicalRoot: string,
	): Promise<ToolCallResult | undefined> => {
		const approvalScopes = new Set<string>()
		for (const p of paths) {
			const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cmdCwd, p)
			const canonicalAbs = await canonicalize(abs)
			if (!isStrictlyInsideWorkspace(canonicalAbs, canonicalRoot)) {
				approvalScopes.add(await getApprovalScope(canonicalAbs))
			}
		}
		if (approvalScopes.size === 0) return undefined

		const approved = approvedFolders.get(event.thread.id) ?? new Set<string>()
		for (const folder of approvalScopes) {
			if (isAlreadyApproved(folder, approved)) continue

			let confirmed: boolean
			try {
				confirmed = await ctx.ui.confirm({
					title: 'Delete outside workspace?',
					message:
						`scoped-yolo: a delete is targeting \`${folder}\`, which is outside the workspace (${root}).\n\n` +
						`Allow deletes anywhere inside \`${folder}\` for the rest of this thread?`,
					confirmButtonText: 'Allow folder',
				})
			} catch (err) {
				if (err instanceof Error && amp.helpers.isPluginUINotAvailableError(err)) {
					return {
						action: 'reject-and-continue',
						message:
							`scoped-yolo blocked a delete in ${folder} (outside workspace ${root}). ` +
							`No interactive UI is available to ask the user for approval.`,
					}
				}
				throw err
			}

			if (!confirmed) {
				return {
					action: 'reject-and-continue',
					message: `scoped-yolo: user denied deletion in ${folder} (outside workspace ${root}).`,
				}
			}
			approved.add(folder)
		}
		approvedFolders.set(event.thread.id, approved)
		return undefined
	}

	amp.on('tool.call', async (event, ctx): Promise<ToolCallResult> => {
		const root = await getWorkspaceRoot()
		const canonicalRoot = await canonicalize(root)

		// Use the helpers API to recognize any shell-command tool call (Bash,
		// shell_command, etc.) instead of branching on a hard-coded tool name.
		const shell = amp.helpers.shellCommandFromToolCall(event)
		if (shell) {
			const originalCmd = shell.command
			const parsed = parseDeletes(originalCmd)
			if (!parsed.hasDelete) return { action: 'allow' }

			const cmdCwd = shell.dir
				? path.isAbsolute(shell.dir)
					? shell.dir
					: path.resolve(root, shell.dir)
				: root

			const reject = await requireApprovalForOutsidePaths(
				event,
				ctx,
				parsed.paths,
				cmdCwd,
				root,
				canonicalRoot,
			)
			if (reject) return reject

			// Rewrite rm/rmdir → trash. Inside-workspace deletes never prompt;
			// outside-workspace deletes only get here after approval above.
			const rewritten = rewriteRmToTrash(originalCmd)
			if (rewritten === originalCmd) return { action: 'allow' }

			// Find the input key whose value is the original command and replace
			// it. This works for both Bash (`cmd`) and shell_command (`command`)
			// without hard-coding either name.
			const newInput: Record<string, unknown> = { ...(event.input as Record<string, unknown>) }
			let replaced = false
			for (const [k, v] of Object.entries(newInput)) {
				if (typeof v === 'string' && v === originalCmd) {
					newInput[k] = rewritten
					replaced = true
				}
			}
			if (!replaced) return { action: 'allow' }

			rewrittenCalls.set(event.toolUseID, { original: originalCmd, rewritten })
			ctx.logger.log(`scoped-yolo rewrote: ${originalCmd}  →  ${rewritten}`)
			return { action: 'modify', input: newInput }
		}

		// Non-shell tool calls: detect file-tool deletes (e.g. apply_patch
		// removing a file). We can't rewrite these to `trash`, but we can at
		// least apply the same outside-workspace approval check and log the
		// deletion so it's visible.
		const fileDeletes = parseFileToolDeletes(event.tool, event.input)
		if (fileDeletes.length === 0) return { action: 'allow' }

		const reject = await requireApprovalForOutsidePaths(
			event,
			ctx,
			fileDeletes,
			root,
			root,
			canonicalRoot,
		)
		if (reject) return reject

		ctx.logger.log(
			`scoped-yolo: ${event.tool} will delete ${fileDeletes.length} file(s): ${fileDeletes.join(', ')}` +
				` (file-tool deletes are not reversible via 'trash')`,
		)
		return { action: 'allow' }
	})

	amp.on('tool.result', (event) => {
		const tracked = rewrittenCalls.get(event.toolUseID)
		if (!tracked) return
		rewrittenCalls.delete(event.toolUseID)
		if (event.status !== 'error') return
		amp.logger.log(
			`scoped-yolo: rewritten command failed (${tracked.rewritten}). ` +
				`If 'trash' is not installed, install it (e.g. \`brew install trash\`). ` +
				`Original command: ${tracked.original}` +
				(event.error ? `\nError: ${event.error}` : ''),
		)
	})

	amp.registerCommand(
		'show-approvals',
		{
			title: 'Show approved delete folders',
			description: 'List folders this thread has approved for outside-workspace deletes.',
		},
		async (ctx) => {
			const id = ctx.thread?.id
			const approved = id ? approvedFolders.get(id) : undefined
			const list = approved && approved.size > 0 ? [...approved].sort().join('\n') : '(none)'
			await ctx.ui.notify(`scoped-yolo approved folders for this thread:\n${list}`)
		},
	)

	amp.registerCommand(
		'clear-approvals',
		{
			title: 'Clear approved delete folders',
			description: 'Forget approved outside-workspace folders for this thread.',
		},
		async (ctx) => {
			if (ctx.thread) approvedFolders.delete(ctx.thread.id)
			await ctx.ui.notify('scoped-yolo: cleared approved folders for this thread.')
		},
	)
}

// ---------- helpers ----------

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n'])

/**
 * Returns true only when `absPath` is a path strictly under `root`. The
 * workspace root itself is intentionally treated as outside, so e.g.
 * `rm -rf .` from the workspace requires explicit approval.
 */
function isStrictlyInsideWorkspace(absPath: string, root: string): boolean {
	const normRoot = path.normalize(root)
	const rel = path.relative(normRoot, absPath)
	if (rel === '' || rel === '.') return false
	return !rel.startsWith('..') && !path.isAbsolute(rel)
}

async function canonicalize(abs: string): Promise<string> {
	try {
		return await realpath(abs)
	} catch {
		// Path doesn't exist (e.g. glob, already-deleted, typo) — fall back.
		return abs
	}
}

/**
 * Approval scope for an outside-workspace target. Approving the directory
 * itself when the target is a directory avoids the surprising case where
 * deleting `/tmp` would otherwise approve `/`.
 */
async function getApprovalScope(abs: string): Promise<string> {
	try {
		const stat = await lstat(abs)
		if (stat.isDirectory()) return abs
	} catch {
		// fall through
	}
	return path.dirname(abs)
}

function isAlreadyApproved(folder: string, approved: Set<string>): boolean {
	const norm = path.normalize(folder)
	for (const a of approved) {
		const an = path.normalize(a)
		if (norm === an) return true
		if (norm.startsWith(an + path.sep)) return true
	}
	return false
}

/**
 * Detects deletions performed by non-shell tools (the LLM's file editor).
 *
 * Currently this covers `apply_patch`-style tools whose input contains
 * `*** Delete File: <path>` markers. Returns the list of paths the tool
 * would delete (empty if none).
 *
 * These are taken from the tool input verbatim — they may be relative to
 * the workspace root.
 */
export function parseFileToolDeletes(
	tool: string,
	input: unknown,
): string[] {
	if (!input || typeof input !== 'object') return []
	const inputObj = input as Record<string, unknown>

	// apply_patch and friends ship the patch text as one of these field names
	// depending on the tool variant. Scan all string-valued fields so we don't
	// have to know the exact schema.
	const candidates: string[] = []
	if (isApplyPatchToolName(tool)) {
		for (const v of Object.values(inputObj)) {
			if (typeof v === 'string') candidates.push(v)
		}
	}

	const paths: string[] = []
	const seen = new Set<string>()
	const re = /^\s*\*\*\*\s*Delete File:\s*(.+?)\s*$/gm
	for (const text of candidates) {
		for (const m of text.matchAll(re)) {
			const p = m[1]!.trim()
			if (p && !seen.has(p)) {
				seen.add(p)
				paths.push(p)
			}
		}
	}
	return paths
}

function isApplyPatchToolName(tool: string): boolean {
	// Cover the main variants: 'apply_patch', 'apply-patch', and the older
	// 'str_replace_based_edit_tool' style is intentionally excluded since it
	// doesn't support deletes via patch markers.
	const t = tool.toLowerCase()
	return t === 'apply_patch' || t === 'apply-patch' || t === 'applypatch'
}

interface ParseResult {
	hasDelete: boolean
	/** All path arguments (literal, possibly globbed) targeted by deletion invocations. */
	paths: string[]
}

const RM_LIKE = new Set(['rm', 'rmdir', 'unlink'])

/**
 * Walks the command, splits on shell separators, and, for each segment whose
 * first command word looks like a deletion (`rm`, `rmdir`, `unlink`, or
 * `find ... -delete` / `find ... -exec rm`), extracts its path arguments.
 *
 * `xargs rm` is detected as a delete (so it gets rewritten to trash), but
 * its paths come from stdin and can't be statically extracted, so it doesn't
 * contribute to approval scopes.
 */
export function parseDeletes(cmd: string): ParseResult {
	const result: ParseResult = { hasDelete: false, paths: [] }
	for (const segment of splitOnSeparators(cmd)) {
		const tokens = tokenize(segment)
		if (tokens.length === 0) continue
		// Skip leading env assignments like FOO=bar BAZ=qux rm ...
		let i = 0
		while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(stripQuotes(tokens[i]!))) i++
		const head = i < tokens.length ? stripQuotes(tokens[i]!) : ''

		if (RM_LIKE.has(head)) {
			result.hasDelete = true
			let sawDoubleDash = false
			for (let j = i + 1; j < tokens.length; j++) {
				const tok = tokens[j]!
				const bare = stripQuotes(tok)
				if (!sawDoubleDash) {
					if (bare === '--') {
						sawDoubleDash = true
						continue
					}
					if (bare.startsWith('-') && bare.length > 1) continue // flag
				}
				result.paths.push(bare)
			}
			continue
		}

		if (head === 'find') {
			const findInfo = analyzeFind(tokens, i)
			if (findInfo.isDelete) {
				result.hasDelete = true
				result.paths.push(...findInfo.paths)
			}
			continue
		}

		if (head === 'xargs') {
			// `xargs [opts] rm/rmdir/unlink ...` — paths are read from stdin
			// so we can't extract them, but we still want to mark this as a
			// delete so rewriteRmToTrash gets a chance to swap in `trash`.
			const sub = findXargsCommand(tokens, i)
			if (sub && RM_LIKE.has(sub)) {
				result.hasDelete = true
			}
			continue
		}
	}
	return result
}

interface FindAnalysis {
	isDelete: boolean
	paths: string[]
}

/**
 * Looks for `-delete`, `-exec rm`, or `-execdir rm` inside a `find` invocation
 * and, if present, returns the path arguments given to find (the roots of the
 * walk — these are what we need to scope approvals to).
 */
function analyzeFind(tokens: string[], headIdx: number): FindAnalysis {
	const result: FindAnalysis = { isDelete: false, paths: [] }
	const paths: string[] = []
	let inPaths = true
	for (let j = headIdx + 1; j < tokens.length; j++) {
		const bare = stripQuotes(tokens[j]!)

		// find's expression starts at the first token that begins with `-`,
		// `(`, `)`, `!`, or `,`. Before that we may see global options like
		// `-H`, `-L`, `-P`, `-D debug`, `-O level`, but those also start with
		// `-`. To keep things simple, treat tokens starting with `-` as the
		// boundary unless they're one of the known global option prefixes that
		// can sit before paths.
		if (inPaths) {
			if (bare === '-H' || bare === '-L' || bare === '-P') continue
			if (bare === '-D' || bare === '-O') {
				j++ // skip its argument
				continue
			}
			if (bare.startsWith('-') || bare === '(' || bare === '!') {
				inPaths = false
			} else {
				paths.push(bare)
				continue
			}
		}

		if (bare === '-delete') {
			result.isDelete = true
			continue
		}
		if (bare === '-exec' || bare === '-execdir') {
			// Next token is the command. May be preceded by env vars but
			// realistically inside -exec people just write the command.
			const next = j + 1 < tokens.length ? stripQuotes(tokens[j + 1]!) : ''
			if (RM_LIKE.has(next)) result.isDelete = true
		}
	}
	if (result.isDelete) result.paths = paths.length > 0 ? paths : ['.']
	return result
}

/**
 * Find the sub-command name of an `xargs` invocation, skipping xargs's own
 * flags. Returns undefined if xargs is being used in a mode we don't handle
 * (e.g. no command given, or only flags).
 */
function findXargsCommand(tokens: string[], headIdx: number): string | undefined {
	// Flags that take an argument.
	const argFlags = new Set([
		'-I',
		'-i',
		'-L',
		'-l',
		'-n',
		'-P',
		'-s',
		'-E',
		'-d',
		'-a',
		'--replace',
		'--max-lines',
		'--max-args',
		'--max-procs',
		'--max-chars',
		'--eof',
		'--delimiter',
		'--arg-file',
	])
	for (let j = headIdx + 1; j < tokens.length; j++) {
		const bare = stripQuotes(tokens[j]!)
		if (!bare.startsWith('-')) return bare
		// Long flag with `=value` form — skip whole token.
		if (bare.includes('=')) continue
		if (argFlags.has(bare)) {
			j++ // skip flag's argument
			continue
		}
		// Boolean flags like -0, -t, -r, -p — just skip.
	}
	return undefined
}

/**
 * Rewrites deletion invocations in a shell command to use `trash`:
 *   - `rm` / `rmdir` / `unlink`           → `trash <paths>` (flags dropped)
 *   - `find ... -delete`                  → `find ... -exec trash {} +`
 *   - `find ... -exec rm ... {} ...`      → `find ... -exec trash {} ...`
 *   - `xargs [opts] rm/rmdir/unlink ...`  → `xargs [opts] trash ...`
 *
 * All other parts of the command are preserved verbatim.
 */
export function rewriteRmToTrash(cmd: string): string {
	const segments = splitWithSeparators(cmd)
	let out = ''
	for (const piece of segments) {
		if (piece.kind === 'sep') {
			out += piece.text
			continue
		}
		out += rewriteSegment(piece.text)
	}
	return out
}

function rewriteSegment(segment: string): string {
	const tokens = tokenize(segment)
	if (tokens.length === 0) return segment
	let i = 0
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(stripQuotes(tokens[i]!))) i++
	const head = i < tokens.length ? stripQuotes(tokens[i]!) : ''

	const leadingWs = segment.match(/^\s*/)?.[0] ?? ''
	const trailingWs = segment.match(/\s*$/)?.[0] ?? ''
	const envPrefix = tokens.slice(0, i).join(' ')

	if (RM_LIKE.has(head)) {
		// Reconstruct: env prefix + "trash" + path tokens (quoted as-is).
		const paths: string[] = []
		let sawDoubleDash = false
		for (let j = i + 1; j < tokens.length; j++) {
			const tok = tokens[j]!
			const bare = stripQuotes(tok)
			if (!sawDoubleDash) {
				if (bare === '--') {
					sawDoubleDash = true
					continue
				}
				if (bare.startsWith('-') && bare.length > 1) continue
			}
			paths.push(tok) // keep original quoting
		}
		const parts = [envPrefix, 'trash', ...paths].filter((s) => s.length > 0)
		return leadingWs + parts.join(' ') + trailingWs
	}

	if (head === 'find') {
		const rewritten = rewriteFindTokens(tokens, i)
		if (!rewritten) return segment
		return leadingWs + rewritten.join(' ') + trailingWs
	}

	if (head === 'xargs') {
		const rewritten = rewriteXargsTokens(tokens, i)
		if (!rewritten) return segment
		return leadingWs + rewritten.join(' ') + trailingWs
	}

	return segment
}

/**
 * Rewrites the deletion bits of a tokenized `find` invocation. Returns the
 * full token list (ready to join with spaces) or undefined if there's nothing
 * to rewrite.
 */
function rewriteFindTokens(tokens: string[], headIdx: number): string[] | undefined {
	const out = tokens.slice(0, headIdx + 1)
	let changed = false
	for (let j = headIdx + 1; j < tokens.length; j++) {
		const tok = tokens[j]!
		const bare = stripQuotes(tok)
		if (bare === '-delete') {
			// `-delete` takes no argument; replace it with an exec batch.
			out.push('-exec', 'trash', '{}', '+')
			changed = true
			continue
		}
		if (bare === '-exec' || bare === '-execdir') {
			// Look ahead for `rm/rmdir/unlink` and rewrite to `trash`,
			// dropping that command's flags up to `{}`.
			const next = j + 1 < tokens.length ? stripQuotes(tokens[j + 1]!) : ''
			if (RM_LIKE.has(next)) {
				out.push(tok, 'trash')
				j += 1 // consume the rm/rmdir/unlink token
				// Skip flags and `--` until we hit `{}` (or end of -exec block).
				let k = j + 1
				let sawDoubleDash = false
				while (k < tokens.length) {
					const inner = stripQuotes(tokens[k]!)
					if (inner === ';' || inner === '+') break
					if (inner === '{}') break
					if (!sawDoubleDash) {
						if (inner === '--') {
							sawDoubleDash = true
							k++
							continue
						}
						if (inner.startsWith('-') && inner.length > 1) {
							k++
							continue
						}
					}
					// Non-flag, non-{} token — keep it (unusual, but safe).
					out.push(tokens[k]!)
					k++
				}
				j = k - 1 // outer loop will ++
				changed = true
				continue
			}
		}
		out.push(tok)
	}
	return changed ? out : undefined
}

/**
 * Rewrites `xargs [opts] rm/rmdir/unlink [flags] ...` to
 * `xargs [opts] trash ...` — drops the inner command's flags but keeps any
 * trailing literal arguments. Returns undefined if the xargs sub-command
 * isn't a deletion.
 */
function rewriteXargsTokens(tokens: string[], headIdx: number): string[] | undefined {
	const argFlags = new Set([
		'-I',
		'-i',
		'-L',
		'-l',
		'-n',
		'-P',
		'-s',
		'-E',
		'-d',
		'-a',
		'--replace',
		'--max-lines',
		'--max-args',
		'--max-procs',
		'--max-chars',
		'--eof',
		'--delimiter',
		'--arg-file',
	])
	const out = tokens.slice(0, headIdx + 1)
	let j = headIdx + 1
	while (j < tokens.length) {
		const bare = stripQuotes(tokens[j]!)
		if (!bare.startsWith('-')) break
		out.push(tokens[j]!)
		if (!bare.includes('=') && argFlags.has(bare) && j + 1 < tokens.length) {
			out.push(tokens[j + 1]!)
			j += 2
			continue
		}
		j++
	}
	if (j >= tokens.length) return undefined
	const sub = stripQuotes(tokens[j]!)
	if (!RM_LIKE.has(sub)) return undefined
	out.push('trash')
	j++
	let sawDoubleDash = false
	for (; j < tokens.length; j++) {
		const tok = tokens[j]!
		const bare = stripQuotes(tok)
		if (!sawDoubleDash) {
			if (bare === '--') {
				sawDoubleDash = true
				continue
			}
			if (bare.startsWith('-') && bare.length > 1) continue
		}
		out.push(tok)
	}
	return out
}

interface Piece {
	kind: 'cmd' | 'sep'
	text: string
}

function splitOnSeparators(cmd: string): string[] {
	return splitWithSeparators(cmd)
		.filter((p) => p.kind === 'cmd')
		.map((p) => p.text)
}

/** Split a command on shell control operators that appear outside quotes. */
function splitWithSeparators(cmd: string): Piece[] {
	const pieces: Piece[] = []
	let buf = ''
	let i = 0
	let quote: '"' | "'" | null = null
	const flush = () => {
		if (buf.length > 0) {
			pieces.push({ kind: 'cmd', text: buf })
			buf = ''
		}
	}
	while (i < cmd.length) {
		const c = cmd[i]!
		if (quote) {
			buf += c
			if (c === '\\' && quote === '"' && i + 1 < cmd.length) {
				buf += cmd[i + 1]
				i += 2
				continue
			}
			if (c === quote) quote = null
			i++
			continue
		}
		if (c === '"' || c === "'") {
			quote = c as '"' | "'"
			buf += c
			i++
			continue
		}
		if (c === '\\' && i + 1 < cmd.length) {
			buf += c + cmd[i + 1]
			i += 2
			continue
		}
		// Two-char operators first
		const two = cmd.slice(i, i + 2)
		if (SEPARATORS.has(two)) {
			flush()
			pieces.push({ kind: 'sep', text: two })
			i += 2
			continue
		}
		if (SEPARATORS.has(c)) {
			flush()
			pieces.push({ kind: 'sep', text: c })
			i++
			continue
		}
		buf += c
		i++
	}
	flush()
	return pieces
}

function tokenize(segment: string): string[] {
	const tokens: string[] = []
	let cur = ''
	let i = 0
	let quote: '"' | "'" | null = null
	while (i < segment.length) {
		const c = segment[i]!
		if (quote) {
			cur += c
			if (c === '\\' && quote === '"' && i + 1 < segment.length) {
				cur += segment[i + 1]
				i += 2
				continue
			}
			if (c === quote) quote = null
			i++
			continue
		}
		if (c === '"' || c === "'") {
			quote = c as '"' | "'"
			cur += c
			i++
			continue
		}
		if (c === '\\' && i + 1 < segment.length) {
			cur += c + segment[i + 1]
			i += 2
			continue
		}
		if (/\s/.test(c)) {
			if (cur.length > 0) {
				tokens.push(cur)
				cur = ''
			}
			i++
			continue
		}
		cur += c
		i++
	}
	if (cur.length > 0) tokens.push(cur)
	return tokens
}

function stripQuotes(tok: string): string {
	if (tok.length >= 2) {
		const f = tok[0]
		const l = tok[tok.length - 1]
		if ((f === '"' || f === "'") && f === l) {
			return tok.slice(1, -1)
		}
	}
	return tok
}
