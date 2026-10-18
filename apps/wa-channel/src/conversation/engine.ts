// Conversation engine of the WA Channel Service (FR-WA-03..08, spec section 5.2). One inbound
// message in, at most one reply out (a single message keeps the order of replies even though the
// Notification Worker sends in parallel). Confirmations of a new ticket or booking are not sent
// from here: they come from the domain events (queue.ticket.created, booking.reservation.held /
// confirmed / cancelled) as approved templates (FR-NOTIF-02, FR-WA-07).
//
// Flow: keyword `ANTRE <slug> <kode>` -> resolve -> wa-context -> main menu by service_mode.
//   Ambil Antrean: service -> POST /queues/tickets.
//   Reservasi: service -> date (open days with free slots in the next 7 days) -> slot (9 per page
//   plus "Slot berikutnya") -> POST /bookings/holds.
//   STATUS / BATAL: always by the verified sender number (customers/active-items), with or
//   without a session.
// Session state is read once and written once per message, after all calls succeeded; a failure
// before that leaves the session untouched and the message is retried.
import type { ActiveItemDto } from '@antre/shared-types';

import {
  CoreApiError,
  type CoreApi,
  type CoreBooking,
  type CoreTicket,
  type CoreWaContext,
} from '../core-client.js';
import type { Logger } from '../logger.js';
import { parseInput } from './commands.js';
import {
  addDays,
  formatDateLong,
  formatDateShort,
  formatRupiah,
  formatSlot,
  localDate,
  zoneLabel,
} from './format.js';
import {
  TEXT,
  cancelOption,
  invalidOptionText,
  optionsMessage,
  paginate,
  statusText,
  textMessage,
  ticketLine,
  type StatusContext,
  type StatusEntry,
  type WaMessage,
} from './messages.js';
import type {
  CancelItem,
  LocationContext,
  MenuOption,
  Session,
  SessionStore,
  Step,
} from './session.js';

export interface InboundInput {
  /** Verified sender number of the webhook. */
  from: string;
  profileName: string | null;
  type: string;
  text: string | null;
  replyId: string | null;
}

export interface TenantRef {
  id: string;
  name: string;
}

export interface LocationRef {
  id: string;
  code: string;
}

export interface Reply {
  /** null when the recipient is not bound to one tenant (spec section 7.1). */
  tenant: TenantRef | null;
  location: LocationRef | null;
  message: WaMessage;
}

export interface EngineDeps {
  core: CoreApi;
  sessions: SessionStore;
  log: Logger;
  now?: () => Date;
}

/** Consecutive invalid answers before the customer is taken back to the main menu. */
export const MAX_INVALID_ANSWERS = 3;
/** Booking dates offered: today and the next 6 days (FR-WA-05). */
export const BOOKING_DAYS = 7;
const DEFAULT_CUSTOMER_NAME = 'Pelanggan';

/** Types answered politely but not processed; reactions and system messages get no answer. */
const SILENT_TYPES = new Set(['reaction', 'system', 'request_welcome']);
const SUPPORTED_TYPES = new Set(['text', 'interactive', 'button']);

const MORE = (title: string): MenuOption => ({ id: 'more', title, label: title });

interface Turn {
  input: InboundInput;
  now: Date;
  /** Session after this message; null = none (deleted if one existed). */
  session: Session | null;
}

interface Entry extends StatusEntry {
  kind: ActiveItemDto['kind'];
  tenant: TenantRef;
  location: LocationRef;
  itemId: string;
}

function toContext(context: CoreWaContext): LocationContext {
  return {
    location_name: context.location.name,
    timezone: context.location.timezone,
    service_mode: context.service_mode,
    show_wait_estimate: context.show_wait_estimate,
    greeting: context.branding.wa_greeting,
    resource_label: context.branding.resource_label,
  };
}

function statusContext(context: CoreWaContext): StatusContext {
  return {
    tenantName: context.tenant.name,
    locationName: context.location.name,
    timeZone: context.location.timezone,
    showEstimate: context.show_wait_estimate,
    resourceLabel: context.branding.resource_label,
  };
}

