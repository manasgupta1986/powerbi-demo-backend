const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function smooth(values, radius = 4) {
  const output = [];
  for (let i = 0; i < values.length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j += 1) {
      sum += values[j];
      count += 1;
    }
    output.push(count ? sum / count : values[i]);
  }
  return output;
}

function buildFallbackBands(height, width) {
  const bands = [];
  const targetHeight = Math.max(700, Math.min(1100, Math.floor(width * 1.15)));
  const overlap = 120;
  let top = 0;
  while (top < height) {
    const bandHeight = Math.min(targetHeight, height - top);
    bands.push({ top, bottom: top + bandHeight });
    if (top + bandHeight >= height) break;
    top += Math.max(300, targetHeight - overlap);
  }
  return bands;
}

function mergeBands(bands, gapTolerance = 40) {
  if (!bands.length) return [];
  const merged = [bands[0]];
  for (let i = 1; i < bands.length; i += 1) {
    const prev = merged[merged.length - 1];
    const current = bands[i];
    if (current.top - prev.bottom <= gapTolerance) prev.bottom = Math.max(prev.bottom, current.bottom);
    else merged.push(current);
  }
  return merged;
}

async function detectChartBands(imagePath) {
  const image = sharp(imagePath).rotate();
  const metadata = await image.metadata();
  const resizedWidth = metadata.width && metadata.width > 1600 ? 1600 : metadata.width;
  const prepared = metadata.width && resizedWidth && metadata.width !== resizedWidth
    ? image.resize({ width: resizedWidth, withoutEnlargement: true })
    : image;

  const { data, info } = await prepared.clone().greyscale().raw().toBuffer({ resolveWithObject: true });
  const rowDensities = [];
  const lightThreshold = 235;
  for (let y = 0; y < info.height; y += 1) {
    let inkCount = 0;
    for (let x = 0; x < info.width; x += 1) {
      const idx = y * info.width + x;
      if (data[idx] < lightThreshold) inkCount += 1;
    }
    rowDensities.push(inkCount / info.width);
  }

  const smoothed = smooth(rowDensities, 5);
  const activeThreshold = Math.max(0.015, Math.min(0.08, average(smoothed) * 0.9));
  const rawBands = [];
  let bandStart = null;
  let emptyGap = 0;

  for (let y = 0; y < smoothed.length; y += 1) {
    const active = smoothed[y] > activeThreshold;
    if (active) {
      if (bandStart === null) bandStart = y;
      emptyGap = 0;
    } else if (bandStart !== null) {
      emptyGap += 1;
      if (emptyGap > 18) {
        rawBands.push({ top: bandStart, bottom: y - emptyGap + 1 });
        bandStart = null;
        emptyGap = 0;
      }
    }
  }
  if (bandStart !== null) rawBands.push({ top: bandStart, bottom: smoothed.length - 1 });

  const expanded = rawBands
    .map((band) => ({ top: Math.max(0, band.top - 35), bottom: Math.min(info.height, band.bottom + 35) }))
    .filter((band) => band.bottom - band.top >= 180);

  return { width: info.width, height: info.height, bands: mergeBands(expanded) };
}

async function createSlicesForImage({ imagePath, outputDir, prefix }) {
  ensureDir(outputDir);
  const base = sharp(imagePath).rotate();
  const meta = await base.metadata();
  const detected = await detectChartBands(imagePath);
  const aspectRatio = meta.height / Math.max(meta.width || 1, 1);
  let bands = detected.bands;
  const isVeryTall = aspectRatio >= 2.0;
  if (isVeryTall && bands.length <= 2) bands = buildFallbackBands(meta.height, meta.width || 1000);
  if (!bands.length) bands = [{ top: 0, bottom: meta.height }];

  const slices = [];
  for (let i = 0; i < bands.length; i += 1) {
    const band = bands[i];
    const height = Math.max(1, band.bottom - band.top);
    const fileName = `${prefix}_slice_${String(i + 1).padStart(2, "0")}.png`;
    const slicePath = path.join(outputDir, fileName);
    await sharp(imagePath)
      .rotate()
      .extract({ left: 0, top: Math.max(0, band.top), width: meta.width, height })
      .png()
      .toFile(slicePath);
    slices.push({ sliceIndex: i + 1, sliceLabel: `slice_${String(i + 1).padStart(2, "0")}`, slicePath, top: band.top, height });
  }

  return { originalWidth: meta.width, originalHeight: meta.height, sliceCount: slices.length, slices };
}

module.exports = { createSlicesForImage };
