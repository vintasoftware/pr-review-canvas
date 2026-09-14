// @vitest-environment node
import { buildSkillCommand } from './skill-command.js'

describe('buildSkillCommand', () => {
  it('names the PR and adds --force only when a canvas exists', () => {
    expect(buildSkillCommand(278, { force: false })).toBe('/pr-review-canvas 278')
    expect(buildSkillCommand(278, { force: true })).toBe('/pr-review-canvas 278 --force')
  })
})
