// The demo's made-up inbox: a dozen offers in every state Spotlight knows, dated relative to "now"
// so countdowns and the runway always look alive. Builds one SQL script that wipes the demo
// database's offers and writes them again. Pure: no database access here, so tests can check it.
//
// Every person, brand and address below is invented. Addresses use the reserved .example domain.
import { DEMO_MANAGER_EMAIL, DEMO_TALENT_EMAIL } from "../config.ts";
import { checkDraft, MODE_LABEL, type DraftMode, type Tone } from "../ai/draft.ts";
import { computePriority, type Preferences, type PriorityResult } from "../ai/priority.ts";
import { ruleRedFlags, type RedFlag } from "../ai/redflags.ts";
import { normalizeForMatch, quoteFound } from "../ai/verify.ts";

const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const DEMO_INBOX = DEMO_TALENT_EMAIL;
export const DEMO_SEEDED_KEY = "demo_seeded_at";
/** How long a visitor's changes last before the next visitor gets a fresh copy. */
export const DEMO_RESET_AFTER_MS = 6 * HOUR_MS;

export const DEMO_PREFERENCES: Preferences = {
  preferredCategories: [],
  preferredBrands: ["Saffron Thread"],
  avoidedBrands: [],
  preferredLocations: [],
  minimumFeeInr: { default: 30000 },
};

/** `days` from today in India, at hh:mm India time. */
export function istAt(now: Date, days: number, hh: number, mm = 0): Date {
  const istMidnight = Math.floor((now.getTime() + IST_MS) / DAY_MS) * DAY_MS - IST_MS;
  return new Date(istMidnight + days * DAY_MS + (hh * 60 + mm) * 60_000);
}
const ago = (now: Date, hours: number) => new Date(now.getTime() - hours * HOUR_MS);
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "long" });
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "long" });
const weekday = (d: Date) => WEEKDAY.format(d);
const dayMonth = (d: Date) => DAY_MONTH.format(d);

// --- The scenario ------------------------------------------------------------------------------------

type Field = { value: string; quote: string; email?: number };
type DemoEmail = {
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  subject: string;
  body: string;
  at: Date;
  role: "original" | "follow_up" | "change" | "cancellation";
  attachments?: string[];
};
type DemoDraft = {
  mode: DraftMode;
  tone: Tone;
  subject: string;
  body: string;
  createdAt: Date;
  sentAt?: Date;
};
type Event = { kind: string; at: Date; by: "manager" | "talent" | "ai" | "system"; detail?: Record<string, unknown> };

export type DemoOffer = {
  key: string;
  title: string;
  category: string;
  summary: string;
  classification: "new_opportunity" | "opportunity_update" | "negotiation_or_contract" | "availability_request" | "suspicious";
  confidence: number;
  emails: DemoEmail[];
  organization?: Field;
  senderRole?: Field;
  phone?: Field;
  pay?: { type: string; status: string; min?: number; max?: number; terms?: string; negotiable?: boolean; quote?: string; email?: number };
  oldPay?: { min: number; quote: string };
  deliverables: string[];
  location?: Field;
  format: "in_person" | "remote" | "hybrid" | "unknown";
  usage?: Field;
  exclusivity?: Field;
  expenses?: Field;
  nextStep?: Field;
  replyBy?: { at: Date; quote: string; email?: number };
  eventStart?: { at: Date; quote: string; email?: number };
  eventEnd?: Date;
  missing: string[];
  status: string;
  isRead: boolean;
  snoozedUntil?: Date;
  flagged?: { at: Date; note?: string; answer?: "interested" | "pass" | "questions"; answerNote?: string; answeredAt?: Date };
  /** Values whose quote deliberately doesn't match the email, to show the warning. */
  unverified?: string[];
  cancelled?: boolean;
  events: Event[];
  draft?: DemoDraft;
  /** What the scenario expects the rules to make of it; checked by the tests. */
  expect: PriorityResult["priority"];
};

export type DemoLooseEmail = {
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  at: Date;
  classification: "unrelated" | "newsletter_or_spam" | "unclear";
  reason: string;
};

