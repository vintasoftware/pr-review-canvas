// @vitest-environment node
import { spawn } from 'node:child_process'
import { createAgentRunner } from './acpx.js'

const preparation = vi.hoisted(() => ({ launch: vi.fn() }))
vi.mock('./sandbox-client.js', () => ({
  createSandboxClient: () => preparation.launch,
  agentPathAsync: async (file: string) => file,
}))
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))

it('cancels during preparation without spawning the agent after preparation finishes', async () => {
  let finish!: (command: { file: string; args: string[] }) => void
  preparation.launch.mockReturnValue(
    new Promise(resolve => {
      finish = resolve
    })
  )
  const run = createAgentRunner({ bin: 'fixture' }).run({
    cwd: '/fixture',
    agent: 'claude',
    session: 'test',
    prompt: 'hello',
    timeoutSec: 10,
  })
  const first = run.cancel()
  expect(run.cancel()).toBe(first)
  await first
  finish({ file: 'fixture', args: [] })
  const events = []
  for await (const event of run.events) events.push(event)
  await new Promise(resolve => setImmediate(resolve))
  expect(events).toEqual([{ type: 'done', stopReason: 'cancelled' }])
  expect(spawn).not.toHaveBeenCalled()
})
