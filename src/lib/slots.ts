export const DEFAULT_WEEKLY_SLOTS = 3;

export interface KvNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface SlotsStatus {
  slots: number;
  label: string;
  urgent: boolean;
}

export function parseSlotsValue(raw: unknown): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return DEFAULT_WEEKLY_SLOTS;
    }
    return Math.min(9, Math.max(0, Math.round(raw)));
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return DEFAULT_WEEKLY_SLOTS;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_WEEKLY_SLOTS;
    }
    return Math.min(9, Math.max(0, Math.round(parsed)));
  }

  return DEFAULT_WEEKLY_SLOTS;
}

export function getSlotsStatus(raw: unknown): SlotsStatus {
  const slots = parseSlotsValue(raw);

  if (slots === 0) {
    return {
      slots: 0,
      label: 'Fully booked this week — now booking next week in Edmonton',
      urgent: true,
    };
  }

  if (slots === 1) {
    return {
      slots: 1,
      label: 'Only 1 open slot left in Edmonton this week',
      urgent: true,
    };
  }

  if (slots <= 3) {
    return {
      slots,
      label: `${slots} open slots left in Edmonton this week`,
      urgent: true,
    };
  }

  return {
    slots,
    label: `${slots} open slots available in Edmonton this week`,
    urgent: false,
  };
}
