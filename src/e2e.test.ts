/**
 * End-to-end test that mocks Amp's PluginAPI and exercises real `tool.call`
 * events through the plugin's default-export function.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import plugin from './index.ts'

const WORKSPACE = '/workspace'

interface ConfirmCall {
	title: string
	message: string
}

function makeAmp(
	opts: {
		confirmAnswers?: boolean[]
		confirmError?: Error
		pwdResults?: Array<{ stdout: string } | { error: Error }>
		isPluginUINotAvailableError?: (e: Error) => boolean
		shellCommandFromToolCall?: (event: any) => { command: string; dir?: string } | null
	} = {},
) {
	type Handler = (event: any, ctx: any) => any
	const handlers: Record<string, Handler> = {}
	const confirmCalls: ConfirmCall[] = []
	const notifyCalls: string[] = []
	const logs: string[] = []
	let confirmIdx = 0
	let pwdIdx = 0
	let pwdCallCount = 0

	const defaultShellCommandFromToolCall = (event: any) => {
		if (event.tool !== 'Bash') return null
		const cmd = typeof event.input?.cmd === 'string' ? event.input.cmd : null
		if (cmd === null) return null
		return {
			command: cmd,
			dir: typeof event.input?.cwd === 'string' ? event.input.cwd : undefined,
		}
	}

	const ctx = {
		logger: { log: (m: string) => logs.push(m) },
		ui: {
			confirm: async (o: { title: string; message: string }) => {
				confirmCalls.push({ title: o.title, message: o.message })
				if (opts.confirmError) throw opts.confirmError
				const answers = opts.confirmAnswers ?? []
				const next = answers[confirmIdx++]
				return next ?? false
			},
			notify: async (m: string) => {
				notifyCalls.push(m)
			},
		},
	}

	const amp: any = {
		logger: { log: (m: string) => logs.push(m) },
		on: (event: string, h: Handler) => {
			handlers[event] = h
		},
		registerCommand: () => {},
		// Tagged-template shell stub. Each call advances through `pwdResults`;
		// once exhausted, defaults to returning the workspace path.
		$: async (_strings: TemplateStringsArray) => {
			pwdCallCount++
			const next = opts.pwdResults?.[pwdIdx++] ?? { stdout: WORKSPACE + '\n' }
			if ('error' in next) throw next.error
			return { stdout: next.stdout }
		},
		helpers: {
			isPluginUINotAvailableError:
				opts.isPluginUINotAvailableError ?? ((_e: Error) => false),
			shellCommandFromToolCall:
				opts.shellCommandFromToolCall ?? defaultShellCommandFromToolCall,
		},
	}

	plugin(amp)

	let nextToolUseID = 1
	const fireToolCall = (input: { cmd: string; cwd?: string }, threadId = 'thread-1') => {
		const toolUseID = `toolu_${nextToolUseID++}`
		return handlers['tool.call']!(
			{ toolUseID, tool: 'Bash', input, thread: { id: threadId } },
			ctx,
		).then((res: any) => ({ result: res, toolUseID }))
	}

	const fireRawToolCall = (
		tool: string,
		input: Record<string, unknown>,
		threadId = 'thread-1',
	) => {
		const toolUseID = `toolu_${nextToolUseID++}`
		return handlers['tool.call']!(
			{ toolUseID, tool, input, thread: { id: threadId } },
			ctx,
		).then((res: any) => ({ result: res, toolUseID }))
	}

	const fireToolResult = (
		toolUseID: string,
		status: 'done' | 'error',
		opts: { error?: string; input?: Record<string, unknown> } = {},
	) =>
		handlers['tool.result']?.(
			{
				toolUseID,
				tool: 'Bash',
				input: opts.input ?? {},
				status,
				error: opts.error,
			},
			ctx,
		)

	return {
		fireToolCall,
		fireRawToolCall,
		fireToolResult,
		confirmCalls,
		notifyCalls,
		logs,
		getConfirmCount: () => confirmIdx,
		getPwdCallCount: () => pwdCallCount,
	}
}

describe('scoped-yolo e2e', () => {
	let amp: ReturnType<typeof makeAmp>

	beforeEach(() => {
		amp = makeAmp()
	})

	it('does not look up workspace for non-delete shell commands', async () => {
		const a = makeAmp({
			pwdResults: [{ error: new Error('pwd should not be called') }],
		})
		const { result } = await a.fireToolCall({ cmd: 'ls -la' })
		expect(result).toEqual({ action: 'allow' })
		expect(a.getPwdCallCount()).toBe(0)
		expect(a.confirmCalls.length).toBe(0)
	})

	it('does not look up workspace for non-delete apply_patch calls', async () => {
		const a = makeAmp({
			pwdResults: [{ error: new Error('pwd should not be called') }],
		})
		const { result } = await a.fireRawToolCall('apply_patch', {
			input: '*** Begin Patch\n*** Update File: foo.ts\n@@\n-x\n+y\n*** End Patch\n',
		})
		expect(result).toEqual({ action: 'allow' })
		expect(a.getPwdCallCount()).toBe(0)
	})

	it('rewrites in-workspace rm to trash without prompting', async () => {
		const { result } = await amp.fireToolCall({ cmd: 'rm -rf node_modules' })
		expect(result.action).toBe('modify')
		expect(result.input.cmd).toBe('trash node_modules')
		expect(amp.confirmCalls.length).toBe(0)
	})

	it('rewrites in-workspace rm with relative cwd', async () => {
		const { result } = await amp.fireToolCall({ cmd: 'rm -rf dist', cwd: 'src' })
		expect(result.action).toBe('modify')
		expect(result.input.cmd).toBe('trash dist')
		expect(amp.confirmCalls.length).toBe(0)
	})

	it('prompts when deleting outside workspace, then rewrites on approval', async () => {
		const ampApprove = makeAmp({ confirmAnswers: [true] })
		const { result } = await ampApprove.fireToolCall({ cmd: 'rm -rf /tmp/foo' })
		expect(ampApprove.confirmCalls.length).toBe(1)
		expect(ampApprove.confirmCalls[0]!.message).toContain('/tmp')
		expect(result.action).toBe('modify')
		expect(result.input.cmd).toBe('trash /tmp/foo')
	})

	it('rejects when user denies outside-workspace delete', async () => {
		const ampDeny = makeAmp({ confirmAnswers: [false] })
		const { result } = await ampDeny.fireToolCall({ cmd: 'rm -rf /tmp/foo' })
		expect(result.action).toBe('reject-and-continue')
		expect(result.message).toContain('/tmp')
	})

	it('does not re-prompt for the same folder in the same thread', async () => {
		const a = makeAmp({ confirmAnswers: [true] })
		const { result: r1 } = await a.fireToolCall({ cmd: 'rm -rf /tmp/foo' })
		expect(r1.action).toBe('modify')
		expect(a.getConfirmCount()).toBe(1)

		const { result: r2 } = await a.fireToolCall({ cmd: 'rm -rf /tmp/bar' })
		expect(r2.action).toBe('modify')
		expect(r2.input.cmd).toBe('trash /tmp/bar')
		expect(a.getConfirmCount()).toBe(1) // no new prompt
	})

	it('approval covers nested subfolders', async () => {
		const a = makeAmp({ confirmAnswers: [true] })
		await a.fireToolCall({ cmd: 'rm -rf /tmp/foo' }) // approves /tmp
		const { result } = await a.fireToolCall({ cmd: 'rm -rf /tmp/sub/dir/file' })
		expect(result.action).toBe('modify')
		expect(result.input.cmd).toBe('trash /tmp/sub/dir/file')
		expect(a.getConfirmCount()).toBe(1)
	})

	it('prompts again for a different outside folder', async () => {
		const a = makeAmp({ confirmAnswers: [true, true] })
		await a.fireToolCall({ cmd: 'rm -rf /tmp/foo' })
		const { result } = await a.fireToolCall({ cmd: 'rm -rf /var/log/x' })
		expect(result.action).toBe('modify')
		expect(a.getConfirmCount()).toBe(2)
		expect(a.confirmCalls[1]!.message).toContain('/var/log')
	})

	it('prompts once for multiple outside-workspace targets in the same folder', async () => {
		const a = makeAmp({ confirmAnswers: [true] })
		const { result } = await a.fireToolCall({ cmd: 'rm -rf /tmp/foo /tmp/bar' })
		expect(result.action).toBe('modify')
		expect(result.input.cmd).toBe('trash /tmp/foo /tmp/bar')
		expect(a.confirmCalls.length).toBe(1)
		expect(a.confirmCalls[0]!.message).toContain('• /tmp/foo')
		expect(a.confirmCalls[0]!.message).toContain('• /tmp/bar')
	})

	it('prompts once per distinct outside folder in a single call', async () => {
		const a = makeAmp({ confirmAnswers: [true, true] })
		const { result } = await a.fireToolCall({
			cmd: 'rm -rf /tmp/foo /var/log/x',
		})
		expect(result.action).toBe('modify')
		expect(a.confirmCalls.length).toBe(2)
		const messages = a.confirmCalls.map((c) => c.message).join('\n')
		expect(messages).toContain('/tmp')
		expect(messages).toContain('/var/log')
	})

	it('isolates approvals per thread', async () => {
		const a = makeAmp({ confirmAnswers: [true, true] })
		await a.fireToolCall({ cmd: 'rm -rf /tmp/foo' }, 'thread-A')
		expect(a.getConfirmCount()).toBe(1)
		await a.fireToolCall({ cmd: 'rm -rf /tmp/bar' }, 'thread-B')
		expect(a.getConfirmCount()).toBe(2) // new thread → new prompt
	})

	it('rewrites all rm in a compound command', async () => {
		const { result } = await amp.fireToolCall({
			cmd: 'mkdir tmp && rm -rf old && echo done',
		})
		expect(result.action).toBe('modify')
		expect(result.input.cmd).toBe('mkdir tmp && trash old && echo done')
	})

	it('prompts when compound contains an outside-workspace rm', async () => {
		const a = makeAmp({ confirmAnswers: [true] })
		const { result } = await a.fireToolCall({
			cmd: 'echo hi && rm -rf /tmp/foo && echo bye',
		})
		expect(a.getConfirmCount()).toBe(1)
		expect(result.action).toBe('modify')
		expect(result.input.cmd).toBe('echo hi && trash /tmp/foo && echo bye')
	})

	it('treats deleting workspace root itself as outside', async () => {
		const a = makeAmp({ confirmAnswers: [false] })
		const { result } = await a.fireToolCall({ cmd: 'rm -rf .' })
		expect(a.getConfirmCount()).toBe(1)
		expect(result.action).toBe('reject-and-continue')
	})

	it('rejects outside-workspace deletes when interactive UI is unavailable', async () => {
		const noUi = new Error('headless')
		const a = makeAmp({
			confirmError: noUi,
			isPluginUINotAvailableError: (e) => e === noUi,
		})
		const { result } = await a.fireToolCall({ cmd: 'rm -rf /tmp/foo' })
		expect(result.action).toBe('reject-and-continue')
		expect(result.message).toContain('No interactive UI is available')
		expect(result.message).toContain('/tmp')
		expect(a.confirmCalls.length).toBe(1)
	})

	it('blocks deletes when workspace lookup fails', async () => {
		const a = makeAmp({
			pwdResults: [{ error: new Error('pwd failed') }],
		})
		const { result } = await a.fireToolCall({ cmd: 'rm -rf node_modules' })
		expect(result.action).toBe('reject-and-continue')
		expect(result.message).toContain('could not determine the workspace root')
		expect(a.confirmCalls.length).toBe(0)
		expect(
			a.logs.some(
				(l) =>
					l.includes('failed to determine workspace root') && l.includes('pwd failed'),
			),
		).toBe(true)
	})

	it('retries workspace lookup after a failed delete', async () => {
		const a = makeAmp({
			pwdResults: [
				{ error: new Error('first pwd failed') },
				{ stdout: WORKSPACE + '\n' },
			],
		})
		const first = await a.fireToolCall({ cmd: 'rm -rf node_modules' })
		expect(first.result.action).toBe('reject-and-continue')

		const second = await a.fireToolCall({ cmd: 'rm -rf dist' })
		expect(second.result.action).toBe('modify')
		expect(second.result.input.cmd).toBe('trash dist')
		expect(a.getPwdCallCount()).toBe(2)
	})

	it('caches workspace info across shell and file-tool delete paths', async () => {
		const a = makeAmp()
		await a.fireToolCall({ cmd: 'rm -rf node_modules' })
		await a.fireRawToolCall('apply_patch', {
			input: '*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch\n',
		})
		expect(a.getPwdCallCount()).toBe(1)
	})

	it('rewrites top-level command fields for non-Bash shell tools', async () => {
		const a = makeAmp({
			shellCommandFromToolCall: (event) => {
				if (event.tool !== 'shell_command') return null
				if (typeof event.input?.command !== 'string') return null
				return {
					command: event.input.command,
					dir: typeof event.input?.cwd === 'string' ? event.input.cwd : undefined,
				}
			},
		})
		const { result } = await a.fireRawToolCall('shell_command', {
			command: 'rm -rf node_modules',
			cwd: 'src',
			untouched: 'keep me',
		})
		expect(result).toEqual({
			action: 'modify',
			input: {
				command: 'trash node_modules',
				cwd: 'src',
				untouched: 'keep me',
			},
		})
	})

	it('logs a helpful message when a rewritten trash command fails', async () => {
		const { toolUseID } = await amp.fireToolCall({ cmd: 'rm -rf node_modules' })
		await amp.fireToolResult(toolUseID, 'error', { error: 'command not found: trash' })
		const matched = amp.logs.find((l) => l.includes("If 'trash' is not installed"))
		expect(matched).toBeTruthy()
		expect(matched).toContain('rm -rf node_modules')
	})

	it('does not log a trash hint when the rewritten command succeeded', async () => {
		const { toolUseID } = await amp.fireToolCall({ cmd: 'rm -rf node_modules' })
		await amp.fireToolResult(toolUseID, 'done')
		const matched = amp.logs.find((l) => l.includes("If 'trash' is not installed"))
		expect(matched).toBeFalsy()
	})

	it('ignores tool.result for tool calls it did not rewrite', async () => {
		await amp.fireToolCall({ cmd: 'ls -la' }) // not rewritten
		await amp.fireToolResult('toolu_unrelated', 'error', { error: 'whatever' })
		const matched = amp.logs.find((l) => l.includes("If 'trash' is not installed"))
		expect(matched).toBeFalsy()
	})

	it('logs and allows in-workspace apply_patch deletes without prompting', async () => {
		const { result } = await amp.fireRawToolCall('apply_patch', {
			input: '*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch\n',
		})
		expect(result).toEqual({ action: 'allow' })
		expect(amp.confirmCalls.length).toBe(0)
		const logged = amp.logs.find(
			(l) => l.includes('apply_patch will delete') && l.includes('src/old.ts'),
		)
		expect(logged).toBeTruthy()
	})

	it('prompts when apply_patch deletes a file outside the workspace', async () => {
		const a = makeAmp({ confirmAnswers: [true] })
		const { result } = await a.fireRawToolCall('apply_patch', {
			input: '*** Begin Patch\n*** Delete File: /tmp/danger.txt\n*** End Patch\n',
		})
		expect(a.confirmCalls.length).toBe(1)
		expect(a.confirmCalls[0]!.message).toContain('/tmp')
		expect(result).toEqual({ action: 'allow' })
	})

	it('rejects when user denies an outside-workspace apply_patch delete', async () => {
		const a = makeAmp({ confirmAnswers: [false] })
		const { result } = await a.fireRawToolCall('apply_patch', {
			input: '*** Begin Patch\n*** Delete File: /tmp/danger.txt\n*** End Patch\n',
		})
		expect(result.action).toBe('reject-and-continue')
		expect(result.message).toContain('/tmp')
	})
})
