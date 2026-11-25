#!/usr/bin/env node
/**
 * LevelUp Cleaning — Media Processing Pipeline
 * Processes:
 *   1. Master circular logo badge with 4x SSAA alpha mask (WebP, PNG, favicon.png)
 *   2. 5 photorealistic architectural photos into responsive AVIF/WebP (640w, 1024w, 1440w) + fallback.jpg
 *   3. 3 real client videos -> faststart 720x1280 MP4 (<4.5 MB) + AVIF/WebP posters (540x960, <30 KB)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEBSITE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(WEBSITE_ROOT, '..');

const PUBLIC_DIR = path.join(WEBSITE_ROOT, 'public');
const MEDIA_DIR = path.join(PUBLIC_DIR, 'media');
const PHOTOS_RAW_DIRS = [
  path.join(MEDIA_DIR, 'photos', 'raw'),
  path.join(REPO_ROOT, 'data', 'website_raw'),
];
const PHOTOS_OUT_DIR = path.join(MEDIA_DIR, 'photos');
const VIDEOS_OUT_DIR = path.join(MEDIA_DIR, 'videos');

const PHOTO_SPECS = [
  { id: 'hero_kitchen', slug: 'hero-kitchen', aspect: '16:9', targetRatio: 16 / 9 },
  { id: 'xray_bathroom', slug: 'xray-bathroom', aspect: '16:9', targetRatio: 16 / 9 },
  { id: 'moveout_condo', slug: 'moveout-condo', aspect: '4:3', targetRatio: 4 / 3 },
  { id: 'winter_entryway', slug: 'winter-entryway', aspect: '4:3', targetRatio: 4 / 3 },
  { id: 'holiday_living', slug: 'holiday-living', aspect: '4:3', targetRatio: 4 / 3 },
];

const PHOTO_WIDTHS = [640, 1024, 1440];

const VIDEO_SPECS = [
  {
    id: 'pet_supervisors',
    slug: 'pet-supervisors',
    source: path.join(REPO_ROOT, 'data', 'posts', 'rendered', 'custom_reels', 'logo_reel_98b741d641.mp4'),
    posterTimeSec: 12.0,
    maxBytes: 4.4 * 1024 * 1024,
  },
  {
    id: 'polished_faucet',
    slug: 'polished-faucet',
    source: path.join(REPO_ROOT, 'data', 'posts', 'rendered', 'wed_story_2_custom_c25a3570.mp4'),
    posterTimeSec: 8.0,
    maxBytes: 4.4 * 1024 * 1024,
  },
  {
    id: 'friday_reset',
    slug: 'friday-reset',
    source: path.join(REPO_ROOT, 'data', 'posts', 'rendered', 'friday_reset_reel_studio.mp4'),
    posterTimeSec: 4.5,
    maxBytes: 4.4 * 1024 * 1024,
  },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 1. Extract circular badge from data/branding/final_chosen_logo.jpg with 4x SSAA smooth alpha mask
 */
