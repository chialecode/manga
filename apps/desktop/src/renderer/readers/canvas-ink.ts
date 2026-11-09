/** Whether any pixel of a canvas has been painted: an ASS renderer's canvas is transparent where there is no subtitle. Kept apart from the
 * screenshot code so the subtitle hooks (which light open uses too) do not bring screenshots and danmaku with them. */
export function hasInk(canvas: HTMLCanvasElement): boolean {
  if (canvas.width <= 0 || canvas.height <= 0) return false;
  const context = canvas.getContext("2d");
  if (!context) return false;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let at = 3; at < data.length; at += 4) if (data[at]! > 0) return true;
  return false;
}
