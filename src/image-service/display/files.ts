import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
  writeFileSync,
  linkSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'

export const hash = (bytes: Uint8Array | string) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export const opaqueId = () => randomBytes(24).toString('base64url')

/** Private local storage, not a same-UID security sandbox. No symlink adoption or recursive mkdir. */
export class DisplayDirectory {
  private readonly inode: number
  private readonly device: number
  constructor(
    readonly path: string,
    create = true,
  ) {
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      realpathSync(dirname(path)) !== dirname(path)
    )
      throw new Error('Unsafe display directory.')
    if (!existsSync(path) && create) mkdirSync(path, { mode: 0o700 })
    const stat = lstatSync(path)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(path) !== path ||
      stat.mode & 0o077
    )
      throw new Error('Display directory must be private and real.')
    this.inode = stat.ino
    this.device = stat.dev
  }
  assert() {
    const stat = lstatSync(this.path)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(this.path) !== this.path ||
      stat.ino !== this.inode ||
      stat.dev !== this.device ||
      stat.mode & 0o077
    )
      throw new Error('Display directory replaced.')
  }
  file(name: string) {
    this.assert()
    if (basename(name) !== name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/.test(name))
      throw new Error('Invalid display filename.')
    return join(this.path, name)
  }
  names(max: number) {
    this.assert()
    const names = readdirSync(this.path)
    if (names.length > max) throw new Error('Display directory capacity exceeded.')
    return names
  }
  has(name: string) {
    return existsSync(this.file(name))
  }
  size(name: string, maxBytes: number) {
    const stat = lstatSync(this.file(name))
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > maxBytes ||
      stat.mode & 0o077
    )
      throw new Error('Invalid private display file.')
    return stat.size
  }
  read(name: string, maxBytes: number) {
    const fd = openSync(this.file(name), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size < 1 ||
        stat.size > maxBytes ||
        stat.mode & 0o077
      )
        throw new Error('Invalid private display file.')
      const bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, null)
        if (!count) throw new Error('Private display file truncated.')
        offset += count
      }
      if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0)
        throw new Error('Private display file grew.')
      const after = fstatSync(fd)
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new Error('Private display file changed.')
      this.assert()
      return bytes
    } finally {
      closeSync(fd)
    }
  }
  exclusive(name: string, bytes: Uint8Array) {
    const fd = openSync(
      this.file(name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.sync()
  }
  /** Commit with no overwrite; a partial staging file never looks complete. */
  publish(name: string, bytes: Uint8Array) {
    const pending = `pending-${opaqueId()}`
    this.exclusive(pending, bytes)
    linkSync(this.file(pending), this.file(name))
    unlinkSync(this.file(pending))
    this.sync()
  }
  sync() {
    const fd = openSync(
      this.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}
