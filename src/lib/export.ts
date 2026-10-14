import {
  ADDONS,
  FINISHES,
  FLOORS,
  catalogItem,
  estimate,
  money,
  productName,
  productHeight,
  entryCenter,
  shareUrl,
  type Config,
} from './config'
import {
  CONTAINER_OPENINGS,
  OPENING_CONCEPTS,
  STUDIO_LAYOUTS,
  PROJECT_URL,
  PRODUCT_SOURCE_DATE,
  productFamily,
} from './products'
import { pdfText, validateProject } from './pdfText'
import type { CaptureResult } from './capture'

export type BriefImageEvidence = Omit<Extract<CaptureResult, { blob: Blob }>, 'blob'>

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
  configuration: Config,
  imageInput: string | Uint8Array | null,
  projectInput: { name: string; notes: string },
  evidenceInput?: BriefImageEvidence,
) {
  const config = structuredClone(configuration)
  const project = validateProject({ ...projectInput })
  const image = imageInput instanceof Uint8Array ? imageInput.slice() : imageInput
  const evidence = evidenceInput ? structuredClone(evidenceInput) : undefined
  const configurationUrl = shareUrl(config)
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF(),
    estimateData = estimate(config)
  let y = 0
  const heading = (title: string) => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    const lines = doc.splitTextToSize(pdfText(title), 174) as string[]
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
    const lines = doc.splitTextToSize(pdfText(value), 174) as string[]
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
  doc.text(config.family === 'studio' ? 'FURY / S-SERIES' : 'FURY / CONTAINER', 18, 22)
  doc.setFontSize(8)
  doc.text('YOUR SPACE. YOUR WAY.', 18, 31)
  y = 53
  heading((project.name || `My ${productName(config)}`).replace(/′/g, "'"))
  text(
    `Concept build brief / ${new Date().toLocaleDateString('en-US')} / Source snapshot: ${estimateData.version}`,
  )
  if (image) {
    const props = doc.getImageProperties(image),
      width = Math.min(174, (85 * props.width) / props.height),
      height = (width * props.height) / props.width
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      throw new Error(
        'The scene image has invalid dimensions. Retry or create an image-free brief.',
      )
    if (y + height + 12 > 269) {
      doc.addPage()
      y = 22
    }
    doc.addImage(image, 'PNG', 18 + (174 - width) / 2, y, width, height)
    y += height + 12
    if (evidence)
      text(
        `Current-view concept rendering. Rendered ${evidence.rendered.width} x ${evidence.rendered.height}; encoded ${evidence.encoded.width} x ${evidence.encoded.height}. ${evidence.status === 'degraded' ? 'DEGRADED: ' + evidence.reasons.join('; ') : 'Settled rendering; not manufacturer photography.'}`,
        8,
      )
  } else {
    text(
      'Image-free brief. No scene image is included; use the interactive configuration link to inspect this design.',
      9,
    )
  }
  heading('01 / Your configuration')
  const finish = FINISHES.find((f) => f.id === config.finish)!.name
  text(
    `${productFamily(config.family).name}: ${config.length} ft L x 8 ft W x ${productHeight(config)} ft H / ${config.length * 8} sq ft nominal gross floor area.\nConcept exterior: ${finish}${config.accent ? ' with timber accent' : ''}.\nConcept floor: ${FLOORS.find((f) => f.id === config.flooring)!.name}. Concept mirror wall: ${config.mirror ? 'Yes' : 'No'}.\nOutdoor: ${
      ADDONS.filter((a) => config.addons[a.id])
        .map((a) => a.name)
        .join(', ') || 'No additions'
    }.`,
  )
  if (config.family === 'container')
    text(
      `Opening request: ${CONTAINER_OPENINGS.find((o) => o.id === config.containerOpening)!.name}. Only the featured roll-up width is published; other opening geometry is conceptual.`,
    )
  text(
    `Opening treatment: ${OPENING_CONCEPTS.find((opening) => opening.id === config.openingConcept)!.name}. Presentation pose: ${config.presentation.openingPose}. Nonstandard treatments are reference-backed concepts; rendered mechanics are not manufacturer-approved engineering.`,
    9,
  )
  if (config.presentation.context !== 'product')
    text(
      `Presentation context: ${config.presentation.context}. Custom architecture/site context only; excluded from the configured unit and published family starting price. Discuss this separately with Fury.`,
      9,
    )
  if (config.family === 'studio')
    text(
      `Configuration request: ${STUDIO_LAYOUTS.find((o) => o.id === config.studioLayout)!.name}.${config.studioLayout !== 'single' ? ' The scene and floor plan show one reference unit only, not the requested assembly. Unit count, arrangement, structure and access require Fury review.' : ''}`,
    )
  text('Published features: ' + productFamily(config.family).features, 9)
  if (y > 210) {
    doc.addPage()
    y = 22
  }
  heading('02 / Published starting price (USD)')
  text(
    `${productFamily(config.family).name} base models starting at ${money(estimateData.startingPrice)}. This is a family-level published starting price, not a price for this size or your configured project.`,
  )
  text(`Source checked ${PRODUCT_SOURCE_DATE}: ${estimateData.source}`, 9)
  text(
    'The project inquiry page separately says entry-level projects typically begin at $25,000. That is project guidance, not an additional fee.',
    9,
  )
  heading('Selections requiring a quote')
  for (const line of estimateData.lines) {
    if (y > 258) {
      doc.addPage()
      y = 22
    }
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(78, 83, 73)
    const nameLines = doc.splitTextToSize(line.name.replace(/′/g, "'"), 125) as string[]
    if (y + nameLines.length * 5 > 264) {
      doc.addPage()
      y = 22
    }
    doc.text(nameLines, 18, y)
    doc.text('Quote required', 192, y, { align: 'right' })
    y += Math.max(7, nameLines.length * 5 + 2)
  }
  y += 3
  heading('Configured project: quote required')
  text(
    'Not a quotation or an offer. No configured total or financing estimate has been calculated. Concept finish palettes, equipment and add-on geometry are not approved specifications. Confirm tax, delivery, foundation, site work, permits, utilities and installation with Fury. Availability, support, access and engineering require review.',
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
  doc.setFillColor(205, 218, 184)
  doc.rect(
    left + (entryCenter(config) + config.length / 2 - 1.6) * scale,
    top + 6.3 * scale,
    3.2 * scale,
    1.7 * scale,
    'F',
  )
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
  text(
    `${config.length} ft x 8 ft external footprint of one unit. Shaded zone: planned entry. Equipment positions:`,
    10,
  )
  for (const item of config.items)
    text(
      `${catalogItem(item.sku).name}: x ${item.x} ft, z ${item.z} ft, rotation ${item.rotation} degrees.`,
      9,
    )
  if (project.notes.trim()) {
    heading('04 / Project notes')
    text(project.notes)
  }
  const linkSection = (title: string, label: string, url: string, notice: string) => {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    const sectionHeight = 9 + 10 + doc.splitTextToSize(notice, 174).length * 9 * 0.48 + 3
    if (y + sectionHeight > 269) {
      doc.addPage()
      y = 22
    }
    heading(title)
    doc.setFontSize(10)
    doc.setTextColor(61, 94, 39)
    doc.textWithLink(label, 18, y, { url })
    y += 10
    text(notice, 9)
  }
  linkSection(
    'Continue this design',
    'Open the interactive configuration',
    configurationUrl,
    'The link works wherever this application is hosted. Local development links require the application to be running at that address. This brief is downloaded to your device; it has not been sent to a sales team.',
  )
  linkSection(
    'Request an official quote',
    'Start a project with Fury Co Gyms',
    PROJECT_URL,
    'Opening this link does not send your design. Supply this brief yourself through Fury’s inquiry process. Published product source: ' +
      estimateData.source,
  )
  for (let page = 1; page <= doc.getNumberOfPages(); page++) {
    doc.setPage(page)
    doc.setFontSize(7)
    doc.setTextColor(120, 125, 111)
    doc.text('FURY / GYM CONFIGURATOR  -  CONCEPT ONLY  -  NOT FOR CONSTRUCTION', 18, 285)
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
  doc.save(`Fury-${config.family}-${config.length}-build-brief.pdf`)
}
