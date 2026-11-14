import { formatSeconds } from "./config.js";
import { listHours, listCourts, bookCourt } from "./api.js";
import { normalizeHours, timeStepFrom, matchSlot, dateToUnix } from "./match.js";
import { log } from "./logger.js";

const QUEUE_PLAYER_COUNT = 2;

export async function findOpenSlot(page, config, facility, surface, { date, startSeconds, durationMinutes }) {
  const timestamp = dateToUnix(date, config.timeZone);
  const payload = await listHours(page, config.facilityId, {
    timestamp,
    surface: surface.surface,
    kind: config.kind,
  });
  const hours = normalizeHours(payload);
  const step = timeStepFrom(payload, facility.timeStep || 1800);
  const slot = { startSeconds, durationMinutes };
  const match = matchSlot(hours, slot, step);
  if (!match) return null;
  return { date, timestamp, slot, match, step };
}

export async function bookMatchedSlot(page, config, facility, surface, hit, options = {}) {
  const courts = await listCourts(page, config.facilityId, {
    date: hit.timestamp,
    surface: surface.surface,
    startHour: hit.match.hourStart,
    hourEnd: hit.match.hourEnd,
    kind: config.kind,
  });
  const court = courts.find((item) => item.available !== false) || courts[0];
  if (!court?.id) throw new Error("A time matched, but no court was returned.");

  const reservationType =
    options.reservationType != null
      ? options.reservationType
      : options.twoPlayers
        ? QUEUE_PLAYER_COUNT
        : config.players;

  let userIds = [facility.userId];
  if (options.user2Id != null) {
    const partnerId = Number(options.user2Id);
    if (!Number.isFinite(partnerId) || partnerId <= 0) {
      throw new Error("Invalid partner user id for booking.");
    }
    if (partnerId !== facility.userId) userIds.push(partnerId);
    userIds = [...new Set(userIds)];
  }

  const payload = {
    reservation: {
      date: hit.date,
      hour_start: hit.match.hourStart,
      hour_end: hit.match.hourEnd,
      reservation_type: reservationType,
      public_game: false,
      min_ntrp: 1,
      max_ntrp: 7,
      kind: config.kind,
      ntrp_verified: false,
    },
    payment: {
      method: config.paymentMethod,
      moment: "now",
      payment_intent_id: "",
      card_details: {},
      coupon: { code: "" },
    },
    user_ids: userIds,
    user_excluded_ids: [],
    user_ids_guest_names: { player0: { name: null } },
    reservation_fees: [],
    users_fees: [],
    auto_fill_courts: facility.autoFillCourts,
    free_fare_players: [],
    guest_pass_users: [],
    booking_package_applies_to_user_ids: [],
  };

  const label = hit.match?.label || `${formatSeconds(hit.match.hourStart)}–${formatSeconds(hit.match.hourEnd)}`;
  log(`Booking court ${court.name || court.id} for ${hit.date} ${label} with ${config.paymentMethod}.`);
  const result = await bookCourt(page, court.id, payload);
  if (result.status >= 400) {
    throw new Error(`Booking failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
  log(`Booked. Response: ${JSON.stringify(result.body)}`);
  return { court, result, label };
}

export async function notifyBooking(config, message) {
  log(message);
  if (!config.notifyWebhook) return;
  await fetch(config.notifyWebhook, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: message,
  }).catch((error) => log(`Notify failed: ${error.message}`));
}