// Shared by the browser (game) and Node (server prompts, tests). Keep it free of Node/DOM APIs.

const COUNTRY = 'Novaria';

/**
 * The rulebook. Every rule is one atomic, literal statement that is TRUE when the rule is violated.
 * - LLM desks receive all rules in one prompt and answer APPROVE / REJECT.
 * - JEV receives one Noul question per rule (asked in parallel in a single request) and the
 *   decision is composed in code: reject when any rule is violated.
 */
export const RULES = Object.freeze([
  { id: 'forged', title: 'Forged documents', text: 'The passport or entry permit shows signs of forgery, alteration, or tampering.' },
  { id: 'expired', title: 'Expired documents', text: 'The passport or entry permit is expired.' },
  { id: 'contraband', title: 'Prohibited goods', text: 'The applicant declares weapons, explosives, narcotics, or other prohibited goods.' },
  { id: 'watchlist', title: 'Watchlist match', text: 'The security check reports a match with the watchlist.' },
  { id: 'unsponsored', title: 'No sponsor for work', text: `The applicant intends to work in ${COUNTRY} and has no sponsor letter.` },
  { id: 'contradiction', title: 'Contradictory story', text: 'The applicant statement contradicts the stated purpose of visit.' },
]);

export const RULE_IDS = RULES.map((r) => r.id);

/** Dossier fields in display order: [key, label]. */
export const FIELDS = Object.freeze([
  ['name', 'Applicant'],
  ['origin', 'Coming from'],
  ['purpose', 'Purpose of visit'],
  ['sponsor_letter', 'Sponsor letter'],
  ['passport', 'Passport'],
  ['entry_permit', 'Entry permit'],
  ['declared_goods', 'Declared goods'],
  ['security_check', 'Security check'],
  ['statement', 'Applicant statement'],
]);

const MAX_FIELD_LENGTH = 300;

export function dossierToText(dossier) {
  return FIELDS.map(([key, label]) => `${label}: ${dossier[key]}`).join('\n');
}

/** Returns an error string, or null when the value is a well-formed dossier. */
export function validateDossier(dossier) {
  if (!dossier || typeof dossier !== 'object' || Array.isArray(dossier)) return 'dossier must be an object';
  for (const [key] of FIELDS) {
    if (typeof dossier[key] !== 'string' || dossier[key].length === 0) return `dossier.${key} must be a non-empty string`;
    if (dossier[key].length > MAX_FIELD_LENGTH) return `dossier.${key} is too long`;
  }
  return null;
}

export function buildLlmMessages(dossier) {
  const rules = RULES.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
  return [
    {
      role: 'system',
      content:
        `You are an entry-permit approver at the ${COUNTRY} border checkpoint.\n` +
        'Reject the application if ANY of the following is true. If none is true, approve it.\n\n' +
        `${rules}\n\nReply with exactly one word: APPROVE or REJECT.`,
    },
    { role: 'user', content: dossierToText(dossier) },
  ];
}

export function buildSystemOneQuestions() {
  return Object.fromEntries(RULES.map((r) => [r.id, { type: 'noul', instructions: r.text }]));
}

// ---------------------------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------------------------

export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

