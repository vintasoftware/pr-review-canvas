import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { z } from 'zod'

/** Writes JSON through a temp file and a rename, so a reader never sees a half-written file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  return writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function writeTextAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporaryDir = await mkdtemp(`${file}.`)
  try {
    const tmp = path.join(temporaryDir, 'content')
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, file)
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

/** Parsed and validated JSON, or null when the file does not exist. Invalid content throws. */
export async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if (isNotFound(err)) {
      return null
    }
    throw err
  }
  return schema.parse(JSON.parse(text))
}

/**
 * Like readJson, but a missing file, invalid JSON, or a shape the schema rejects all return
 * `fallback()`. Other read errors still throw.
 */
export async function readJsonOrDefault<T, D>(file: string, schema: z.ZodType<T>, fallback: () => D): Promise<T | D> {
  const text = await readText(file)
  if (text === null) {
    return fallback()
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fallback()
  }
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : fallback()
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    if (isNotFound(err)) {
      return null
    }
    throw err
  }
}

export function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
