// backend/eval/run.js

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/env.js';
import { createLlmAdapter } from '../src/composition.js';
import { RegexModerationAdapter } from '../src/adapters/moderation/RegexModerationAdapter.js';
import { ModerationVerdict } from '../src/ports/ModerationPort.js';

/**
 * Runs the golden set through both moderation stages and reports what each got wrong.
 *
 * The two stages are scored apart on purpose: stage 1 is deterministic and needs no
 * model, so it runs anywhere, while stage 2 depends on whatever the endpoint happens
 * to be serving today. Only MODERATION_LLM_PROVIDER decides whether the model is asked
 * at all.
 *
 *   node eval/run.js                       # stage 1 only unless a provider is configured
 *   MODERATION_LLM_PROVIDER=ollama node eval/run.js
 *   node eval/run.js --repeat 3            # same case several times: small models wobble
 *   node eval/run.js --only-queued         # skip the messages the model never sees today
 */

const CASES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'cases.json');

/** The golden set speaks the reviewer's vocabulary; the port speaks its own. */
const EXPECTED_LLM = Object.freeze({
  safe: ModerationVerdict.AUTO_APPROVE,
  unsure: ModerationVerdict.NEEDS_REVIEW,
  unsafe: ModerationVerdict.REJECT
});

const SHORT = Object.freeze({
  auto_approve: 'safe',
  needs_review: 'unsure',
  reject: 'unsafe'
});

/**
 * @typedef {object} GoldenCase
 * @property {number} id
 * @property {string} family
 * @property {string} text
 * @property {'auto_approve' | 'needs_review' | 'reject'} regex
 * @property {string[]} reasons
 * @property {'safe' | 'unsure' | 'unsafe'} llm
 * @property {string} [todo]
 * @property {string} [note]
 */

/**
 * @param {string[]} argv
 * @returns {{ repeat: number, onlyQueued: boolean }}
 */
function parseArgs(argv) {
  const repeatFlag = argv.indexOf('--repeat');
  const repeat = repeatFlag >= 0 ? Number(argv[repeatFlag + 1]) : 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat wants a positive integer');
  return { repeat, onlyQueued: argv.includes('--only-queued') };
}

