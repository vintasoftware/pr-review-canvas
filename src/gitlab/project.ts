import type { Repo } from '../contract/review-artifact.js'

export function gitlabProjectApi(repo: Repo): string {
  return `projects/${encodeURIComponent(`${repo.owner}/${repo.name}`)}`
}

export function gitlabMrUrl(webBase: string, repo: Repo, iid: number): string {
  return `${webBase}/${repo.owner}/${repo.name}/-/merge_requests/${iid}`
}

export function gitlabNoteUrl(webBase: string, repo: Repo, iid: number, noteId: number): string {
  return `${gitlabMrUrl(webBase, repo, iid)}#note_${noteId}`
}