function shuffle(rng, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Content pools. Violation pools and "ok"/decoy pools never share a value (see tests), so the
// ground truth is unambiguous. Decoys are hard negatives: they look suspicious but are fine.
// Everything is semantic on purpose: no date arithmetic or counting, which are weak spots for
// small decision models and would make the comparison about the wrong thing.
// ---------------------------------------------------------------------------------------------

export const POOLS = Object.freeze({
  firstNames: ['Mara', 'Tomas', 'Ilse', 'Jonas', 'Petra', 'Anton', 'Lena', 'Viktor', 'Greta', 'Emil', 'Sasha', 'Nora', 'Felix', 'Dara', 'Oskar', 'Wren', 'Mila', 'Hugo', 'Yara', 'Leif', 'Ines', 'Rurik', 'Tessa', 'Casimir'],
  lastNames: ['Voss', 'Halden', 'Kessler', 'Brandt', 'Orlov', 'Lindqvist', 'Marek', 'Falk', 'Novak', 'Ruiz', 'Stroud', 'Tamm', 'Vance', 'Weiss', 'Zeller', 'Aldous', 'Bexley', 'Crane', 'Dorn', 'Ember'],
  origins: ['Altmark', 'Brevia', 'Corvane', 'Dunmere', 'Estoria', 'Falkrin', 'Gravenholt', 'Hollowmere'],
  employers: ['Hartmann Logistics', 'Brightwell Bakery', 'Kessler Shipyards', 'Northgate Textiles', 'Larkspur Hotel', 'Ironbridge Foundry'],
  schools: ['Aldous Institute', 'Marlowe University', 'the Royal Conservatory', 'Tallis Technical College'],
  hospitals: ['St. Brevik Hospital', 'the Eastside Clinic', 'Novaria General'],
  destinations: ['Estoria', 'Falkrin', 'Gravenholt', 'the northern coast'],

  passportOk: ['Valid', 'Valid, no issues', 'Valid, renewed this year', 'Valid, several earlier visas stamped'],
  passportDecoy: ['Valid, coffee stain on the cover but otherwise intact', 'Valid, corner creased from travel', 'Valid, slightly faded ink but seals intact'],
  passportExpired: ['Expired', 'Expired last spring', 'Expired, renewal never filed', 'Expired for over a year'],
  passportForged: [
    'Photo appears replaced; laminate peeling at the corners',
    'Page numbers out of sequence; pages look re-glued',
    'Official seal is a crude copy',
    'Birth date has been written over in different ink',
  ],

  permitOk: ['Valid, seals intact', 'Valid, clean and intact', 'Valid; stamps and signatures in order', 'Valid, issued at the border post'],
  permitDecoy: ['Valid, folded in half but all seals readable', 'Valid, a smudge on the margin only', 'Valid, reissued after the first copy was lost'],
  permitExpired: ['Expired', 'Expired last month', 'Expired before the applicant arrived', 'Expired, validity has run out'],
  permitForged: [
    'Seal looks re-stamped; ink differs from the rest of the page',
    'Signature looks traced over',
    'Issuing stamp is a crude copy',
    'Serial number has been scratched out and rewritten',
  ],

  goodsOk: [
    'Two suitcases of clothes',
    'A laptop and a camera',
    'Gifts for relatives: chocolates and a scarf',
    'Work tools in a canvas bag',
    'Hiking gear and a tent',
    'Nothing to declare',
    'A violin in a case',
    'Books and school supplies',
    'One bottle of duty-free whiskey',
  ],
  goodsDecoy: [
    "Prescription insulin pens with a doctor's letter",
    'One small box of over-the-counter painkillers',
    'A fireworks-themed picture book for a child',
  ],
  goodsContraband: [
    'A crate of rifles with no export papers',
    'Sealed bags of unlabelled white powder',
    'Blasting caps and two detonators',
    'Several boxes of narcotic pills with no prescription',
    'A concealed pistol hidden in a shoe',
    'Cartons of illegal weapon parts',
  ],

  securityOk: ['No watchlist match', 'Clear, no flags', 'No match found', 'Cleared at the gate'],
  securityDecoy: [
    'Name is similar to a watchlist entry; the officer confirmed a different person, cleared',
    'Selected for a routine bag check only; no watchlist match',
  ],
  securityHit: ['Name matches a watchlist entry', 'Confirmed watchlist match', 'Match found on the watchlist', 'Flagged: appears on the watchlist'],

  sponsorMissing: ['None provided', 'Missing', 'Not provided; the applicant has no letter'],

  skins: ['#f1c9a5', '#e0a97c', '#c68642', '#8d5524', '#6b4226'],
  hairs: ['#2b1d0e', '#4a3320', '#7a5230', '#b5651d', '#d6c08a', '#8a8a8a', '#1b1b1b'],
  coats: ['#8a6d3b', '#5b7c99', '#7d5a7a', '#6b8e5a', '#a65e4d', '#4d6b6e', '#9a8f5b', '#6d6d8f'],
});

const PURPOSES = Object.freeze({
  tourism: { label: 'Tourism' },
  family: { label: 'Family visit' },
  employment: { label: 'Employment' },
  study: { label: 'Study' },
  business: { label: 'Business meeting' },
  medical: { label: 'Medical treatment' },
  transit: { label: 'Transit' },
});
const PURPOSE_KEYS = Object.keys(PURPOSES);

/** A statement is consistent with a purpose when its kind equals the purpose key. */
const STATEMENTS = [
  { kind: 'tourism', text: () => 'I came to see the old town and the coast for a week.' },
  { kind: 'tourism', text: () => 'Just a holiday: museums, the harbour and some hiking.' },
  { kind: 'tourism', text: () => 'I am here for a short holiday with my partner.' },
  { kind: 'family', text: () => 'I am visiting my brother and his children.' },
  { kind: 'family', text: () => 'My grandmother lives here and I am spending the holidays with her.' },
  { kind: 'family', text: () => "I am attending my cousin's wedding this weekend." },
  { kind: 'employment', text: (c) => `I start my new job at ${c.employer} next Monday.` },
  { kind: 'employment', text: (c) => `${c.employer} hired me as a technician and I report to them on arrival.` },
  { kind: 'employment', text: (c) => `I am here to take up my post at ${c.employer}.` },
  { kind: 'study', text: (c) => `I am enrolled for the autumn term at ${c.school}.` },
  { kind: 'study', text: (c) => `I am here to attend a semester at ${c.school}.` },
  { kind: 'business', text: () => 'I am meeting two suppliers, then flying home on Friday.' },
  { kind: 'business', text: () => 'A short trip to sign a contract with a local distributor.' },
  { kind: 'medical', text: (c) => `I have a treatment appointment at ${c.hospital}.` },
  { kind: 'medical', text: (c) => `My doctor referred me to ${c.hospital} for surgery.` },
  { kind: 'transit', text: (c) => `I am only passing through on my way to ${c.destination}.` },
  { kind: 'transit', text: (c) => `Connecting to ${c.destination}; I leave tomorrow morning.` },
  { kind: 'settling', text: () => 'I am moving here for good; my furniture arrives next week.' },
  { kind: 'settling', text: () => 'I do not plan to leave. I will stay and apply for residency.' },
];

/** Statement kinds that are unambiguously incompatible with a purpose. */
const CONFLICT_KINDS = {
  employment: ['tourism', 'transit'],
  default: ['employment', 'settling'],
};

const statementsOfKind = (kinds) => STATEMENTS.filter((s) => kinds.includes(s.kind));

// ---------------------------------------------------------------------------------------------
// Paper generation
// ---------------------------------------------------------------------------------------------

const REJECT_SHARE = 0.45;
const SECOND_VIOLATION_CHANCE = 0.15;
const DECOY_CHANCE = 0.4;

function makeContext(rng) {
  return {
    employer: pick(rng, POOLS.employers),
    school: pick(rng, POOLS.schools),
    hospital: pick(rng, POOLS.hospitals),
    destination: pick(rng, POOLS.destinations),
  };
}

function buildCleanPaper(rng, index) {
  const ctx = makeContext(rng);
  const purposeKey = pick(rng, PURPOSE_KEYS);
  const statement = pick(rng, statementsOfKind([purposeKey]));
  const name = `${pick(rng, POOLS.firstNames)} ${pick(rng, POOLS.lastNames)}`;
  const dossier = {
    name,
    origin: pick(rng, POOLS.origins),
    purpose: PURPOSES[purposeKey].label,
    sponsor_letter: purposeKey === 'employment' ? `Provided, signed by ${ctx.employer}` : 'Not required',
    passport: pick(rng, POOLS.passportOk),
    entry_permit: pick(rng, POOLS.permitOk),
    declared_goods: pick(rng, POOLS.goodsOk),
    security_check: pick(rng, POOLS.securityOk),
    statement: statement.text(ctx),
  };
  return {
    id: index + 1,
    dossier,
    truth: 'approve',
    violations: [],
    decoys: [],
    meta: { purposeKey, statementKind: statement.kind },
    appearance: {
      skin: pick(rng, POOLS.skins),
      hair: pick(rng, POOLS.hairs),
      coat: pick(rng, POOLS.coats),
      hat: rng() < 0.25,
    },
    _ctx: ctx,
  };
}

/** Applies a violation to a clean paper. `docs` hands out passport/permit without reusing one. */
function applyViolation(rule, paper, rng, docs) {
  const { dossier, _ctx: ctx } = paper;
  switch (rule) {
    case 'forged': {
      const doc = docs.shift();
      dossier[doc] = pick(rng, doc === 'passport' ? POOLS.passportForged : POOLS.permitForged);
      break;
    }
    case 'expired': {
      const doc = docs.shift();
      dossier[doc] = pick(rng, doc === 'passport' ? POOLS.passportExpired : POOLS.permitExpired);
      break;
    }
    case 'contraband':
      dossier.declared_goods = pick(rng, POOLS.goodsContraband);
      break;
    case 'watchlist':
      dossier.security_check = pick(rng, POOLS.securityHit);
      break;
    case 'unsponsored': {
      paper.meta.purposeKey = 'employment';
      dossier.purpose = PURPOSES.employment.label;
      dossier.sponsor_letter = pick(rng, POOLS.sponsorMissing);
      const statement = pick(rng, statementsOfKind(['employment']));
      paper.meta.statementKind = statement.kind;
      dossier.statement = statement.text(ctx);
      break;
    }
    case 'contradiction': {
      const kinds = CONFLICT_KINDS[paper.meta.purposeKey] ?? CONFLICT_KINDS.default;
      const statement = pick(rng, statementsOfKind(kinds));
      paper.meta.statementKind = statement.kind;
      dossier.statement = statement.text(ctx);
      break;
    }
    default:
      throw new Error(`Unknown rule: ${rule}`);
  }
}

/** Swaps in a harmless-but-suspicious-looking value on a field that was not otherwise touched. */
function applyDecoy(paper, rng, touched) {
  const options = [
    ['passport', POOLS.passportDecoy],
    ['entry_permit', POOLS.permitDecoy],
    ['declared_goods', POOLS.goodsDecoy],
    ['security_check', POOLS.securityDecoy],
  ].filter(([field]) => !touched.has(field));
  if (options.length === 0) return;
  const [field, pool] = pick(rng, options);
  paper.dossier[field] = pick(rng, pool);
  paper.decoys.push(field);
}

const FIELD_FOR_RULE = {
  forged: ['passport', 'entry_permit'],
  expired: ['passport', 'entry_permit'],
  contraband: ['declared_goods'],
  watchlist: ['security_check'],
  unsponsored: ['purpose', 'sponsor_letter', 'statement'],
  contradiction: ['statement'],
};

/**
 * Builds a reproducible queue. Exactly round(count * 45%) papers are rejections, spread across all
 * rules; the rest are approvals. About 40% of papers also carry a decoy so models cannot lean on
 * keyword spotting alone.
 */
export function generatePapers(seed, count) {
  const rng = makeRng(seed);
  const rejectCount = Math.round(count * REJECT_SHARE);
  const kinds = shuffle(rng, [...Array(rejectCount).fill('reject'), ...Array(count - rejectCount).fill('approve')]);

  let ruleBag = [];
  const nextRule = () => {
    if (ruleBag.length === 0) ruleBag = shuffle(rng, RULE_IDS);
    return ruleBag.shift();
  };

  return kinds.map((kind, index) => {
    const paper = buildCleanPaper(rng, index);
    const touched = new Set();
    if (kind === 'reject') {
      const rules = [nextRule()];
      if (rng() < SECOND_VIOLATION_CHANCE) {
        const second = nextRule();
        if (second !== rules[0]) rules.push(second);
      }
      // `unsponsored` must come first: it rewrites purpose and statement, which `contradiction` builds on.
      rules.sort((a, b) => (a === 'unsponsored' ? -1 : b === 'unsponsored' ? 1 : 0));
      const docs = shuffle(rng, ['passport', 'entry_permit']);
      for (const rule of rules) {
        applyViolation(rule, paper, rng, docs);
        FIELD_FOR_RULE[rule].forEach((field) => touched.add(field));
        paper.violations.push(rule);
      }
      paper.truth = 'reject';
    }
    if (rng() < DECOY_CHANCE) applyDecoy(paper, rng, touched);
    delete paper._ctx;
    return paper;
  });
}

/** Two fixed papers for connectivity checks: one clean, one with a single obvious violation. */
export const SAMPLE_PAPERS = Object.freeze({
  approve: Object.freeze({
    name: 'Mara Voss',
    origin: 'Brevia',
    purpose: 'Tourism',
    sponsor_letter: 'Not required',
    passport: 'Valid',
    entry_permit: 'Valid, seals intact',
    declared_goods: 'Two suitcases of clothes',
    security_check: 'No watchlist match',
    statement: 'I came to see the old town and the coast for a week.',
  }),
  reject: Object.freeze({
    name: 'Viktor Orlov',
    origin: 'Corvane',
    purpose: 'Tourism',
    sponsor_letter: 'Not required',
    passport: 'Valid',
    entry_permit: 'Valid, seals intact',
    declared_goods: 'A crate of rifles with no export papers',
    security_check: 'No watchlist match',
    statement: 'I came to see the old town and the coast for a week.',
  }),
});
