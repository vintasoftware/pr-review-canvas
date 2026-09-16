// @vitest-environment node
import { TEST_REPO } from '../testing/fakes.js'
import { gitlabHost } from '../host/host.js'
import { findGitlabAttachmentLinks, gitlabAttachmentHosts, gitlabAuthHeaders } from './attachments.js'

const HOST = gitlabHost('gitlab.com')
const NAME = 'pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip'

describe('findGitlabAttachmentLinks', () => {
  it('reads markdown, relative uploads, and full URLs on this host', () => {
    const text = [
      `[${NAME}](/uploads/abc/${NAME})`,
      `https://gitlab.com/acme/widgets/uploads/def/${NAME}`,
      `[other.zip](https://github.com/acme/widgets/uploads/x/other.zip)`,
    ].join('\n')
    expect(findGitlabAttachmentLinks(text, HOST, TEST_REPO)).toEqual([
      {
        url: `https://gitlab.com/acme/widgets/uploads/abc/${NAME}`,
        name: NAME,
      },
      {
        url: `https://gitlab.com/acme/widgets/uploads/def/${NAME}`,
        name: NAME,
      },
    ])
    expect(findGitlabAttachmentLinks('[x.zip](not a url)', HOST, TEST_REPO)).toEqual([])
    expect(findGitlabAttachmentLinks('[x.zip](http://gitlab.com/x.zip)', HOST, TEST_REPO)).toEqual([])
    expect(gitlabAttachmentHosts(HOST)).toEqual(new Set(['gitlab.com']))
    expect(gitlabAuthHeaders('tok')).toEqual({ authorization: 'Bearer tok' })
  })
})
