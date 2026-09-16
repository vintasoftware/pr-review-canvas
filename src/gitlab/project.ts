import type { Repo } from '../contract/review-artifact.js'

/** URL-encoded `group/subgroup/project` as GitLab's `:id` path parameter. */
export function gitlabProjectPath(repo: Repo): string {
  return encodeURIComponent(`${repo.owner}/${repo.name}`)
}

export function gitlabProjectApi(repo: Repo): string {
  return `projects/${gitlabProjectPath(repo)}`
}

export function gitlabMrUrl(webBase: string, repo: Repo, iid: number): string {
  return `${webBase}/${repo.owner}/${repo.name}/-/merge_requests/${iid}`
}

export function gitlabNoteUrl(webBase: string, repo: Repo, iid: number, noteId: number): string {
  return `${gitlabMrUrl(webBase, repo, iid)}#note_${noteId}`
}
