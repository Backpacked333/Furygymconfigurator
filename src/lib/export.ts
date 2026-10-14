import {
  ADDONS,
  FINISHES,
  FLOORS,
  catalogItem,
  estimate,
  money,
  shareUrl,
  type Config,
} from './config'

export function downloadFile(name: string, content: string | Blob, type = 'application/json') {
  const url = URL.createObjectURL(
    typeof content === 'string' ? new Blob([content], { type }) : content,
  )
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export async function createBrief(
  config: Config,
  image: string | null,
  project: { name: string; notes: string },
) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF(),
    estimateData = estimate(config)
  let y = 0
  const heading = (title: string) => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    const lines = doc.splitTextToSize(title, 174) as string[]
    if (y + lines.length * 6 > 262) {
      doc.addPage()
      y = 22
    }
    doc.setTextColor(35, 44, 33)
    doc.text(lines, 18, y)
    y += lines.length * 6 + 3
  }
  const text = (value: string, size = 10) => {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(size)
    doc.setTextColor(78, 83, 73)
    const lines = doc.splitTextToSize(value, 174) as string[]
    for (const line of lines) {
      if (y > 269) {
        doc.addPage()
        y = 22
      }
      doc.text(line, 18, y)
      y += size * 0.48
    }
    y += 3
  }
  doc.setFillColor(35, 42, 34)
  doc.rect(0, 0, 210, 39, 'F')
  doc.setTextColor(214, 233, 158)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(23)
  doc.text('FURY / S-SERIES', 18, 22)
  doc.setFontSize(8)
  doc.text('YOUR STUDIO. YOUR WAY.', 18, 31)
  y = 53
  heading(project.name || `My S-${config.length} studio`)
  text(
    `Concept build brief / ${new Date().toLocaleDateString('en-US')} / Pricing model: ${estimateData.version}`,
  )
  if (image) {
    const props = doc.getImageProperties(image),
      width = Math.min(174, (85 * props.width) / props.height),
      height = (width * props.height) / props.width
    doc.addImage(image, 'PNG', 18 + (174 - width) / 2, y, width, height)
    y += height + 12
  }
  heading('01 / Your configuration')
  const finish = FINISHES.find((f) => f.id === config.finish)!.name
  text(
    `S-${config.length}: ${config.length} ft L x 8 ft W x 10 ft H / ${config.length * 8} sq ft gross floor area.\nExterior: ${finish}${config.accent ? ' with cedar accent cladding' : ''}.\nFloor: ${FLOORS.find((f) => f.id === config.flooring)!.name}. Mirror wall: ${config.mirror ? 'Yes' : 'No'}.\nOutdoor: ${
      ADDONS.filter((a) => config.addons[a.id])
        .map((a) => a.name)
        .join(', ') || 'No additions'
    }.`,
  )
  if (y > 210) {
    doc.addPage()
    y = 22
  }
  heading('02 / Illustrative estimate (USD)')
  for (const line of estimateData.lines) {
    if (y > 258) {
      doc.addPage()
      y = 22
    }
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(78, 83, 73)
    doc.text(line.name, 18, y)
    doc.text(money(line.amount), 192, y, { align: 'right' })
    y += 7
  }
  y += 3
  heading(`Illustrative total: ${money(estimateData.total)}`)
  text(
    'Not a quotation or an offer. All prices are demonstration assumptions, not an approved company price list. Tax, shipping, crane access, foundation, site work, permits, utility connections and installation are excluded. Availability, specifications and engineering require confirmation.',
    9,
  )
  doc.addPage()
  y = 22
  heading('03 / Interior floor plan')
  text(
    'Concept footprint layout. Not for construction. Dimensions in feet; front entry at the bottom. Equipment is generic, with no partner endorsement or manufacturer clearance approval.',
    9,
  )
  const scale = Math.min(174 / config.length, 10),
    left = 18,
    top = y + 5
  doc.setFillColor(231, 234, 223)
  doc.setDrawColor(70, 82, 62)
  doc.rect(left, top, config.length * scale, 8 * scale, 'FD')
  for (const item of config.items) {
    const p = catalogItem(item.sku),
      w = item.rotation === 0 ? p.w : p.d,
      d = item.rotation === 0 ? p.d : p.w
    const x = left + (item.x + config.length / 2 - w / 2) * scale,
      z = top + (item.z + 4 - d / 2) * scale
    doc.setFillColor(187, 204, 164)
    doc.rect(x, z, w * scale, d * scale, 'FD')
    doc.setFontSize(6)
    doc.text(doc.splitTextToSize(p.name, w * scale - 2), x + 1, z + 4)
  }
  y = top + 8 * scale + 13
  text(`${config.length} ft x 8 ft external footprint. Equipment positions:`, 10)
  for (const item of config.items)
    text(
      `${catalogItem(item.sku).name}: x ${item.x} ft, z ${item.z} ft, rotation ${item.rotation} degrees.`,
      9,
    )
  if (project.notes.trim()) {
    heading('04 / Project notes')
    text(project.notes.slice(0, 2000))
  }
  const continuationNotice =
    'The link works wherever this application is hosted. Local development links require the application to be running at that address. This brief is downloaded to your device; it has not been sent to a sales team.'
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  const continuationHeight =
    9 + 10 + doc.splitTextToSize(continuationNotice, 174).length * 9 * 0.48 + 3
  if (y + continuationHeight > 269) {
    doc.addPage()
    y = 22
  }
  heading('Continue this design')
  doc.setFontSize(10)
  doc.setTextColor(61, 94, 39)
  doc.textWithLink('Open the interactive configuration', 18, y, { url: shareUrl(config) })
  y += 10
  text(continuationNotice, 9)
  for (let page = 1; page <= doc.getNumberOfPages(); page++) {
    doc.setPage(page)
    doc.setFontSize(7)
    doc.setTextColor(120, 125, 111)
    doc.text('FURY / S-SERIES  -  CONCEPT ONLY  -  NOT FOR CONSTRUCTION', 18, 285)
    doc.text(`${page} / ${doc.getNumberOfPages()}`, 192, 285, { align: 'right' })
  }
  return doc
}
export async function exportBrief(
  config: Config,
  image: string | null,
  project: { name: string; notes: string },
) {
  const doc = await createBrief(config, image, project)
  doc.save(`Fury-S${config.length}-build-brief.pdf`)
}
