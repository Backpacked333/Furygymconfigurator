export type CloudWork =
  | { stage: 'requesting' }
  | { stage: 'uploading'; completed: number; total: number }
  | { stage: 'receiving' }

export type WorkStage = CloudWork | { stage: 'preparing' | 'retrying' | 'unavailable' }

/** These are observations, not percentages of elapsed time or predicted completion. */
export function describeWork(work: WorkStage): { label: string; fraction?: number } {
  switch (work.stage) {
    case 'preparing':
      return { label: 'Preparing your design' }
    case 'requesting':
      return { label: 'Waiting for your cloud-rendered image' }
    case 'uploading':
      return {
        label: 'Sending scene assets · files completed',
        fraction: work.total > 0 ? work.completed / work.total : undefined,
      }
    case 'receiving':
      return { label: 'Receiving your finished image' }
    case 'retrying':
      return { label: 'Renderer busy · retrying automatically' }
    case 'unavailable':
      return { label: 'The finished image is unavailable' }
  }
}
