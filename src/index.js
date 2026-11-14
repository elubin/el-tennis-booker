import { loadConfig, formatSeconds, materializeBookingConfigFromEnv } from "./config.js";
import { openSession, ensureLoggedIn, readFacility } from "./session.js";
import { listCourtTypes, listHours } from "./api.js";
import { upcomingDates, normalizeHours, timeStepFrom, matchSlot, dateToUnix } from "./match.js";
import { bookMatchedSlot, notifyBooking } from "./booking.js";
import { runPendingBookings, formatPendingSummary } from "./run-pending.js";
import { log, logSection, logEnv, logJson, logError } from "./logger.js";
import { diagnosePage } from "./diagnostics.js";
import { materializeStorageFromEnv, encodeStorageFile, STORAGE_PATH } from "./storage-state.js";

const command = process.argv[2] || "check";

const COMMANDS = ["login", "check", "once", "watch", "book", "export-session", "pending"];

async function main() {
  materializeBookingConfigFromEnv();
  logSection(`Start command=${command}`);
  logEnv();

  if (command === "pending") {
    const run = await runPendingBookings();
    log(formatPendingSummary(run));
    if (run.error) process.exitCode = 1;
    return;
  }

  const config = command === "watch" ? await waitForConfig() : loadConfig();
  logJson("config (no secrets)", {
    facilitySlug: config.facilitySlug,
    facilityId: config.facilityId,
    timeZone: config.timeZone,
    kind: config.kind,
    surface: config.surface,
    players: config.players,
    paymentMethod: config.paymentMethod,
    dryRun: config.dryRun,
    daysAhead: config.daysAhead,
    slots: config.slots,
    bookingUrl: config.bookingUrl,
    headless: config.headless,
  });
  if (!COMMANDS.includes(command)) {
    throw new Error(`Use ${COMMANDS.join(", ")}.`);
  }

  materializeStorageFromEnv();

  if (command === "export-session") {
    await exportSession(config);
    return;
  }

  const session = await openSession(config, { fresh: command === "login" });
  try {
    await ensureLoggedIn(session, config);
    const facility = await readFacility(session.page);
    logJson("facility", facilityForLog(facility));
    if (!facility?.userId) throw new Error("Signed in, but the booking page did not expose a user.");
    log(`Signed in. Next schedule open: ${facility.nextOpenScheduleDateTime || "unknown"}.`);

    if (command === "login") return;

    const courtTypes = await listCourtTypes(session.page, config.facilityId, config.kind);
    logJson("courtTypes", courtTypes);
    const surface = pickSurface(courtTypes, config.surface);
    log(`Court type: ${surface.surface}`);

    if (command === "check" || command === "once") {
      const hit = await scan(session.page, config, facility, surface, { book: false });
      if (command === "check" || !hit) {
        if (command === "once" && !hit) log("No matching open slot right now.");
        return;
      }
      if (config.dryRun) {
        log(`Dry run: would book ${hit.date} ${hit.match.label}. Set dryRun to false to reserve it.`);
        return;
      }
      await bookMatchedSlot(session.page, config, facility, surface, hit);
      await notifyBooking(config, `Booked ${hit.date} ${hit.match.label}.`);
      return;
    }

    if (command === "book") {
      const hit = await scan(session.page, config, facility, surface, { book: false });
      if (!hit) {
        log("No matching open slot right now.");
        return;
      }
      await bookMatchedSlot(session.page, config, facility, surface, hit);
      await notifyBooking(config, `Booked ${hit.date} ${hit.match.label}.`);
      return;
    }

    log(`Watching every ${config.pollIntervalSeconds}s. dryRun=${config.dryRun}.`);
    const announced = new Set();
    let active = config;
    let activeSurface = surface;
    for (;;) {
      try {
        const next = loadConfig();
        if (settingsChanged(active, next)) {
          log("Booking settings changed. Applying them on this poll.");
          if (next.bookingUrl !== active.bookingUrl) await ensureLoggedIn(session, next);
          if (next.facilityId !== active.facilityId || next.surface !== active.surface) {
            const types = await listCourtTypes(session.page, next.facilityId, next.kind);
            activeSurface = pickSurface(types, next.surface);
          }
        }
        active = next;
        const hit = await scan(session.page, active, facility, activeSurface, { book: false });
        if (hit) {
          const key = `${hit.date} ${hit.match.label}`;
          if (active.dryRun) {
            if (!announced.has(key)) {
              announced.add(key);
              await notifyBooking(active, `Slot open (dry run): ${key}`);
              log("Dry run is on, so nothing was booked. Turn off dry run in settings to reserve it.");
            }
          } else {
            await bookMatchedSlot(session.page, active, facility, activeSurface, hit);
            await notifyBooking(active, `Booked ${hit.date} ${hit.match.label}.`);
            return;
          }
        }
      } catch (error) {
        log(`Poll error: ${error.message}`);
        await ensureLoggedIn(session, active);
      }
      await sleep(active.pollIntervalSeconds * 1000);
    }
  } catch (error) {
    logError(error);
    try {
      if (session?.page) await diagnosePage(session.page, "fatal");
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    await session.close();
  }
}

async function scan(page, config, facility, surface, { book }) {
  const targets = upcomingDates(config);
  let found = null;
  for (const target of targets) {
    const timestamp = dateToUnix(target.date, config.timeZone);
    const payload = await listHours(page, config.facilityId, {
      timestamp,
      surface: surface.surface,
      kind: config.kind,
    });
    const hours = normalizeHours(payload);
    const step = timeStepFrom(payload, facility.timeStep || 1800);
    const open = hours.filter((hour) => hour.available).map((hour) => formatSeconds(hour.seconds));
    log(`${target.date} ${target.weekday}: ${open.length ? open.join(", ") : "no open times"}`);

    for (const slot of target.slots) {
      const match = matchSlot(hours, slot, step);
      if (!match) continue;
      found = { date: target.date, timestamp, slot, match, step };
      log(`Match: ${target.date} ${match.label}`);
      if (!book) return found;
    }
  }
  return found;
}

function facilityForLog(facility) {
  if (!facility) return facility;
  const rest = { ...facility };
  delete rest.userName;
  return rest;
}

function settingsChanged(previous, next) {
  return (
    previous.facilitySlug !== next.facilitySlug ||
    previous.facilityId !== next.facilityId ||
    previous.surface !== next.surface ||
    previous.bookingUrl !== next.bookingUrl ||
    previous.dryRun !== next.dryRun ||
    previous.players !== next.players ||
    previous.paymentMethod !== next.paymentMethod ||
    previous.daysAhead !== next.daysAhead ||
    JSON.stringify(previous.slots) !== JSON.stringify(next.slots)
  );
}

async function waitForConfig() {
  log("Waiting for a complete booking config on disk.");
  for (;;) {
    try {
      return loadConfig();
    } catch (error) {
      log(error.message);
      await sleep(5000);
    }
  }
}

function pickSurface(courtTypes, wanted) {
  const match = courtTypes.find((type) => String(type.surface).toLowerCase() === wanted.toLowerCase());
  if (match) return match;
  if (courtTypes[0]) {
    log(`Surface "${wanted}" was not listed. Using ${courtTypes[0].surface}.`);
    return courtTypes[0];
  }
  throw new Error("No court types were returned for this account.");
}

async function exportSession(config) {
  logSection("export-session (headed browser)");
  log("Complete Cloudflare and log in to PlayByPoint in the window that opens.");
  log("When the booking page shows you as logged in, this will save cookies and print a base64 secret.");
  const headed = { ...config, headless: false };
  const session = await openSession(headed, { fresh: true });
  try {
    await session.page.goto(config.bookingUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    const deadline = Date.now() + 8 * 60 * 1000;
    while (Date.now() < deadline) {
      const loggedIn = await session.page.evaluate(() => {
        const node = document.querySelector('[data-react-class="BookBox"]');
        if (!node) return false;
        try {
          const props = JSON.parse(node.getAttribute("data-react-props") || "{}");
          return Boolean(props.current_user?.id);
        } catch {
          return false;
        }
      });
      if (loggedIn) break;
      log("export-session: waiting for you to finish Cloudflare + login…");
      await session.page.waitForTimeout(5000);
    }
    if (!(await isLoggedInQuick(session.page))) {
      throw new Error("Timed out waiting for login. Try again with HEADLESS=false npm run export-session");
    }
    await session.save();
    const encoded = encodeStorageFile(STORAGE_PATH);
    logSection("Add this GitHub secret: PBP_STORAGE_STATE");
    console.log(encoded);
  } finally {
    await session.close();
  }
}

async function isLoggedInQuick(page) {
  return page.evaluate(() => {
    const node = document.querySelector('[data-react-class="BookBox"]');
    if (!node) return false;
    const props = JSON.parse(node.getAttribute("data-react-props") || "{}");
    return Boolean(props.current_user?.id);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  logError(error);
  process.exitCode = 1;
});