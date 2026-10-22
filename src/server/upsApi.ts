import 'server-only';

import { randomUUID } from 'node:crypto';
import {
  IndeterminateError, languageStageStatus, NotFoundError, RateLimitedError, SchemaError, TransportError,
  type CarrierEvent, type CarrierResult, type CarrierStatus,
} from 'universal-parcel-scraper';
import type { AdapterFactory, CarrierAdapter, RegistryDefinition, TrackingContext, TrackingInput } from 'universal-parcel-scraper/node';

/*
 * fkeil: UPS through its official Tracking API (developer.ups.com, free Community tier with
 * 90,000 calls a month) instead of UPS's tracking page, which blocks this server's address after
 * frequent lookups. Active with UPS_CLIENT_ID and UPS_CLIENT_SECRET; without them the scraper's
 * own UPS adapter stays. Written by ~/peek/fork.sh on the server, not part of upstream.
 */

const API = 'https://onlinetools.ups.com';
const PROVIDER = 'UPS';
const TIMEOUT_MS = 15_000;
type Stage = Parameters<typeof languageStageStatus>[0];

// UPS activity codes as the scraper maps them in carriers/ups/status.ts, which the package does not export.
const ACTIVITY_STAGES = new Map<string, string>([
  ['MP', 'registered'],
  ['XD', 'accepted'], ['ZO', 'accepted'], ['PU', 'accepted'], ['PC', 'accepted'], ['AG', 'accepted'], ['OR', 'accepted'],
  ['AR', 'in_transit'], ['DP', 'in_transit'], ['DS', 'in_transit'], ['YP', 'in_transit'], ['HL', 'in_transit'],
  ['EP', 'in_transit'], ['IP', 'in_transit'], ['DA', 'in_transit'],
  ['18', 'in_transit'], ['Q5', 'in_transit'], ['E3', 'in_transit'], ['2U', 'in_transit'],
  ['AL', 'in_transit'], ['HM', 'in_transit'], ['H6', 'in_transit'], ['TB', 'in_transit'],
  ['ZA', 'in_transit'], ['ZB', 'in_transit'], ['ZC', 'in_transit'],
  ['ZW', 'in_transit'], ['LX', 'in_transit'], ['YH', 'in_transit'], ['3P', 'in_transit'], ['6B', 'in_transit'],
  ['Z1', 'customs'], ['7F', 'customs'], ['OQ', 'customs'],
  ['OF', 'out_for_delivery'], ['OT', 'out_for_delivery'],
  ['48', 'failed_attempt'], ['49', 'failed_attempt'], ['G3', 'failed_attempt'], ['5R', 'failed_attempt'],
  ['2Q', 'ready_for_pickup'], ['ZP', 'ready_for_pickup'],
  ['9E', 'delivered'], ['FS', 'delivered'], ['KB', 'delivered'], ['KE', 'delivered'], ['2W', 'delivered'], ['YC', 'delivered'],
]);
// Without a mapped code, the activity type: M manifest, P pickup, I in transit, D delivered, X exception.
const TYPE_STATUS: Record<string, CarrierStatus> = { M: 'pending', P: 'in_transit', I: 'in_transit', D: 'delivered', X: 'exception', RS: 'exception' };

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);
// UPS's wording as it sends it, ™ and ® included ("UPS Access Point™"), as Parcel shows it.
const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
  .replace(/\s+/g, ' ').trim();
const regions = new Intl.DisplayNames(['en'], { type: 'region' });

let token: { value: string; expires: number } | null = null;
let pending: Promise<string> | null = null;

