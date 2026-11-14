import { loadQueueConfig, applyFacilityFromPage } from "./config.js";
import { openSession, ensureLoggedIn, readFacility } from "./session.js";
import { listCourtTypes } from "./api.js";
import { findOpenSlot, bookMatchedSlot, notifyBooking } from "./booking.js";
import { listPendingBookings, markBookingComplete } from "./playbycourt-api.js";
import { formatSeconds } from "./config.js";
import { log, logSection } from "./logger.js";
import { materializeStorageFromEnv } from "./storage-state.js";

function pickSurface(courtTypes, wanted) {
  const match = courtTypes.find((type) => String(type.surface).toLowerCase() === wanted.toLowerCase());
  if (match) return match;
  if (courtTypes[0]) {
    log(`Surface "${wanted}" was not listed. Using ${courtTypes[0].surface}.`);
    return courtTypes[0];
  }
  throw new Error("No court types were returned for this account.");
}

/**
 * Fetch pending rows from PlayByCourt API, book on PlayByPoint when slots are open,
 * mark completed in the API. Does not start Chromium when the queue is empty.
 */
export async function runPendingBookings() {
  logSection("run pending bookings");
  let pending;
  try {
    pending = await listPendingBookings();
  } catch (error) {
    return {
      startedBrowser: false,
      results: [],
      message: error.message,
      error: true,
    };
  }

  if (pending.length === 0) {
    return { startedBrowser: false, results: [], message: "No pending bookings." };
  }

  let bookConfig = { ...loadQueueConfig(), dryRun: false };
  materializeStorageFromEnv();

  const results = [];
  const session = await openSession(bookConfig, { fresh: false });
  try {
    await ensureLoggedIn(session, bookConfig);
    const facility = await readFacility(session.page);
    if (!facility?.userId) throw new Error("Signed in, but the booking page did not expose a user.");

    bookConfig = applyFacilityFromPage(bookConfig, facility);
    if (!bookConfig.facilityId) {
      throw new Error("facilityId missing. Set PBP_FACILITY_ID or ensure the booking page exposes a facility.");
    }

    const courtTypes = await listCourtTypes(session.page, bookConfig.facilityId, bookConfig.kind);
    const surfaceWanted = bookConfig.surface || courtTypes[0]?.surface;
    if (!surfaceWanted) throw new Error("Set PBP_SURFACE or add surface in booking.config.json.");
    const surface = pickSurface(courtTypes, surfaceWanted);

    for (const item of pending) {
      const label = `${item.date} ${formatSeconds(item.startSeconds)}`;
      try {
        const hit = await findOpenSlot(session.page, bookConfig, facility, surface, {
          date: item.date,
          startSeconds: item.startSeconds,
          durationMinutes: item.durationMinutes,
        });
        if (!hit) {
          results.push({
            id: item.id,
            status: "unavailable",
            detail: `Slot not open: ${label}`,
          });
          continue;
        }

        const { label: bookedLabel } = await bookMatchedSlot(session.page, bookConfig, facility, surface, hit, {
          twoPlayers: true,
          reservationType: 2,
          user2Id: item.user2Id,
        });

        await markBookingComplete(item.id);
        await notifyBooking(bookConfig, `Booked (queue id=${item.id}) ${hit.date} ${bookedLabel}.`);
        results.push({
          id: item.id,
          status: "booked",
          detail: `${hit.date} ${bookedLabel}`,
        });
      } catch (error) {
        log(`Pending id=${item.id} failed: ${error.message}`);
        results.push({
          id: item.id,
          status: "error",
          detail: error.message,
        });
      }
    }
  } finally {
    await session.close();
  }

  const booked = results.filter((r) => r.status === "booked").length;
  const failed = results.length - booked;
  const message =
    failed === 0
      ? `Booked ${booked} reservation(s).`
      : `Booked ${booked}, ${failed} not completed (see below).`;

  return { startedBrowser: true, results, message };
}

export function formatPendingSummary(run) {
  if (run.error) return run.message;
  if (!run.startedBrowser && run.results.length === 0) return run.message;
  const lines = [run.message, ""];
  for (const row of run.results) {
    lines.push(`id ${row.id}: ${row.status} — ${row.detail}`);
  }
  return lines.join("\n");
}