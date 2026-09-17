// @vitest-environment node
import { TEST_REPO } from '../testing/fakes.js'
import { gitlabAttachments } from './attachments.js'

const ATTACHMENTS = gitlabAttachments('gitlab.com', 'https://gitlab.com')
const NAME = 'pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip'

describe('gitlabAttachments', () => {
  it('reads markdown links, project-relative uploads, and full URLs on this instance, once each', () => {
    const text = [
      `[${NAME}](/uploads/abc/${NAME})`,
      `/uploads/abc/${NAME}`,
      `https://gitlab.com/acme/widgets/uploads/def/${NAME}`,
      `[other.zip](https://github.com/acme/widgets/uploads/x/other.zip)`,
    ].join('\n')
    expect(ATTACHMENTS.findLinks(text, TEST_REPO)).toEqual([
      { url: `https://gitlab.com/acme/widgets/uploads/abc/${NAME}`, name: NAME },
      { url: `https://gitlab.com/acme/widgets/uploads/def/${NAME}`, name: NAME },
    ])
  })

  it('refuses links that are not https on this instance', () => {
    expect(ATTACHMENTS.findLinks('[x.zip](not a url)', TEST_REPO)).toEqual([])
    expect(ATTACHMENTS.findLinks('[x.zip](http://gitlab.com/x.zip)', TEST_REPO)).toEqual([])
    expect(ATTACHMENTS.findLinks('[x.zip](https://evil.example/uploads/a/x.zip)', TEST_REPO)).toEqual([])
  })

  it('discovers uploads only on the configured HTTPS port', () => {
    const attachments = gitlabAttachments('gitlab.example.com:8443', 'https://gitlab.example.com:8443')
    expect(attachments.findLinks(`[${NAME}](/uploads/abc/${NAME})`, TEST_REPO)).toEqual([
      { url: `https://gitlab.example.com:8443/acme/widgets/uploads/abc/${NAME}`, name: NAME },
    ])
    expect(
      attachments.findLinks('[x.zip](https://gitlab.example.com:9443/uploads/a/x.zip)', TEST_REPO)
    ).toEqual([])
  })

  it('allows the instance alone and sends the token as a Bearer header', () => {
    expect(ATTACHMENTS.allowedHosts).toEqual(new Set(['gitlab.com']))
    expect(ATTACHMENTS.authHeader('tok')).toEqual({ authorization: 'Bearer tok' })
  })
})
