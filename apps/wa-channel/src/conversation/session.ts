// Conversation session (FR-WA-03): one per phone number in Redis `wa:conv:{phone}`, JSON, TTL
// since the last message (default 30 minutes). A new keyword replaces the session. A stored value
// that does not parse (older version, corruption) counts as no session.
import { z } from 'zod';

import { KEYS, type KeyValueStore } from '../store.js';

export const STEPS = [
  'MENU',
  'WALKIN_SERVICE',
  'BOOKING_SERVICE',
  'BOOKING_DATE',
  'BOOKING_SLOT',
  'CANCEL_PICK',
] as const;
export type Step = (typeof STEPS)[number];

const optionSchema = z.object({
  /** Reply id of the button or list row (e.g. "svc:<uuid>"). */
  id: z.string().min(1).max(256),
  /** Short title shown on the button or row. */
  title: z.string(),
  /** Full text of the numbered line in the message body. */
  label: z.string(),
  description: z.string().optional(),
});
export type MenuOption = z.infer<typeof optionSchema>;

const cancelItemSchema = z.object({
  kind: z.enum(['TICKET', 'BOOKING']),
  tenant: z.object({ id: z.string(), name: z.string() }),
  location: z.object({ id: z.string(), code: z.string() }),
  item_id: z.string(),
  label: z.string(),
});
export type CancelItem = z.infer<typeof cancelItemSchema>;

const contextSchema = z.object({
  location_name: z.string(),
  timezone: z.string(),
  service_mode: z.enum(['WALK_IN', 'RESERVATION', 'BOTH']),
  show_wait_estimate: z.boolean(),
  greeting: z.string().nullable(),
  resource_label: z.string().nullable(),
});
export type LocationContext = z.infer<typeof contextSchema>;

const sessionSchema = z.object({
  v: z.literal(1),
  /** null only for a pending BATAL choice of a number without a tenant session. */
  tenant: z.object({ id: z.string(), name: z.string() }).nullable(),
  location: z.object({ id: z.string(), code: z.string() }).nullable(),
  context: contextSchema.nullable(),
  step: z.enum(STEPS),
  /** Options of the last prompt, in order: reply "1" picks options[0]. */
  options: z.array(optionSchema),
  /** Last prompt, to repeat it after an invalid answer. */
  prompt: z.object({ intro: z.string(), footer: z.string() }).nullable(),
  draft: z.object({
    service_id: z.string().optional(),
    service_name: z.string().optional(),
    date: z.string().optional(),
    page: z.number().int().min(0).optional(),
    cancel_items: z.array(cancelItemSchema).optional(),
  }),
  /** Consecutive answers that matched no option. */
  invalid: z.number().int().min(0),
});
export type Session = z.infer<typeof sessionSchema>;

export class SessionStore {
  private readonly store: KeyValueStore;
  private readonly ttlMs: number;

  constructor(store: KeyValueStore, ttlSeconds: number) {
    this.store = store;
    this.ttlMs = ttlSeconds * 1000;
  }

  async load(phone: string): Promise<Session | null> {
    const raw = await this.store.get(KEYS.session(phone));
    if (raw === null) return null;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = sessionSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }

  /** Writes the session and restarts its TTL. */
  async save(phone: string, session: Session): Promise<void> {
    await this.store.set(KEYS.session(phone), JSON.stringify(session), this.ttlMs);
  }

  async delete(phone: string): Promise<void> {
    await this.store.delete(KEYS.session(phone));
  }
}
