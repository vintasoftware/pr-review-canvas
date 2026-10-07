import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { lock } from 'proper-lockfile'
import { createFakeGit, makeTempDir } from '../testing/fakes.js'
import { createCanvasStore } from './canvas-store.js'

const children: ChildProcess[] = []
let root: string
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
  if (root) await rm(root, { recursive: true, force: true })
})

it('preserves writes, revisions, and PR associations from separate processes', async () => {
  root = await makeTempDir('canvas-concurrency-')
  const worker = path.join(root, 'writer.mjs')
  await writeFile(
    worker,
    `
    import { createCanvasStore } from ${JSON.stringify(new URL('./canvas-store.ts', import.meta.url).href)};
    import { createFakeGit } from ${JSON.stringify(new URL('../testing/fakes.ts', import.meta.url).href)};
    import { syntheticArtifact } from ${JSON.stringify(new URL('../testing/synthetic.ts', import.meta.url).href)};
    const store = createCanvasStore(process.argv[2], createFakeGit(), null);
    const number = Number(process.argv[3]);
    const sha = String(number).padStart(40, '0');
    const artifact = syntheticArtifact();
    const manifest = {
      formatVersion: 1, tool: { name: 'pr-review', version: '0.5.0' },
      repo: artifact.pr.repo, headSha: sha, mergeBaseSha: artifact.pr.mergeBaseSha,
      baseRef: 'main', headRef: 'feature', generatedAt: artifact.generatedAt, generator: artifact.generator,
    };
    const go = new Promise(resolve => process.once('message', resolve));
    process.send('ready');
    await go;
    await store.write(sha, artifact, manifest);
    await store.revise(sha, { ...artifact, revisedAt: '2026-09-20T12:00:00.000Z',
      settled: { 'fp-2': { reason: 'Preserve this answer', at: '2026-09-20T12:00:00.000Z' } } });
    await store.attachPrNumber(sha, number);
    process.disconnect();
  `
  )
  // Hold the real lock until all workers are ready, then let their updates contend for it.
  const release = await lock(root, { lockfilePath: path.join(root, 'index.json.lock') })
  const numbers = [42, 43, 44, 45]
  const exits: Array<Promise<unknown>> = []
  try {
    await Promise.all(
      numbers.map(async number => {
        const child = fork(worker, [root, String(number)], { execArgv: ['--import', 'tsx'], silent: true })
        children.push(child)
        let stderr = ''
        child.stderr?.on('data', chunk => {
          stderr += String(chunk)
        })
        exits.push(
          once(child, 'exit').then(([code]) => {
            expect(code, stderr).toBe(0)
            return code
          })
        )
        await once(child, 'message')
      })
    )
    for (const child of children) child.send('go')
  } finally {
    await release()
  }
  await Promise.all(exits)
  const index = await createCanvasStore(root, createFakeGit(), null).readIndex()
  expect(Object.keys(index.canvases)).toHaveLength(numbers.length)
  for (const number of numbers) {
    const sha = String(number).padStart(40, '0')
    expect(index.canvases[sha]).toMatchObject({ prNumber: number, revisedAt: '2026-09-20T12:00:00.000Z' })
    const artifact = JSON.parse(await readFile(path.join(root, 'canvases', sha, 'review.json'), 'utf8'))
    expect(artifact.settled['fp-2'].reason).toBe('Preserve this answer')
  }
}, 20_000)

it('releases the index lock after a failed update', async () => {
  root = await makeTempDir('canvas-concurrency-')
  const store = createCanvasStore(root, createFakeGit(), null)
  await expect(store.attachPrNumber('0'.repeat(40), 42)).resolves.toBeUndefined()
  await writeFile(path.join(root, 'index.json'), '{broken')
  await expect(store.attachPrNumber('0'.repeat(40), 42)).rejects.toThrow()
  await writeFile(path.join(root, 'index.json'), '{"canvases":{}}')
  await expect(store.attachPrNumber('0'.repeat(40), 42)).resolves.toBeUndefined()
})
