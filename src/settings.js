import { createServer, request as httpRequest } from "node:http";
import { resolveBookingUrl, facilitySlugFromBookingUrl, materializeBookingConfigFromEnv } from "./config.js";
import { lookupAvailability } from "./lookup.js";
import { closePreviewSession, previewCheckout } from "./checkout.js";
import { runPendingBookings, formatPendingSummary } from "./run-pending.js";

const NOVNC_PORT = 6080;

const port = Number(process.env.SETTINGS_PORT || 8890);
let busy = false;

const server = createServer(async (req, res) => {
  try {
    const path = pathname(req.url);
    if (path === "/live-view" || path === "/live-view/") {
      res.writeHead(302, {
        Location: "/live-view/vnc.html?autoconnect=1&resize=scale&path=live-view/websockify",
      });
      res.end();
      return;
    }
    if (path.startsWith("/live-view/")) return proxyNovnc(req, res);
    if (req.method === "GET" && (path === "/" || path === "/settings" || path === "/settings/")) {
      return send(res, 200, page("", null));
    }
    if (req.method !== "POST" || (path !== "/" && path !== "/settings")) return send(res, 404, "Not found");

    const body = JSON.parse(await readBody(req));
    if (busy) return send(res, 200, page("Already busy. Wait for the current task to finish.", null));

    busy = true;
  try {
      if (body.action === "automate") {
        const run = await runPendingBookings();
        const summary = formatPendingSummary(run);
        return send(res, 200, page(summary, null));
      }

      const bookingUrl = resolveBookingUrl();

      if (body.action === "checkout") {
        const checkoutMessage = await previewCheckout({
          bookingUrl,
          date: body.date,
          surface: body.surface,
          seconds: body.seconds,
          label: body.label,
        });
        return send(res, 200, page(checkoutMessage, null));
      }

      if (body.action === "lookup" || !body.action) {
        await closePreviewSession();
        const result = await lookupAvailability(bookingUrl);
        return send(res, 200, page("", result));
      }

      throw new Error(`Unknown action: ${body.action}`);
    } finally {
      busy = false;
    }
  } catch (error) {
    busy = false;
    send(res, 200, page(error.message, null));
  }
});

