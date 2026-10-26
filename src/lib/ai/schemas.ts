// The two answers Spotlight asks Claude for, as JSON schemas (Claude API structured outputs)
// plus a small validator that re-checks every answer before anything is stored.
// Schemas avoid unions: "not stated" is an empty string, so nothing has to be nullable.

export const CLASSIFICATIONS = [
  "new_opportunity",
  "opportunity_update",
  "negotiation_or_contract",
  "availability_request",
  "unrelated",
  "newsletter_or_spam",
  "suspicious",
  "unclear",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** Classes that describe real work, so they get the detailed extraction pass. */
export const OPPORTUNITY_CLASSES: ReadonlySet<Classification> = new Set([
  "new_opportunity",
  "opportunity_update",
  "negotiation_or_contract",
  "availability_request",
  "suspicious",
]);

export const COMPENSATION_TYPES = ["paid", "unpaid", "barter", "commission", "affiliate", "unspecified"] as const;
export const COMPENSATION_STATUSES = ["confirmed", "range", "requested_rate", "not_disclosed"] as const;
export const FORMATS = ["in_person", "remote", "hybrid", "unknown"] as const;
export const DATE_KINDS = ["reply_by", "deadline", "audition", "shoot", "event_start", "event_end", "other"] as const;
export type DateKind = (typeof DATE_KINDS)[number];

export type JsonSchema = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  enum?: readonly (string | number | boolean)[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchema;
};

const str = (description?: string): JsonSchema => ({ type: "string", ...(description ? { description } : {}) });
const obj = (properties: Record<string, JsonSchema>, description?: string): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
  ...(description ? { description } : {}),
});
const quoted = (description: string) =>
  obj({ value: str("Empty string if the email does not state it."), quote: str("Exact words copied from the email, or empty.") }, description);

// --- Triage -----------------------------------------------------------------------------

export type TriageAnswer = {
  classification: Classification;
  confidence: number;
  category: string;
  reason: string;
};

export function triageSchema(categorySlugs: string[]): JsonSchema {
  return obj({
    classification: { type: "string", enum: CLASSIFICATIONS },
    confidence: { type: "number", description: "How sure you are, from 0 to 1." },
    category: { type: "string", enum: [...categorySlugs, "none"], description: "Best category, or none for non-opportunities." },
    reason: str("One short sentence explaining the classification, in plain English."),
  });
}

// --- Extraction -----------------------------------------------------------------------------

export type QuotedValue = { value: string; quote: string };
export type ExtractionAnswer = {
  title: string;
  summary: string;
  category: string;
  organization: QuotedValue;
  sender_role: QuotedValue;
  contact_phone: QuotedValue;
  offer: QuotedValue;
  deliverables: Array<{ item: string; quote: string }>;
  compensation: {
    type: (typeof COMPENSATION_TYPES)[number];
    status: (typeof COMPENSATION_STATUSES)[number];
    amount_min: number;
    amount_max: number;
    currency: string;
    text: string;
    quote: string;
  };
  usage_rights: QuotedValue;
  exclusivity: QuotedValue;
  expenses_covered: QuotedValue;
  location: QuotedValue;
  format: (typeof FORMATS)[number];
  dates: Array<{ kind: DateKind; date: string; time: string; text: string; quote: string }>;
  requested_action: QuotedValue;
  is_negotiable: "yes" | "no" | "unknown";
  missing_information: string[];
  red_flags: Array<{ flag: string; quote: string }>;
  cancellation: boolean;
};

