// Audio of the Kiosk TV (FR-REALTIME-03): a two-tone chime synthesised with WebAudio (no audio
// asset) followed by Indonesian text-to-speech (SpeechSynthesis, id-ID). Announcements play one
// after another. Browsers allow audio only after a user gesture (or with an autoplay policy flag
// on kiosk Chromium); `unlock()` is called from the first click.
import type { RealtimeUpdate } from '@antre/messaging/realtime';

const ONES = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan'];

/** 0..9999 in Indonesian words (12 -> "dua belas", 105 -> "seratus lima"). */
export function numberToWords(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 9999) return String(value);
  if (value === 0) return 'nol';
  const parts: string[] = [];
  let rest = value;
  const thousands = Math.floor(rest / 1000);
  if (thousands > 0) parts.push(thousands === 1 ? 'seribu' : `${ONES[thousands]} ribu`);
  rest %= 1000;
  const hundreds = Math.floor(rest / 100);
  if (hundreds > 0) parts.push(hundreds === 1 ? 'seratus' : `${ONES[hundreds]} ratus`);
  rest %= 100;
  if (rest >= 20) {
    parts.push(`${ONES[Math.floor(rest / 10)]} puluh`);
    if (rest % 10 > 0) parts.push(ONES[rest % 10]!);
  } else if (rest >= 12) {
    parts.push(`${ONES[rest - 10]} belas`);
  } else if (rest === 11) {
    parts.push('sebelas');
  } else if (rest === 10) {
    parts.push('sepuluh');
  } else if (rest > 0) {
    parts.push(ONES[rest]!);
  }
  return parts.join(' ');
}

/** "A-012" -> "A, dua belas"; anything else is spoken as is. */
export function spokenTicketNumber(ticketNumber: string): string {
  const match = /^([A-Z]{1,3})-([0-9]+)$/.exec(ticketNumber);
  if (match === null) return ticketNumber;
  const letters = match[1]!.split('').join(' ');
  return `${letters}, ${numberToWords(Number(match[2]))}`;
}

export function announcementText(update: RealtimeUpdate, ticketLabel = 'Nomor antrean'): string {
  const number = spokenTicketNumber(update.ticket_number ?? '');
  const prefix = update.is_recall === true ? 'Panggilan ulang. ' : '';
  return `${prefix}${ticketLabel} ${number}, silakan menuju ${update.resource_name ?? 'loket'}.`;
}

export interface Announcer {
  unlock(): void;
  announce(update: RealtimeUpdate): void;
}

const CHIME_MS = 1300;

type AudioContextConstructor = new () => AudioContext;

export function createAnnouncer(win: Window = window): Announcer {
  let context: AudioContext | null = null;
  let queue: Promise<void> = Promise.resolve();

  const audioContext = (): AudioContext | null => {
    if (context !== null) return context;
    const Ctor =
      (win as unknown as { AudioContext?: AudioContextConstructor }).AudioContext ??
      (win as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
    context = Ctor === undefined ? null : new Ctor();
    return context;
  };

  const chime = (): void => {
    const ctx = audioContext();
    if (ctx === null) return;
    void ctx.resume().catch(() => undefined);
    const start = ctx.currentTime + 0.05;
    [880, 660].forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      const at = start + index * 0.55;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.4, at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.75);
    });
  };

  const speak = (text: string): Promise<void> =>
    new Promise((resolve) => {
      const synth = win.speechSynthesis as SpeechSynthesis | undefined;
      if (synth === undefined || typeof SpeechSynthesisUtterance === 'undefined') {
        resolve();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'id-ID';
      utterance.rate = 0.9;
      const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith('id'));
      if (voice !== undefined) utterance.voice = voice;
      const done = () => resolve();
      utterance.onend = done;
      utterance.onerror = done;
      // Some engines never fire onend; never block the queue for long.
      win.setTimeout(done, 15_000);
      synth.speak(utterance);
    });

  return {
    unlock() {
      void audioContext()
        ?.resume()
        .catch(() => undefined);
    },
    announce(update) {
      const text = announcementText(update);
      queue = queue
        .then(async () => {
          chime();
          await new Promise((resolve) => win.setTimeout(resolve, CHIME_MS));
          await speak(text);
        })
        .catch(() => undefined);
    },
  };
}
