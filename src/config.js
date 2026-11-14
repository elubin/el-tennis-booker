import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function configPath() {
  return resolve(process.env.CONFIG_PATH || "booking.config.json");
}

export function facilitySlugFromBookingUrl(url) {
  const match = String(url || "").match(/\/book\/([^/?#]+)/i);
  return match ? match[1] : "";
}

export function readConfigFileOptional() {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${path}. (${error.message})`);
  }
}

export function readConfigFile() {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(`Could not read ${path}. (${error.code || "ENOENT"})`);
  }
  return readConfigFileOptional();
}

/** PlayByPoint booking page URL from env, config file, or facility slug. */
/**
 * If booking.config.json is missing, create it from PBP_* env (never overwrites an existing file).
 */
export function materializeBookingConfigFromEnv() {
  const path = configPath();
  if (existsSync(path)) {
    return { created: false, path };
  }

  const url = envText("PBP_BOOKING_URL");
  const surface = envText("PBP_SURFACE");
  const paymentMethod = envText("PBP_PAYMENT_METHOD").toLowerCase();
  if (!url || !surface || !paymentMethod) {
    return { created: false, path, reason: "Set PBP_BOOKING_URL, PBP_SURFACE, and PBP_PAYMENT_METHOD to auto-create config." };
  }
  if (!["card", "prepaid"].includes(paymentMethod)) {
    throw new Error('PBP_PAYMENT_METHOD must be "card" or "prepaid".');
  }

  const slug = facilitySlugFromBookingUrl(url);
  if (!slug) {
    throw new Error("PBP_BOOKING_URL must look like https://app.playbypoint.com/book/yourclub");
  }

  const body = {
    facilitySlug: slug,
    facilityId: envNumber("PBP_FACILITY_ID"),
    timeZone: envText("PBP_TIMEZONE") || "America/New_York",
    kind: "reservation",
    surface,
    players: envNumber("PBP_PLAYERS") ?? 2,
    paymentMethod,
    dryRun: envText("PBP_DRY_RUN") !== "false",
    pollIntervalSeconds: Number(envText("PBP_POLL_INTERVAL_SECONDS") || 20) || 20,
    daysAhead: envNumber("PBP_DAYS_AHEAD") ?? 3,
    slots: [],
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return { created: true, path };
}

export function resolveBookingUrl(file = null) {
  const envUrl = String(process.env.PBP_BOOKING_URL || "").trim();
  if (envUrl) return envUrl;

  const data = file ?? readConfigFileOptional();
  const fromFile = String(data.bookingUrl || "").trim();
  if (fromFile) return fromFile;

  const slug = String(data.facilitySlug || "").trim();
  if (slug) return `https://app.playbypoint.com/book/${slug}`;

  throw new Error(
    "Set PBP_BOOKING_URL in the environment, or facilitySlug / bookingUrl in booking.config.json.",
  );
}

function envText(name) {
  return String(process.env[name] || "").trim();
}

function envNumber(name) {
  const raw = envText(name);
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function mergeFileWithEnv(file) {
  const bookingUrl = resolveBookingUrl(file);
  const slug =
    String(file.facilitySlug || "").trim() || facilitySlugFromBookingUrl(bookingUrl) || envText("PBP_FACILITY_SLUG");
  return {
    ...file,
    facilitySlug: slug,
    facilityId: file.facilityId ?? envNumber("PBP_FACILITY_ID") ?? null,
    timeZone: String(file.timeZone || "").trim() || envText("PBP_TIMEZONE") || "America/New_York",
    surface: String(file.surface || "").trim() || envText("PBP_SURFACE"),
    paymentMethod: String(file.paymentMethod || "").trim() || envText("PBP_PAYMENT_METHOD"),
    players: file.players ?? envNumber("PBP_PLAYERS") ?? 2,
    daysAhead: file.daysAhead ?? envNumber("PBP_DAYS_AHEAD") ?? 3,
    kind: file.kind || "reservation",
    dryRun: file.dryRun !== false,
    pollIntervalSeconds: file.pollIntervalSeconds ?? 20,
    slots: Array.isArray(file.slots) ? file.slots : [],
    bookingUrl,
  };
}

/**
 * @param {{ requireSlots?: boolean }} options
 * requireSlots false — queue / pending (PBP_BOOKING_URL + payment/surface env ok without JSON file)
 */
export function loadConfig(options = {}) {
  const requireSlots = options.requireSlots !== false;
  const path = configPath();
  const file = readConfigFileOptional();

  if (!existsSync(path) && !envText("PBP_BOOKING_URL") && !String(file.facilitySlug || "").trim()) {
    throw new Error(
      `Missing ${path}. Set PBP_BOOKING_URL (and PBP_SURFACE, PBP_PAYMENT_METHOD) in the environment, or create booking.config.json on the config volume.`,
    );
  }

  const email = process.env.PBP_EMAIL;
  const password = process.env.PBP_PASSWORD;
  if (!email || !password) {
    throw new Error("Set PBP_EMAIL and PBP_PASSWORD in the environment or a .env file.");
  }

  return {
    ...bookingFromFile(mergeFileWithEnv(file), { requireSlots }),
    email,
    password,
    notifyWebhook: process.env.NOTIFY_WEBHOOK || "",
    headless: process.env.HEADLESS !== "false",
  };
}

/** Queue automation: slots[] not required; facility id can come from the booking page after login. */
export function loadQueueConfig() {
  return loadConfig({ requireSlots: false });
}

export function bookingFromFile(file, { requireSlots = true } = {}) {
  const bookingUrl = file.bookingUrl || resolveBookingUrl(file);
  const facilitySlug =
    String(file.facilitySlug || "").trim() ||
    facilitySlugFromBookingUrl(bookingUrl) ||
    requiredText("", "facilitySlug (set PBP_BOOKING_URL or facilitySlug)");

  const facilityIdFromFile = file.facilityId;
  let facilityId = facilityIdFromFile != null && facilityIdFromFile !== "" ? Number(facilityIdFromFile) : null;
  if (facilityId != null && (!Number.isFinite(facilityId) || facilityId <= 0)) facilityId = null;

  const timeZone = requiredText(file.timeZone, "timeZone");
  const surface = requiredText(
    file.surface,
    requireSlots ? "surface" : "surface (set PBP_SURFACE or booking.config.json)",
  );
  const players = requiredNumber(file.players, "players");
  const paymentMethod = requiredText(
    file.paymentMethod,
    requireSlots ? "paymentMethod" : "paymentMethod (set PBP_PAYMENT_METHOD to card or prepaid)",
  );
  if (!["card", "prepaid"].includes(paymentMethod)) {
    throw new Error('paymentMethod must be "card" or "prepaid".');
  }
  const daysAhead = requiredNumber(file.daysAhead, "daysAhead");
  const pollIntervalSeconds = Number(file.pollIntervalSeconds || 20);
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
    throw new Error("pollIntervalSeconds must be a positive number.");
  }

  const slots = (file.slots || []).map((slot) => {
    const weekday = String(slot.weekday || "").toLowerCase();
    if (!WEEKDAYS.includes(weekday)) {
      throw new Error(`Unknown weekday "${slot.weekday}". Use monday through sunday.`);
    }
    const start = String(slot.start || "").trim();
    const startSeconds = parseClock(start);
    const durationMinutes = Number(slot.durationMinutes);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      throw new Error(`Invalid durationMinutes for ${weekday} ${start}.`);
    }
    return { weekday, start, startSeconds, durationMinutes };
  });

  if (requireSlots && slots.length === 0) {
    throw new Error("Add at least one preferred slot in booking.config.json (not needed for queue-only runs).");
  }

  if (requireSlots) {
    facilityId = requiredNumber(facilityId, "facilityId");
  }

  return {
    facilitySlug,
    facilityId,
    timeZone,
    kind: file.kind || "reservation",
    surface,
    players,
    paymentMethod,
    dryRun: file.dryRun !== false,
    pollIntervalSeconds,
    daysAhead,
    slots,
    bookingUrl,
    signInUrl: "https://app.playbypoint.com/users/sign_in",
  };
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Set ${label}.`);
  return text;
}

function requiredNumber(value, label) {
  if (value == null || value === "") throw new Error(`Set ${label}.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive number.`);
  return number;
}

function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) throw new Error(`Invalid start time "${value}". Use HH:MM.`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid start time "${value}".`);
  return hours * 3600 + minutes * 60;
}

export function formatSeconds(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Apply ids read from the live booking page when config/env omit facilityId. */
export function applyFacilityFromPage(config, facility) {
  if (!facility) return config;
  const next = { ...config };
  if (!next.facilityId && facility.facilityId) next.facilityId = facility.facilityId;
  if (facility.timeZone) next.timeZone = facility.timeZone;
  return next;
}