server.on("upgrade", (req, socket, head) => {
  if (!pathname(req.url).startsWith("/live-view/")) {
    socket.destroy();
    return;
  }
  const proxy = httpRequest({
    hostname: "127.0.0.1",
    port: NOVNC_PORT,
    path: stripLivePrefix(req.url),
    method: "GET",
    headers: { ...req.headers, host: `127.0.0.1:${NOVNC_PORT}` },
  });
  proxy.on("upgrade", (upstream, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${upstream.statusCode} ${upstream.statusMessage}`];
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (value == null) continue;
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (upstreamHead?.length) socket.write(upstreamHead);
    if (head?.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  proxy.on("error", () => socket.destroy());
  proxy.end();
});

materializeBookingConfigFromEnv();

server.listen(port, "0.0.0.0", () => {
  console.log(`Settings page listening on ${port}`);
});

function facilityHint() {
  try {
    const url = resolveBookingUrl();
    const slug = facilitySlugFromBookingUrl(url);
    if (slug) return `Configured facility: ${slug}`;
    return "Using configured PlayByPoint facility.";
  } catch {
    return "Set PBP_BOOKING_URL in the container environment.";
  }
}

function pathname(url) {
  return new URL(url || "/", "http://localhost").pathname;
}

function stripLivePrefix(url) {
  const parsed = new URL(url || "/", "http://localhost");
  let path = parsed.pathname.replace(/^\/live-view/, "") || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  return `${path}${parsed.search}`;
}

function proxyNovnc(req, res) {
  const proxy = httpRequest(
    {
      hostname: "127.0.0.1",
      port: NOVNC_PORT,
      path: stripLivePrefix(req.url),
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${NOVNC_PORT}` },
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxy.on("error", () => {
    if (!res.headersSent) send(res, 502, "Live view is not up yet. Restart the container and try again.");
  });
  req.pipe(proxy);
}

function page(message, result) {
  const banner = message ? `<p class="banner">${escapeHtml(message)}</p>` : "";
  const times = result ? renderTimes(result) : "";
  const hint = escapeHtml(facilityHint());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Available courts</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 40rem; padding: 0 1rem; color: #1a1a1a; }
    button { margin-top: 0.8rem; margin-right: 0.5rem; padding: 0.55rem 0.9rem; }
  .banner { background: #f4f4f4; padding: 0.7rem 0.8rem; white-space: pre-wrap; }
    .day { margin-top: 1.2rem; }
    .surface { margin: 0.7rem 0 0.25rem; }
    .slots { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.2rem 0 0.6rem; }
    .slot { margin-top: 0; }
    .booked { display: inline-block; margin-top: 0; padding: 0.55rem 0.9rem; background: #f3d2a6; color: #8a3b00; border: 1px solid #e09a3a; border-radius: 4px; }
    .actions { margin: 1rem 0; }
  </style>
</head>
<body>
  <h1>Court booking</h1>
  <p>${hint}. Login uses PBP_EMAIL and PBP_PASSWORD from the container environment.</p>
  <p>If Cloudflare asks you to click a box, open <a href="/live-view">the live view</a> in another tab and click it there. Login cookies stay in the auth folder afterward.</p>
  ${banner}
  <div class="actions">
    <button type="button" id="lookup">Show available times</button>
    <button type="button" id="automate">Book pending from queue</button>
  </div>
  ${times}
  <script>
    document.getElementById("lookup").addEventListener("click", async () => {
      const button = document.getElementById("lookup");
      button.disabled = true;
      const auto = document.getElementById("automate");
      auto.disabled = true;
      button.textContent = "Signing in…";
      await postAndReplace({ action: "lookup" });
    });
    document.getElementById("automate").addEventListener("click", async () => {
      const button = document.getElementById("automate");
      button.disabled = true;
      const lookup = document.getElementById("lookup");
      lookup.disabled = true;
      button.textContent = "Booking…";
      await postAndReplace({ action: "automate" });
    });
    for (const button of document.querySelectorAll(".slot")) {
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Opening Book page…";
        await postAndReplace({
          action: "checkout",
          date: button.dataset.date,
          surface: button.dataset.surface,
          seconds: Number(button.dataset.seconds),
          label: button.dataset.label,
        });
      });
    }
    async function postAndReplace(body) {
      const response = await fetch(location.pathname || "/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      document.open();
      document.write(await response.text());
      document.close();
    }
  </script>
</body>
</html>`;
}

function renderTimes(result) {
  const days = result.days
    .map((day) => {
      const surfaces = day.surfaces
        .map((surface) => {
          const slots = surface.slots.length
            ? `<div class="slots">${surface.slots
                .map((slot) =>
                  slot.booked
                    ? `<span class="booked">${escapeHtml(slot.label)}</span>`
                    : `<button type="button" class="slot" data-date="${escapeHtml(day.date)}" data-surface="${escapeHtml(surface.surface)}" data-seconds="${Number(slot.seconds)}" data-label="${escapeHtml(slot.label)}">${escapeHtml(slot.label)}</button>`,
                )
                .join("")}</div>`
            : `<p>none open</p>`;
          return `<p class="surface"><strong>${escapeHtml(surface.surface)}</strong></p>${slots}`;
        })
        .join("");
      return `<section class="day"><h2>${escapeHtml(day.weekday)} ${escapeHtml(day.date)}</h2>${surfaces}</section>`;
    })
    .join("");
  const next = result.nextOpen ? `<p>Next booking window opens ${escapeHtml(result.nextOpen)}.</p>` : "";
  return `<h2>Open times</h2><p>Click one open time for a checkout preview (nothing is booked).</p><p>Facility ${escapeHtml(result.facilityId)}. Times are ${escapeHtml(result.timeZone)}.</p>${next}${days}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function send(res, status, body) {
  const html = String(body).startsWith("<!");
  const headers = { "Content-Type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" };
  if (html) headers["Cache-Control"] = "no-store";
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}