function accessToken(clientId: string, secret: string): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return Promise.resolve(token.value);
  pending ??= (async () => {
    let response: Response;
    try {
      response = await fetch(`${API}/security/v1/oauth/token`, {
        method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
    } catch (error) {
      throw new TransportError(PROVIDER, 'UPS API sign-in unreachable', { cause: error });
    }
    if (!response.ok) throw new TransportError(PROVIDER, `UPS API sign-in failed (HTTP ${response.status})`, { status: response.status });
    const body: unknown = await response.json();
    const value = isRecord(body) ? text(body.access_token) : '';
    if (!value) throw new SchemaError(PROVIDER, 'UPS returned no access token');
    const seconds = isRecord(body) ? Number(body.expires_in) : NaN;
    token = { value, expires: Date.now() + (Number.isFinite(seconds) ? seconds : 3600) * 1000 };
    return value;
  })().finally(() => { pending = null; });
  return pending;
}

function day(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function clock(activity: Json): CarrierEvent {
  const gmtDate = text(activity.gmtDate);
  const gmtTime = text(activity.gmtTime);
  if (/^\d{8}$/.test(gmtDate) && /^\d{2}:\d{2}:\d{2}$/.test(gmtTime)) return { time: `${day(gmtDate)}T${gmtTime}+00:00` };
  const date = text(activity.date);
  const time = text(activity.time);
  const offset = text(activity.gmtOffset);
  if (/^\d{8}$/.test(date) && /^\d{6}$/.test(time)) {
    const local = `${day(date)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
    return /^[+-]\d{2}:\d{2}$/.test(offset) ? { time: `${local}${offset}` } : { local_time: local };
  }
  return {};
}

/** Where UPS's English names differ from the CLDR ones. */
const UPS_COUNTRY_NAMES: Record<string, string> = { CZ: 'Czech Republic', TR: 'Turkey', US: 'United States' };

function place(location: unknown): string {
  const address = isRecord(location) && isRecord(location.address) ? location.address : null;
  if (!address) return '';
  // As UPS writes it ("STRANCICE", "Nurnberg"), like Parcel shows it, with the country in English.
  const city = text(address.city);
  const code = text(address.countryCode).toUpperCase();
  let country = UPS_COUNTRY_NAMES[code] ?? '';
  try { country ||= /^[A-Z]{2}$/.test(code) ? regions.of(code) ?? code : ''; } catch { country = code; }
  return [city, text(address.stateProvince), country].filter(Boolean).join(', ');
}

/** The scheduled day, with UPS's estimated window when it gives one ("2026-10-22 13:00–15:00"). */
function expectedDelivery(parcel: Json): string | null {
  const dates = records(parcel.deliveryDate);
  const scheduled = dates.find((entry) => text(entry.type) === 'RDD') ?? dates.find((entry) => text(entry.type) === 'SDD');
  const date = scheduled ? text(scheduled.date) : '';
  if (!/^\d{8}$/.test(date)) return null;
  const window = isRecord(parcel.deliveryTime) ? parcel.deliveryTime : null;
  const start = window ? text(window.startTime) : '';
  const end = window ? text(window.endTime) : '';
  if (window && ['EDW', 'CDW', 'IDW'].includes(text(window.type)) && /^\d{4,6}$/.test(start) && /^\d{4,6}$/.test(end)) {
    return `${day(date)} ${start.slice(0, 2)}:${start.slice(2, 4)}–${end.slice(0, 2)}:${end.slice(2, 4)}`;
  }
  return day(date);
}

/**
 * The UPS Access Point the parcel waits at, as the scraper's own UPS adapter writes it: the
 * business name, then its street and its town on their own lines ("PERI-OBST-GEMUESE\n20 MEHROWER
 * ALLEE\n12687 BERLIN"). Only the business name, never a person's.
 */
function accessPoint(parcel: Json): string {
  const point = isRecord(parcel.accessPointInformation) ? parcel.accessPointInformation : null;
  const name = point ? text(point.companyName) : '';
  const address = point && isRecord(point.address) ? point.address : null;
  if (!name || !address) return name;
  const street = text(address.addressLine1);
  const more = [address.addressLine2, address.addressLine3].map(text).filter(Boolean).join(', ');
  const city = text(address.city);
  if (!street || !city) return name;
  const region = text(address.stateProvince);
  const postcode = text(address.postalCode);
  const town = region ? `${city}, ${[region, postcode].filter(Boolean).join(' ')}` : [postcode, city].filter(Boolean).join(' ');
  return [name, street, more, town].filter(Boolean).join('\n');
}

export function parseUpsApiResponse(payload: unknown, number: string): CarrierResult {
  const response = isRecord(payload) && isRecord(payload.trackResponse) ? payload.trackResponse : null;
  const shipment = response ? records(response.shipment)[0] : undefined;
  if (!shipment) throw new SchemaError(PROVIDER);
  if (records(shipment.warnings).some((warning) => text(warning.code).toUpperCase() === 'TW0001' || /not found/i.test(text(warning.message)))) {
    throw new NotFoundError(PROVIDER);
  }
  const parcels = records(shipment.package);
  const parcel = parcels.find((entry) => text(entry.trackingNumber).toUpperCase() === number) ?? parcels[0];
  if (!parcel) throw new NotFoundError(PROVIDER);

  const events: CarrierEvent[] = [];
  let newestType = '';
  for (const activity of records(parcel.activity)) {
    const status = isRecord(activity.status) ? activity.status : {};
    const description = text(status.description);
    if (!description) continue;
    if (!events.length) newestType = text(status.type).toUpperCase();
    const code = text(status.code).toUpperCase();
    const stage = ACTIVITY_STAGES.get(code);
    events.push({
      ...clock(activity),
      location: place(activity.location),
      description,
      ...(/^[A-Z0-9]{1,4}$/.test(code) ? { provider_code: code } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    });
  }
  // UPS lists the newest activity first.
  const newest = events[0];
  const stage = typeof newest?.stage === 'string' ? newest.stage : undefined;
  const status: CarrierStatus = stage ? languageStageStatus(stage as Stage) : TYPE_STATUS[newestType] ?? (events.length ? 'in_transit' : 'unknown');
  const delivered = stage ? stage === 'delivered' : status === 'delivered';
  const current = isRecord(parcel.currentStatus) ? parcel.currentStatus : {};
  const service = isRecord(parcel.service) ? text(parcel.service.description) : '';
  const destination = records(parcel.packageAddress).find((entry) => text(entry.type) === 'DESTINATION');
  const country = destination && isRecord(destination.address) ? text(destination.address.countryCode).toUpperCase() : '';
  const newestTime = typeof newest?.time === 'string' ? newest.time : null;
  // Who took the parcel: the app adds it to UPS's delivery scans, as Parcel does ("ZUGESTELLT.
  // Entgegengenommen von: …"). Kept out of the scans' wording, which must stay the same between checks.
  const receiver = isRecord(parcel.deliveryInformation) ? text(parcel.deliveryInformation.receivedBy) : '';
  // Where it waits for collection, while it does (the scraper's adapter keeps it the same way).
  const pickupPoint = stage === 'ready_for_pickup' ? accessPoint(parcel) : '';
  return {
    status,
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest?.description || text(current.description) || 'Tracking information received',
    last_update: newestTime,
    expected_delivery: delivered ? null : expectedDelivery(parcel),
    ...(delivered && newestTime ? { delivered_at: newestTime } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...(service ? { service_name: service } : {}),
    ...(receiver ? { receiver_name: receiver } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    events,
  };
}

class UpsApiAdapter implements CarrierAdapter {
  readonly id = 'ups';
  readonly steps = ['api'];

  constructor(private readonly clientId: string, private readonly secret: string) {}

  async track(input: TrackingInput, context?: TrackingContext): Promise<CarrierResult> {
    context?.signal?.throwIfAborted();
    const number = input.number.replace(/\s+/g, '').toUpperCase();
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(TIMEOUT_MS, context?.budgetMs ?? TIMEOUT_MS)));
    const signal = context?.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    for (let attempt = 0; attempt < 2; attempt++) {
      const bearer = await accessToken(this.clientId, this.secret);
      let response: Response;
      try {
        response = await fetch(`${API}/api/track/v1/details/${encodeURIComponent(number)}?locale=de_DE&returnSignature=false&returnMilestones=false&returnPOD=false`, {
          signal,
          headers: { Authorization: `Bearer ${bearer}`, transId: randomUUID().replaceAll('-', ''), transactionSrc: 'peek' },
        });
      } catch (error) {
        throw new TransportError(PROVIDER, 'UPS API unreachable', { cause: error });
      }
      if (response.status === 401 && attempt === 0) {
        token = null;
        continue;
      }
      if (response.status === 404) throw new NotFoundError(PROVIDER);
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        throw new RateLimitedError(PROVIDER, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 15 * 60_000);
      }
      if (!response.ok) throw new IndeterminateError(PROVIDER, `UPS API returned HTTP ${response.status}`, { status: response.status });
      return parseUpsApiResponse(await response.json(), number);
    }
    throw new TransportError(PROVIDER, 'UPS refused the API token');
  }
}

/** The scraper's adapters, with UPS answered by the official API when its credentials are set. */
export function withUpsApi(definition: RegistryDefinition, env: Record<string, string | undefined> = process.env): RegistryDefinition {
  const clientId = env.UPS_CLIENT_ID?.trim();
  const secret = env.UPS_CLIENT_SECRET?.trim();
  if (!clientId || !secret || definition.carriers.ups !== 'ups') return definition;
  const factory: AdapterFactory = () => new UpsApiAdapter(clientId, secret);
  return { ...definition, factories: { ...definition.factories, ups: factory } };
}