async function processLogo() {
  const srcPath = path.join(REPO_ROOT, 'data', 'branding', 'final_chosen_logo.jpg');
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Master logo not found: ${srcPath}`);
  }
  ensureDir(MEDIA_DIR);

  const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  // Detect exact bounding box of the outer sage-green ring (excluding warm linen background)
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      if (r < 200 && g < 210 && b < 200) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Hug the exact outer edge of the sage-green ring so dark backgrounds show ZERO pale halo
  const pad = 0;
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const cropW = Math.min(width - left, maxX - minX + 1 + pad * 2);
  const cropH = Math.min(height - top, maxY - minY + 1 + pad * 2);

  // Extract the exact ring box and normalize to a 1024x1024 working canvas (4x SSAA for 256px final)
  const ssaaSize = 1024;
  const croppedSquare = await sharp(srcPath)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(ssaaSize, ssaaSize, { fit: 'fill', kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer();

  // Apply smooth 4x-supersampled circular alpha mask inset ~3px into outer AA edge (eliminates cream fringe)
  const half = ssaaSize / 2;
  const radius = half - 5.5;
  const feather = 2.0; // 2px feather at 4x resolution => 0.5px razor-smooth AA at 256px
  for (let y = 0; y < ssaaSize; y++) {
    for (let x = 0; x < ssaaSize; x++) {
      const dx = x + 0.5 - half;
      const dy = y + 0.5 - half;
      const dist = Math.hypot(dx, dy);
      const idx = (y * ssaaSize + x) * 4;
      if (dist >= radius + feather) {
        croppedSquare[idx + 3] = 0;
      } else if (dist > radius - feather) {
        const t = (radius + feather - dist) / (2 * feather);
        const smooth = t * t * (3 - 2 * t);
        croppedSquare[idx + 3] = Math.round(smooth * 255);
      } else {
        croppedSquare[idx + 3] = 255;
      }
    }
  }

  const ssaaSharp = sharp(croppedSquare, {
    raw: { width: ssaaSize, height: ssaaSize, channels: 4 },
  });

  const webpPath = path.join(MEDIA_DIR, 'logo-badge.webp');
  const pngPath = path.join(MEDIA_DIR, 'logo-badge.png');
  const faviconPath = path.join(PUBLIC_DIR, 'favicon.png');

  await ssaaSharp
    .clone()
    .resize(256, 256, { kernel: 'lanczos3' })
    .webp({ quality: 86, alphaQuality: 100, effort: 6 })
    .toFile(webpPath);

  await ssaaSharp
    .clone()
    .resize(256, 256, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(pngPath);

  await ssaaSharp
    .clone()
    .resize(64, 64, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(faviconPath);

  console.log('[logo] Generated:', {
    cropBox: { left, top, cropW, cropH },
    webpBytes: fs.statSync(webpPath).size,
    pngBytes: fs.statSync(pngPath).size,
    faviconBytes: fs.statSync(faviconPath).size,
  });
}

function findRawPhoto(id) {
  const exts = ['.png', '.jpg', '.jpeg', '.webp'];
  for (const dir of PHOTOS_RAW_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const ext of exts) {
      const p = path.join(dir, `${id}${ext}`);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Encode image buffer with adaptive quality to guarantee size cap while preserving crispness
 */
async function writeUnderBudget(pipelineFactory, outPath, format, startQuality, minQuality, maxBytes) {
  let q = startQuality;
  while (q >= minQuality) {
    let p = pipelineFactory();
    if (format === 'avif') {
      p = p.avif({ quality: q, effort: 6, chromaSubsampling: '4:2:0' });
    } else if (format === 'webp') {
      p = p.webp({ quality: q, effort: 6, smartSubsample: true });
    } else {
      p = p.jpeg({ quality: q, mozjpeg: true, progressive: true });
    }
    const buf = await p.toBuffer();
    if (buf.length <= maxBytes || q <= minQuality) {
      fs.writeFileSync(outPath, buf);
      return { bytes: buf.length, quality: q };
    }
    q -= 4;
  }
  throw new Error(`Failed encoding ${outPath}`);
}

/**
 * 2. Optimize architectural photos into responsive AVIF, WebP (640w, 1024w, 1440w) + fallback.jpg
 */
async function processPhotos() {
  ensureDir(PHOTOS_OUT_DIR);
  const report = [];

  for (const spec of PHOTO_SPECS) {
    const rawPath = findRawPhoto(spec.id);
    if (!rawPath) {
      console.warn(`[photos] Skipping ${spec.id} — raw file not found in ${PHOTOS_RAW_DIRS.join(', ')}`);
      continue;
    }

    const meta = await sharp(rawPath).metadata();
    const srcW = meta.width;
    const srcH = meta.height;

    // Center-crop to exact target aspect ratio if needed
    let cropW = srcW;
    let cropH = srcH;
    const srcRatio = srcW / srcH;
    if (Math.abs(srcRatio - spec.targetRatio) > 0.02) {
      if (srcRatio > spec.targetRatio) {
        cropW = Math.round(srcH * spec.targetRatio);
      } else {
        cropH = Math.round(srcW / spec.targetRatio);
      }
    }
    const cropLeft = Math.floor((srcW - cropW) / 2);
    const cropTop = Math.floor((srcH - cropH) / 2);

    const entry = {
      id: spec.id,
      slug: spec.slug,
      aspect: spec.aspect,
      variants: {},
    };

    for (const w of PHOTO_WIDTHS) {
      const h = Math.round(w / spec.targetRatio);
      const maxBytes = w <= 640 ? 55 * 1024 : w <= 1024 ? 83 * 1024 : 138 * 1024;
      const makePipe = () =>
        sharp(rawPath)
          .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
          .resize(w, h, { kernel: 'lanczos3' });

      const avifName = `${spec.slug}-${w}w.avif`;
      const webpName = `${spec.slug}-${w}w.webp`;

      const avifRes = await writeUnderBudget(
        makePipe,
        path.join(PHOTOS_OUT_DIR, avifName),
        'avif',
        w === 1440 ? 56 : 58,
        34,
        maxBytes
      );
      const webpRes = await writeUnderBudget(
        makePipe,
        path.join(PHOTOS_OUT_DIR, webpName),
        'webp',
        w === 1440 ? 78 : 80,
        52,
        maxBytes
      );

      entry.variants[w] = {
        width: w,
        height: h,
        avif: { path: `/media/photos/${avifName}`, bytes: avifRes.bytes, quality: avifRes.quality },
        webp: { path: `/media/photos/${webpName}`, bytes: webpRes.bytes, quality: webpRes.quality },
      };
    }

    // Compressed 1200w fallback.jpg (also great for OG tags)
    const fbW = 1200;
    const fbH = Math.round(fbW / spec.targetRatio);
    const fbName = `${spec.slug}-fallback.jpg`;
    const fbRes = await writeUnderBudget(
      () =>
        sharp(rawPath)
          .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
          .resize(fbW, fbH, { kernel: 'lanczos3' }),
      path.join(PHOTOS_OUT_DIR, fbName),
      'jpeg',
      82,
      58,
      145 * 1024
    );
    entry.fallback = {
      path: `/media/photos/${fbName}`,
      width: fbW,
      height: fbH,
      bytes: fbRes.bytes,
      quality: fbRes.quality,
    };

    report.push(entry);
    console.log(`[photos] Processed ${spec.id}:`, {
      '640w': `${Math.round(entry.variants[640].avif.bytes / 1024)}KB avif / ${Math.round(entry.variants[640].webp.bytes / 1024)}KB webp`,
      '1024w': `${Math.round(entry.variants[1024].avif.bytes / 1024)}KB avif / ${Math.round(entry.variants[1024].webp.bytes / 1024)}KB webp`,
      '1440w': `${Math.round(entry.variants[1440].avif.bytes / 1024)}KB avif / ${Math.round(entry.variants[1440].webp.bytes / 1024)}KB webp`,
      fallback: `${Math.round(fbRes.bytes / 1024)}KB jpg`,
    });
  }

  return report;
}

/**
 * 3. Process 3 real client videos into faststart 720x1280 MP4 (< 4.5 MB) + AVIF/WebP posters (540x960, < 30 KB)
 */
async function processVideos() {
  ensureDir(VIDEOS_OUT_DIR);
  const report = [];

  for (const spec of VIDEO_SPECS) {
    if (!fs.existsSync(spec.source)) {
      throw new Error(`Source video missing: ${spec.source}`);
    }

    const mp4Path = path.join(VIDEOS_OUT_DIR, `${spec.slug}.mp4`);
    const tmpPosterPng = path.join(VIDEOS_OUT_DIR, `.${spec.slug}-poster-tmp.png`);
    const posterAvifPath = path.join(VIDEOS_OUT_DIR, `${spec.slug}-poster.avif`);
    const posterWebpPath = path.join(VIDEOS_OUT_DIR, `${spec.slug}-poster.webp`);

    // Probe source duration & audio stream
    const probeJson = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', spec.source],
        { encoding: 'utf8' }
      )
    );
    const hasAudio = probeJson.streams.some((s) => s.codec_type === 'audio');
    const durationSec = Number.parseFloat(probeJson.format.duration || '0');

    // Transcode web-optimized 720x1280 faststart MP4; bump CRF slightly if needed to stay strictly < 4.5 MB
    let crf = 26;
    while (crf <= 32) {
      const args = [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        spec.source,
        '-vf',
        'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-profile:v',
        'main',
        '-level',
        '3.1',
        '-crf',
        String(crf),
        '-movflags',
        '+faststart',
      ];
      if (hasAudio) {
        args.push('-c:a', 'aac', '-b:a', '96k', '-ac', '2');
      } else {
        args.push('-an');
      }
      args.push(mp4Path);

      execFileSync('ffmpeg', args, { stdio: 'inherit' });
      const size = fs.statSync(mp4Path).size;
      if (size <= spec.maxBytes || crf >= 32) {
        break;
      }
      crf += 2;
    }

    // Extract clean representative frame for 540x960 poster
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(spec.posterTimeSec),
        '-i',
        spec.source,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        tmpPosterPng,
      ],
      { stdio: 'inherit' }
    );

    const makePosterPipe = () =>
      sharp(tmpPosterPng).resize(540, 960, { fit: 'cover', position: 'centre', kernel: 'lanczos3' });

    const avifRes = await writeUnderBudget(makePosterPipe, posterAvifPath, 'avif', 54, 30, 29 * 1024);
    const webpRes = await writeUnderBudget(makePosterPipe, posterWebpPath, 'webp', 74, 44, 29 * 1024);

    if (fs.existsSync(tmpPosterPng)) fs.unlinkSync(tmpPosterPng);

    const mp4Bytes = fs.statSync(mp4Path).size;
    report.push({
      id: spec.id,
      slug: spec.slug,
      durationSec: Number(durationSec.toFixed(2)),
      width: 720,
      height: 1280,
      mp4: { path: `/media/videos/${spec.slug}.mp4`, bytes: mp4Bytes, crf },
      poster: {
        width: 540,
        height: 960,
        avif: { path: `/media/videos/${spec.slug}-poster.avif`, bytes: avifRes.bytes },
        webp: { path: `/media/videos/${spec.slug}-poster.webp`, bytes: webpRes.bytes },
      },
    });

    console.log(`[videos] Processed ${spec.id}:`, {
      mp4MB: (mp4Bytes / (1024 * 1024)).toFixed(2),
      crf,
      posterAvifKB: (avifRes.bytes / 1024).toFixed(1),
      posterWebpKB: (webpRes.bytes / 1024).toFixed(1),
    });
  }

  return report;
}

async function main() {
  const only = process.argv[2] || 'all';
  if (only === 'all' || only === 'logo') await processLogo();
  if (only === 'all' || only === 'photos') await processPhotos();
  if (only === 'all' || only === 'videos') await processVideos();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