export function demoScenario(now: Date): { offers: DemoOffer[]; loose: DemoLooseEmail[] } {
  const d = (days: number, hh: number, mm = 0) => istAt(now, days, hh, mm);
  const offers: DemoOffer[] = [];

  // 1. A paid reel due in two days: the one in the spotlight.
  {
    const replyBy = d(2, 18);
    offers.push({
      key: "lumora",
      title: "Lumora Skin serum launch reel",
      category: "social_media",
      summary: "Paid reel and two stories for Lumora's new Vitamin C serum, shot at home in Mumbai.",
      classification: "new_opportunity",
      confidence: 0.96,
      emails: [
        {
          fromName: "Ritika Menon",
          fromEmail: "ritika@lumoraskin.example",
          subject: "Paid collab: Lumora Vitamin C serum launch",
          at: ago(now, 3),
          role: "original",
          body: `Hi Tara,

I lead influencer partnerships at Lumora Skin. We're launching our Vitamin C Glow Serum next month and would love you to be part of it.

What we have in mind:
- 1 Instagram reel (30–45 seconds)
- 2 Instagram stories with a link sticker

The fee is ₹85,000 for the package, paid within 30 days of the post going live. Usage: 3 months on Lumora's own social pages, no paid ads. The only exclusivity is not posting another serum brand for 2 weeks either side.

We'd ship the product to you in Mumbai, so the shoot can be at home. Could you let us know by ${weekday(replyBy)} if Tara is interested, along with her available dates?

Warmly,
Ritika Menon
Influencer Partnerships, Lumora Skin
+91 98765 43210`,
        },
      ],
      organization: { value: "Lumora Skin", quote: "influencer partnerships at Lumora Skin" },
      senderRole: { value: "Influencer Partnerships", quote: "Influencer Partnerships, Lumora Skin" },
      phone: { value: "+91 98765 43210", quote: "+91 98765 43210" },
      pay: { type: "paid", status: "confirmed", min: 85000, max: 85000, terms: "Within 30 days of the post going live", quote: "The fee is ₹85,000 for the package" },
      deliverables: ["1 Instagram reel (30–45 seconds)", "2 Instagram stories with a link sticker"],
      location: { value: "Mumbai, at home", quote: "ship the product to you in Mumbai, so the shoot can be at home" },
      format: "remote",
      usage: { value: "3 months on Lumora's own social pages, no paid ads", quote: "Usage: 3 months on Lumora's own social pages, no paid ads" },
      exclusivity: { value: "No other serum brand for 2 weeks either side", quote: "not posting another serum brand for 2 weeks either side" },
      nextStep: { value: "Say if she's interested and share her available dates", quote: "let us know by" },
      replyBy: { at: replyBy, quote: `let us know by ${weekday(replyBy)}` },
      missing: ["Shoot dates", "Brief or script"],
      status: "new",
      isRead: false,
      events: [],
      draft: {
        mode: "express_interest",
        tone: "friendly",
        subject: "Re: Paid collab: Lumora Vitamin C serum launch",
        createdAt: ago(now, 1),
        body: `Hi Ritika,

Thank you for thinking of Tara for the Vitamin C Glow Serum launch. She'd love to hear more.

The package of 1 reel and 2 stories at ₹85,000 sounds good in principle. She's free to shoot on [her available dates], and we'd like to see the brief before she films.

Could you share the brief and when the product would reach her?

Best,
Kabir Rao
Manager to Tara Desai`,
      },
      expect: "high",
    });
  }

  // 2. An audition put to her, waiting for her answer: "Your call".
  {
    const due = d(5, 23, 59);
    offers.push({
      key: "tideline",
      title: "The Tide Line: audition for Meera",
      category: "film_entertainment",
      summary: "Self-tape audition for a supporting role in an 8-episode web series shooting in Goa.",
      classification: "availability_request",
      confidence: 0.93,
      emails: [
        {
          fromName: "Anil Joseph",
          fromEmail: "casting@kettlehill.example",
          subject: "Audition: The Tide Line (web series), role of Meera",
          at: ago(now, 46),
          role: "original",
          attachments: ["TideLine_Meera_scenes.pdf"],
          body: `Dear Tara,

Kettle Hill Pictures is casting for The Tide Line, an 8-episode web series for a streaming platform, shooting in Goa from early January.

We think you'd be a strong fit for Meera, a marine biologist and the lead's older sister (a supporting role across 5 of the 8 episodes).

Please send a self-tape of the two attached scenes by ${weekday(due)}, ${dayMonth(due)}. The fee for the role will be discussed with shortlisted actors.

Regards,
Anil Joseph
Casting Director, Kettle Hill Pictures`,
        },
      ],
      organization: { value: "Kettle Hill Pictures", quote: "Kettle Hill Pictures is casting" },
      senderRole: { value: "Casting Director", quote: "Casting Director, Kettle Hill Pictures" },
      deliverables: ["Self-tape of two scenes"],
      location: { value: "Goa", quote: "shooting in Goa from early January" },
      format: "in_person",
      nextStep: { value: "Send a self-tape of the two attached scenes", quote: "send a self-tape of the two attached scenes" },
      replyBy: { at: due, quote: `by ${weekday(due)}, ${dayMonth(due)}` },
      missing: ["Fee", "Exact shoot dates"],
      status: "reviewed",
      isRead: true,
      flagged: { at: ago(now, 20), note: "Supporting role, but a good platform. Want to tape for it?" },
      events: [{ kind: "status_changed", at: ago(now, 21), by: "manager", detail: { from: "new", to: "reviewed" } }],
      expect: "medium",
    });
  }

  // 3. A preferred brand's campaign: she said Interested, now in negotiation.
  {
    const replyBy = d(6, 18);
    const shoot = d(12, 9);
    offers.push({
      key: "saffron",
      title: "Saffron Thread festive campaign",
      category: "paid_shoots_advertising",
      summary: "Face of Saffron Thread's wedding-season campaign: a two-day photoshoot and short film in Jaipur.",
      classification: "new_opportunity",
      confidence: 0.95,
      emails: [
        {
          fromName: "Devika Shah",
          fromEmail: "devika@saffronthread.example",
          subject: "Festive campaign shoot in Jaipur",
          at: ago(now, 98),
          role: "original",
          body: `Hi Kabir,

We'd love Tara to be the face of Saffron Thread's wedding-season campaign this year.

It's a two-day photoshoot plus one short film at a heritage haveli in Jaipur on ${dayMonth(shoot)} and ${dayMonth(d(13, 9))}. Budget: ₹1,80,000 to ₹2,20,000 depending on usage. Usage would be 12 months, digital and in-store.

Travel and stay for Tara and one person are covered.

Could you confirm her interest by ${weekday(replyBy)}?

Thanks,
Devika Shah
Brand Manager, Saffron Thread`,
        },
      ],
      organization: { value: "Saffron Thread", quote: "Saffron Thread's wedding-season campaign" },
      senderRole: { value: "Brand Manager", quote: "Brand Manager, Saffron Thread" },
      pay: { type: "paid", status: "range", min: 180000, max: 220000, negotiable: true, quote: "Budget: ₹1,80,000 to ₹2,20,000 depending on usage" },
      deliverables: ["Two-day photoshoot", "One short film"],
      location: { value: "Jaipur", quote: "a heritage haveli in Jaipur" },
      format: "in_person",
      usage: { value: "12 months, digital and in-store", quote: "Usage would be 12 months, digital and in-store" },
      expenses: { value: "Travel and stay for Tara and one person", quote: "Travel and stay for Tara and one person are covered" },
      nextStep: { value: "Confirm her interest", quote: "confirm her interest by" },
      replyBy: { at: replyBy, quote: `confirm her interest by ${weekday(replyBy)}` },
      eventStart: { at: shoot, quote: `in Jaipur on ${dayMonth(shoot)}` },
      eventEnd: d(13, 18),
      missing: ["Exclusivity"],
      status: "in_negotiation",
      isRead: true,
      flagged: {
        at: ago(now, 80),
        note: "Your favourite brand. Two days in Jaipur, travel covered.",
        answer: "interested",
        answerNote: "Love their work! Can we ask if they'd do 12 months digital only?",
        answeredAt: ago(now, 70),
      },
      events: [
        { kind: "status_changed", at: ago(now, 70), by: "system", detail: { from: "new", to: "interested", because: "She said she's interested" } },
        { kind: "note", at: ago(now, 30), by: "manager", detail: { text: "Asked Devika about digital-only usage at the top of the range. She'll check with the brand." } },
        { kind: "status_changed", at: ago(now, 30), by: "manager", detail: { from: "interested", to: "in_negotiation" } },
      ],
      expect: "high",
    });
  }

  // 4. A classic scam: fee to "register", ID and bank details, 24-hour pressure.
  {
    const body = `Dear Tara,

CONGRATULATIONS! You have been SHORTLISTED for the lead role in a big-budget feature film.

To confirm your slot, please pay a registration fee of ₹4,999 within 24 hours. Send a copy of your Aadhaar card and bank details so we can prepare the contract.

This offer is only for today.

StarPath Casting Team`;
    offers.push({
      key: "starpath",
      title: "Lead role in a feature film (StarPath Casting)",
      category: "film_entertainment",
      summary: "Claims she's shortlisted for a lead role, but asks for a registration fee and ID documents first.",
      classification: "suspicious",
      confidence: 0.9,
      emails: [
        {
          fromName: "StarPath Casting",
          fromEmail: "starpath.casting.official@gmail.com",
          subject: "Congratulations! Shortlisted for LEAD ROLE",
          at: ago(now, 7),
          role: "original",
          body,
        },
      ],
      organization: { value: "StarPath Casting", quote: "StarPath Casting Team" },
      deliverables: [],
      format: "unknown",
      nextStep: { value: "Pay a registration fee and send ID", quote: "pay a registration fee of ₹4,999 within 24 hours" },
      missing: ["Film title", "Production company", "Fee"],
      status: "new",
      isRead: false,
      events: [],
      expect: "needs_review",
    });
  }

  // 5. A charity run: unpaid, with a location that couldn't be matched word for word.
  {
    const run = d(9, 6, 30);
    offers.push({
      key: "seaside",
      title: "Seaside 10K: guest of honour",
      category: "events_appearances",
      summary: "Flag off a charity run for children's literacy and hand out medals. Unpaid.",
      classification: "new_opportunity",
      confidence: 0.91,
      emails: [
        {
          fromName: "Farah Khan",
          fromEmail: "events@openpages.example",
          subject: "Invitation: guest of honour at the Seaside 10K",
          at: ago(now, 52),
          role: "original",
          body: `Hello Tara,

Open Pages Foundation runs the Seaside 10K every year to raise money for children's libraries. This year's run is on ${weekday(run)}, ${dayMonth(run)} at 6:30 am on the Carter Road seafront in Bandra.

We'd be honoured if you would flag off the race and hand out medals at the finish (about 2 hours). As a charity event we're unable to offer a fee, but we will feature you across our channels.

With thanks,
Farah Khan
Events Lead, Open Pages Foundation`,
        },
      ],
      organization: { value: "Open Pages Foundation", quote: "Open Pages Foundation runs the Seaside 10K" },
      senderRole: { value: "Events Lead", quote: "Events Lead, Open Pages Foundation" },
      pay: { type: "unpaid", status: "not_disclosed", quote: "we're unable to offer a fee" },
      deliverables: ["Flag off the race", "Hand out medals (about 2 hours)"],
      location: { value: "Carter Road, Bandra", quote: "Carter Road promenade, Bandra" },
      format: "in_person",
      eventStart: { at: run, quote: `${weekday(run)}, ${dayMonth(run)} at 6:30 am` },
      missing: [],
      status: "reviewed",
      isRead: true,
      unverified: ["location"],
      events: [],
      expect: "low",
    });
  }

  // 6. A podcast: unpaid publicity.
  {
    const replyBy = d(10, 18);
    offers.push({
      key: "pocketchai",
      title: "Pocket Chai podcast interview",
      category: "media_publicity",
      summary: "A 45-minute conversation on a podcast about Mumbai's creative scene, recorded in Andheri.",
      classification: "new_opportunity",
      confidence: 0.92,
      emails: [
        {
          fromName: "Rohan Iyer",
          fromEmail: "rohan@pocketchai.example",
          subject: "Guest on Pocket Chai?",
          at: ago(now, 30),
          role: "original",
          body: `Hi Tara,

I host Pocket Chai, a weekly podcast about Mumbai's creative scene. We'd love to have you on for a 45-minute conversation about your journey from theatre to screen.

We record at our studio in Andheri. We don't pay guests, but we share clips across our channels.

Could you let me know by ${dayMonth(replyBy)} if you're up for it?

Cheers,
Rohan Iyer
Host, Pocket Chai`,
        },
      ],
      organization: { value: "Pocket Chai", quote: "I host Pocket Chai" },
      senderRole: { value: "Host", quote: "Host, Pocket Chai" },
      pay: { type: "unpaid", status: "not_disclosed", quote: "We don't pay guests" },
      deliverables: ["45-minute podcast conversation"],
      location: { value: "Andheri, Mumbai", quote: "our studio in Andheri" },
      format: "in_person",
      replyBy: { at: replyBy, quote: `let me know by ${dayMonth(replyBy)}` },
      missing: ["Recording date"],
      status: "new",
      isRead: true,
      events: [],
      expect: "low",
    });
  }

  // 7. A barter post.
  offers.push({
    key: "velvet",
    title: "Velvet Crumb Diwali hamper post",
    category: "commercial_affiliate",
    summary: "A Diwali hamper in exchange for one Instagram post. No fee.",
    classification: "new_opportunity",
    confidence: 0.9,
    emails: [
      {
        fromName: "Velvet Crumb Bakery",
        fromEmail: "hello@velvetcrumb.example",
        subject: "A little Diwali sweetness for you",
        at: ago(now, 75),
        role: "original",
        body: `Hi Tara!

We're a small bakery in Pune and big fans of your work. We'd love to send you a hamper from our new Diwali range in exchange for one Instagram post or story about it.

Let us know your address if you'd like one!

Love,
Team Velvet Crumb`,
      },
    ],
    organization: { value: "Velvet Crumb", quote: "Team Velvet Crumb" },
    pay: { type: "barter", status: "not_disclosed", quote: "a hamper from our new Diwali range in exchange for one Instagram post" },
    deliverables: ["One Instagram post or story"],
    format: "remote",
    nextStep: { value: "Share her address", quote: "Let us know your address" },
    missing: ["Deadline"],
    status: "new",
    isRead: true,
    events: [],
    expect: "low",
  });

  // 8. A TV commercial whose fee went up in a second email: "Recent changes" and "Terms changed".
  {
    const shoot = d(20, 7);
    const replyBy = d(8, 18);
    offers.push({
      key: "brightline",
      title: "Brightline Mobile TV commercial",
      category: "paid_shoots_advertising",
      summary: "One-day TV commercial shoot for Brightline's new phone. Fee raised to ₹3,50,000 for a year of TV and digital.",
      classification: "negotiation_or_contract",
      confidence: 0.97,
      emails: [
        {
          fromName: "Sameer Kulkarni",
          fromEmail: "sameer@reelhouse.example",
          subject: "TVC for Brightline Mobile",
          at: ago(now, 140),
          role: "original",
          body: `Hi Kabir,

Reelhouse Productions is producing a TV commercial for Brightline Mobile's new phone, and the agency would like Tara for the lead.

It's a one-day shoot at a studio in Goregaon, Mumbai on ${dayMonth(shoot)}. The fee is ₹3,00,000 for 1 year of TV and digital usage.

Let me know if she's available.

Sameer Kulkarni
Producer, Reelhouse Productions`,
        },
        {
          fromName: "Sameer Kulkarni",
          fromEmail: "sameer@reelhouse.example",
          subject: "Re: TVC for Brightline Mobile",
          at: ago(now, 26),
          role: "change",
          body: `Hi Kabir,

Good news: the client has approved a revised fee of ₹3,50,000, same usage. The shoot date is unchanged.

Could we lock the dates by ${weekday(replyBy)}?

Sameer`,
        },
      ],
      organization: { value: "Reelhouse Productions", quote: "Reelhouse Productions is producing a TV commercial" },
      senderRole: { value: "Producer", quote: "Producer, Reelhouse Productions" },
      pay: { type: "paid", status: "confirmed", min: 350000, max: 350000, quote: "revised fee of ₹3,50,000", email: 1 },
      oldPay: { min: 300000, quote: "The fee is ₹3,00,000" },
      deliverables: ["One-day TV commercial shoot"],
      location: { value: "Goregaon, Mumbai", quote: "a studio in Goregaon, Mumbai" },
      format: "in_person",
      usage: { value: "1 year of TV and digital", quote: "1 year of TV and digital usage" },
      nextStep: { value: "Lock the shoot dates", quote: "lock the dates by", email: 1 },
      replyBy: { at: replyBy, quote: `lock the dates by ${weekday(replyBy)}`, email: 1 },
      eventStart: { at: shoot, quote: `Goregaon, Mumbai on ${dayMonth(shoot)}` },
      missing: ["Exclusivity", "Payment terms"],
      status: "awaiting_my_response",
      isRead: true,
      events: [
        { kind: "status_changed", at: ago(now, 120), by: "manager", detail: { from: "new", to: "awaiting_their_response" } },
        { kind: "email_received", at: ago(now, 26), by: "ai", detail: {} },
        { kind: "change_detected", at: ago(now, 26), by: "ai", detail: { field: "compensation", from: "₹3,00,000", to: "₹3,50,000", verified: true } },
        { kind: "status_changed", at: ago(now, 26), by: "system", detail: { from: "awaiting_their_response", to: "awaiting_my_response", because: "They replied" } },
        { kind: "note", at: ago(now, 20), by: "manager", detail: { text: "Called Sameer. Call time 7 am, wardrobe by the agency." } },
      ],
      expect: "high",
    });
  }

  // 9. A music video: we replied (sent from Spotlight), now waiting on them.
  {
    const shoot = d(15, 10);
    const replySent = ago(now, 96);
    offers.push({
      key: "indigo",
      title: "Indigo Loop music video",
      category: "paid_shoots_advertising",
      summary: "Lead in a music video for an indie band, one day in Lonavala. ₹1,20,000.",
      classification: "new_opportunity",
      confidence: 0.94,
      emails: [
        {
          fromName: "Neha Bhatt",
          fromEmail: "neha@indigoloop.example",
          subject: "Music video lead: Indigo Loop",
          at: ago(now, 190),
          role: "original",
          body: `Hi Tara,

Indigo Loop Studios is making the video for The Paper Boats' new single, and we'd love you as the lead.

It's a one-day shoot in Lonavala on ${dayMonth(shoot)}. The fee is ₹1,20,000, with travel from Mumbai covered.

Would you be interested?

Neha Bhatt
Producer, Indigo Loop Studios`,
        },
      ],
      organization: { value: "Indigo Loop Studios", quote: "Indigo Loop Studios is making the video" },
      senderRole: { value: "Producer", quote: "Producer, Indigo Loop Studios" },
      pay: { type: "paid", status: "confirmed", min: 120000, max: 120000, quote: "The fee is ₹1,20,000" },
      deliverables: ["One-day music video shoot"],
      location: { value: "Lonavala", quote: "one-day shoot in Lonavala" },
      format: "in_person",
      expenses: { value: "Travel from Mumbai", quote: "travel from Mumbai covered" },
      eventStart: { at: shoot, quote: `Lonavala on ${dayMonth(shoot)}` },
      missing: ["Usage rights", "Reply-by date"],
      status: "awaiting_their_response",
      isRead: true,
      events: [
        { kind: "reply_drafted", at: ago(now, 97), by: "manager", detail: { mode: MODE_LABEL.ask_budget } },
        { kind: "reply_sent", at: replySent, by: "manager", detail: { to: "neha@indigoloop.example", subject: "Re: Music video lead: Indigo Loop" } },
        { kind: "status_changed", at: replySent, by: "system", detail: { from: "new", to: "awaiting_their_response", because: "A reply was sent" } },
      ],
      draft: {
        mode: "ask_budget",
        tone: "professional",
        subject: "Re: Music video lead: Indigo Loop",
        createdAt: ago(now, 97),
        sentAt: replySent,
        body: `Hi Neha,

Thank you for thinking of Tara. She likes The Paper Boats and is interested in principle.

Before we go further, could you tell us how the video will be used and for how long, and whether the fee includes any paid promotion?

Best regards,
Kabir Rao
Manager to Tara Desai`,
      },
      expect: "medium",
    });
  }

  // 10. A launch appearance the hotel withdrew: archived, still in "Recent changes".
  {
    const launch = d(4, 19);
    offers.push({
      key: "harbour",
      title: "Harbour Lane Hotels launch appearance",
      category: "events_appearances",
      summary: "Appearance at a hotel launch in Alibaug. Withdrawn by the hotel.",
      classification: "new_opportunity",
      confidence: 0.95,
      cancelled: true,
      emails: [
        {
          fromName: "Karan Malhotra",
          fromEmail: "karan@harbourlane.example",
          subject: "Launch evening at Harbour Lane Alibaug",
          at: ago(now, 118),
          role: "original",
          body: `Dear Tara,

We're opening Harbour Lane Alibaug on ${dayMonth(launch)} and would love you to attend the launch evening as our guest of honour (2 hours, a short ribbon-cutting and photos).

We can offer ₹75,000 plus a two-night stay.

Karan Malhotra
Marketing, Harbour Lane Hotels`,
        },
        {
          fromName: "Karan Malhotra",
          fromEmail: "karan@harbourlane.example",
          subject: "Re: Launch evening at Harbour Lane Alibaug",
          at: ago(now, 44),
          role: "cancellation",
          body: `Dear Kabir,

I'm sorry to let you know that the launch has been postponed indefinitely, so we have to withdraw the invitation for now. We hope to work with Tara another time.

Karan`,
        },
      ],
      organization: { value: "Harbour Lane Hotels", quote: "Marketing, Harbour Lane Hotels" },
      senderRole: { value: "Marketing", quote: "Marketing, Harbour Lane Hotels" },
      pay: { type: "paid", status: "confirmed", min: 75000, max: 75000, quote: "We can offer ₹75,000" },
      deliverables: ["Guest of honour at the launch (2 hours)"],
      location: { value: "Alibaug", quote: "Harbour Lane Alibaug" },
      format: "in_person",
      expenses: { value: "Two-night stay", quote: "a two-night stay" },
      eventStart: { at: launch, quote: `Harbour Lane Alibaug on ${dayMonth(launch)}` },
      missing: [],
      status: "archived",
      isRead: true,
      events: [
        { kind: "email_received", at: ago(now, 44), by: "ai", detail: {} },
        { kind: "cancellation_detected", at: ago(now, 44), by: "ai", detail: {} },
        { kind: "status_changed", at: ago(now, 40), by: "manager", detail: { from: "new", to: "archived" } },
      ],
      expect: "medium",
    });
  }

  // 11. An agency pitch, snoozed for later.
  offers.push({
    key: "tinsel",
    title: "Tinsel Talent representation (South markets)",
    category: "representation_partnerships",
    summary: "An agency offering to represent her for brand deals in the South, on commission.",
    classification: "new_opportunity",
    confidence: 0.88,
    emails: [
      {
        fromName: "Lakshmi Narayan",
        fromEmail: "lakshmi@tinseltalent.example",
        subject: "Representation for brand work in the South",
        at: ago(now, 160),
        role: "original",
        body: `Hello Kabir,

Tinsel Talent represents actors for brand work across Chennai, Bengaluru and Hyderabad. We'd like to discuss representing Tara for brand deals in these markets, on a commission basis.

Happy to set up a call at your convenience.

Lakshmi Narayan
Partner, Tinsel Talent`,
      },
    ],
    organization: { value: "Tinsel Talent", quote: "Tinsel Talent represents actors" },
    senderRole: { value: "Partner", quote: "Partner, Tinsel Talent" },
    pay: { type: "commission", status: "not_disclosed", quote: "on a commission basis" },
    deliverables: [],
    format: "unknown",
    nextStep: { value: "Set up a call", quote: "set up a call" },
    missing: ["Commission rate", "Contract length"],
    status: "reviewed",
    isRead: true,
    snoozedUntil: d(5, 9),
    events: [{ kind: "snoozed", at: ago(now, 48), by: "manager", detail: { days: 7 } }],
    expect: "low",
  });

  // 12. Done and paid: shows under Closed.
  {
    const posted = d(-21, 12);
    offers.push({
      key: "zest",
      title: "Zest Kitchen festive recipe reel",
      category: "social_media",
      summary: "A festive recipe reel for Zest Kitchen. Posted and paid.",
      classification: "new_opportunity",
      confidence: 0.95,
      emails: [
        {
          fromName: "Ira Sethi",
          fromEmail: "ira@zestkitchen.example",
          subject: "Festive recipe reel with Zest Kitchen",
          at: d(-35, 11),
          role: "original",
          body: `Hi Tara,

We'd love you to cook one of our festive recipes on camera for a reel. The fee is ₹40,000, paid on posting, with 2 months of usage on our pages. We'd like it live on ${dayMonth(posted)}.

Ira Sethi
Social, Zest Kitchen`,
        },
      ],
      organization: { value: "Zest Kitchen", quote: "Social, Zest Kitchen" },
      senderRole: { value: "Social", quote: "Social, Zest Kitchen" },
      pay: { type: "paid", status: "confirmed", min: 40000, max: 40000, terms: "Paid on posting", quote: "The fee is ₹40,000, paid on posting" },
      deliverables: ["One recipe reel"],
      format: "remote",
      usage: { value: "2 months on their pages", quote: "2 months of usage on our pages" },
      eventStart: { at: posted, quote: `live on ${dayMonth(posted)}` },
      missing: [],
      status: "completed",
      isRead: true,
      events: [
        { kind: "status_changed", at: d(-33, 12), by: "manager", detail: { from: "new", to: "accepted" } },
        { kind: "status_changed", at: d(-19, 12), by: "manager", detail: { from: "accepted", to: "completed" } },
      ],
      expect: "low",
    });
  }

  const loose: DemoLooseEmail[] = [
    {
      fromName: "Studio Notes",
      fromEmail: "newsletter@studionotes.example",
      subject: "This week: 5 audition tips from casting directors",
      at: ago(now, 12),
      classification: "newsletter_or_spam",
      reason: "A weekly newsletter, not an offer.",
      body: "This week's issue: five audition tips from casting directors, plus the festivals open for submissions. You're receiving this because you subscribed.",
    },
    {
      fromName: "Mira Desai",
      fromEmail: "mira.d@example.com",
      subject: "Dinner on Sunday?",
      at: ago(now, 28),
      classification: "unrelated",
      reason: "A personal message.",
      body: "Hey! Are you free for dinner on Sunday? Thinking of that new place in Bandra.",
    },
    {
      fromName: "Vikram",
      fromEmail: "vikram.films@example.com",
      subject: "Quick question",
      at: ago(now, 15),
      classification: "unclear",
      reason: "Might be about work, but it doesn't say what. A person should look.",
      body: "Hi, are you available sometime next month? Have something in mind, would love to discuss. Call me.",
    },
  ];
  return { offers, loose };
}

