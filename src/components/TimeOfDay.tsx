import { Moon, Sun } from 'lucide-react'
import { useRef, useState } from 'react'

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
  const [draft, setDraft] = useState(time)
  const [previous, setPrevious] = useState(time)
  const editing = useRef(false)
  const value = useRef(time)
  if (previous !== time) {
    setPrevious(time)
    setDraft(time)
    value.current = time
  }
  const finish = () => {
    if (!editing.current) return
    editing.current = false
    if (value.current !== time) onChange(value.current)
  }
  const rangeKey = (key: string) =>
    [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ].includes(key)
  return (
    <>
      <div className="section-label separated">
        {label} <span>{clockTime(draft)}</span>
      </div>
      <input
        className="time-slider"
        type="range"
        min="6"
        max="21"
        step="0.25"
        value={draft}
        aria-label="Time of day"
        aria-valuetext={clockTime(draft)}
        onPointerDown={(e) => {
          editing.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerUp={finish}
        onPointerCancel={() => {
          editing.current = false
          value.current = time
          setDraft(time)
        }}
        onKeyDown={(e) => {
          if (rangeKey(e.key)) editing.current = true
        }}
        onKeyUp={(e) => {
          if (rangeKey(e.key)) finish()
        }}
        onBlur={finish}
        onChange={(e) => {
          value.current = Number(e.target.value)
          setDraft(value.current)
          if (!editing.current) onChange(value.current)
        }}
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
