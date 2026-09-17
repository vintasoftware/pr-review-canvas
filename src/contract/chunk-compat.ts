/** Read fields from canvases and configs written before the chunk terminology change. */
function renameField(value: unknown, previous: string, current: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !(previous in value)) {
    return value
  }
  const { [previous]: oldValue, ...renamed } = value as Record<string, unknown>
  if (!(current in renamed)) renamed[current] = oldValue
  return renamed
}

export function readChunkFields(value: unknown): unknown {
  return renameField(value, 'hunks', 'chunks')
}

export function readChunkLimit(value: unknown): unknown {
  return renameField(value, 'smallPrHunks', 'smallPrChunks')
}
