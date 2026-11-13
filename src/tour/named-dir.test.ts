// @vitest-environment node
import { namedTourDir } from './named-dir.js'

describe('namedTourDir', () => {
  it('names no dir for a validate of a model file alone, nor for a bare --tour', () => {
    expect(namedTourDir(['validate', 'model.json'])).toBeUndefined()
    expect(namedTourDir(['validate', 'model.json', '--tour'])).toBeUndefined()
  })

  it("passes over the value of a preview's --landmark to find the dir", () => {
    expect(namedTourDir(['preview', '--landmark', 'world', '/d/tours/x'])).toBe('/d/tours/x')
  })
})
