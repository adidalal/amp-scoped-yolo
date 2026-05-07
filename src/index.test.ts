import { describe, expect, it } from 'bun:test'
import { parseDeletes, rewriteRmToTrash } from './index.ts'

describe('parseDeletes', () => {
	it('detects no deletes in unrelated commands', () => {
		expect(parseDeletes('ls -la /tmp').hasDelete).toBe(false)
		expect(parseDeletes('echo rm is not a delete').hasDelete).toBe(false)
		expect(parseDeletes('npm run dev').hasDelete).toBe(false)
	})

	it('detects rm and extracts paths', () => {
		const r = parseDeletes('rm -rf /tmp/foo /tmp/bar')
		expect(r.hasDelete).toBe(true)
		expect(r.paths).toEqual(['/tmp/foo', '/tmp/bar'])
	})

	it('detects rmdir', () => {
		const r = parseDeletes('rmdir build')
		expect(r.hasDelete).toBe(true)
		expect(r.paths).toEqual(['build'])
	})

	it('handles -- terminator', () => {
		const r = parseDeletes('rm -rf -- -weird-name --also-weird')
		expect(r.paths).toEqual(['-weird-name', '--also-weird'])
	})

	it('handles env var prefix', () => {
		const r = parseDeletes('FOO=1 BAR=2 rm a b')
		expect(r.hasDelete).toBe(true)
		expect(r.paths).toEqual(['a', 'b'])
	})

	it('finds rm inside compound commands', () => {
		const r = parseDeletes('mkdir tmp && rm -rf old && echo done')
		expect(r.hasDelete).toBe(true)
		expect(r.paths).toEqual(['old'])
	})

	it('strips quotes from paths', () => {
		const r = parseDeletes(`rm -f "hello world.txt" 'a b'`)
		expect(r.paths).toEqual(['hello world.txt', 'a b'])
	})

	it('does not match rm as a substring', () => {
		expect(parseDeletes('charm-cli build').hasDelete).toBe(false)
		expect(parseDeletes('npm run rm-task').hasDelete).toBe(false)
	})
})

describe('rewriteRmToTrash', () => {
	it('rewrites simple rm', () => {
		expect(rewriteRmToTrash('rm -rf node_modules')).toBe('trash node_modules')
	})

	it('rewrites rm with multiple paths', () => {
		expect(rewriteRmToTrash('rm -f a.log b.log c.log')).toBe('trash a.log b.log c.log')
	})

	it('rewrites rmdir', () => {
		expect(rewriteRmToTrash('rmdir build')).toBe('trash build')
	})

	it('preserves other commands in a compound', () => {
		expect(rewriteRmToTrash('mkdir tmp && rm -rf old && echo done')).toBe(
			'mkdir tmp && trash old && echo done',
		)
	})

	it('preserves env prefix', () => {
		expect(rewriteRmToTrash('FOO=1 rm a b')).toBe('FOO=1 trash a b')
	})

	it('preserves quoted paths', () => {
		expect(rewriteRmToTrash(`rm -rf "hello world.txt" 'a b'`)).toBe(
			`trash "hello world.txt" 'a b'`,
		)
	})

	it('handles -- terminator', () => {
		expect(rewriteRmToTrash('rm -rf -- -weird-name')).toBe('trash -weird-name')
	})

	it('leaves non-rm commands untouched', () => {
		const cmd = 'echo hello && ls -la /tmp'
		expect(rewriteRmToTrash(cmd)).toBe(cmd)
	})

	it('does not touch rm appearing inside quotes', () => {
		expect(rewriteRmToTrash(`echo "rm -rf danger"`)).toBe(`echo "rm -rf danger"`)
	})
})
