// A stand-in for the Claude Messages API, used only by scripts/test/ai-e2e.sh.
// It answers by the "[case:...]" marker in the email subject and records every request.
import http from "node:http";

const PORT = Number(process.env.FAKE_ANTHROPIC_PORT ?? 4020);
const requests = []; // { step, model, system, user, hasTools, hasOutputConfig }
const calls = new Map(); // `${case}:${step}` -> count

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const qv = (value = "", quote = "") => ({ value, quote });

function triage(classification, confidence, category = "brand_collaborations", reason = "Test answer.") {
  return { classification, confidence, category: classification === "newsletter_or_spam" || classification === "unrelated" ? "none" : category, reason };
}

function extraction(over) {
  return {
    title: "Untitled",
    summary: "Test summary.",
    category: "brand_collaborations",
    organization: qv(),
    sender_role: qv(),
    contact_phone: qv(),
    offer: qv(),
    deliverables: [],
    compensation: { type: "unspecified", status: "not_disclosed", amount_min: 0, amount_max: 0, currency: "", text: "", quote: "" },
    usage_rights: qv(),
    exclusivity: qv(),
    expenses_covered: qv(),
    location: qv(),
    format: "unknown",
    dates: [],
    requested_action: qv(),
    is_negotiable: "unknown",
    missing_information: [],
    red_flags: [],
    cancellation: false,
    ...over,
  };
}

