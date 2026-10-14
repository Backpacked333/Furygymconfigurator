const URI_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$'
export const DOCUMENT_LIMITS = { encodedChars: 12_000, decodedChars: 16_000 } as const

// LZ-string's URI bitstream, with limits enforced before allocating output/dictionary entries.
export function boundedDecompress(
  input: string,
  limit: number = DOCUMENT_LIMITS.decodedChars,
): string | null {
  if (
    !input ||
    input.length > DOCUMENT_LIMITS.encodedChars ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  )
    return null
  const values = [...input.replace(/ /g, '+')].map((character) => URI_ALPHABET.indexOf(character))
  if (values.some((value) => value < 0)) return null
  let index = 0,
    position = 32,
    exhausted = false
  const bits = (count: number) => {
    let result = 0
    for (let bit = 0; bit < count; bit++) {
      if (index >= values.length) {
        exhausted = true
        return 0
      }
      if (values[index] & position) result += 2 ** bit
      position >>= 1
      if (position === 0) {
        position = 32
        index++
      }
    }
    return result
  }
  const first = bits(2)
  if (first === 2) return ''
  if (first !== 0 && first !== 1) return null
  let previous = String.fromCharCode(bits(first === 0 ? 8 : 16))
  const dictionary: string[] = []
  dictionary[3] = previous
  const output = [previous]
  let size = 4,
    width = 3,
    remaining = 4,
    length = 1
  while (!exhausted && index <= values.length && size <= limit * 2 + 4) {
    let code = bits(width)
    if (exhausted) return null
    if (code === 2) return output.join('')
    if (code === 0 || code === 1) {
      dictionary[size++] = String.fromCharCode(bits(code === 0 ? 8 : 16))
      code = size - 1
      remaining--
    }
    if (remaining === 0) {
      remaining = 2 ** width
      width++
    }
    const entry = dictionary[code] ?? (code === size ? previous + previous[0] : null)
    if (exhausted || entry === null || length + entry.length > limit || previous.length + 1 > limit)
      return null
    output.push(entry)
    length += entry.length
    dictionary[size++] = previous + entry[0]
    remaining--
    previous = entry
    if (remaining === 0) {
      remaining = 2 ** width
      width++
    }
  }
  return null
}
