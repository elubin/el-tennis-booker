import { log } from "./logger.js";

export function bookingApiConfig() {
  const baseUrl = String(process.env.BOOKING_API_BASE_URL || "").replace(/\/$/, "");
  const secret = String(process.env.BOOKING_API_SECRET || "").trim();
  if (!baseUrl) {
    throw new Error("Set BOOKING_API_BASE_URL in the environment (PlayByCourt API origin, no trailing slash).");
  }
  if (!secret) {
    throw new Error("Set BOOKING_API_SECRET in the environment (same value as BookingAutomation:Secret).");
  }
  return { baseUrl, secret };
}

export function resolveUser2Id(raw) {
  const text = raw == null ? "" : String(raw).trim();
  if (text) {
    const id = Number(text);
    if (!Number.isFinite(id) || id <= 0) throw new Error(`Invalid user2Id "${raw}".`);
    return id;
  }
  const fallback = String(process.env.PBP_DEFAULT_USER2_ID || "").trim();
  if (!fallback) {
    throw new Error("Pending row has no user2Id. Set PBP_DEFAULT_USER2_ID in the environment.");
  }
  const id = Number(fallback);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("PBP_DEFAULT_USER2_ID must be a positive number.");
  }
  return id;
}

export function normalizePendingRow(row) {
  if (!row || row.id == null) throw new Error("Pending row is missing id.");
  const date = String(row.bookingDate || row.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Pending id=${row.id} has invalid bookingDate.`);
  }
  const startTime = Number(row.startTime);
  const endTime = Number(row.endTime);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw new Error(`Pending id=${row.id} has invalid startTime/endTime.`);
  }
  const durationMinutes = (endTime - startTime) / 60;
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new Error(`Pending id=${row.id} has invalid duration.`);
  }
  return {
    id: row.id,
    date,
    startSeconds: startTime,
    durationMinutes,
    user2Id: resolveUser2Id(row.user2Id),
  };
}

function secretHeaders(secret) {
  return {
    Accept: "application/json",
    "X-Booking-Secret": secret,
  };
}

export async function listPendingBookings() {
  const { baseUrl, secret } = bookingApiConfig();
  const url = `${baseUrl}/api/playbycourt/pending`;
  log(`playbycourt: GET pending`);
  const response = await fetch(url, { headers: secretHeaders(secret) });
  if (!response.ok) {
    throw new Error(`Pending list failed (${response.status}).`);
  }
  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("Pending list response was not a JSON array.");
  }
  const items = body.map((row) => normalizePendingRow(row));
  log(`playbycourt: ${items.length} pending booking(s)`);
  return items;
}

export async function markBookingComplete(id) {
  const { baseUrl, secret } = bookingApiConfig();
  const url = `${baseUrl}/api/playbycourt/complete/${encodeURIComponent(id)}`;
  log(`playbycourt: POST complete id=${id}`);
  const response = await fetch(url, {
    method: "POST",
    headers: secretHeaders(secret),
  });
  if (!response.ok) {
    throw new Error(`Complete failed for id=${id} (${response.status}).`);
  }
}