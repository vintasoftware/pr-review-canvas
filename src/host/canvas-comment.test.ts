import { CANVAS_COMMENT_MARKER } from '../canvas/comment.js'
import { createHostClient, type CliExec } from './client.js'
import { GITHUB_HOST, gitlabHost } from './host.js'

const repo = { owner: 'team/subgroup', name: 'widgets' }
const date = '2026-09-17T12:00:00Z'

describe.each([GITHUB_HOST, gitlabHost('gitlab.example.com')])('$label canvas comment', host => {
  const github = host.kind === 'github'
  const list = github
    ? 'repos/team/subgroup/widgets/issues/42/comments'
    : 'projects/team%2Fsubgroup%2Fwidgets/merge_requests/42/notes'
  const record = (id: number, author: string, body: string) => ({
    id,
    body,
    created_at: date,
    user: { login: author },
    author: { username: author },
    html_url: `https://github.com/team/subgroup/widgets/pull/42#issuecomment-${id}`,
  })

  it.each([false, true])(
    'creates or updates only the current user’s marked comment (existing=%s)',
    async existing => {
      const calls: Array<{ args: string[]; input?: string }> = []
      const comments = [record(1, 'someone-else', CANVAS_COMMENT_MARKER), record(2, 'me', 'normal comment')]
      if (existing) comments.push(record(3, 'me', CANVAS_COMMENT_MARKER))
      const exec: CliExec = async (args, options = {}) => {
        calls.push({ args, ...(options.input === undefined ? {} : { input: options.input }) })
        const method = args[2]
        const endpoint = args[3]
        let response: unknown
        if (method !== 'GET') response = record(3, 'me', 'new body')
        else if (endpoint === 'user') response = { login: 'me', username: 'me' }
        else if (endpoint === list) response = comments
        else throw new Error(`unexpected request: ${args.join(' ')}`)
        return { stdout: JSON.stringify(response), stderr: '', code: 0, missingBinary: false }
      }
      const url = await host.shareCanvas(createHostClient(host.cli, exec), repo, 42, 'new body')
      expect(url).toContain(github ? '#issuecomment-3' : '#note_3')
      const write = calls.find(c => c.input !== undefined)!
      expect(write.args.slice(0, 4)).toEqual([
        'api',
        '--method',
        existing ? (github ? 'PATCH' : 'PUT') : 'POST',
        existing ? (github ? 'repos/team/subgroup/widgets/issues/comments/3' : `${list}/3`) : list,
      ])
      expect(JSON.parse(write.input!)).toEqual({ body: 'new body' })
      expect(write.args.join(' ')).not.toContain('new body')
    }
  )
})
