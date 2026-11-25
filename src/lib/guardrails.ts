export type ForbiddenClaimRule = RegExp & {
  readonly id: string;
  readonly label: string;
  readonly pattern: RegExp;
};

export interface SurfaceSafetyValidationResult {
  valid: boolean;
  reason?: string;
}

function createForbiddenRule(
  id: string,
  label: string,
  pattern: RegExp,
): ForbiddenClaimRule {
  const compiled = new RegExp(pattern.source, pattern.flags);
  return Object.assign(compiled, {
    id,
    label,
    pattern,
  });
}

/**
 * Compiled forbidden-claim rule descriptors aligned 1:1 with
 * `data/site_context_lock.json -> guardrails.forbiddenPatterns`.
 * Each entry is a real RegExp instance augmented with `{ id, label, pattern }`.
 */
export const FORBIDDEN_CLAIM_PATTERNS: readonly ForbiddenClaimRule[] = [
  createForbiddenRule('two_million_numeric', '$2,000,000', /\$2,000,000(?!\d)/i),
  createForbiddenRule('two_million_short', '$2M', /\$2\s*M\b/i),
  createForbiddenRule('insured', 'insured', /\binsured\b/i),
  createForbiddenRule('insurance', 'insurance', /\binsurance\b/i),
  createForbiddenRule('bonded', 'bonded', /\bbonded\b/i),
  createForbiddenRule('wcb', 'WCB', /\bWCB\b/i),
  createForbiddenRule(
    'workers_compensation',
    "Workers' Compensation",
    /workers['’]?\s+compensation/i,
  ),
  createForbiddenRule('free_reclean', 'free re-clean', /free\s+re-?clean/i),
  createForbiddenRule(
    'reclean_guarantee',
    're-clean guarantee',
    /re-?clean\s+guarantee/i,
  ),
  createForbiddenRule(
    'touchup_guarantee',
    'touch-up guarantee',
    /touch-?up\s+guarantee/i,
  ),
  createForbiddenRule('placeholder_phone', '555-LVL1', /555-LVL1/i),
];

/**
 * Scans input text for any prohibited brand, coverage, redo-guarantee, or
 * placeholder-contact claims. Returns matched rule labels (`[]` when clean).
 */
export function scanForbiddenClaims(text: string): string[] {
  if (!text) {
    return [];
  }

  const matched: string[] = [];
  for (const rule of FORBIDDEN_CLAIM_PATTERNS) {
    if (rule.pattern.test(text) && !matched.includes(rule.label)) {
      matched.push(rule.label);
    }
  }
  return matched;
}

const DIY_CHEMISTRY_TRIGGER_REGEX =
  /\b(?:vinegar|citric\s+acid|baking[- ]soda|descal\w*)\b/i;

const PROHIBITED_SURFACE_CHECKS: ReadonlyArray<{
  readonly name: string;
  readonly regex: RegExp;
}> = [
  { name: 'marble', regex: /\bmarble\b/i },
  { name: 'natural stone / travertine', regex: /\b(?:natural\s+stone|stone|travertine)\b/i },
  { name: 'quartz', regex: /\bquartz\b/i },
  { name: 'hardwood', regex: /\bhardwood\b/i },
  { name: 'unsealed grout', regex: /\bunsealed\s+grout\b/i },
  { name: 'matte-black fixtures', regex: /\bmatte[- ]black\b/i },
];

/**
 * Validates that any text mentioning DIY/acid/alkaline cleaning chemistry
 * (`vinegar`, `citric acid`, `baking soda`, `descal*`) explicitly states:
 * 1. Safe ONLY on sealed ceramic/porcelain and chrome scope;
 * 2. Explicit prohibition (NEVER / do not) against marble, stone, quartz,
 *    hardwood, unsealed grout, and matte-black surfaces;
 * 3. Mandatory spot-test instruction.
 */
export function validateSurfaceSafetyCompliance(
  text: string,
): SurfaceSafetyValidationResult {
  if (!text || !DIY_CHEMISTRY_TRIGGER_REGEX.test(text)) {
    return { valid: true };
  }

  const missing: string[] = [];

  const hasSafeOnlyScope =
    /\bonly\b/i.test(text) &&
    /sealed\s+ceramic/i.test(text) &&
    /\bporcelain\b/i.test(text) &&
    /\bchrome\b/i.test(text);

  if (!hasSafeOnlyScope) {
    missing.push(
      'explicit safe-only scope (sealed ceramic/porcelain tile or chrome mesh ONLY)',
    );
  }

  const hasProhibitionDirective = /\b(?:never|do\s+not|don['’]t)\b/i.test(text);
  if (!hasProhibitionDirective) {
    missing.push('explicit prohibition directive (NEVER / do not)');
  }

  const missingSurfaces = PROHIBITED_SURFACE_CHECKS.filter(
    (surface) => !surface.regex.test(text),
  ).map((surface) => surface.name);

  if (missingSurfaces.length > 0) {
    missing.push(
      `prohibited delicate surfaces (${missingSurfaces.join(', ')})`,
    );
  }

  const hasSpotTestRule = /\bspot[- ]test\b/i.test(text);
  if (!hasSpotTestRule) {
    missing.push('mandatory spot-test rule');
  }

  if (missing.length > 0) {
    return {
      valid: false,
      reason: `Surface-safety disclaimer incomplete for DIY/chemistry mention; missing: ${missing.join('; ')}.`,
    };
  }

  return { valid: true };
}
