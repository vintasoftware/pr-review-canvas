// @vitest-environment node
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { makeTempDir } from '../testing/fakes.js'
import { writeJsonAtomic, writeTextAtomic } from './atomic-json.js'

describe.each([
  {
    name: 'JSON',
    write: (file: string) => writeJsonAtomic(file, { value: 'complete' }),
    expected: '{\n  "value": "complete"\n}\n',
  },
  {
    name: 'text',
    write: (file: string) => writeTextAtomic(file, 'complete\n'),
    expected: 'complete\n',
  },
])('atomic $name writes', ({ write, expected }) => {
  let dir: string
  beforeEach(async () => {
    dir = await makeTempDir()
    vi.spyOn(Date, 'now').mockReturnValue(1789160662564)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('completes concurrent writes in the same millisecond without leaving temporary files', async () => {
    const file = path.join(dir, 'record')
    const results = await Promise.allSettled([write(file), write(file), write(file)])

    expect(results).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ])
    expect(await readFile(file, 'utf8')).toBe(expected)
    expect(await readdir(dir)).toEqual(['record'])
  })

  it('cleans up temporary files when the destination cannot be replaced', async () => {
    const destination = path.join(dir, 'record')
    await mkdir(destination)
    await writeFile(path.join(destination, 'keep.txt'), 'keep')

    await expect(write(destination)).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['record'])
    expect(await readFile(path.join(destination, 'keep.txt'), 'utf8')).toBe('keep')
  })
})