function matchOption(options: MenuOption[], input: InboundInput): MenuOption | null {
  if (input.replyId !== null) {
    const byId = options.find((option) => option.id === input.replyId);
    if (byId !== undefined) return byId;
  }
  if (input.text === null) return null;
  const text = input.text.trim().replace(/\s+/g, ' ');
  if (/^[0-9]{1,2}$/.test(text)) return options[Number(text) - 1] ?? null;
  const lower = text.toLowerCase();
  return (
    options.find(
      (option) => option.title.toLowerCase() === lower || option.label.toLowerCase() === lower,
    ) ?? null
  );
}

export class ConversationEngine {
  private readonly deps: EngineDeps;
  private readonly now: () => Date;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  async handle(input: InboundInput): Promise<Reply | null> {
    if (SILENT_TYPES.has(input.type)) return null;
    const existing = await this.deps.sessions.load(input.from);
    const turn: Turn = { input, now: this.now(), session: existing };
    const reply = await this.dispatch(turn);
    // Every message restarts the TTL of a live session (FR-WA-03: 30 minutes since the last one).
    if (turn.session !== null) await this.deps.sessions.save(input.from, turn.session);
    else if (existing !== null) await this.deps.sessions.delete(input.from);
    return reply;
  }

  private async dispatch(turn: Turn): Promise<Reply | null> {
    const { input } = turn;
    if (!SUPPORTED_TYPES.has(input.type) || (input.text === null && input.replyId === null)) {
      return this.reply(turn, textMessage(TEXT.unsupported));
    }
    const parsed = parseInput(input.text, input.replyId);
    switch (parsed.kind) {
      case 'keyword':
        return this.start(turn, parsed.slug, parsed.code);
      case 'invalid-keyword':
        return untenanted(textMessage(TEXT.unknownLocation));
      case 'command':
        switch (parsed.command) {
          case 'MENU':
            if (turn.session?.tenant && turn.session.context) return this.mainMenu(turn, null);
            turn.session = null;
            return untenanted(textMessage(TEXT.scanQr));
          case 'STATUS':
            return this.status(turn);
          case 'BATAL':
            return this.cancel(turn);
          case 'BANTUAN':
            return this.reply(turn, textMessage(TEXT.help));
          case 'STOP': {
            // FR-WA has no opt-out; STOP only ends the session (decision S09, see report).
            const reply = this.reply(turn, textMessage(TEXT.stopped));
            turn.session = null;
            return reply;
          }
        }
        break;
      case 'answer':
        if (turn.session === null) return untenanted(textMessage(TEXT.scanQr));
        return this.answer(turn);
    }
    return null;
  }

  // Session start and main menu

  private async start(turn: Turn, slug: string, code: string): Promise<Reply | null> {
    const resolved = await this.deps.core.resolveLocation(slug, code);
    if (resolved === null) return untenanted(textMessage(TEXT.unknownLocation));
    const context = await this.deps.core.waContext(resolved.tenant_id, resolved.location_id);
    if (!context.location.is_active) return untenanted(textMessage(TEXT.unknownLocation));
    // One session per number; a new keyword replaces the old session (FR-WA-03).
    turn.session = {
      v: 1,
      tenant: context.tenant,
      location: { id: context.location.id, code: context.location.code },
      context: toContext(context),
      step: 'MENU',
      options: [],
      prompt: null,
      draft: {},
      invalid: 0,
    };
    return this.mainMenu(turn, null, true);
  }

  private mainMenuState(session: Session, greet: boolean) {
    const context = session.context!;
    const tenantName = session.tenant!.name;
    const options: MenuOption[] = [];
    if (context.service_mode !== 'RESERVATION') {
      options.push({ id: 'menu:walkin', title: 'Ambil Antrean', label: 'Ambil Antrean' });
    }
    if (context.service_mode !== 'WALK_IN') {
      options.push({ id: 'menu:booking', title: 'Reservasi', label: 'Reservasi' });
    }
    options.push({ id: 'menu:status', title: 'Cek Status', label: 'Cek Status' });
    const greeting =
      context.greeting ?? `Selamat datang di ${tenantName} (${context.location_name}).`;
    const intro = greet
      ? `${greeting}\n\nSilakan pilih:`
      : `${tenantName} (${context.location_name}). Silakan pilih:`;
    return { options, prompt: { intro, footer: TEXT.menuFooter } };
  }