export function extractionSchema(categorySlugs: string[]): JsonSchema {
  return obj({
    title: str("Short card title, e.g. 'Glow Labs paid reel collaboration'. Under 70 characters."),
    summary: str("Two plain sentences on what is offered and what they want."),
    category: { type: "string", enum: categorySlugs },
    organization: quoted("Brand, agency, studio or production house making the offer."),
    sender_role: quoted("The sender's role, e.g. casting director, brand manager."),
    contact_phone: quoted("Phone or WhatsApp number given for contact."),
    offer: quoted("What the opportunity is, in one sentence of your own words; quote the key line."),
    deliverables: {
      type: "array",
      description: "Each thing she must do or produce, e.g. '1 Instagram reel'.",
      items: obj({ item: str(), quote: str("Exact words from the email.") }),
    },
    compensation: obj(
      {
        type: { type: "string", enum: COMPENSATION_TYPES },
        status: { type: "string", enum: COMPENSATION_STATUSES },
        amount_min: { type: "number", description: "Lowest amount as a plain number (75k = 75000, 1.5 lakh = 150000). 0 if not stated." },
        amount_max: { type: "number", description: "Highest amount; same as amount_min for a single figure. 0 if not stated." },
        currency: str("ISO code such as INR or USD. ₹, Rs and rupees mean INR. Empty if no amount."),
        text: str("The pay terms in a few words, e.g. '₹75,000 + travel'. Empty if not stated."),
        quote: str("Exact words from the email stating the pay, or empty."),
      },
      "Payment offered. status=requested_rate when they ask for her rate; not_disclosed when nothing is said.",
    ),
    usage_rights: quoted("How long and where the content may be used."),
    exclusivity: quoted("Any exclusivity or non-compete condition."),
    expenses_covered: quoted("Travel, stay or other costs they cover."),
    location: quoted("City or venue."),
    format: { type: "string", enum: FORMATS },
    dates: {
      type: "array",
      description: "Every date mentioned that matters: reply deadlines, auditions, shoots, events.",
      items: obj({
        kind: { type: "string", enum: DATE_KINDS },
        date: str("YYYY-MM-DD, resolved using the received date for words like 'next Friday'. Empty if no specific day."),
        time: str("HH:MM in 24-hour India time, or empty."),
        text: str("The date as written in the email."),
        quote: str("Exact words from the email."),
      }),
    },
    requested_action: quoted("What they ask her to do next, e.g. 'share rate card', 'confirm availability'."),
    is_negotiable: { type: "string", enum: ["yes", "no", "unknown"] },
    missing_information: { type: "array", items: str(), description: "Important details the email leaves out, e.g. 'fee', 'usage period'." },
    red_flags: {
      type: "array",
      description: "Warning signs such as upfront fees, requests for ID or bank details, pressure tactics. Empty if none.",
      items: obj({ flag: str(), quote: str("Exact words from the email.") }),
    },
    cancellation: { type: "boolean", description: "True only if this email cancels or withdraws the opportunity." },
  });
}

// --- Validation -----------------------------------------------------------------------------

/** Checks a value against the subset of JSON Schema used above. Returns problems; empty means valid. */
export function validateAgainst(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  const typeOk = (() => {
    switch (schema.type) {
      case "object":
        return typeof value === "object" && value !== null && !Array.isArray(value);
      case "array":
        return Array.isArray(value);
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
    }
  })();
  if (!typeOk) return [`${path}: expected ${schema.type}`];
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    return [`${path}: not one of the allowed values`];
  }
  if (schema.type === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${path}.${key}: missing`);
    }
    for (const [key, child] of Object.entries(record)) {
      const childSchema = schema.properties?.[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: unexpected`);
        continue;
      }
      errors.push(...validateAgainst(child, childSchema, `${path}.${key}`));
    }
  }
  if (schema.type === "array" && schema.items) {
    (value as unknown[]).forEach((item, i) => errors.push(...validateAgainst(item, schema.items!, `${path}[${i}]`)));
  }
  return errors;
}

export function validateTriage(value: unknown, categorySlugs: string[]): TriageAnswer {
  const errors = validateAgainst(value, triageSchema(categorySlugs));
  if (errors.length > 0) throw new InvalidAnswerError(errors);
  const answer = value as TriageAnswer;
  return { ...answer, confidence: Math.min(1, Math.max(0, answer.confidence)) };
}

export function validateExtraction(value: unknown, categorySlugs: string[]): ExtractionAnswer {
  const errors = validateAgainst(value, extractionSchema(categorySlugs));
  if (errors.length > 0) throw new InvalidAnswerError(errors);
  return value as ExtractionAnswer;
}

export class InvalidAnswerError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`The AI answer didn't match the expected format (${problems.slice(0, 3).join("; ")})`);
    this.problems = problems;
  }
}
