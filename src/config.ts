import { strict as assert } from 'node:assert'
import * as os from 'node:os'
import * as path from 'node:path'

const expandHome = (p: string): string => {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

assert(process.env.ROOT_PATH, 'ROOT_PATH environment variable must be set')
assert(process.env.HOUSEKEEPING_PATH, 'HOUSEKEEPING_PATH environment variable must be set')

export const ROOT_PATH: string = path.resolve(expandHome(process.env.ROOT_PATH))
export const HOUSEKEEPING_PATH: string = path.resolve(expandHome(process.env.HOUSEKEEPING_PATH))
