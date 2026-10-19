import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

/** Where published stills live. Keys are content-addressed, so nothing is ever overwritten. */
export interface Storage {
  exists(path: string): Promise<boolean>
  put(path: string, body: Buffer | string, contentType: string, immutable?: boolean): Promise<void>
  /** Every path under a prefix. */
  list(prefix: string): Promise<Set<string>>
  describe(): string
}

export class LocalStorage implements Storage {
  constructor(private root: string) {}
  describe() {
    return this.root
  }
  async exists(path: string) {
    try {
      await stat(join(this.root, path))
      return true
    } catch {
      return false
    }
  }
  async put(path: string, body: Buffer | string) {
    const file = join(this.root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, body)
  }
  async list(prefix: string) {
    const found = new Set<string>()
    const walk = async (dir: string) => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await walk(path)
        else found.add(relative(this.root, path).split('\\').join('/'))
      }
    }
    await walk(join(this.root, prefix))
    return found
  }
}

/**
 * Cloudflare R2 through its S3 API: no egress fees, served from a custom domain through
 * Cloudflare's CDN. Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
 */
export class R2Storage implements Storage {
  private client: S3Client
  private bucket: string
  constructor(env = process.env) {
    const missing = [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
    ].filter((k) => !env[k])
    if (missing.length) throw new Error(`Missing ${missing.join(', ')} for R2 storage.`)
    this.bucket = env.R2_BUCKET!
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      },
    })
  }
  describe() {
    return `r2://${this.bucket}`
  }
  async exists(path: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: path }))
      return true
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFound') return false
      throw error
    }
  }
  async put(path: string, body: Buffer | string, contentType: string, immutable = true) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        Body: body,
        ContentType: contentType,
        CacheControl: immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
      }),
    )
  }
  async list(prefix: string) {
    const found = new Set<string>()
    let token: string | undefined
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      )
      for (const object of page.Contents ?? []) if (object.Key) found.add(object.Key)
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return found
  }
}

export function storageFrom(args: { out?: string; r2?: boolean }): Storage {
  if (args.r2) return new R2Storage()
  return new LocalStorage(args.out ?? 'out')
}
