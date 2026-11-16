import { fileURLToPath } from "node:url";
import { materializeBookingConfigFromEnv } from "./config.js";
import { runPendingBookings, formatPendingSummary } from "./run-pending.js";
import { log, logSection, logEnv } from "./logger.js";

const TICK_MS = 10_000;

export function parsePendingRunAt(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error('Set PENDING_RUN_AT (daily time as HH:MM, 24-hour clock, e.g. 13:00 for 1pm or 15:52 for a test).');
  }
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`PENDING_RUN_AT must look like HH:MM (got "${raw}").`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`PENDING_RUN_AT hour must be 0–23 (got ${match[1]}).`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`PENDING_RUN_AT minute must be 0–59 (got ${match[2]}).`);
  }
  return { hour, minute };
}

function scheduleTimeZone() {
  return (
    String(process.env.PENDING_SCHEDULE_TZ || process.env.TZ || "America/New_York").trim() ||
    "America/New_York"
  );
}

function wallClockInZone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const pick = (type) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatHm(hour, minute) {
  return `${pad2(hour)}:${pad2(minute)}`;
}

function minuteKey(clock) {
  return `${clock.year}-${clock.month}-${clock.day}T${formatHm(clock.hour, clock.minute)}`;
}

export function nextRunPhrase(hour, minute, timeZone) {
  const now = wallClockInZone(timeZone);
  const nowMinutes = now.hour * 60 + now.minute;
  const targetMinutes = hour * 60 + minute;
  const at = formatHm(hour, minute);
  if (nowMinutes < targetMinutes) {
    return `today at ${at} (${timeZone})`;
  }
  return `tomorrow at ${at} (${timeZone})`;
}

/** Settings UI: when the booker container will next poll the ladder queue. */
export function describeScheduledRun() {
  try {
    const timeZone = scheduleTimeZone();
    const { hour, minute } = parsePendingRunAt(process.env.PENDING_RUN_AT);
    const dailyAt = formatHm(hour, minute);
    return {
      ok: true,
      timeZone,
      dailyAt,
      nextRun: nextRunPhrase(hour, minute, timeZone),
    };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wake once per day at PENDING_RUN_AT (in TZ) and run the bocatennisladder pending queue.
 */
export async function startPendingSchedule() {
  materializeBookingConfigFromEnv();
  logSection("Start command=schedule");
  logEnv();

  const timeZone = scheduleTimeZone();
  const { hour, minute } = parsePendingRunAt(process.env.PENDING_RUN_AT);
  logSection("pending schedule");
  log(`Timezone: ${timeZone}`);
  log(`Daily queue run at ${formatHm(hour, minute)} — PlayByPoint slot watching (watch) is off.`);
  log(`Next run: ${nextRunPhrase(hour, minute, timeZone)}. Checking the clock every ${TICK_MS / 1000}s.`);

  let lastRunKey = "";
  for (;;) {
    const now = wallClockInZone(timeZone);
    const key = minuteKey(now);
    if (now.hour === hour && now.minute === minute && lastRunKey !== key) {
      lastRunKey = key;
      logSection(`Scheduled queue run ${key}`);
      const run = await runPendingBookings();
      log(formatPendingSummary(run));
      log(`Next run: ${nextRunPhrase(hour, minute, timeZone)}.`);
    }
    await sleep(TICK_MS);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  startPendingSchedule().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}