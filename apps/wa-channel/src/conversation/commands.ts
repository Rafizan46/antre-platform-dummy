// Classification of an inbound text (FR-WA-03, FR-WA-06): the QR keyword
// `ANTRE <slug> <kode_lokasi>`, a global command (MENU, STATUS, BATAL, BANTUAN, STOP), or an
// answer to the current prompt. Matching ignores case and surrounding whitespace.
import { locationCodeSchema, slugSchema } from '@antre/shared-types';

export type GlobalCommand = 'MENU' | 'STATUS' | 'BATAL' | 'BANTUAN' | 'STOP';

export type ParsedInput =
  | { kind: 'keyword'; slug: string; code: string }
  /** Starts with ANTRE but the slug or code is missing or malformed. */
  | { kind: 'invalid-keyword' }
  | { kind: 'command'; command: GlobalCommand }
  | { kind: 'answer' };

const COMMANDS: Record<string, GlobalCommand> = {
  MENU: 'MENU',
  STATUS: 'STATUS',
  'CEK STATUS': 'STATUS',
  BATAL: 'BATAL',
  BANTUAN: 'BANTUAN',
  HELP: 'BANTUAN',
  STOP: 'STOP',
  BERHENTI: 'STOP',
};

/** Reply ids of buttons that run a global command. */
const COMMAND_REPLY_IDS: Record<string, GlobalCommand> = {
  'cmd:menu': 'MENU',
  'cmd:status': 'STATUS',
  'cmd:batal': 'BATAL',
};

const KEYWORD_PATTERN = /^ANTRE(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i;

export function parseInput(text: string | null, replyId: string | null): ParsedInput {
  if (replyId !== null && Object.hasOwn(COMMAND_REPLY_IDS, replyId)) {
    return { kind: 'command', command: COMMAND_REPLY_IDS[replyId]! };
  }
  if (text === null) return { kind: 'answer' };
  const normalized = text.trim().replace(/\s+/g, ' ');

  const keyword = KEYWORD_PATTERN.exec(normalized);
  if (keyword !== null || /^ANTRE\b/i.test(normalized)) {
    const slug = keyword?.[1]?.toLowerCase();
    const code = keyword?.[2]?.toLowerCase();
    if (
      slug !== undefined &&
      code !== undefined &&
      slugSchema.safeParse(slug).success &&
      locationCodeSchema.safeParse(code).success
    ) {
      return { kind: 'keyword', slug, code };
    }
    return { kind: 'invalid-keyword' };
  }

  const upper = normalized.toUpperCase();
  if (Object.hasOwn(COMMANDS, upper)) return { kind: 'command', command: COMMANDS[upper]! };
  return { kind: 'answer' };
}
