import { describe, expect, it } from 'bun:test'
import { parseDeletes, parseFileToolDeletes, rewriteRmToTrash } from './index.ts'

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

	it('detects unlink and extracts paths', () => {
		const r = parseDeletes('unlink /tmp/foo.txt')
		expect(r.hasDelete).toBe(true)
		expect(r.paths).toEqual(['/tmp/foo.txt'])
	})

	it('detects find ... -delete and extracts find paths', () => {
		const r = parseDeletes('find /tmp/old -name "*.log" -delete')
		expect(r.hasDelete).toBe(true)
		expect(r.paths).toEqual(['/tmp/old'])
	})

	it('detects find ... -exec rm', () => {
		const r = parseDeletes('find /tmp/old -type f -exec rm -f {} +')
		expect(r.hasDelete).toBe(true)
		expect(r.paths).toEqual(['/tmp/old'])
	})

	it('detects find with multiple roots', () => {
		const r = parseDeletes('find a b c -delete')
		expect(r.hasDelete).toBe(true)
		expect(r.paths).toEqual(['a', 'b', 'c'])
	})

	it('defaults find path to "." when omitted', () => {
		const r = parseDeletes('find -name "*.tmp" -delete')
		expect(r.hasDelete).toBe(true)
		expect(r.paths).toEqual(['.'])
	})

	it('ignores find without a delete action', () => {
		expect(parseDeletes('find /tmp -name "*.log"').hasDelete).toBe(false)
	})

	it('detects xargs rm but extracts no paths', () => {
		const r = parseDeletes('xargs -0 rm -rf')
		expect(r.hasDelete).toBe(true)
		expect(r.paths).toEqual([])
	})

	it('does not match xargs with a non-deletion command', () => {
		expect(parseDeletes('xargs echo hi').hasDelete).toBe(false)
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

	it('rewrites unlink', () => {
		expect(rewriteRmToTrash('unlink /tmp/foo.txt')).toBe('trash /tmp/foo.txt')
	})

	it('rewrites find -delete to find -exec trash {} +', () => {
		expect(rewriteRmToTrash('find /tmp/old -name "*.log" -delete')).toBe(
			'find /tmp/old -name "*.log" -exec trash {} +',
		)
	})

	it('rewrites find -exec rm to find -exec trash', () => {
		expect(rewriteRmToTrash('find /tmp/old -type f -exec rm -f {} +')).toBe(
			'find /tmp/old -type f -exec trash {} +',
		)
	})

	it('rewrites find -execdir rm to find -execdir trash', () => {
		expect(rewriteRmToTrash('find . -type f -execdir rm -rf {} \\;')).toBe(
			'find . -type f -execdir trash {} \\;',
		)
	})

	it('leaves find without delete actions untouched', () => {
		expect(rewriteRmToTrash('find /tmp -name "*.log" -print')).toBe(
			'find /tmp -name "*.log" -print',
		)
	})

	it('rewrites xargs rm to xargs trash and drops rm flags', () => {
		expect(rewriteRmToTrash('xargs -0 rm -rf')).toBe('xargs -0 trash')
	})

	it('rewrites find ... | xargs rm', () => {
		expect(rewriteRmToTrash('find . -name "*.tmp" -print0 | xargs -0 rm -f')).toBe(
			'find . -name "*.tmp" -print0 | xargs -0 trash',
		)
	})

	it('preserves xargs flags with arguments', () => {
		expect(rewriteRmToTrash('xargs -n 1 -P 4 rm -rf')).toBe('xargs -n 1 -P 4 trash')
	})

	it('leaves xargs with non-deletion command untouched', () => {
		expect(rewriteRmToTrash('xargs -0 echo hi')).toBe('xargs -0 echo hi')
	})
})

describe('parseFileToolDeletes', () => {
	it('returns empty for non-apply_patch tools', () => {
		expect(
			parseFileToolDeletes('edit_file', { path: 'foo', content: '*** Delete File: x' }),
		).toEqual([])
	})

	it('returns empty when input has no Delete File markers', () => {
		expect(
			parseFileToolDeletes('apply_patch', {
				input: '*** Begin Patch\n*** Update File: a\n*** End Patch\n',
			}),
		).toEqual([])
	})

	it('extracts a single Delete File path', () => {
		expect(
			parseFileToolDeletes('apply_patch', {
				input: '*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch\n',
			}),
		).toEqual(['src/old.ts'])
	})

	it('extracts multiple Delete File paths and dedupes', () => {
		expect(
			parseFileToolDeletes('apply_patch', {
				input:
					'*** Begin Patch\n' +
					'*** Delete File: a.ts\n' +
					'*** Delete File: b/c.ts\n' +
					'*** Delete File: a.ts\n' +
					'*** End Patch\n',
			}),
		).toEqual(['a.ts', 'b/c.ts'])
	})

	it('handles paths with spaces', () => {
		expect(
			parseFileToolDeletes('apply_patch', {
				input: '*** Begin Patch\n*** Delete File: hello world.txt\n*** End Patch\n',
			}),
		).toEqual(['hello world.txt'])
	})

	it('returns empty for non-object input', () => {
		expect(parseFileToolDeletes('apply_patch', null)).toEqual([])
		expect(parseFileToolDeletes('apply_patch', 'not-an-object')).toEqual([])
	})
})
