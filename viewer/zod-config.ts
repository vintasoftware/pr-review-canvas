// Imported first by main.ts, before any module builds a zod schema. The page's CSP forbids eval,
// and zod v4 probes `Function('')` while building each object schema to decide whether to compile
// its parsers; the browser reports every refused probe as a policy violation.
import { z } from 'zod'

z.config({ jitless: true })
