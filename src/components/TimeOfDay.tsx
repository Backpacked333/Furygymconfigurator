import { Moon, Sun } from 'lucide-react'

/** "16:30" for a time of day in hours. */
const clockTime = (time: number) =>
  `${Math.floor(time)}:${String(Math.round((time % 1) * 60)).padStart(2, '0')}`

/**
 * The time-of-day slider, with its heading and the clock time: in the Setting panel and in the
 * stage's Adjust scene popover.
 */
export function TimeOfDay({
  time,
  onChange,
  label,
}: {
  time: number
  onChange: (time: number) => void
  label: string
}) {
  return (
    <>
      <div className="section-label separated">
        {label} <span>{clockTime(time)}</span>
      </div>
      <input
        className="time-slider"
        type="range"
        min="6"
        max="21"
        step="0.25"
        value={time}
        aria-label="Time of day"
        aria-valuetext={clockTime(time)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="time-labels">
        <span>
          <Sun size={13} /> Morning
        </span>
        <span>
          <Moon size={13} /> After dark
        </span>
      </div>
    </>
  )
}
