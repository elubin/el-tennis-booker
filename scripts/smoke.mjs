import { bookingUrlFromInput, openSlots } from "../src/lookup.js";
import { openSession } from "../src/session.js";
import { normalizePendingRow } from "../src/playbycourt-api.js";
import { parsePendingRunAt } from "../src/schedule-pending.js";
import { requirePartnerName } from "../src/checkout.js";

if (parsePendingRunAt("13:00").hour !== 13 || parsePendingRunAt("15:52").minute !== 52) {
  throw new Error("parsePendingRunAt mismatch");
}

const row = normalizePendingRow({
  id: 59,
  bookingDate: "2026-11-16",
  startTime: 66600,
  endTime: 72000,
  user2Name: "Player Two",
});
if (
  row.durationMinutes !== 90 ||
  row.startSeconds !== 66600 ||
  row.date !== "2026-11-16" ||
  row.user2Name !== "Player Two"
) {
  throw new Error("normalizePendingRow sample row mismatch");
}

try {
  normalizePendingRow({ id: 1, bookingDate: "2026-11-16", startTime: 0, endTime: 3600 });
  throw new Error("expected missing user2Name to throw");
} catch (error) {
  if (!/user2Name/.test(error.message)) throw error;
}

if (requirePartnerName(" Player Two ") !== "Player Two") {
  throw new Error("requirePartnerName should trim");
}

const slots = openSlots(
  [
    { seconds: 32400, available: true, label: "9:00 AM" },
    { seconds: 34200, available: true, label: "9:30 AM" },
    { seconds: 36000, available: false, label: "10:00 AM" },
  ],
  1800,
);
if (slots.length !== 2 || slots[0].label !== "9:00 AM" || slots[1].seconds !== 34200) {
  throw new Error("open times were merged or dropped");
}

const mapped = openSlots([{ seconds: 57600, available: true, label: "16:00" }], 3600, ["4:00 PM – 5:00 PM"]);
if (mapped.length !== 1 || mapped[0].label !== "4:00 PM – 5:00 PM" || mapped[0].seconds !== 57600) {
  throw new Error("booking page label was replaced");
}

const friday = openSlots(
  [
    { seconds: 23400, available: false, label: "6:30 AM" },
    { seconds: 25200, available: false, label: "7:00 AM" },
    { seconds: 27000, available: true, label: "7:30 AM" },
    { seconds: 28800, available: true, label: "8:00 AM" },
  ],
  1800,
  ["6:30-7AM +", "7-7:30AM +", "7:30-8AM", "8-8:30AM"],
);
const openFriday = friday.filter((slot) => !slot.booked);
if (friday[0]?.label !== "6:30-7AM +" || friday[0]?.booked !== true || friday[1]?.label !== "7-7:30AM +") {
  throw new Error("booked compact ranges were dropped or shifted");
}
if (openFriday[0]?.label !== "7:30-8AM" || openFriday[1]?.label !== "8-8:30AM") {
  throw new Error("open compact ranges were rewritten");
}
if (friday.some((slot) => slot.label.includes("8:00 AM"))) {
  throw new Error("8:00 was rewritten as a spaced AM range");
}

const url = bookingUrlFromInput("https://app.playbypoint.com/book/example");
if (!url.endsWith("/book/example")) {
  throw new Error(`Unexpected booking URL: ${url}`);
}

try {
  const session = await openSession({ headless: true, timeZone: "UTC" }, { fresh: true });
  await session.close();
} catch (error) {
  if (error instanceof ReferenceError) throw error;
  const message = String(error?.message || error);
  if (!/executable doesn't exist|browserType\.launch|please run the following/i.test(message)) {
    throw error;
  }
  console.log("smoke: startup reached Chromium launch");
}