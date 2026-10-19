import { Moon, Sun } from 'lucide-react'

/** Restored clock values stay intact until the customer explicitly chooses a lighting preset. */
export function DayNightSetting({
  time,
  onChange,
  label,
}: {
  time: number
  onChange: (time: number) => void
  label: string
}) {
  const night = time < 6 || time >= 19
  return (
    <div className="setting-row">
      <span>{label}</span>
      <div className="segmented" role="group" aria-label="Scene lighting">
        <button
          className={!night ? 'active' : ''}
          aria-pressed={!night}
          onClick={() => onChange(12)}
        >
          <Sun size={13} aria-hidden="true" /> Day
        </button>
        <button className={night ? 'active' : ''} aria-pressed={night} onClick={() => onChange(21)}>
          <Moon size={13} aria-hidden="true" /> Night
        </button>
      </div>
    </div>
  )
}
