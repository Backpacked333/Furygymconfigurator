/** Converts a finished still for PNG download or PDF export without loading the 3D engine. */
export async function pngOf(image: Blob | string) {
  let blob: Blob
  if (typeof image === 'string') {
    const response = await fetch(image)
    if (!response.ok) throw new Error('The finished image could not be downloaded.')
    blob = await response.blob()
  } else blob = image
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image export is unavailable in this browser.')
    context.drawImage(bitmap, 0, 0)
    return canvas.toDataURL('image/png')
  } finally {
    bitmap.close()
  }
}