/** @param {string} title */
function heading(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

/**
 * @param {GoldenCase[]} cases
 * @returns {Promise<{ regressions: number, contexts: Map<number, { reasons: string[], matches: string[] }> }>}
 */
async function scoreRegexStage(cases) {
  const regex = new RegexModerationAdapter();

  /** @type {Array<{ item: GoldenCase, got: string, reasons: string[] }>} */
  const regressions = [];
  /** @type {Array<{ item: GoldenCase, got: string }>} */
  const known = [];
  /** @type {Map<number, { reasons: string[], matches: string[] }>} */
  const contexts = new Map();

  for (const item of cases) {
    const result = await regex.evaluate(item.text);
    contexts.set(item.id, { reasons: result.reasons, matches: result.matches ?? [] });
    const reasonsMatch =
      item.reasons.length === 0 || item.reasons.every((reason) => result.reasons.includes(reason));

    if (result.verdict === item.regex && reasonsMatch) continue;
    if (item.todo) known.push({ item, got: result.verdict });
    else regressions.push({ item, got: result.verdict, reasons: result.reasons });
  }

  heading(`Stadio 1 — regex (${cases.length} casi)`);
  console.log(`in linea con l'atteso: ${cases.length - regressions.length - known.length}`);

  if (known.length > 0) {
    console.log(`\ngià in piano (${known.length}):`);
    for (const { item, got } of known) {
      console.log(`  #${item.id} "${item.text}" — atteso ${item.regex}, ottenuto ${got} [${item.todo}]`);
    }
  }

  if (regressions.length > 0) {
    console.log(`\nDA GUARDARE (${regressions.length}):`);
    for (const { item, got, reasons } of regressions) {
      console.log(
        `  #${item.id} "${item.text}"\n     atteso ${item.regex} ${JSON.stringify(item.reasons)}` +
          `, ottenuto ${got} ${JSON.stringify(reasons)}`
      );
    }
  }

  return { regressions: regressions.length, contexts };
}

/**
 * @param {GoldenCase[]} cases
 * @param {import('../src/ports/ModerationPort.js').LlmModerationPort} llm
 * @param {number} repeat
 * @param {Map<number, { reasons: string[], matches: string[] }>} contexts what stage 1
 *   found, handed over exactly as the escalation use case hands it over in production
 */
async function scoreLlmStage(cases, llm, repeat, contexts) {
  /** @type {Record<string, Record<string, number>>} */
  const matrix = { safe: {}, unsure: {}, unsafe: {} };
  /** @type {Array<{ item: GoldenCase, got: string[], kind: string }>} */
  const wrong = [];
  let failures = 0;
  let total = 0;

  for (const item of cases) {
    /** @type {string[]} */
    const verdicts = [];

    for (let run = 0; run < repeat; run += 1) {
      const result = await llm.evaluate(item.text, contexts.get(item.id));
      const failed = result.reasons.some((reason) => reason.startsWith('llm_failed:'));
      if (failed) {
        failures += 1;
        verdicts.push(result.reasons[0]);
        continue;
      }
      const got = SHORT[result.verdict];
      verdicts.push(`${got} (${result.reasons[0] ?? ''})`);
      matrix[item.llm][got] = (matrix[item.llm][got] ?? 0) + 1;
      total += 1;
    }

    const judged = verdicts.filter((verdict) => !verdict.startsWith('llm_failed:'));
    const agreed = judged.every((verdict) => verdict.startsWith(item.llm));
    if (judged.length > 0 && !agreed) {
      wrong.push({ item, got: verdicts, kind: classify(item.llm, judged) });
    }
  }

  heading(`Stadio 2 — modello (${cases.length} casi × ${repeat})`);

  console.log('atteso \\ ottenuto      safe   unsure   unsafe');
  for (const expected of ['safe', 'unsure', 'unsafe']) {
    const row = matrix[expected];
    console.log(
      `  ${expected.padEnd(18)} ${String(row.safe ?? 0).padStart(4)} ${String(row.unsure ?? 0).padStart(8)} ${String(row.unsafe ?? 0).padStart(8)}`
    );
  }

  // The two errors that cost something, plus how much work the model is pushing back
  // onto the admin. A model that answers "unsure" to everything scores no errors and
  // is still useless.
  const falseRejects = (matrix.safe.unsafe ?? 0) + (matrix.unsure.unsafe ?? 0);
  const falseApprovals = matrix.unsafe.safe ?? 0;
  const queued =
    (matrix.safe.unsure ?? 0) + (matrix.unsure.unsure ?? 0) + (matrix.unsafe.unsure ?? 0);

  console.log(`\nfalsi rifiuti:   ${falseRejects}/${total} (${percent(falseRejects, total)})`);
  console.log(`falsi approvati: ${falseApprovals}/${total} (${percent(falseApprovals, total)})`);
  console.log(`tasso di coda:   ${queued}/${total} (${percent(queued, total)})`);
  if (failures > 0) console.log(`chiamate fallite: ${failures}`);

  if (wrong.length > 0) {
    console.log(`\nscarti (${wrong.length}):`);
    for (const { item, got, kind } of wrong) {
      console.log(`  [${kind}] #${item.id} "${item.text}"`);
      console.log(`     atteso ${item.llm}, ottenuto ${got.join(' | ')}`);
    }
  }
}

/**
 * @param {string} expected
 * @param {string[]} judged
 * @returns {string}
 */
function classify(expected, judged) {
  if (judged.some((verdict) => verdict.startsWith('unsafe')) && expected !== 'unsafe') {
    return 'falso rifiuto';
  }
  if (expected === 'unsafe' && judged.some((verdict) => verdict.startsWith('safe'))) {
    return 'falso approvato';
  }
  // Expected the admin's queue, got a publication: not a rejection, but nobody looked.
  return 'salta la coda';
}

/**
 * @param {number} part
 * @param {number} whole
 * @returns {string}
 */
function percent(part, whole) {
  return whole === 0 ? 'n/d' : `${((part / whole) * 100).toFixed(1)}%`;
}

async function main() {
  const { repeat, onlyQueued } = parseArgs(process.argv.slice(2));
  /** @type {{ cases: GoldenCase[] }} */
  const golden = JSON.parse(readFileSync(CASES_PATH, 'utf8'));

  const { regressions, contexts } = await scoreRegexStage(golden.cases);

  const config = loadConfig();
  const llm = createLlmAdapter(config);

  if (!(await llm.isAvailable())) {
    console.log(
      `\nStadio 2 saltato: MODERATION_LLM_PROVIDER=${config.moderation.llmProvider} non risponde.`
    );
    process.exitCode = regressions > 0 ? 1 : 0;
    return;
  }

  // Everything is sent to the model, including the messages that stage 1 publishes or
  // bins on its own: those never reach it in production, and the gap between what it
  // would have caught and what it is shown is the point of measuring.
  const subject = onlyQueued
    ? golden.cases.filter((item) => item.regex === ModerationVerdict.NEEDS_REVIEW)
    : golden.cases;

  await scoreLlmStage(subject, llm, repeat, contexts);
  process.exitCode = regressions > 0 ? 1 : 0;
}

await main();