function answer(kase, step, received) {
  const n = (calls.get(`${kase}:${step}`) ?? 0) + 1;
  calls.set(`${kase}:${step}`, n);
  const t = step === "triage";
  switch (kase) {
    case "offer":
      return t
        ? triage("new_opportunity", 0.95)
        : extraction({
            title: "Glow Labs serum reel collaboration",
            summary: "Glow Labs wants one reel and two stories for a serum launch.",
            organization: qv("Glow Labs", "Glow Labs"),
            offer: qv("Reel and stories for a serum launch", "1 Instagram reel and 2 stories for our new serum"),
            deliverables: [
              { item: "1 Instagram reel", quote: "1 Instagram reel" },
              { item: "2 stories", quote: "2 stories" },
            ],
            compensation: { type: "paid", status: "confirmed", amount_min: 75000, amount_max: 75000, currency: "INR", text: "₹75,000", quote: "Budget: ₹75,000" },
            usage_rights: qv("3 months on social pages", "Usage: 3 months on our social pages"),
            location: qv("Mumbai", "Shoot in Mumbai"),
            format: "in_person",
            dates: [
              { kind: "reply_by", date: iso(received + 3 * DAY), time: "", text: "Friday", quote: "Please confirm by Friday" },
              { kind: "shoot", date: iso(received + 10 * DAY), time: "", text: "", quote: "Shoot in Mumbai" },
            ],
            is_negotiable: "yes",
          });
    case "followup":
      return t
        ? triage("opportunity_update", 0.9)
        : extraction({
            title: "Glow Labs budget increase",
            organization: qv("Glow Labs", "Glow Labs"),
            compensation: { type: "paid", status: "confirmed", amount_min: 90000, amount_max: 90000, currency: "INR", text: "₹90,000", quote: "increase the budget to ₹90,000" },
            dates: [{ kind: "reply_by", date: iso(received + 3 * DAY), time: "", text: "Friday", quote: "Please confirm by Friday" }],
          });
    case "dup":
      return t
        ? triage("new_opportunity", 0.92)
        : extraction({
            title: "Glow Labs Diwali serum campaign",
            organization: qv("Glow Labs", "Glow Labs"),
            compensation: { type: "paid", status: "confirmed", amount_min: 60000, amount_max: 60000, currency: "INR", text: "₹60,000", quote: "Budget: ₹60,000" },
          });
    case "newsletter":
      return t ? triage("newsletter_or_spam", 0.97) : null;
    case "unclear":
      return t ? triage("new_opportunity", 0.5) : null;
    case "injection":
      return t ? triage("unrelated", 0.9) : null;
    case "invented":
      return t
        ? triage("new_opportunity", 0.9)
        : extraction({
            title: "Snack brand reel",
            compensation: { type: "paid", status: "confirmed", amount_min: 500000, amount_max: 500000, currency: "INR", text: "₹5,00,000", quote: "Budget: ₹5,00,000" },
          });
    case "scam":
      return t
        ? triage("suspicious", 0.85, "film_entertainment")
        : extraction({
            title: "Lead role in a Netflix India series",
            category: "film_entertainment",
            organization: qv("Netflix India", "Netflix India"),
            red_flags: [{ flag: "Upfront fee requested", quote: "registration fee of ₹5,000" }],
          });
    case "garbage":
      return "not json at all";
    case "flaky":
      if (t && n === 1) return { status: 529 };
      return t
        ? triage("new_opportunity", 0.9, "events_appearances")
        : extraction({ title: "Store launch appearance", category: "events_appearances", organization: qv("Zing Stores", "Zing Stores") });
    case "old":
      return t
        ? triage("new_opportunity", 0.9, "film_entertainment")
        : extraction({
            title: "Short film audition",
            category: "film_entertainment",
            compensation: { type: "paid", status: "confirmed", amount_min: 20000, amount_max: 20000, currency: "INR", text: "₹20,000", quote: "₹20,000" },
            dates: [{ kind: "audition", date: iso(received + 5 * DAY), time: "11:00", text: "", quote: "Audition for a short film" }],
          });
    case "orphan":
      return t ? triage("opportunity_update", 0.9) : extraction({ title: "Update about something" });
    case "manual":
      // Unsure at first; once her team says it's an offer, extraction gives a proper card.
      return t
        ? triage("unclear", 0.5)
        : extraction({
            title: "Wedding appearance in Jaipur",
            category: "events_appearances",
            organization: qv("Rao Weddings", "Rao Weddings"),
            location: qv("Jaipur", "a wedding in Jaipur"),
            compensation: { type: "paid", status: "confirmed", amount_min: 200000, amount_max: 200000, currency: "INR", text: "₹2,00,000", quote: "₹2,00,000" },
          });
    case "auth":
      return { status: 401 };
    case "credit":
      return { status: 400 };
    default:
      return t ? triage("unrelated", 0.9) : extraction({});
  }
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/_control/requests") return send(res, 200, requests);

  if (url.pathname === "/v1/messages" && req.method === "POST") {
    if (!req.headers["x-api-key"] || req.headers["anthropic-version"] !== "2023-06-01") {
      return send(res, 400, { type: "error", error: { type: "invalid_request_error" } });
    }
    const body = JSON.parse(raw);
    const schemaProps = body.output_config?.format?.schema?.properties ?? {};
    const step = "classification" in schemaProps ? "triage" : "extract";
    const user = body.messages?.[0]?.content ?? "";
    requests.push({ step, model: body.model, system: body.system, user, hasTools: "tools" in body, hasOutputConfig: Boolean(body.output_config) });

    const kase = user.match(/\[case:([a-z]+)\]/)?.[1] ?? "unknown";
    const receivedDay = user.match(/Received: .*\((\d{4}-\d{2}-\d{2})\)/)?.[1];
    const received = receivedDay ? Date.parse(`${receivedDay}T06:30:00Z`) : Date.now();
    const out = answer(kase, step, received);

    if (out && typeof out === "object" && "status" in out && typeof out.status === "number" && !("classification" in out)) {
      if (out.status === 400) {
        // What Claude says when the account has no credit left.
        return send(res, 400, {
          type: "error",
          error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." },
        });
      }
      return send(res, out.status, { type: "error", error: { type: out.status === 401 ? "authentication_error" : "overloaded_error" } });
    }
    const text = typeof out === "string" ? out : JSON.stringify(out);
    return send(res, 200, {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: Math.ceil(user.length / 4), output_tokens: Math.ceil(text.length / 4) },
    });
  }
  send(res, 404, { error: { type: "not_found" } });
});

server.listen(PORT, () => console.log(`fake anthropic listening on ${PORT}`));
