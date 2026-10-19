/** Node-only provision authority. Never imported by the display client or private GPU page.
 * Reading a provision is not issuing one. No default, env override, repair or reset path exists. */
import {
  constants,
  existsSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { z } from 'zod'
import { displayIdSchema } from './contract'
import { localDisplayPermitSchema } from './session'

export const DISPLAY_OPERATOR_DIRECTORY =
  '/home/ubuntu/Documents/fury-display-handoff/private-display-operator'
export const DISPLAY_OPERATOR_PATH = `${DISPLAY_OPERATOR_DIRECTORY}/operator.json`
export const displayOperatorSchema = z
  .object({
    version: z.literal(1),
    permit: localDisplayPermitSchema,
    ownerId: displayIdSchema,
    credential: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export function loadDisplayOperator() {
  if (!existsSync(DISPLAY_OPERATOR_DIRECTORY)) return null
  for (const path of [DISPLAY_OPERATOR_DIRECTORY, DISPLAY_OPERATOR_PATH]) {
    if (realpathSync(path) !== path) throw new Error('Unsafe display operator path.')
  }
  const dir = openSync(
    DISPLAY_OPERATOR_DIRECTORY,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const info = fstatSync(dir)
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error('Display operator directory must be private and owned.')
  } finally {
    closeSync(dir)
  }
  const file = openSync(DISPLAY_OPERATOR_PATH, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(file)
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > 8192 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0
    )
      throw new Error('Display operator file must be bounded, private and owned.')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(file, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error('Display operator file truncated.')
      offset += count
    }
    const after = fstatSync(file)
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('Display operator changed during read.')
    return displayOperatorSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    )
  } finally {
    closeSync(file)
  }
}
