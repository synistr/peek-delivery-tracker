import { describe, expect, it, vi } from 'vitest';
import { STORED_EVENT_IDENTITIES, type SupabaseServiceClient } from './supabase';
import { buildEvents, resultStage, TrackingSyncService } from './trackingSync';
import type { JsonObject } from './types';
import { parseUpsApiResponse } from './upsApi';

/*
 * fkeil: the UPS adapter of the official API (upsApi.ts) and the UPS scan identity fork.sh adds to
 * eventIdentity.ts. Written by ~/peek/fork.sh on the server, not part of upstream.
 */

const NUMBER = '1Z0000000000000000';
const MISSED = 'Wir haben Sie wieder verpasst. Am nächsten Werktag erfolgt ein letzter Versuch.';

const activity = (gmtTime: string, type: string, code: string, description: string, city: string) => ({
  date: '20261027', gmtDate: '20261027', gmtTime, gmtOffset: '+01:00',
  status: { type, code, description },
  location: { address: { city, countryCode: 'DE' } },
});
const answer = (...activities: JsonObject[]) => parseUpsApiResponse(
  { trackResponse: { shipment: [{ package: [{ trackingNumber: NUMBER, activity: activities }] }] } }, NUMBER);
const outForDelivery = activity('08:36:24', 'I', 'OT', 'Wird heute zugestellt', 'Dahlwitz-Hoppegarten');

describe('UPS scan stages', () => {
  it('reads the second missed delivery as a failed attempt, on the scan as on the parcel', () => {
    const result = answer(activity('12:43:20', 'X', 'KX', MISSED, 'Dahlwitz-Hoppegarten'), outForDelivery);
    expect(result.events?.map((event) => event.stage)).toEqual(['failed_attempt', 'out_for_delivery']);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map' });
  });

  it('reads the Access Point reminder as the exception UPS types it, not as returned', () => {
    const reminder = 'Holen Sie Ihr Paket bald ab, da es sich dem maximalen Aufbewahrungslimit nähert und eventuell an den Absender zurückgesendet wird.';
    const result = answer(activity('09:16:10', 'X', '5G', reminder, 'Dahlwitz-Hoppegarten'));
    expect(result).toMatchObject({ current_stage: 'exception', events: [expect.objectContaining({ stage: 'exception' })] });
  });

  it.each([
    ['X', 'Q9', 'Die Zustellung verzögert sich.'],
    ['X', 'Q9', MISSED],
    ['I', 'Q9', 'Paket wird bearbeitet'],
    ['I', 'Q9', 'Im Lager'],
    ['D', 'Q9', 'ZUGESTELLT'],
    ['W', 'Q9', 'Im Lager'],
  ])('gives an unmapped %s scan the parcel\'s stage, so Peek adds no row of its own beside it', (type, code, description) => {
    const result = answer(activity('12:43:20', type, code, description, 'Berlin'), outForDelivery);
    const newest = result.events![0]!;
    expect(newest.stage).toBe(result.current_stage);
    expect(resultStage(result)).toBe(newest.stage);
    const rows = buildEvents({ id: 'parcel', carrier: 'ups', current_stage: 'out_for_delivery' }, result, 'ups', new Date('2026-10-27T13:46:00Z'));
    expect(rows.filter((row) => (row.raw_data as JsonObject).observed_without_provider_timestamp === true)).toEqual([]);
  });

  // Peek stores a scan in no stage of its own as pending once the parcel is past transit (scanStages).
  const stored = (result: ReturnType<typeof answer>, previous: string) => buildEvents(
    { id: 'parcel', carrier: 'ups', current_stage: previous }, result, 'ups', new Date('2026-10-27T13:46:00Z'));

  it('keeps the parcel out for delivery on a scan no code, type or wording reads, which Peek stores pending', () => {
    const result = answer(activity('12:43:20', 'W', 'Q9', 'Im Lager', 'Berlin'), outForDelivery);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Wird heute zugestellt', last_update: '2026-10-27T12:43:20+00:00' });
    expect(result.events?.map((event) => [event.stage, event.stage_source])).toEqual([['out_for_delivery', 'none'], ['out_for_delivery', 'carrier_map']]);
    const rows = stored(result, 'out_for_delivery');
    expect(rows.map((row) => [row.description, row.stage])).toEqual([['Im Lager', 'pending'], ['Wird heute zugestellt', 'out_for_delivery']]);
  });

  it('keeps a delivery, dated by its own scan, when a scan no rule reads follows it', () => {
    const result = answer(activity('12:43:20', 'W', 'Q9', 'Im Lager', 'Berlin'), activity('11:02:00', 'D', 'FS', 'ZUGESTELLT', 'Berlin'), outForDelivery);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-10-27T11:02:00+00:00',
      last_status_text: 'ZUGESTELLT', expected_delivery: null });
    const rows = stored(result, 'out_for_delivery');
    expect(rows.map((row) => row.stage)).toEqual(['pending', 'delivered', 'out_for_delivery']);
  });

  it('reads a scan no rule reads in transit before the round, as before', () => {
    const result = answer(activity('12:43:20', 'W', 'Q9', 'Im Lager', 'Berlin'), activity('06:10:00', 'I', 'AR', 'Ankunft in der Einrichtung', 'Berlin'));
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Im Lager', events: [expect.objectContaining({ stage: 'in_transit', stage_source: 'none' }), expect.anything()] });
    expect(stored(result, 'in_transit').map((row) => row.stage)).toEqual(['in_transit', 'in_transit']);
  });

  it('gives a notice the stage of the scan before it', () => {
    const result = answer(activity('12:43:20', 'M', 'L0', 'Zustellanweisungen erhalten', 'Berlin'), activity('08:00:00', 'M', 'MP', 'Auftragsdaten übermittelt', 'Berlin'));
    expect(result).toMatchObject({ current_stage: 'registered', last_status_text: 'Auftragsdaten übermittelt',
      events: [expect.objectContaining({ stage: 'registered', stage_source: 'none' }), expect.objectContaining({ stage: 'registered' })] });
    expect(stored(result, 'registered').map((row) => row.stage)).toEqual(['registered', 'registered']);
  });
});

