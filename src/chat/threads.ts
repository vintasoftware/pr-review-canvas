// A chat thread is one acpx session plus the transcript of what was said in it. Both are named
// after the pull request, so two repositories never share a session and a name can never point
// outside the chat directory.
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { type ChatTurn, ChatTurnSchema } from '../contract/chat.js'
import type { Repo } from '../contract/review-artifact.js'
import type { ChatThread } from '../contract/state.js'
import { isNotFound } from '../store/atomic-json.js'

/** Only these characters make it into a session name, so the name is also a safe file name. */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function threadName(repo: Repo, prNumber: number, agent: string, index: number): string {
  return `pr-review-${slug(repo.owner)}-${slug(repo.name)}-${prNumber}-${slug(agent)}-t${index}`
}

const NAME_RE = /^pr-review-[a-z0-9-]+-(\d+)-[a-z0-9-]+-t(\d+)$/

/** True when the name is one this tool could have made for this pull request. */
export function isThreadNameFor(name: string, prNumber: number): boolean {
  const m = NAME_RE.exec(name)
  return m !== null && m[1] === String(prNumber)
}

/** The next `t<k>`: one past the highest index already used on this pull request. */
export function nextThreadIndex(threads: readonly ChatThread[]): number {
  let highest = 0
  for (const thread of threads) {
    const m = NAME_RE.exec(thread.name)
    const index = m?.[2] === undefined ? 0 : Number(m[2])
    highest = Math.max(highest, index)
  }
  return highest + 1
}

/** The thread list's label for a thread, taken from its first message. */
export const THREAD_TITLE_MAX = 60

/** What a thread is called until it carries a message. */
export const NEW_THREAD_TITLE = 'New thread'

export function threadTitle(firstMessage: string): string {
  const oneLine = firstMessage.replace(/\s+/g, ' ').trim()
  if (oneLine === '') {
    return NEW_THREAD_TITLE
  }
  return oneLine.length <= THREAD_TITLE_MAX ? oneLine : `${oneLine.slice(0, THREAD_TITLE_MAX - 1)}…`
}

export interface TranscriptStore {
  dir(prNumber: number): string
  file(prNumber: number, name: string): string
  eventsFile(prNumber: number, name: string): string
  read(prNumber: number, name: string): Promise<ChatTurn[]>
  append(prNumber: number, name: string, turn: ChatTurn): Promise<void>
  /** Appends one already-scrubbed acpx line to the raw event log. */
  appendEvent(prNumber: number, name: string, line: string): Promise<void>
}

export function createTranscriptStore(prDir: (prNumber: number) => string): TranscriptStore {
  const dir = (prNumber: number): string => path.join(prDir(prNumber), 'chat')
  const named = (prNumber: number, name: string, suffix: string): string => {
    if (!isThreadNameFor(name, prNumber)) {
      throw new Error(`not a chat thread of pull request ${prNumber}: ${name}`)
    }
    return path.join(dir(prNumber), `${name}${suffix}`)
  }
  const appendLine = async (file: string, line: string): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, `${line}\n`, 'utf8')
  }
  return {
    dir,
    file: (prNumber, name) => named(prNumber, name, '.jsonl'),
    eventsFile: (prNumber, name) => named(prNumber, name, '.events.ndjson'),
    async read(prNumber, name) {
      let text: string
      try {
        text = await readFile(named(prNumber, name, '.jsonl'), 'utf8')
      } catch (err) {
        if (isNotFound(err)) {
          return []
        }
        throw err
      }
      const turns: ChatTurn[] = []
      for (const line of text.split('\n')) {
        if (line.trim() === '') {
          continue
        }
        let raw: unknown
        try {
          raw = JSON.parse(line) as unknown
        } catch {
          continue
        }
        const parsed = ChatTurnSchema.safeParse(raw)
        if (parsed.success) {
          turns.push(parsed.data)
        }
      }
      return turns
    },
    append: (prNumber, name, turn) => appendLine(named(prNumber, name, '.jsonl'), JSON.stringify(turn)),
    appendEvent: (prNumber, name, line) => appendLine(named(prNumber, name, '.events.ndjson'), line),
  }
}