  /** Sends the main menu (FR-WA-04): buttons by service_mode, plus "Cek Status". */
  private mainMenu(turn: Turn, notice: string | null, greet = false): Reply {
    const { options, prompt } = this.mainMenuState(turn.session!, greet);
    return this.prompt(turn, 'MENU', options, prompt, notice, {});
  }

  /** Puts the session back on the main menu without sending it (after a ticket or hold). */
  private backToMenu(turn: Turn): void {
    const session = turn.session;
    if (session === null) return;
    if (session.tenant === null || session.context === null) {
      turn.session = null;
      return;
    }
    const { options, prompt } = this.mainMenuState(session, false);
    Object.assign(session, { step: 'MENU', options, prompt, draft: {}, invalid: 0 });
  }

  private prompt(
    turn: Turn,
    step: Step,
    options: MenuOption[],
    prompt: { intro: string; footer: string },
    notice: string | null,
    draft: Session['draft'],
  ): Reply {
    const session = turn.session!;
    Object.assign(session, { step, options, prompt, draft, invalid: 0 });
    return this.reply(turn, optionsMessage(prompt, options, notice));
  }

  private reply(turn: Turn, message: WaMessage): Reply {
    const session = turn.session;
    if (session?.tenant) return { tenant: session.tenant, location: session.location, message };
    return untenanted(message);
  }

  private async refreshContext(turn: Turn): Promise<void> {
    const session = turn.session!;
    const context = await this.deps.core.waContext(session.tenant!.id, session.location!.id);
    session.tenant = context.tenant;
    session.context = toContext(context);
  }

  // Answers to a prompt

  private async answer(turn: Turn): Promise<Reply | null> {
    const session = turn.session!;
    const option = matchOption(session.options, turn.input);
    if (option === null) return this.invalid(turn);
    session.invalid = 0;
    const page = session.draft.page ?? 0;

    switch (session.step) {
      case 'MENU':
        if (option.id === 'menu:walkin') return this.services(turn, 'walkin', 0);
        if (option.id === 'menu:booking') return this.services(turn, 'booking', 0);
        if (option.id === 'menu:status') return this.status(turn);
        break;
      case 'WALKIN_SERVICE':
        if (option.id === 'more') return this.services(turn, 'walkin', page + 1);
        if (option.id.startsWith('svc:')) return this.takeTicket(turn, option.id.slice(4));
        break;
      case 'BOOKING_SERVICE':
        if (option.id === 'more') return this.services(turn, 'booking', page + 1);
        if (option.id.startsWith('svc:')) {
          return this.bookingDates(turn, option.id.slice(4), option.title, null);
        }
        break;
      case 'BOOKING_DATE':
        if (option.id.startsWith('date:')) return this.bookingSlots(turn, option.id.slice(5), 0);
        break;
      case 'BOOKING_SLOT':
        if (option.id === 'more') return this.bookingSlots(turn, session.draft.date!, page + 1);
        if (option.id.startsWith('slot:')) return this.hold(turn, option.id.slice(5));
        break;
      case 'CANCEL_PICK': {
        const index = Number(option.id.slice('cancel:'.length)) - 1;
        const item = session.draft.cancel_items?.[index];
        if (item !== undefined) return this.cancelItem(turn, item);
        break;
      }
    }
    return this.invalid(turn);
  }

  /** Repeats the prompt; after MAX_INVALID_ANSWERS goes back to the main menu (FR-WA-07). */
  private invalid(turn: Turn): Reply {
    const session = turn.session!;
    session.invalid += 1;
    const hasMenu = session.tenant !== null && session.context !== null;
    if (session.invalid >= MAX_INVALID_ANSWERS || session.prompt === null) {
      if (hasMenu) return this.mainMenu(turn, TEXT.backToMenu);
      turn.session = null;
      return untenanted(textMessage(TEXT.scanQr));
    }
    return this.reply(
      turn,
      optionsMessage(session.prompt, session.options, invalidOptionText(session.options.length)),
    );
  }

