// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now
/**
 * scoped-yolo
 *  - Rewrite shell deletes (rm/rmdir/unlink, find -delete, xargs rm) to `trash`.
 *  - Ask once per outside-workspace folder per thread before any delete that
 *    targets a path outside the workspace.
 */

import type { PluginAPI, ToolCallResult } from '@ampcode/plugin'
import { lstat, realpath } from 'node:fs/promises'
import * as path from 'node:path'

// ---------- types & module constants ----------

interface WorkspaceInfo {
	root: string
	canonicalRoot: string
}

interface ConfirmOptions {
	title: string
	message: string
	confirmButtonText?: string
}

interface ToolCallContext {
	logger: { log(message: string): void }
	ui: {
		confirm(options: ConfirmOptions): Promise<boolean>
		notify(message: string): Promise<void>
	}
}

const RM_LIKE = new Set(['rm', 'rmdir', 'unlink'])

const APPLY_PATCH_TOOL_NAMES = new Set(['apply_patch', 'apply-patch', 'applypatch'])

/** xargs flags that consume a following argument. */
const XARGS_FLAGS_WITH_ARG = new Set([
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

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n'])

// ---------- plugin entry ----------

export default function scopedYolo(amp: PluginAPI) {
	// Folders the user has approved for outside-workspace deletes, keyed by
	// thread id. Stored absolute, normalized, and canonical (symlink-resolved)
	// when possible.
	const approvedOutsideFoldersByThread = new Map<string, Set<string>>()

	// Bash calls we rewrote and want to follow up on in tool.result, so we can
	// give a clearer message if `trash` is missing or fails.
	const pendingRewrittenCalls = new Map<
		string,
		{ original: string; rewritten: string }
	>()

	// Workspace root + its canonical form. Cached for the life of the plugin
	// instance — we assume one plugin instance per workspace/session. Resolved
	// lazily, only when a delete is detected, so a `pwd` failure can't affect
	// unrelated tool calls.
	let workspaceInfoPromise: Promise<WorkspaceInfo> | null = null
	const getWorkspaceInfo = (): Promise<WorkspaceInfo> => {
		if (!workspaceInfoPromise) {
			workspaceInfoPromise = (async () => {
				const result = await amp.$`pwd`
				const root = result.stdout.toString().trim()
				const canonicalRoot = await canonicalize(root)
				return { root, canonicalRoot }
			})().catch((err) => {
				// Don't cache a failed lookup forever — let the next call retry.
				workspaceInfoPromise = null
				throw err
			})
		}
		return workspaceInfoPromise
	}

	amp.on('session.start', () => {
		amp.logger.log('scoped-yolo loaded — rm→trash + ask-before-outside-delete')
	})

	amp.on('tool.call', async (event, ctx): Promise<ToolCallResult> => {
		// Use the helpers API to recognize any shell-command tool call (Bash,
		// shell_command, …) instead of branching on a hard-coded tool name.
		const shell = amp.helpers.shellCommandFromToolCall(event)
		if (shell) return handleShellToolCall(event, ctx, shell)
		return handleFileToolCall(event, ctx)
	})

	async function handleShellToolCall(
		event: any,
		ctx: ToolCallContext,
		shell: { command: string; dir?: string },
	): Promise<ToolCallResult> {
		const originalCmd = shell.command
		const parsed = parseDeletes(originalCmd)
		if (!parsed.hasDelete) return { action: 'allow' }

		const workspace = await safeGetWorkspaceInfo(ctx)
		if (!workspace) return blockedNoWorkspace()

		const resolveFromDir = shell.dir
			? path.isAbsolute(shell.dir)
				? shell.dir
				: path.resolve(workspace.root, shell.dir)
			: workspace.root

		const reject = await approveOutsideWorkspaceDeletes(event, ctx, parsed.paths, {
			resolveFromDir,
			workspace,
		})
		if (reject) return reject

		// Inside-workspace deletes never prompt; outside-workspace deletes only
		// reach here after approval above.
		const rewritten = rewriteRmToTrash(originalCmd)
		if (rewritten === originalCmd) return { action: 'allow' }

		const newInput = replaceTopLevelStringValue(
			event.input as Record<string, unknown>,
			originalCmd,
			rewritten,
		)
		if (!newInput) return { action: 'allow' }

		pendingRewrittenCalls.set(event.toolUseID, { original: originalCmd, rewritten })
		ctx.logger.log(`scoped-yolo rewrote: ${originalCmd}  →  ${rewritten}`)
		return { action: 'modify', input: newInput }
	}

	async function handleFileToolCall(
		event: any,
		ctx: ToolCallContext,
	): Promise<ToolCallResult> {
		// Non-shell tool calls: detect file-tool deletes (e.g. apply_patch
		// removing a file). We can't rewrite these to `trash`, but we can apply
		// the same outside-workspace approval check and log the deletion.
		const fileDeletes = parseFileToolDeletes(event.tool, event.input)
		if (fileDeletes.length === 0) return { action: 'allow' }

		const workspace = await safeGetWorkspaceInfo(ctx)
		if (!workspace) return blockedNoWorkspace()

		const reject = await approveOutsideWorkspaceDeletes(event, ctx, fileDeletes, {
			resolveFromDir: workspace.root,
			workspace,
		})
		if (reject) return reject

		ctx.logger.log(
			`scoped-yolo: ${event.tool} will delete ${fileDeletes.length} file(s): ` +
				`${fileDeletes.join(', ')} (file-tool deletes are not reversible via 'trash')`,
		)
		return { action: 'allow' }
	}

	async function safeGetWorkspaceInfo(
		ctx: ToolCallContext,
	): Promise<WorkspaceInfo | undefined> {
		try {
			return await getWorkspaceInfo()
		} catch (err) {
			ctx.logger.log(
				`scoped-yolo: failed to determine workspace root, blocking delete. ` +
					(err instanceof Error ? err.message : String(err)),
			)
			return undefined
		}
	}

	/**
	 * Ask the user once per outside-workspace folder before allowing a delete
	 * that targets it. Returns a reject result, or undefined to proceed.
	 */
	async function approveOutsideWorkspaceDeletes(
		event: { thread: { id: string }; input: unknown },
		ctx: ToolCallContext,
		targets: string[],
		opts: { resolveFromDir: string; workspace: WorkspaceInfo },
	): Promise<ToolCallResult | undefined> {
		const { resolveFromDir, workspace } = opts

		// Group outside-workspace targets by the folder we'll ask approval for,
		// so multiple targets under the same folder share a single prompt.
		const targetsByFolder = new Map<string, string[]>()
		for (const p of targets) {
			const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(resolveFromDir, p)
			const canonicalAbs = await canonicalize(abs)
			if (isStrictDescendantOfWorkspace(canonicalAbs, workspace.canonicalRoot)) continue
			const folder = await getApprovedFolderForTarget(canonicalAbs)
			const list = targetsByFolder.get(folder) ?? []
			list.push(p)
			targetsByFolder.set(folder, list)
		}
		if (targetsByFolder.size === 0) return undefined

		const approved =
			approvedOutsideFoldersByThread.get(event.thread.id) ?? new Set<string>()
		for (const [folder, folderTargets] of targetsByFolder) {
			if (isPathCoveredByApprovedFolder(folder, approved)) continue

			let confirmed: boolean
			try {
				confirmed = await ctx.ui.confirm({
					title: 'Allow delete outside workspace?',
					message:
						`The agent wants to delete:\n` +
						folderTargets.map((p) => `• ${p}`).join('\n') +
						`\n\nThis is outside the workspace (${workspace.root}).\n\n` +
						`Allowing this will permit further deletes anywhere inside:\n${folder}\n` +
						`for the rest of this thread.`,
					confirmButtonText: `Allow ${folder}`,
				})
			} catch (err) {
				if (err instanceof Error && amp.helpers.isPluginUINotAvailableError(err)) {
					return {
						action: 'reject-and-continue',
						message:
							`Blocked delete outside workspace (${folder}). ` +
							`No interactive UI is available to ask the user for approval.`,
					}
				}
				throw err
			}

			if (!confirmed) {
				return {
					action: 'reject-and-continue',
					message: `Blocked delete outside workspace: user denied deletion in ${folder}.`,
				}
			}
			approved.add(folder)
		}
		approvedOutsideFoldersByThread.set(event.thread.id, approved)
		return undefined
	}

	amp.on('tool.result', (event) => {
		const tracked = pendingRewrittenCalls.get(event.toolUseID)
		if (!tracked) return
		pendingRewrittenCalls.delete(event.toolUseID)
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
			title: 'Show approved outside-workspace folders',
			description: 'List folders this thread has approved for outside-workspace deletes.',
		},
		async (ctx) => {
			const id = ctx.thread?.id
			const approved = id ? approvedOutsideFoldersByThread.get(id) : undefined
			const list = approved && approved.size > 0 ? [...approved].sort().join('\n') : '(none)'
			await ctx.ui.notify(`scoped-yolo approved folders for this thread:\n${list}`)
		},
	)

	amp.registerCommand(
		'clear-approvals',
		{
			title: 'Clear approved outside-workspace folders',
			description: 'Forget approved outside-workspace folders for this thread.',
		},
		async (ctx) => {
			if (ctx.thread) approvedOutsideFoldersByThread.delete(ctx.thread.id)
			await ctx.ui.notify('scoped-yolo: cleared approved folders for this thread.')
		},
	)
}

function blockedNoWorkspace(): ToolCallResult {
	return {
		action: 'reject-and-continue',
		message:
			'scoped-yolo blocked this delete because it could not determine the workspace root safely.',
	}
}

// ---------- approval / path helpers ----------

/**
 * True only when `absPath` is a path strictly *under* `root`. The workspace
 * root itself is intentionally treated as outside, so e.g. `rm -rf .` from
 * the workspace requires explicit approval.
 */
function isStrictDescendantOfWorkspace(absPath: string, root: string): boolean {
	const rel = path.relative(path.normalize(root), absPath)
	if (rel === '' || rel === '.') return false
	return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** True if `child` is the same as, or a descendant of, `parent`. */
function isPathEqualOrDescendant(child: string, parent: string): boolean {
	const rel = path.relative(parent, child)
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function canonicalize(abs: string): Promise<string> {
	try {
		return await realpath(abs)
	} catch {
		// Path doesn't exist (glob, already-deleted, typo) — fall back.
		return abs
	}
}

/**
 * The folder we ask the user to approve when `abs` is targeted by a delete.
 *
 * - If `abs` is a directory, approve `abs` itself. (Approving the parent of
 *   `/tmp` would otherwise leak approval to `/`.)
 * - If `abs` is a file (or unknown), approve its parent directory.
 */
async function getApprovedFolderForTarget(abs: string): Promise<string> {
	try {
		const stat = await lstat(abs)
		if (stat.isDirectory()) return abs
	} catch {
		// fall through
	}
	return path.dirname(abs)
}

function isPathCoveredByApprovedFolder(folder: string, approved: Set<string>): boolean {
	const norm = path.normalize(folder)
	for (const a of approved) {
		if (isPathEqualOrDescendant(norm, path.normalize(a))) return true
	}
	return false
}

/**
 * Replace a top-level string field on a tool input. Only string-valued
 * top-level fields whose value equals `from` are replaced; nested objects
 * and arrays are not traversed. This is enough for current shell tools
 * (Bash's `cmd`, shell_command's `command`).
 *
 * Returns the new input, or undefined if no field matched.
 */
function replaceTopLevelStringValue(
	input: Record<string, unknown>,
	from: string,
	to: string,
): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = { ...input }
	let replaced = false
	for (const [k, v] of Object.entries(out)) {
		if (typeof v === 'string' && v === from) {
			out[k] = to
			replaced = true
		}
	}
	return replaced ? out : undefined
}

// ---------- file-tool delete detection ----------

/**
 * Detects deletions performed by non-shell tools (the LLM's file editor).
 *
 * Currently this covers `apply_patch`-style tools whose input contains
 * `*** Delete File: <path>` markers. Returns the list of paths the tool
 * would delete (empty if none).
 *
 * Only top-level string fields of `input` are scanned — schema-agnostic but
 * intentionally shallow. Paths come from the tool input verbatim and may be
 * relative to the workspace root.
 */
export function parseFileToolDeletes(tool: string, input: unknown): string[] {
	if (!input || typeof input !== 'object') return []
	if (!isApplyPatchLikeTool(tool)) return []
	const inputObj = input as Record<string, unknown>

	const paths: string[] = []
	const seen = new Set<string>()
	const re = /^\s*\*\*\*\s*Delete File:\s*(.+?)\s*$/gm
	for (const v of Object.values(inputObj)) {
		if (typeof v !== 'string') continue
		for (const m of v.matchAll(re)) {
			const p = m[1]!.trim()
			if (p && !seen.has(p)) {
				seen.add(p)
				paths.push(p)
			}
		}
	}
	return paths
}

function isApplyPatchLikeTool(tool: string): boolean {
	// The older `str_replace_based_edit_tool` style is intentionally excluded
	// since it doesn't express deletes via patch markers.
	return APPLY_PATCH_TOOL_NAMES.has(tool.toLowerCase())
}

// ---------- shell delete parsing / rewriting ----------
//
// scoped-yolo uses a small, test-driven tokenizer for common shell forms
// (rm/rmdir/unlink, find -delete / -exec rm, xargs rm). It is not a full
// POSIX shell parser.

interface ParseResult {
	hasDelete: boolean
	/** Path arguments (literal, possibly globbed) targeted by deletion invocations. */
	paths: string[]
}

/**
 * Walks the command, splits on shell separators, and, for each segment whose
 * first command word looks like a deletion (`rm`, `rmdir`, `unlink`, or
 * `find ... -delete` / `find ... -exec rm`), extracts its path arguments.
 *
 * `xargs rm` is detected as a delete (so it gets rewritten to `trash`), but
 * its paths come from stdin and can't be statically extracted, so it doesn't
 * contribute to approval scopes.
 */
export function parseDeletes(cmd: string): ParseResult {
	const result: ParseResult = { hasDelete: false, paths: [] }
	for (const segment of splitOnSeparators(cmd)) {
		const tokens = tokenize(segment)
		if (tokens.length === 0) continue
		const headIdx = skipEnvAssignments(tokens)
		const head = headIdx < tokens.length ? stripQuotes(tokens[headIdx]!) : ''

		if (RM_LIKE.has(head)) {
			result.hasDelete = true
			result.paths.push(...collectRmPathTokens(tokens, headIdx))
			continue
		}

		if (head === 'find') {
			const findInfo = analyzeFind(tokens, headIdx)
			if (findInfo.isDelete) {
				result.hasDelete = true
				result.paths.push(...findInfo.paths)
			}
			continue
		}

		if (head === 'xargs') {
			// `xargs [opts] rm/rmdir/unlink ...` — paths come from stdin so we
			// can't extract them, but we still want to rewrite to `trash`.
			const sub = findXargsCommand(tokens, headIdx)
			if (sub && RM_LIKE.has(sub)) result.hasDelete = true
			continue
		}
	}
	return result
}

/** Collect the (non-flag) path tokens of an `rm`/`rmdir`/`unlink` invocation. */
function collectRmPathTokens(tokens: string[], headIdx: number): string[] {
	const paths: string[] = []
	let sawDoubleDash = false
	for (let j = headIdx + 1; j < tokens.length; j++) {
		const tok = tokens[j]!
		const bare = stripQuotes(tok)
		if (!sawDoubleDash) {
			if (bare === '--') {
				sawDoubleDash = true
				continue
			}
			if (bare.startsWith('-') && bare.length > 1) continue
		}
		paths.push(bare)
	}
	return paths
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

		// find's expression starts at the first token beginning with `-`, `(`,
		// `)`, `!`, or `,`. Global options like `-H -L -P -D <arg> -O <arg>`
		// can sit before paths; treat them specially.
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
	for (let j = headIdx + 1; j < tokens.length; j++) {
		const bare = stripQuotes(tokens[j]!)
		if (!bare.startsWith('-')) return bare
		if (bare.includes('=')) continue // long flag with =value
		if (XARGS_FLAGS_WITH_ARG.has(bare)) {
			j++ // skip flag's argument
			continue
		}
		// Boolean flag (-0, -t, -r, -p, …) — just skip.
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
	let out = ''
	for (const piece of splitWithSeparators(cmd)) {
		out += piece.kind === 'sep' ? piece.text : rewriteSegment(piece.text)
	}
	return out
}

function rewriteSegment(segment: string): string {
	const tokens = tokenize(segment)
	if (tokens.length === 0) return segment
	const headIdx = skipEnvAssignments(tokens)
	const head = headIdx < tokens.length ? stripQuotes(tokens[headIdx]!) : ''

	const leadingWs = segment.match(/^\s*/)?.[0] ?? ''
	const trailingWs = segment.match(/\s*$/)?.[0] ?? ''
	const envPrefix = tokens.slice(0, headIdx).join(' ')

	if (RM_LIKE.has(head)) {
		// Reconstruct: env prefix + "trash" + path tokens (keep original quoting).
		const paths: string[] = []
		let sawDoubleDash = false
		for (let j = headIdx + 1; j < tokens.length; j++) {
			const tok = tokens[j]!
			const bare = stripQuotes(tok)
			if (!sawDoubleDash) {
				if (bare === '--') {
					sawDoubleDash = true
					continue
				}
				if (bare.startsWith('-') && bare.length > 1) continue
			}
			paths.push(tok)
		}
		const parts = [envPrefix, 'trash', ...paths].filter((s) => s.length > 0)
		return leadingWs + parts.join(' ') + trailingWs
	}

	if (head === 'find') {
		const rewritten = rewriteFindTokens(tokens, headIdx)
		if (!rewritten) return segment
		return leadingWs + rewritten.join(' ') + trailingWs
	}

	if (head === 'xargs') {
		const rewritten = rewriteXargsTokens(tokens, headIdx)
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
	const out = tokens.slice(0, headIdx + 1)
	let j = headIdx + 1
	while (j < tokens.length) {
		const bare = stripQuotes(tokens[j]!)
		if (!bare.startsWith('-')) break
		out.push(tokens[j]!)
		if (
			!bare.includes('=') &&
			XARGS_FLAGS_WITH_ARG.has(bare) &&
			j + 1 < tokens.length
		) {
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

// ---------- low-level tokenization helpers ----------
//
// splitWithSeparators and tokenize intentionally implement the same minimal
// quoting rules: `'` and `"` preserve internal whitespace; `\` escapes the
// next char (only inside `"..."` or outside quotes). They are not full
// POSIX-correct.

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

function isEnvAssignmentToken(tok: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(stripQuotes(tok))
}

/** Index of the command head, after any leading `FOO=bar BAR=baz` env assignments. */
function skipEnvAssignments(tokens: string[]): number {
	let i = 0
	while (i < tokens.length && isEnvAssignmentToken(tokens[i]!)) i++
	return i
}
