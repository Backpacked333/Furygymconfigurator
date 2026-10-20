import { createMockArtifact, type MockArtifact } from './protocol'
import type { MockLease } from './store'

export type FakeOutcome = 'success' | 'known-failure' | 'unknown-failure' | 'wrong-artifact'
export class FakeRenderFailure extends Error {
  constructor(readonly outcome: 'known' | 'unknown') {
    super('Injected local mock failure.')
  }
}

/** The sole renderer. No URLs, network clients, engine processes, credentials or provider adapters. */
export class FakeRenderer {
  readonly mode = 'mock-diagnostic' as const
  private readonly outcomes: FakeOutcome[]
  private readonly held: boolean
  private readonly releases: (() => void)[] = []
  calls = 0

  constructor(options: { outcomes?: readonly FakeOutcome[]; held?: boolean } = {}) {
    this.outcomes = [...(options.outcomes ?? [])]
    this.held = options.held ?? false
  }

  get pending(): number {
    return this.releases.length
  }
  /** A deterministic test gate, not a wall-clock sleep. */
  releaseNext(): void {
    this.releases.shift()?.()
  }

  async render(lease: MockLease): Promise<MockArtifact> {
    this.calls++
    const outcome = this.outcomes.shift() ?? 'success'
    if (this.held) await new Promise<void>((resolve) => this.releases.push(resolve))
    if (outcome === 'known-failure') throw new FakeRenderFailure('known')
    if (outcome === 'unknown-failure') throw new FakeRenderFailure('unknown')
    const artifact = await createMockArtifact(lease.design)
    return outcome === 'wrong-artifact'
      ? { ...artifact, checksum: `sha256:${'0'.repeat(64)}` }
      : artifact
  }
}
