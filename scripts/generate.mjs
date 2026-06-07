// The Daily Prophet — daily edition generator
// Runs once a day in GitHub Actions. Calls Claude (Sonnet 4.6) with the engine
// system prompt + the day's inputs, parses the JSON edition, and writes it into
// the published app, archives it, and advances the serialized storylines.
//
// Env:
//   ANTHROPIC_API_KEY  (required, from GitHub Actions secret)
//   DP_MOCK=1          (optional, for local testing: uses app/sample-edition.json
//                       instead of calling the API)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (...x) => path.join(ROOT, ...x);

const MODEL = "claude-sonnet-4-6";      // daily model (see deploy guide to confirm exact string)
const MAX_TOKENS = 2200;
const RECENT_COUNT = 6;                  // editions of memory fed back for anti-repetition

const readJSON = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; }
};
const writeJSON = (f, obj) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj, null, 2) + "\n");
};

function dateLabel(d) {
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}`;
}

// --- load the engine system prompt (strip the leading editor's note blockquote) ---
function loadSystemPrompt() {
  const raw = fs.readFileSync(p("daily-prophet-system-prompt.md"), "utf8");
  return raw.split("\n").filter(line => !line.startsWith("> ")).join("\n").trim();
}

// --- gather recent editions as a compact digest (keeps tokens + cost low) ---
function recentDigest() {
  const dir = p("app", "archive");
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
  const last = files.slice(-RECENT_COUNT);
  return last.map(f => {
    const e = readJSON(path.join(dir, f), {});
    return {
      edition_number: e.edition_number,
      date: e.edition_date,
      headlines: (e.stories || []).map(s => s.headline),
      arcs: e.storyline_updates || []
    };
  });
}

async function callClaude(system, userPayload) {
  if (process.env.DP_MOCK) {
    // Local test: pretend the model returned the sample edition.
    return fs.readFileSync(p("app", "sample-edition.json"), "utf8");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 1,
      system,
      messages: [{ role: "user", content: JSON.stringify(userPayload) }]
    })
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.content.map(c => c.text || "").join("");
}

// pull the JSON object out of the model's reply, tolerant of any stray text/fences
function extractJSON(text) {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("No JSON object found in model output");
  return JSON.parse(text.slice(a, b + 1));
}

async function main() {
  const system = loadSystemPrompt();
  const counter = readJSON(p("state", "counter.json"), { next: 1, firstDone: false });
  const storyline = readJSON(p("state", "storyline-state.json"), { arcs: [] });
  const eventsFile = readJSON(p("events.json"), { events: [] });
  const today = new Date();

  const userPayload = {
    edition_date: dateLabel(today),
    edition_number: counter.next,
    recent_editions: recentDigest(),
    storyline_state: storyline.arcs,
    real_events: eventsFile.events || [],
    special: counter.firstDone ? null : "belated_birthday"
  };

  console.log(`Generating edition #${counter.next} (${userPayload.edition_date})` +
    (userPayload.special ? ` [${userPayload.special}]` : "") +
    (userPayload.real_events.length ? ` [${userPayload.real_events.length} real event(s)]` : ""));

  const raw = await callClaude(system, userPayload);
  const edition = extractJSON(raw);

  // make sure the date/number are correct regardless of model drift
  edition.edition_date = userPayload.edition_date;
  edition.edition_number = counter.next;

  // basic shape validation — refuse to publish a broken paper
  if (!Array.isArray(edition.stories) || edition.stories.length === 0) {
    throw new Error("Edition has no stories — refusing to publish.");
  }

  // publish + archive
  writeJSON(p("app", "edition", "today.json"), edition);
  writeJSON(p("app", "archive", String(counter.next).padStart(4, "0") + ".json"), edition);

  // advance serialized storylines for tomorrow (drop resolved arcs)
  const updated = (edition.storyline_updates || []).filter(a => a.status !== "resolved");
  writeJSON(p("state", "storyline-state.json"), { arcs: updated });

  // bump counter, mark first edition done
  writeJSON(p("state", "counter.json"), { next: counter.next + 1, firstDone: true });

  // consume any real-world events so they aren't reused
  if ((eventsFile.events || []).length) {
    writeJSON(p("events.json"), { _comment: eventsFile._comment, events: [] });
  }

  console.log(`Published edition #${counter.next}: "${edition.stories[0].headline}"`);
  console.log(`Active storylines for tomorrow: ${updated.length}`);
}

main().catch(err => { console.error("GENERATION FAILED:", err.message); process.exit(1); });
