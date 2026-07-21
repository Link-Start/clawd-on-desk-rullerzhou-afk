// Tray flash icons (#722).
//
// The completion flash blinks the menu bar / taskbar icon between the normal
// icon and a highlight dot. The highlight asset is a 32×32 PNG, the macOS
// normal icon is a 16pt template (16×16 plus an @2x sibling). Loading the
// highlight as a plain 32×32 image therefore handed the menu bar an icon that
// was logically twice as wide, so every blink resized the icon and shoved the
// neighbouring status items sideways.
//
// On macOS the 32px asset is added as the @2x representation of a 16pt image
// so both frames occupy the exact same slot. Windows / Linux trays work in
// raw pixels and both assets are already normalised to 32×32 there.

const TRAY_POINT_SIZE = 16; // macOS menu bar works in points
const TRAY_PIXEL_SIZE = 32; // Windows / Linux trays work in pixels

function loadTrayNormalIcon({ nativeImage, platform, templatePath, iconPath }) {
  if (platform === "darwin") {
    const icon = nativeImage.createFromPath(templatePath);
    icon.setTemplateImage(true);
    return icon;
  }
  return nativeImage
    .createFromPath(iconPath)
    .resize({ width: TRAY_PIXEL_SIZE, height: TRAY_PIXEL_SIZE });
}

function loadTrayFlashIcon({ nativeImage, platform, flashPath, fileExists }) {
  if (!fileExists(flashPath)) return null;

  const src = nativeImage.createFromPath(flashPath);
  if (!src || src.isEmpty()) return null;

  if (platform !== "darwin") {
    return src.resize({ width: TRAY_PIXEL_SIZE, height: TRAY_PIXEL_SIZE });
  }

  // Point size = pixels / scaleFactor, so a 32px @2x representation renders in
  // the same 16pt box as the template icon — no reflow while flashing.
  const scaled = nativeImage.createEmpty();
  try {
    scaled.addRepresentation({ scaleFactor: 2, dataURL: src.toDataURL() });
    if (!scaled.isEmpty()) return scaled;
  } catch {
    // addRepresentation is unavailable or rejected the payload — fall through.
  }

  // Fallback: downscale to the same point size. Softer, but still stable-width.
  return src.resize({ width: TRAY_POINT_SIZE, height: TRAY_POINT_SIZE });
}

module.exports = { loadTrayNormalIcon, loadTrayFlashIcon, TRAY_POINT_SIZE, TRAY_PIXEL_SIZE };
