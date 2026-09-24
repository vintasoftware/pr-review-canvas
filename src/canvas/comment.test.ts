import { syntheticArtifact } from '../testing/synthetic.js'
import { buildCanvasComment, CANVAS_COMMENT_MARKER, readCanvasComment } from './comment.js'

const zip = {
  name: 'pr-42-canvas.zip',
  headSha: 'a'.repeat(40),
  prNumber: 42,
  bytes: Uint8Array.from([0, 1, 255]),
  artifact: syntheticArtifact(),
}

it('round-trips binary bytes in one hidden comment and measures the complete body', () => {
  const body = buildCanvasComment(zip, 65_536)
  expect(body).toContain('Run `pr-review serve`')
  expect(readCanvasComment(body)).toEqual({ name: zip.name, bytes: Buffer.from(zip.bytes) })
  expect(buildCanvasComment(zip, body.length)).toBe(body)
  expect(() => buildCanvasComment(zip, body.length - 1)).toThrow(/host limit/)
})

it('says what the canvas leaves for the reviewer and what the author settled', () => {
  expect(buildCanvasComment(zip, 65_536)).toContain(
    '**For the reviewer:** 1 attention point to judge (1 decide).\n**Not yet settled by the author:** 2.'
  )
  const settled = {
    ...zip,
    artifact: { ...zip.artifact, settled: { 'fp-2': { reason: 'Covered by the e2e suite.', at: 'now' } } },
  }
  expect(buildCanvasComment(settled, 65_536)).toContain(
    '**Settled by the author:** 1, each with its reason in the canvas.\n**Not yet settled by the author:** 1.'
  )
})

it.each([
  'ordinary comment',
  '<!-- pr-review-canvas:v2\npr-42-canvas.zip\nAAH/\n-->',
  `${CANVAS_COMMENT_MARKER}pr-42-canvas.zip\n$bad\n-->`,
  `${CANVAS_COMMENT_MARKER}pr-42-canvas.zip\nAAA\n-->`,
  `${CANVAS_COMMENT_MARKER}pr-42-canvas.zip\n${'A'.repeat(1_000_004)}\n-->`,
])('ignores unsupported or malformed envelopes %#', body => {
  expect(readCanvasComment(body)).toBeNull()
})
