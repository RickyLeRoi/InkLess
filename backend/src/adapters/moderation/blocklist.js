// backend/src/adapters/moderation/blocklist.js

/**
 * 20260831 ++ RG #blocklist_layers
 * Three layers, each doing what the one below cannot:
 *
 *   1. WORDS      single tokens. Leetspeak, accents and repeated letters are folded
 *                 by the adapter before lookup, so "c4zz0", "càzzo" and "caaazzzo"
 *                 all reduce to the plain spelling. Do NOT add those variants here.
 *   2. PATTERNS   compositional forms a word list cannot express: two tokens in
 *                 either order, with any separator between them.
 *   3. adapter    separator tolerance ("c.a.z.z.o") and run squeezing, applied to
 *                 whatever appears below.
 *
 * Keep entries as the plain dictionary spelling. Every obfuscation you can think of
 * is somebody else's job in this pipeline.
 */

/** Straight profanity. Rejected outright, per the spec's "block immediately". */
export const PROFANITY = Object.freeze([
  'troia',
  'troie',
  'puttana',
  'puttane',
  'zoccola',
  'mignotta',
  'coglione',
  'coglioni',
  'bastardo',
  'bastarda',
  'pompino',
  'sborra',
  'bitch',
  'cunt',
  'asshole',
  'motherfucker'
]);

/**
 * 20260831 ++ RG #ambiguous_tier
 * Words that are vulgar in one sentence and affectionate in the next: "che figa" is
 * a compliment, "sti cazzi" is half of Italian conversation. Auto-rejecting these
 * throws away honest messages, so they go to the admin instead of the bin.
*/
export const SUSPICIOUS = Object.freeze([
  'cazzo',
  'cazzi',
  'cazzata',
  'cazzate',
  'stronzo',
  'stronza',
  'stronzi',
  'stronzate',
  'merda',
  'merdoso',
  'vaffanculo',
  'vaffangulo',
  'vafanculo',
  'fanculo',
  'affanculo',
  'inculare',
  'puttanata',
  'coglionata',
  'minchia',
  'minchione',
  'rincoglionito',
  'fuck',
  'fucking',
  'shit',
  'figa',
  'fica',
  'culo',
  'cesso',
  'schifoso',
  'sticazzi',
  'scopare',
  'incazzato',
  'finocchio',
  'checca',
  'ritardato',
  'handicappato',
  'giudeo',
  // 20260903 ++ RG #violence_words
  // Not insults, but the vocabulary of a threat or an accusation. Review, never
  // rejection: "ammazzo" is a word a cook uses too, and "ladro" is half of Italian
  // football commentary. "ammazza" stays out on purpose — in Roman it means "wow".
  'ammazzo',
  'ladro',
  'ladri',
  // The infinitive alone let every conjugation walk past. Only the unambiguous forms:
  // "scopo" is a noun before it is a verb, and it is handled as an ordered pair below.
  'scopata',
  'scopate',
  'scoparti',
  'scoparmi'
]);

/**
 * 20260903 ++ RG #ordered_pairs
 * Expressions that are only offensive as a sequence, and only in this order. The
 * blasphemy matcher cannot express them twice over: it accepts the two halves in
 * either order, and it allows no word between them, while "spacco la faccia" has one.
 * Reversing them is what makes the difference between a threat and "lo scopo ti sarà
 * chiaro", so these are matched left to right only.
 */
export const SUSPICIOUS_PAIRS = Object.freeze([
  Object.freeze(['spacco', 'faccia']),
  Object.freeze(['spacca', 'faccia']),
  Object.freeze(['ti', 'scopo'])
]);

/**
 * Slurs and hate markers. Never merely flagged: these are rejected without appeal,
 * because there is no context in a 200-character message that redeems them.
 */
// 20260903 -- RG
// "terrone" and "terroni" left the list, and "crucco" left SUSPICIOUS: regional
// epithets have worn down to the level of "polentone" in the register this board
// speaks, and rejecting them without appeal was the harshest verdict in the pipeline
// spent on football banter.
export const HARD_REJECT = Object.freeze([
  'negro',
  'negri',
  'negretto',
  'frocio',
  'froci',
  'ricchione',
  'zingaro',
  'zingari',
  'mongoloide',
  'nigger',
  'faggot',
  'retard',
  'tranny'
]);

/**
 * Compositional blasphemy. A word list cannot hold these: the two halves are
 * innocent on their own ("dio" is a noun, "porco" is a farm animal) and only the
 * pairing offends, in either order and with any junk in between.
 *
 * Each entry is a [left, right] pair; the adapter matches it in both directions.
 */
const DEITIES = ['dio', 'iddio', 'madonna', 'madonne', 'gesu', 'cristo', 'signore'];

/**
 * 20260902 ** RG #epithet_inflection
 * Whole words lost this race: "porcaccio dio" walked past a list holding "porco",
 * and no amount of run squeezing brings the two together. Italian glues its insults
 * onto a stem — porco, porcaccio, porcone, porcaccia — so the epithet side is a stem
 * plus an ending, and the list stops chasing forms.
 */
const EPITHET_STEMS = [
  'porc',
  'can',
  'boi',
  'maial',
  'ladr',
  'besti',
  'merd',
  'schifos',
  'bastard',
  'stronz',
  'puttan',
  'troi',
  'infam',
  'serpent'
];

// 20260902 -- RG
// "caro" left with the inflection: as a whole word it only paired into "dio caro",
// which is dismay rather than blasphemy, and as a stem it started binning "la cara
// madonna di mia nonna". The mildest entry on the list was not worth that.


/**
 * Endings the stems accept: the plain gender/number vowel plus the pejoratives and
 * augmentatives that carry the insult ("-accio", "-azzo", "-one", "-otto").
 */
const EPITHET_ENDING = '(?:[aeio]|acci[aeio]|azz[aeio]|on[aei]|ott[aeio]|astr[aeio]|issim[aeio])';

/**
 * 20260902 ++ RG #deities_stay_exact
 * The same trick is deliberately NOT applied to the deities. Stemming "dio" to "di"
 * would also match "dia" and "die", and "che il cane dia la zampa" would become a
 * blasphemy. Widening the epithet side is free by comparison: a match still needs a
 * deity spelled out next to it.
 */
export const BLASPHEMY = Object.freeze({
  deities: Object.freeze(DEITIES),
  epithetStems: Object.freeze(EPITHET_STEMS),
  epithetEnding: EPITHET_ENDING
});