  private customerName(turn: Turn): string {
    const name = turn.input.profileName?.trim();
    return name ? name.slice(0, 100) : DEFAULT_CUSTOMER_NAME;
  }

  private unexpected(turn: Turn, error: CoreApiError): Reply {
    this.deps.log.warn(
      { code: error.code, status: error.status, step: turn.session?.step ?? null },
      'unexpected core services answer',
    );
    this.backToMenu(turn);
    return this.reply(turn, textMessage(TEXT.requestFailed));
  }

  // Walk-in (FR-WA-04, FR-QUEUE-01) and service lists

  private async services(
    turn: Turn,
    mode: 'walkin' | 'booking',
    page: number,
    notice: string | null = null,
  ): Promise<Reply> {
    const session = turn.session!;
    const services = (
      await this.deps.core.listServices(session.tenant!.id, session.location!.id)
    ).filter((service) => service.is_active);
    if (services.length === 0) return this.mainMenu(turn, TEXT.noServices);

    const { items, hasMore, page: current } = paginate(services, page);
    const options: MenuOption[] = items.map((service) => ({
      id: `svc:${service.id}`,
      title: service.name,
      label:
        mode === 'booking' && service.requires_dp && service.dp_amount !== null
          ? `${service.name} (DP ${formatRupiah(service.dp_amount)})`
          : service.name,
    }));
    if (hasMore) options.push(MORE('Layanan berikutnya'));
    const intro =
      mode === 'walkin'
        ? 'Pilih layanan untuk mengambil nomor antrean:'
        : 'Pilih layanan yang ingin direservasi:';
    return this.prompt(
      turn,
      mode === 'walkin' ? 'WALKIN_SERVICE' : 'BOOKING_SERVICE',
      options,
      { intro, footer: TEXT.listFooter },
      notice,
      { page: current },
    );
  }

  private async takeTicket(turn: Turn, serviceId: string): Promise<Reply | null> {
    const session = turn.session!;
    const tenant = session.tenant!;
    try {
      await this.deps.core.createTicket(tenant.id, {
        location_id: session.location!.id,
        service_id: serviceId,
        customer_phone: turn.input.from,
        customer_name: this.customerName(turn),
      });
      // The confirmation is the antre_ticket_created template of queue.ticket.created.
      this.backToMenu(turn);
      return null;
    } catch (error) {
      if (!(error instanceof CoreApiError)) throw error;
      switch (error.code) {
        case 'QUOTA_EXCEEDED':
          this.backToMenu(turn);
          return this.reply(turn, textMessage(TEXT.queueQuota));
        case 'ACTIVE_TICKET_EXISTS': {
          this.backToMenu(turn);
          const existing = (error.details as { ticket?: CoreTicket } | undefined)?.ticket;
          const context = session.context!;
          const line =
            existing?.ticket_number !== undefined
              ? `\n\n${ticketLine(existing, {
                  tenantName: tenant.name,
                  locationName: context.location_name,
                  timeZone: context.timezone,
                  showEstimate: context.show_wait_estimate,
                  resourceLabel: context.resource_label,
                })}`
              : '';
          return this.reply(
            turn,
            textMessage(
              `Nomor Anda sudah memiliki antrean aktif hari ini di lokasi ini.${line}\n\nKetik STATUS untuk cek posisi antrean atau BATAL untuk membatalkannya.`,
            ),
          );
        }
        case 'MODE_DISABLED':
          await this.refreshContext(turn);
          return this.mainMenu(turn, TEXT.walkinDisabled);
        case 'LOCATION_CLOSED':
          this.backToMenu(turn);
          return this.reply(turn, textMessage(TEXT.locationClosed));
        case 'NOT_FOUND':
          return this.services(turn, 'walkin', 0, TEXT.serviceGone);
        default:
          return this.unexpected(turn, error);
      }
    }
  }

