#!/usr/bin/env node
import { tsImport } from 'tsx/esm/api'

const cli = await tsImport('../src/cli.ts', import.meta.url)
process.exitCode = await cli.main(process.argv.slice(2))
