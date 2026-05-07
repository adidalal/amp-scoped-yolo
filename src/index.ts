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

	amp.on('tool.call', async (event, ctx): Promise<ToolCallResult> => {
		// Use the helpers API to recognize any shell-command tool call (Bash,
		// shell_command, etc.) instead of branching on a hard-coded tool name.
		const shell = amp.helpers.shellCommandFromToolCall(event)
		if (!shell) return { action: 'allow' }

		const originalCmd = shell.command
		const parsed = parseDeletes(originalCmd)
		if (!parsed.hasDelete) return { action: 'allow' }

		const root = await getWorkspaceRoot()
		const canonicalRoot = await canonicalize(root)
		const cmdCwd = shell.dir
			? path.isAbsolute(shell.dir)
				? shell.dir
				: path.resolve(root, shell.dir)
			: root

		// Determine which folders, outside the workspace, would be affected.
		const approvalScopes = new Set<string>()
		for (const p of parsed.paths) {
			const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cmdCwd, p)
			const canonicalAbs = await canonicalize(abs)
			if (!isStrictlyInsideWorkspace(canonicalAbs, canonicalRoot)) {
				approvalScopes.add(await getApprovalScope(canonicalAbs))
			}
		}

		if (approvalScopes.size > 0) {
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
						// No interactive UI — fail closed.
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
		}

		// Rewrite rm/rmdir → trash. Inside-workspace deletes never prompt;
		// outside-workspace deletes only get here after approval above.
		const rewritten = rewriteRmToTrash(originalCmd)
		if (rewritten === originalCmd) return { action: 'allow' }

		// Find the input key whose value is the original command and replace
		// it. This works for both Bash (`cmd`) and shell_command (`command`)
		// without hard-coding either name.
		const newInput: Record<string, unknown> = { ...event.input }
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

interface ParseResult {
	hasDelete: boolean
	/** All path arguments (literal, possibly globbed) targeted by rm/rmdir invocations. */
	paths: string[]
}

/**
 * Walks the command, splits on shell separators, and, for each segment whose
 * first command word is `rm` or `rmdir`, extracts its path arguments.
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
		if (head !== 'rm' && head !== 'rmdir') continue
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
	}
	return result
}

/**
 * Rewrites `rm`/`rmdir` invocations in a shell command to `trash`. Flags are
 * dropped (trash needs no `-r`/`-f`); only path arguments are kept. All other
 * parts of the command are preserved verbatim.
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
	if (head !== 'rm' && head !== 'rmdir') return segment

	// Reconstruct: leading whitespace + env prefix + "trash" + path tokens (quoted as-is).
	const leadingWs = segment.match(/^\s*/)?.[0] ?? ''
	const envPrefix = tokens.slice(0, i).join(' ')
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
	const trailingWs = segment.match(/\s*$/)?.[0] ?? ''
	return leadingWs + parts.join(' ') + trailingWs
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
