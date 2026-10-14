const punctuation: Record<string, string> = {
  '′': "'",
  '″': '"',
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  '→': '->',
  '×': 'x',
}

export function pdfText(value: string): string {
  const normalized = value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[′″‘’“”–—…→×]/g, (character) => punctuation[character])
  if (/[^\t\n\x20-\x7e\xa0-\xff]/u.test(normalized))
    throw new Error(
      'The PDF font supports Latin-script text and common punctuation only. Remove unsupported characters from the project name or notes, or use the configuration JSON to preserve your original text.',
    )
  return normalized
}

export function validateProject(project: { name: string; notes: string }) {
  if (project.name.length > 60 || project.notes.length > 2000)
    throw new Error('Use up to 60 characters for the project name and 2,000 for notes.')
  return { name: pdfText(project.name), notes: pdfText(project.notes) }
}