/** Stored rows keyed by identity, as the database keeps them: an identity written again updates its row. */
function eventStore() {
  const rows = new Map<string, JsonObject>();
  let created = 0;
  const client = {
    listActivePackages: vi.fn().mockResolvedValue([]),
    listFollowedOneOffPackages: vi.fn().mockResolvedValue([]),
    listUnwatchedPackageIds: vi.fn().mockResolvedValue([]),
    sharedAlertPackageIds: vi.fn().mockResolvedValue(new Set()),
    autoLinkPackages: vi.fn().mockResolvedValue(0),
    reopenScanAnnouncements: vi.fn(async (_packageId: string, ids: string[]) => ids.length),
    unarchivedParcelLegs: vi.fn().mockResolvedValue([]),
    updatePackage: vi.fn().mockResolvedValue(undefined),
    insertEvents: vi.fn().mockResolvedValue(undefined),
    deleteEventsByDescriptions: vi.fn().mockResolvedValue(undefined),
    startSyncAttempt: vi.fn().mockResolvedValue(undefined),
    completeSyncAttempt: vi.fn().mockResolvedValue(true),
    recordTrackingHealth: vi.fn().mockResolvedValue([]),
    ackTrackingHealth: vi.fn().mockResolvedValue(undefined),
    recordTrackingStatusObservations: vi.fn().mockResolvedValue(undefined),
    closeTrackingStatusObservations: vi.fn().mockResolvedValue(1),
    applyTrackingSync: vi.fn(async (
      parcel: JsonObject, values: JsonObject, events: JsonObject[] = [], descriptions: string[] = [], absorbed: string[] = [],
    ) => {
      const ids = events.map((event) => String(event.provider_event_id));
      for (const event of events) {
        const id = String(event.provider_event_id);
        rows.set(id, { ...event, id: rows.get(id)?.id ?? `row-${++created}` });
      }
      for (const [id, row] of rows) if (descriptions.includes(String(row.description))) rows.delete(id);
      for (const id of absorbed) if (!ids.includes(id)) rows.delete(id);
      await client.updatePackage(parcel.id, values);
      return true;
    }),
  };
  return {
    client,
    rows,
    identities: () => [...rows.values()].map((row) => ({
      provider_event_id: row.provider_event_id,
      occurred_at: new Date(String(row.occurred_at)).toISOString().replace('.000Z', '+00:00'),
      stage: row.stage,
      description: row.description,
      location: row.location,
      time: (row.raw_data as JsonObject | undefined)?.time,
      provider_code: (row.raw_data as JsonObject | undefined)?.provider_code,
      observed_without_provider_timestamp: (row.raw_data as JsonObject | undefined)?.observed_without_provider_timestamp,
    })),
  };
}

describe('UPS scans moved to another town', () => {
  /** One check per answer, each listing the missed delivery in these towns. */
  const sync = async (answers: string[][], code = 'KX') => {
    const store = eventStore();
    const adapter = { fetch: vi.fn() };
    for (const towns of answers) {
      adapter.fetch.mockResolvedValueOnce(answer(...towns.map((town) => activity('12:43:20', 'X', code, MISSED, town)), outForDelivery));
    }
    const service = new TrackingSyncService(store.client as unknown as SupabaseServiceClient, adapter, null,
      () => new Date('2026-10-27T13:46:00Z'));
    const ids: string[] = [];
    for (const [index] of answers.entries()) {
      await service.syncPackage({ id: 'ups-parcel', user_id: 'owner', carrier: 'ups', tracking_number: NUMBER,
        current_stage: index === 0 ? 'out_for_delivery' : 'failed_attempt', [STORED_EVENT_IDENTITIES]: store.identities() });
      ids.push(...[...store.rows.values()].filter((row) => row.description === MISSED).map((row) => String(row.id)));
    }
    return { rows: [...store.rows.values()], ids };
  };

  // Without a code too: Peek's rewordedScans (since upstream 2026-10) moves the row of a scan its carrier
  // no longer lists to the one scan at its instant and in its stage that takes its place.
  it.each([['KX'], ['']])('keeps one row for a scan UPS moves to another town, the one first stored (code %j)', async (code) => {
    const { rows, ids } = await sync([['BERLIN'], ['Dahlwitz-Hoppegarten'], ['Dahlwitz-Hoppegarten']], code);
    const missed = rows.filter((row) => row.description === MISSED);
    expect(missed).toEqual([expect.objectContaining({ id: ids[0], stage: 'failed_attempt', location: 'Dahlwitz-Hoppegarten, Germany' })]);
    expect(new Set(ids)).toEqual(new Set([ids[0]]));
    expect(rows.filter((row) => (row.raw_data as JsonObject).observed_without_provider_timestamp === true)).toEqual([]);
  });

  it.each([['KX'], ['']])('keeps two rows while UPS lists the scan in both towns (code %j)', async (code) => {
    const { rows } = await sync([['BERLIN'], ['Dahlwitz-Hoppegarten', 'BERLIN']], code);
    expect(rows.filter((row) => row.description === MISSED).map((row) => row.location).sort())
      .toEqual(['BERLIN, Germany', 'Dahlwitz-Hoppegarten, Germany']);
  });
});
