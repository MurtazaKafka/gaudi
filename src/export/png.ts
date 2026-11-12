/** SVG → PNG in the browser: let the browser draw the vector sheet onto a canvas. */

/** CSS pixels per millimetre at 96 dpi. */
const PX_PER_MM = 96 / 25.4;
/** Longest edge we ask a canvas for (Safari refuses much more). */
const MAX_EDGE = 4800;

export async function svgToPng(svg: string, widthMm: number, heightMm: number, density = 3): Promise<Blob> {
  const scale = Math.min(density * PX_PER_MM, MAX_EDGE / Math.max(widthMm, heightMm));
  const w = Math.round(widthMm * scale);
  const h = Math.round(heightMm * scale);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Couldn't draw the sheet."));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Couldn't draw the sheet.");
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't make the image."))), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