  // Reservation (FR-WA-05)

  /** Errors of the booking listing calls shared by the date and slot steps. */
  private async bookingListError(turn: Turn, error: unknown): Promise<Reply> {
    if (!(error instanceof CoreApiError)) throw error;
    if (error.code === 'MODE_DISABLED') {
      await this.refreshContext(turn);
      return this.mainMenu(turn, TEXT.bookingDisabled);
    }
    if (error.code === 'NOT_FOUND') return this.services(turn, 'booking', 0, TEXT.serviceGone);
    return this.unexpected(turn, error);
  }

  private async bookingDates(
    turn: Turn,
    serviceId: string,
    serviceName: string,
    notice: string | null,
  ): Promise<Reply> {
    const session = turn.session!;
    const timeZone = session.context!.timezone;
    const today = localDate(turn.now, timeZone);
    const dates = Array.from({ length: BOOKING_DAYS }, (_, index) => addDays(today, index));
    let counts: number[];
    try {
      counts = await Promise.all(
        dates.map(async (date) => {
          const result = await this.deps.core.availableSlots(
            session.tenant!.id,
            session.location!.id,
            serviceId,
            date,
          );
          return result.slots.length;
        }),
      );
    } catch (error) {
      return this.bookingListError(turn, error);
    }

    const options: MenuOption[] = dates
      .map((date, index) => ({ date, count: counts[index]! }))
      .filter(({ count }) => count > 0)
      .map(({ date, count }) => ({
        id: `date:${date}`,
        title: formatDateShort(date),
        label: `${formatDateLong(date)} (${count} slot)`,
        description: `${count} slot tersedia`,
      }));
    if (options.length === 0) return this.services(turn, 'booking', 0, TEXT.noSlotsWeek);
    return this.prompt(
      turn,
      'BOOKING_DATE',
      options,
      { intro: `Pilih tanggal untuk ${serviceName}:`, footer: TEXT.listFooter },
      notice,
      { service_id: serviceId, service_name: serviceName },
    );
  }

  private async bookingSlots(
    turn: Turn,
    date: string,
    page: number,
    notice: string | null = null,
  ): Promise<Reply> {
    const session = turn.session!;
    const { service_id: serviceId, service_name: serviceName } = session.draft;
    if (serviceId === undefined || serviceName === undefined) return this.mainMenu(turn, null);
    const timeZone = session.context!.timezone;
    let slots: { start_time: string; end_time: string }[];
    try {
      slots = (
        await this.deps.core.availableSlots(
          session.tenant!.id,
          session.location!.id,
          serviceId,
          date,
        )
      ).slots;
    } catch (error) {
      return this.bookingListError(turn, error);
    }
    if (slots.length === 0) return this.bookingDates(turn, serviceId, serviceName, TEXT.dayFull);

    const { items, hasMore, page: current } = paginate(slots, page);
    const options: MenuOption[] = items.map((slot) => {
      const title = formatSlot(slot.start_time, slot.end_time, timeZone);
      return { id: `slot:${slot.start_time}`, title, label: `${title} ${zoneLabel(timeZone)}` };
    });
    if (hasMore) options.push(MORE('Slot berikutnya'));
    return this.prompt(
      turn,
      'BOOKING_SLOT',
      options,
      {
        intro: `Pilih jam untuk ${serviceName} pada ${formatDateLong(date)}:`,
        footer: TEXT.listFooter,
      },
      notice,
      {
        service_id: serviceId,
        service_name: serviceName,
        date,
        page: current,
      },
    );
  }

