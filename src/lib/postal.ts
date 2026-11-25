import strategyData from '../data/strategy.json';
import type { PostalLookupResult } from '../types/contracts';

interface FsaDirectoryEntry {
  areaName: string;
  municipality: string;
  zoneLabel: string;
  travelFeeCad: number;
}

const FSA_DIRECTORY: Record<string, FsaDirectoryEntry> = strategyData.fsaDirectory;

const FSA_ONLY_PATTERN = /^[A-Z]\d[A-Z]$/;
const FULL_POSTAL_PATTERN = /^[A-Z]\d[A-Z]\d[A-Z]\d$/;

/**
 * Checks whether a 3-character Canadian FSA is within LevelUp Cleaning's
 * supported Greater Edmonton service directory.
 */
export function isSupportedFsa(fsa: string): boolean {
  const normalized = String(fsa ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
  if (!FSA_ONLY_PATTERN.test(normalized)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(FSA_DIRECTORY, normalized);
}

/**
 * Normalizes a 3-character FSA or 6-character Canadian postal code and resolves
 * Greater Edmonton zone details and travel fee ($0 core / $15 Capital Region ring).
 */
export function lookupPostalCode(rawInput: string): PostalLookupResult {
  const cleaned = String(rawInput ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');

  if (!cleaned) {
    return {
      valid: false,
      normalizedFsa: '',
      areaName: '',
      municipality: '',
      zoneLabel: 'Enter Postal Code',
      travelFeeCad: 0,
      message:
        'Enter your 3-character Edmonton FSA (e.g. T5J) or full 6-character postal code.',
    };
  }

  if (!FSA_ONLY_PATTERN.test(cleaned) && !FULL_POSTAL_PATTERN.test(cleaned)) {
    return {
      valid: false,
      normalizedFsa: '',
      areaName: '',
      municipality: '',
      zoneLabel: 'Invalid Postal Format',
      travelFeeCad: 0,
      message:
        'Please enter a valid Canadian postal code or 3-character FSA (e.g. T5K or T6W 1A2).',
    };
  }

  const fsa = cleaned.slice(0, 3);
  const entry = Object.prototype.hasOwnProperty.call(FSA_DIRECTORY, fsa)
    ? FSA_DIRECTORY[fsa]
    : undefined;

  if (!entry) {
    return {
      valid: false,
      normalizedFsa: fsa,
      areaName: '',
      municipality: '',
      zoneLabel: 'Outside Standard Zone',
      travelFeeCad: 0,
      message: `${fsa} is outside our standard Greater Edmonton online zone. Text +1 (780) 710-1503 for custom availability.`,
    };
  }

  const message =
    entry.travelFeeCad === 0
      ? `Serving ${entry.areaName} (${entry.municipality}) — $0 travel fee.`
      : `Serving ${entry.areaName} (${entry.municipality}) — +$${entry.travelFeeCad} CAD Capital Region travel fee.`;

  return {
    valid: true,
    normalizedFsa: fsa,
    areaName: entry.areaName,
    municipality: entry.municipality,
    zoneLabel: entry.zoneLabel,
    travelFeeCad: entry.travelFeeCad,
    message,
  };
}