// --- Turning it into SQL -----------------------------------------------------------------------------

/** A SQL literal. The values here are our own constants, but they're escaped properly anyway. */
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number in demo seed");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
const json = (v: unknown) => `${lit(JSON.stringify(v))}::jsonb`;
const textArray = (xs: string[]) => (xs.length ? `ARRAY[${xs.map(lit).join(", ")}]::text[]` : `'{}'::text[]`);
const userRef = (email: string) => `(SELECT id FROM users WHERE email = ${lit(email)})`;
const categoryRef = (slug: string) => `(SELECT id FROM categories WHERE slug = ${lit(slug)})`;

export type DemoSeed = { sql: string; offers: Array<{ key: string; id: string; title: string; priority: PriorityResult }> };

export function buildDemoSeed(now: Date, newId: () => string = () => crypto.randomUUID()): DemoSeed {
  const { offers, loose } = demoScenario(now);
  const manager = userRef(DEMO_MANAGER_EMAIL);
  const talent = userRef(DEMO_TALENT_EMAIL);
  const actor = (by: Event["by"]) => (by === "manager" ? manager : by === "talent" ? talent : "NULL");
  const actorType = (by: Event["by"]) => (by === "manager" || by === "talent" ? "user" : by);
  const account = newId();
  const out: string[] = [];
  const summary: DemoSeed["offers"] = [];

  // Start clean. Deleting the inbox cascades to its emails and offers, and their history.
  out.push(`DELETE FROM gmail_accounts`, `DELETE FROM notifications`, `DELETE FROM reminders`, `DELETE FROM push_subscriptions`);

  for (const [email, name] of [
    [DEMO_MANAGER_EMAIL, "Kabir Rao"],
    [DEMO_TALENT_EMAIL, "Tara Desai"],
  ] as const) {
    out.push(
      `INSERT INTO users (email, name) VALUES (${lit(email)}, ${lit(name)})
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, avatar_url = NULL,
         alert_channels = '{"in_app": true, "push": true, "telegram": false}'::jsonb,
         alert_types = '{"new_offers": "all", "deadlines": true, "changes": true, "nudges": true}'::jsonb,
         quiet_hours_start = '23:00', quiet_hours_end = '08:00', telegram_chat_id = NULL, telegram_link_hash = NULL,
         telegram_link_expires_at = NULL, telegram_linked_at = NULL, telegram_awaiting_opportunity = NULL, telegram_awaiting_until = NULL`,
    );
  }

  const prefs: Array<[string, unknown]> = [
    ["talent_email", DEMO_TALENT_EMAIL],
    ["reply_signature", "Kabir Rao\nManager to Tara Desai"],
    ["reply_facts", "Portfolio: https://portfolio.example/tara-desai\nBased in Mumbai. Speaks Hindi, English and Marathi."],
    ["preferred_categories", DEMO_PREFERENCES.preferredCategories],
    ["preferred_brands", DEMO_PREFERENCES.preferredBrands],
    ["avoided_brands", DEMO_PREFERENCES.avoidedBrands],
    ["preferred_locations", DEMO_PREFERENCES.preferredLocations],
    ["minimum_fee_inr", DEMO_PREFERENCES.minimumFeeInr],
    [DEMO_SEEDED_KEY, now.toISOString()],
  ];
  for (const [key, value] of prefs) {
    out.push(`INSERT INTO preferences (key, value) VALUES (${lit(key)}, ${json(value)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
  }

  out.push(
    `INSERT INTO gmail_accounts (id, email, status, scopes, history_id, last_synced_at, initial_scan_completed_at, connected_by, connected_at, scan_days, scan_after, scan_listed)
     VALUES (${lit(account)}, ${lit(DEMO_INBOX)}, 'connected',
       ARRAY['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose']::text[],
       'demo', ${lit(now)}, ${lit(ago(now, 240))}, ${manager}, ${lit(ago(now, 240))}, 30, ${lit(ago(now, 960))}, 42)`,
    `INSERT INTO worker_heartbeats (worker_id, started_at, last_beat_at) VALUES ('scheduler', ${lit(now)}, ${lit(now)})
     ON CONFLICT (worker_id) DO UPDATE SET last_beat_at = EXCLUDED.last_beat_at`,
  );

  let msg = 0;
  const insertEmail = (e: { fromName: string; fromEmail: string; replyTo?: string; subject: string; body: string; at: Date; attachments?: string[] }, thread: string, extra: string) => {
    const id = newId();
    msg++;
    out.push(
      `INSERT INTO emails (id, gmail_account_id, gmail_message_id, gmail_thread_id, rfc_message_id, from_name, from_email, reply_to, to_emails,
         subject, snippet, body_text, received_at, has_attachments, attachment_names, is_historical, processing_state, processed_at,
         classification, classification_confidence, classification_reason)
       VALUES (${lit(id)}, ${lit(account)}, ${lit(`demo-msg-${msg}`)}, ${lit(thread)}, ${lit(`<demo-${msg}@spotlight.example>`)},
         ${lit(e.fromName)}, ${lit(e.fromEmail)}, ${lit(e.replyTo ?? null)}, ${textArray([DEMO_INBOX])}, ${lit(e.subject)},
         ${lit(e.body.replace(/\s+/g, " ").slice(0, 140))}, ${lit(e.body)}, ${lit(e.at)}, ${lit(Boolean(e.attachments?.length))},
         ${textArray(e.attachments ?? [])}, false, ${extra})`,
    );
    return id;
  };

  for (const o of offers) {
    const id = newId();
    const thread = `demo-thread-${o.key}`;
    const emailIds = o.emails.map((e, i) =>
      insertEmail(
        e,
        thread,
        `'processed', ${lit(e.at)}, ${lit(i === 0 ? o.classification : "opportunity_update")}, ${o.confidence}, ${lit(i === 0 ? "Reads as a work offer." : "A reply in the same conversation.")}`,
      ),
    );
    const first = o.emails[0]!;
    const sourceOf = (i = 0) => normalizeForMatch(`${o.emails[i]!.subject}\n${o.emails[i]!.body}`);
    const verified = (f: { quote: string; email?: number }) => quoteFound(f.quote, sourceOf(f.email ?? 0));

    const redFlags: RedFlag[] = o.classification === "suspicious"
      ? ruleRedFlags({ fromEmail: first.fromEmail, fromName: first.fromName, replyTo: first.replyTo ?? null, subject: first.subject, body: first.body, organization: o.organization?.value ?? null })
      : [];
    const unverified = [...(o.unverified ?? [])];
    const future = [o.replyBy?.at, o.eventStart?.at].filter((x): x is Date => !!x && x.getTime() >= now.getTime()).sort((a, b) => a.getTime() - b.getTime());
    const past = [o.replyBy?.at, o.eventStart?.at, o.eventEnd].filter((x): x is Date => !!x && x.getTime() < now.getTime()).sort((a, b) => a.getTime() - b.getTime());
    const pay = o.pay ?? { type: "unspecified", status: "not_disclosed" };
    const priority = computePriority(
      {
        classification: o.classification,
        confidence: o.confidence,
        categorySlug: o.category,
        organization: o.organization?.value ?? null,
        location: o.location?.value ?? null,
        compensation: { type: pay.type, status: pay.status, amountMin: pay.min ?? null, amountMax: pay.max ?? null, currency: "INR", verified: !unverified.includes("compensation") },
        nextDeadline: future[0] ?? null,
        latestPastDeadline: past.at(-1) ?? null,
        redFlags,
        cancelled: Boolean(o.cancelled),
        unverified,
      },
      DEMO_PREFERENCES,
      now,
    );
    summary.push({ key: o.key, id, title: o.title, priority });

    const lastAt = [...o.emails.map((e) => e.at), ...o.events.map((e) => e.at)].sort((a, b) => b.getTime() - a.getTime())[0]!;
    const f = o.flagged;
    out.push(
      `INSERT INTO opportunities (id, gmail_account_id, title, category_id, summary, sender_name, sender_email, organization, sender_role, contact_phone,
         compensation_type, compensation_status, amount_min, amount_max, currency, payment_terms, is_negotiable, usage_rights, exclusivity,
         expenses_covered, deliverables, location, format, event_start_at, event_end_at, reply_by_at, next_deadline_at, requested_action,
         missing_information, priority, priority_score, priority_reasons, red_flags, confidence, status, is_read, snoozed_until,
         flagged_for_talent_at, flagged_by, talent_response, talent_response_note, talent_responded_at, first_received_at, last_activity_at,
         created_at, from_historical, unverified_fields, classification)
       VALUES (${lit(id)}, ${lit(account)}, ${lit(o.title)}, ${categoryRef(o.category)}, ${lit(o.summary)}, ${lit(first.fromName)}, ${lit(first.fromEmail)},
         ${lit(o.organization?.value ?? null)}, ${lit(o.senderRole?.value ?? null)}, ${lit(o.phone?.value ?? null)},
         ${lit(pay.type)}, ${lit(pay.status)}, ${lit(pay.min ?? null)}, ${lit(pay.max ?? null)}, 'INR', ${lit(pay.terms ?? null)}, ${lit(pay.negotiable ?? null)},
         ${lit(o.usage?.value ?? null)}, ${lit(o.exclusivity?.value ?? null)}, ${lit(o.expenses?.value ?? null)},
         ${json(o.deliverables.map((item) => ({ item, verified: true })))}, ${lit(o.location?.value ?? null)}, ${lit(o.format)},
         ${lit(o.eventStart?.at ?? null)}, ${lit(o.eventEnd ?? null)}, ${lit(o.replyBy?.at ?? null)}, ${lit(future[0] ?? null)}, ${lit(o.nextStep?.value ?? null)},
         ${json(o.missing)}, ${lit(priority.priority)}, ${priority.score}, ${json(priority.reasons)}, ${json(redFlags)}, ${o.confidence},
         ${lit(o.status)}, ${lit(o.isRead)}, ${lit(o.snoozedUntil ?? null)},
         ${lit(f?.at ?? null)}, ${f ? manager : "NULL"}, ${lit(f?.answer ?? null)}, ${lit(f?.answerNote ?? null)}, ${lit(f?.answeredAt ?? null)},
         ${lit(first.at)}, ${lit(lastAt)}, ${lit(first.at)}, false, ${textArray(unverified)}, ${lit(o.classification)})`,
    );
    o.emails.forEach((e, i) => {
      out.push(`INSERT INTO opportunity_emails (opportunity_id, email_id, role, linked_by, created_at) VALUES (${lit(id)}, ${lit(emailIds[i])}, ${lit(e.role)}, 'thread', ${lit(e.at)})`);
    });

    // Every fact with the words it came from.
    const fields: Array<{ name: string; text: string | null; json?: unknown; quote: string | null; email: number; verified: boolean; current?: boolean }> = [];
    const textField = (name: string, fld?: Field) => {
      if (fld) fields.push({ name, text: fld.value, quote: fld.quote, email: fld.email ?? 0, verified: verified(fld) && !unverified.includes(name) });
    };
    textField("organization", o.organization);
    textField("sender_role", o.senderRole);
    textField("contact_phone", o.phone);
    textField("location", o.location);
    textField("usage_rights", o.usage);
    textField("exclusivity", o.exclusivity);
    textField("expenses_covered", o.expenses);
    textField("requested_action", o.nextStep);
    if (o.oldPay) {
      fields.push({
        name: "compensation",
        text: null,
        json: { type: "paid", status: "confirmed", amountMin: o.oldPay.min, amountMax: o.oldPay.min, currency: "INR" },
        quote: o.oldPay.quote,
        email: 0,
        verified: verified({ quote: o.oldPay.quote }),
        current: false,
      });
    }
    if (o.pay?.quote) {
      fields.push({
        name: "compensation",
        text: o.pay.terms ?? null,
        json: { type: o.pay.type, status: o.pay.status, amountMin: o.pay.min ?? null, amountMax: o.pay.max ?? null, currency: "INR" },
        quote: o.pay.quote,
        email: o.pay.email ?? 0,
        verified: verified({ quote: o.pay.quote, email: o.pay.email }),
      });
    }
    if (o.deliverables.length) fields.push({ name: "deliverables", text: o.deliverables.join("; "), json: o.deliverables.map((item) => ({ item, verified: true })), quote: null, email: 0, verified: false });
    if (o.replyBy) fields.push({ name: "date:reply_by", text: null, json: { at: o.replyBy.at.toISOString() }, quote: o.replyBy.quote, email: o.replyBy.email ?? 0, verified: verified(o.replyBy) });
    if (o.eventStart) fields.push({ name: "date:event_start", text: null, json: { at: o.eventStart.at.toISOString() }, quote: o.eventStart.quote, email: o.eventStart.email ?? 0, verified: verified(o.eventStart) });
    for (const x of fields) {
      out.push(
        `INSERT INTO extracted_fields (opportunity_id, email_id, field_name, value_text, value_json, source_quote, is_verified, confidence, is_current, created_at)
         VALUES (${lit(id)}, ${lit(emailIds[x.email])}, ${lit(x.name)}, ${lit(x.text)}, ${x.json === undefined ? "NULL" : json(x.json)}, ${lit(x.quote)},
           ${lit(x.verified && x.quote !== null)}, ${o.confidence}, ${lit(x.current ?? true)}, ${lit(o.emails[x.email]!.at)})`,
      );
    }

    // History: found by the AI, then whatever happened since.
    const history: Event[] = [{ kind: "created", at: first.at, by: "ai", detail: { emailId: emailIds[0], classification: o.classification, reason: "Reads as a work offer." } }];
    if (f) {
      history.push({ kind: "flagged_for_her", at: f.at, by: "manager", detail: f.note ? { note: f.note } : {} });
      if (f.answer) history.push({ kind: "her_answer", at: f.answeredAt!, by: "talent", detail: { answer: f.answer, note: f.answerNote ?? null, via: "spotlight" } });
    }
    history.push(...o.events);
    history.sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const h of history) {
      out.push(
        `INSERT INTO activities (opportunity_id, actor_type, actor_user_id, kind, detail, created_at)
         VALUES (${lit(id)}, ${lit(actorType(h.by))}, ${actor(h.by)}, ${lit(h.kind)}, ${json(h.detail ?? {})}, ${lit(h.at)})`,
      );
    }

    if (o.draft) {
      const g = o.draft;
      const sources = o.emails.map((e) => e.body).join("\n\n");
      const warnings = checkDraft(g.body, sources);
      const sent = Boolean(g.sentAt);
      out.push(
        `INSERT INTO drafts (opportunity_id, reply_to_email, mode, tone, subject, body, status, created_by, to_email, thread_id, warnings,
           ai_notes, approved_by, approved_by_email, approved_at, sent_at, gmail_sent_message_id, created_at, updated_at)
         VALUES (${lit(id)}, ${lit(emailIds.at(-1))}, ${lit(g.mode)}, ${lit(g.tone)}, ${lit(g.subject)}, ${lit(g.body)},
           ${lit(sent ? "sent" : "ready")}, ${manager}, ${lit(first.fromEmail)}, ${lit(thread)}, ${json(warnings)},
           ${lit(sent ? null : "Fill in her available dates before sending.")},
           ${sent ? manager : "NULL"}, ${lit(sent ? DEMO_MANAGER_EMAIL : null)}, ${lit(g.sentAt ?? null)}, ${lit(g.sentAt ?? null)},
           ${lit(sent ? "demo-sent-1" : null)}, ${lit(g.createdAt)}, ${lit(g.sentAt ?? g.createdAt)})`,
      );
    }
  }

  for (const e of loose) {
    const state = e.classification === "unclear" ? "needs_review" : "processed";
    insertEmail(e, `demo-thread-loose-${msg + 1}`, `${lit(state)}, ${lit(e.at)}, ${lit(e.classification)}, ${e.classification === "unclear" ? 0.55 : 0.97}, ${lit(e.reason)}`);
  }

  // Alerts each of them would have had.
  const idOf = (key: string) => summary.find((s) => s.key === key)!.id;
  const alerts: Array<{ who: string; key: string; kind: string; title: string; body: string; at: Date; read: boolean }> = [
    { who: DEMO_MANAGER_EMAIL, key: "lumora", kind: "new_offer", title: "New offer: high priority", body: "Lumora Skin serum launch reel · Lumora Skin", at: ago(now, 3), read: false },
    { who: DEMO_MANAGER_EMAIL, key: "starpath", kind: "new_offer", title: "Check this one: possible scam signs", body: "Lead role in a feature film (StarPath Casting)", at: ago(now, 7), read: false },
    { who: DEMO_MANAGER_EMAIL, key: "brightline", kind: "terms_changed", title: "Terms changed", body: "Brightline Mobile TV commercial · Reelhouse Productions\nFee: ₹3,00,000 → ₹3,50,000", at: ago(now, 26), read: true },
    { who: DEMO_MANAGER_EMAIL, key: "harbour", kind: "cancelled", title: "They cancelled", body: "Harbour Lane Hotels launch appearance · Harbour Lane Hotels", at: ago(now, 44), read: true },
    { who: DEMO_MANAGER_EMAIL, key: "saffron", kind: "her_answer", title: "She said: Interested", body: "Saffron Thread festive campaign\n“Love their work! Can we ask if they'd do 12 months digital only?”", at: ago(now, 70), read: true },
    { who: DEMO_MANAGER_EMAIL, key: "indigo", kind: "nudge_follow_up", title: "No answer from them yet. Follow up?", body: "Indigo Loop music video · Indigo Loop Studios\nWaiting 4 days for their reply.", at: ago(now, 2), read: false },
    { who: DEMO_TALENT_EMAIL, key: "tideline", kind: "flag", title: "Your call: are you interested?", body: "The Tide Line: audition for Meera · Kettle Hill Pictures\n“Supporting role, but a good platform. Want to tape for it?”", at: ago(now, 20), read: false },
    { who: DEMO_TALENT_EMAIL, key: "lumora", kind: "new_offer", title: "New offer: high priority", body: "Lumora Skin serum launch reel · Lumora Skin", at: ago(now, 3), read: false },
  ];
  alerts.forEach((a, i) => {
    out.push(
      `INSERT INTO notifications (user_id, opportunity_id, event_key, channel, kind, title, body, url, status, sent_at, read_at, created_at, deliver_after)
       VALUES (${userRef(a.who)}, ${lit(idOf(a.key))}, ${lit(`demo:${i}`)}, 'in_app', ${lit(a.kind)}, ${lit(a.title)}, ${lit(a.body)},
         ${lit(`/opportunities/${idOf(a.key)}`)}, 'sent', ${lit(a.at)}, ${lit(a.read ? a.at : null)}, ${lit(a.at)}, ${lit(a.at)})`,
    );
  });

  out.push(
    `INSERT INTO reminders (opportunity_id, kind, due_at, status, dedupe_key, created_by, for_user, note)
     VALUES (${lit(idOf("brightline"))}, 'custom', ${lit(istAt(now, 2, 10))}, 'pending', 'demo:reminder:1', ${manager}, ${manager}, 'Confirm call time and wardrobe with Sameer')`,
  );

  return { sql: out.join(";\n") + ";\n", offers: summary };
}