  private async hold(turn: Turn, slotStart: string): Promise<Reply | null> {
    const session = turn.session!;
    const { service_id: serviceId, date } = session.draft;
    if (serviceId === undefined || date === undefined) return this.mainMenu(turn, null);
    try {
      await this.deps.core.createHold(session.tenant!.id, {
        location_id: session.location!.id,
        service_id: serviceId,
        slot_start: slotStart,
        customer_name: this.customerName(turn),
        customer_phone: turn.input.from,
      });
      // DP: antre_booking_payment (QRIS, 5 minutes) from booking.reservation.held; without DP:
      // antre_booking_confirmed from booking.reservation.confirmed.
      this.backToMenu(turn);
      return null;
    } catch (error) {
      if (!(error instanceof CoreApiError)) throw error;
      switch (error.code) {
        case 'SLOT_LOCKED':
        case 'SLOT_TAKEN':
        case 'VALIDATION_ERROR':
          return this.bookingSlots(turn, date, 0, TEXT.slotTaken);
        case 'QUOTA_EXCEEDED':
          this.backToMenu(turn);
          return this.reply(turn, textMessage(TEXT.bookingQuota));
        case 'MODE_DISABLED':
          await this.refreshContext(turn);
          return this.mainMenu(turn, TEXT.bookingDisabled);
        case 'LOCATION_CLOSED':
          this.backToMenu(turn);
          return this.reply(turn, textMessage(TEXT.bookingClosed));
        case 'NOT_FOUND':
          return this.services(turn, 'booking', 0, TEXT.serviceGone);
        default:
          return this.unexpected(turn, error);
      }
    }
  }

  // STATUS and BATAL (FR-WA-06): by the verified sender number, with or without a session

