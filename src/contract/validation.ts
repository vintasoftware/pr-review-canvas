/** The problems `pr-review validate` and `publish` report, one line each. */
export const VALIDATION_CODES = [
  'SCHEMA',
  'TEXT_TOO_LONG',
  'CHUNK_UNASSIGNED',
  'CHUNK_DUPLICATE',
  'CHUNK_UNKNOWN',
  'PATH_UNKNOWN',
  'LAYER_EMPTY',
  'LAYER_KEY_DUPLICATE',
  'OTHER_DUPLICATE',
  'OTHER_NOT_LAST',
  'TEST_NOT_LAST',
  'TEST_IN_OTHER',
  'RISK_IN_OTHER',
  'ANNOTATION_OUTSIDE_CHUNK',
  'FOLD_INVALID',
  'POINT_OUTSIDE_DIFF',
  'TOO_MANY_POINTS',
  'TEST_PATH_UNKNOWN',
  'LINK_UNRESOLVED',
  'DIAGRAM_NODE_UNKNOWN',
  'DIAGRAM_LIMIT',
] as const
export type ValidationCode = (typeof VALIDATION_CODES)[number]

export interface ValidationError {
  code: ValidationCode
  /** One line that stands on its own, without the code. */
  message: string
  /** Where in the output the problem sits, for tools: `summary`, `layer:<key>`, `point:<n>`. */
  where?: string
}

export interface ValidationReport {
  ok: boolean
  errors: ValidationError[]
}

/** The line a human reads: the code, then the message. */
export function formatValidationError(error: ValidationError): string {
  return `${error.code} ${error.message}`
}