  /** Active items of the sender with their details, in the order of app_find_active_by_phone. */
  private async loadEntries(phone: string): Promise<Entry[]> {
    const { core, log } = this.deps;
    const items = await core.activeItems(phone);
    const groups = new Map<string, ActiveItemDto[]>();
    for (const item of items) {
      const key = `${item.tenant_id}|${item.location_id}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }

    const details = new Map<
      string,
      { context: CoreWaContext; ticket: CoreTicket | null; bookings: CoreBooking[] }
    >();
    const tolerate = async <T>(call: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await call;
      } catch (error) {
        // A business error for one location (e.g. MODE_DISABLED) must not hide the others.
        if (!(error instanceof CoreApiError)) throw error;
        log.warn({ code: error.code, status: error.status }, 'active item detail unavailable');
        return fallback;
      }
    };
    await Promise.all(
      [...groups.entries()].map(async ([key, group]) => {
        const { tenant_id: tenantId, location_id: locationId } = group[0]!;
        const context = await tolerate<CoreWaContext | null>(
          core.waContext(tenantId, locationId),
          null,
        );
        if (context === null) return;
        const [ticket, bookings] = await Promise.all([
          group.some((item) => item.kind === 'TICKET')
            ? tolerate(core.activeTicket(tenantId, locationId, phone), null)
            : Promise.resolve(null),
          group.some((item) => item.kind === 'BOOKING')
            ? tolerate(core.activeBookings(tenantId, locationId, phone), [])
            : Promise.resolve([]),
        ]);
        details.set(key, { context, ticket, bookings });
      }),
    );

    const entries: Entry[] = [];
    for (const item of items) {
      const detail = details.get(`${item.tenant_id}|${item.location_id}`);
      if (detail === undefined) continue;
      const base = {
        kind: item.kind,
        tenant: detail.context.tenant,
        location: { id: detail.context.location.id, code: detail.context.location.code },
        itemId: item.item_id,
        context: statusContext(detail.context),
      };
      if (item.kind === 'TICKET') {
        if (detail.ticket?.id === item.item_id) entries.push({ ...base, ticket: detail.ticket });
      } else {
        const booking = detail.bookings.find((candidate) => candidate.id === item.item_id);
        if (booking !== undefined) entries.push({ ...base, booking });
      }
    }
    return entries;
  }

  /** Tenant of a reply about `entries`: set only when they all belong to one tenant (7.1). */
  private scopeOf(entries: Entry[]): { tenant: TenantRef | null; location: LocationRef | null } {
    const first = entries[0];
    if (first === undefined) return { tenant: null, location: null };
    if (entries.some((entry) => entry.tenant.id !== first.tenant.id)) {
      return { tenant: null, location: null };
    }
    const sameLocation = entries.every((entry) => entry.location.id === first.location.id);
    return { tenant: first.tenant, location: sameLocation ? first.location : null };
  }

  private noActiveItems(turn: Turn): Reply {
    const hint = turn.session?.tenant ? 'Ketik MENU untuk melihat menu.' : TEXT.scanQr;
    return this.reply(turn, textMessage(`${TEXT.noActiveItems}\n\n${hint}`));
  }

  private async status(turn: Turn): Promise<Reply> {
    const entries = await this.loadEntries(turn.input.from);
    if (entries.length === 0) return this.noActiveItems(turn);
    return { ...this.scopeOf(entries), message: textMessage(statusText(entries)) };
  }

  private cancellable(entry: Entry, now: Date): boolean {
    if (entry.ticket !== undefined) return entry.ticket.status === 'WAITING';
    const booking = entry.booking!;
    return (
      (booking.status === 'PENDING_PAYMENT' || booking.status === 'CONFIRMED') &&
      Date.parse(booking.start_time) > now.getTime()
    );
  }

  private async cancel(turn: Turn): Promise<Reply | null> {
    const entries = await this.loadEntries(turn.input.from);
    const cancellable = entries.filter((entry) => this.cancellable(entry, turn.now));
    if (cancellable.length === 0) {
      if (entries.length > 0) return this.reply(turn, textMessage(TEXT.notCancellable));
      return this.noActiveItems(turn);
    }
    const items: CancelItem[] = cancellable.map((entry) => ({
      kind: entry.kind,
      tenant: entry.tenant,
      location: entry.location,
      item_id: entry.itemId,
      label: cancelOption(entry).label,
    }));
    if (items.length === 1) return this.cancelItem(turn, items[0]!);

    // Several items: numbered choice, kept in the session (FR-WA-06). A number without a tenant
    // session gets a session without tenant just for this choice.
    turn.session ??= {
      v: 1,
      tenant: null,
      location: null,
      context: null,
      step: 'CANCEL_PICK',
      options: [],
      prompt: null,
      draft: {},
      invalid: 0,
    };
    const options: MenuOption[] = cancellable.map((entry, index) => ({
      id: `cancel:${index + 1}`,
      title: cancelOption(entry).title,
      label: cancelOption(entry).label,
    }));
    const prompt = {
      intro: 'Anda memiliki beberapa antrean atau reservasi aktif. Mana yang ingin dibatalkan?',
      footer: TEXT.cancelFooter,
    };
    Object.assign(turn.session, {
      step: 'CANCEL_PICK',
      options,
      prompt,
      draft: { cancel_items: items },
      invalid: 0,
    });
    return { ...this.scopeOf(cancellable), message: optionsMessage(prompt, options) };
  }

  private async cancelItem(turn: Turn, item: CancelItem): Promise<Reply | null> {
    const { core } = this.deps;
    const scope = { tenant: item.tenant, location: item.location };
    try {
      if (item.kind === 'TICKET') {
        const ticket = await core.cancelTicket(item.tenant.id, item.item_id, turn.input.from);
        this.backToMenu(turn);
        // queue.ticket.cancelled has no consumer (spec 7.1): the confirmation is this reply.
        return {
          ...scope,
          message: textMessage(
            `Antrean ${ticket.ticket_number} di ${item.tenant.name} sudah dibatalkan. Terima kasih telah memberi tahu kami.`,
          ),
        };
      }
      await core.cancelBooking(item.tenant.id, item.item_id, turn.input.from);
      // The confirmation is the antre_booking_cancelled template (refund note included) of
      // booking.reservation.cancelled, sent for every cancellation cause (S09).
      this.backToMenu(turn);
      return null;
    } catch (error) {
      if (!(error instanceof CoreApiError)) throw error;
      this.backToMenu(turn);
      if (error.code === 'INVALID_TRANSITION' || error.code === 'NOT_FOUND') {
        return { ...scope, message: textMessage(TEXT.notCancellableAnymore) };
      }
      this.deps.log.warn({ code: error.code, status: error.status }, 'cancel failed');
      return { ...scope, message: textMessage(TEXT.requestFailed) };
    }
  }
}

function untenanted(message: WaMessage): Reply {
  return { tenant: null, location: null, message };
}
