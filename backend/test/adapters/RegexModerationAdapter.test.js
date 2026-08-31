// backend/test/adapters/RegexModerationAdapter.test.js

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RegexModerationAdapter } from '../../src/adapters/moderation/RegexModerationAdapter.js';
import { ModerationVerdict } from '../../src/ports/ModerationPort.js';

const moderation = new RegexModerationAdapter();

/** @param {string} text */
async function verdictOf(text) {
  return (await moderation.evaluate(text)).verdict;
}

/** @param {string} text */
async function reasonsOf(text) {
  return (await moderation.evaluate(text)).reasons;
}

describe('clean messages', () => {
  const innocuous = [
    'Buon compleanno nonna!',
    'Ti aspetto sotto casa alle otto',
    'Grazie di tutto, sei stata importante',
    'Il figaro di Siviglia e una bella opera',
    'Che dio ti benedica sempre',
    'Allevo un porco e due galline',
    'Il mio cane si chiama Ugo',
    'La madonna del Caravaggio e a Roma'
  ];

  for (const text of innocuous) {
    it(`approves: ${text}`, async () => {
      assert.equal(await verdictOf(text), ModerationVerdict.AUTO_APPROVE);
    });
  }
});

describe('profanity', () => {
  it('rejects an explicit insult outright', async () => {
    const result = await moderation.evaluate('sei un coglione');
    assert.equal(result.verdict, ModerationVerdict.REJECT);
    assert.deepEqual(result.reasons, ['profanity']);
  });

  it('rejects it through leetspeak too', async () => {
    assert.equal(await verdictOf('sei un c0gl10ne'), ModerationVerdict.REJECT);
  });
});

/**
 * The ladder from the brief. These words sit in SUSPICIOUS, so the verdict is review
 * rather than rejection — what is under test here is that every disguise still
 * reaches the dictionary entry, not the severity attached to it.
 */
describe('obfuscation always reaches the word behind it', () => {
  const variants = [
    ['cazzo', 'plain'],
    ['c4zzo', 'leet a'],
    ['cazz0', 'leet o'],
    ['c4zz0', 'leet both'],
    ['càzzo', 'accent'],
    ['CAZZO', 'uppercase'],
    ['caaaazzzo', 'repeated letters'],
    ['c.a.z.z.o', 'dotted'],
    ['c-a-z-z-o', 'hyphenated'],
    ['c a z z o', 'spaced']
  ];

  for (const [text, label] of variants) {
    it(`catches ${label}: ${text}`, async () => {
      const result = await moderation.evaluate(`ma che ${text} dici`);
      assert.notEqual(result.verdict, ModerationVerdict.AUTO_APPROVE);
      assert.ok(result.reasons.includes('ambiguous_language'));
    });
  }

  it('does not fire inside a longer innocent word', async () => {
    assert.equal(await verdictOf('passami la cazzuola'), ModerationVerdict.AUTO_APPROVE);
  });
});

describe('homoglyphs', () => {
  // Cyrillic lookalikes: identical on screen, different code points. Unicode
  // normalisation does not touch them, so they need their own fold.
  it('sees a Cyrillic e inside a slur', async () => {
    assert.equal(await verdictOf('sei un tеrrone'), ModerationVerdict.REJECT);
  });

  it('sees a Cyrillic o and a', async () => {
    assert.equal(await verdictOf('sei un cоgliоne'), ModerationVerdict.REJECT);
  });

  it('sees a Greek omicron', async () => {
    assert.equal(await verdictOf('sei un cοglione'), ModerationVerdict.REJECT);
  });

  it('folds fullwidth characters', async () => {
    assert.equal(await verdictOf('sei un ｃoglione'), ModerationVerdict.REJECT);
  });

  it('leaves honest non-Latin text alone', async () => {
    assert.equal(await verdictOf('ti scrivo da Mosca, privet'), ModerationVerdict.AUTO_APPROVE);
  });
});

describe('compositional blasphemy', () => {
  // Neither half offends alone, which is exactly why a word list cannot catch these.
  const variants = [
    'porcodio',
    'porco dio',
    'dioporco',
    'dio porco',
    'dio maiale',
    'dio p0rc0',
    'porco    dio',
    'porcoddio',
    'dio cane',
    'porca madonna',
    'madonna puttana'
  ];

  for (const text of variants) {
    it(`rejects: ${text}`, async () => {
      assert.equal(await verdictOf(`che ${text} di giornata`), ModerationVerdict.REJECT);
    });
  }

  it('labels it as blasphemy, not generic profanity', async () => {
    assert.deepEqual(await reasonsOf('porco dio'), ['blasphemy']);
  });

  it('leaves the halves alone when they are apart', async () => {
    assert.equal(
      await verdictOf('il porco e nel recinto mentre prego dio'),
      ModerationVerdict.AUTO_APPROVE
    );
  });
});

describe('hate speech', () => {
  it('rejects a slur without appeal', async () => {
    const result = await moderation.evaluate('sei proprio un terrone');
    assert.equal(result.verdict, ModerationVerdict.REJECT);
    assert.deepEqual(result.reasons, ['hate_speech']);
  });

  it('catches an obfuscated slur', async () => {
    assert.equal(await verdictOf('sei un t3rr0ne'), ModerationVerdict.REJECT);
  });
});

describe('ambiguous language goes to a human', () => {
  it('flags rather than rejects a word that is often harmless', async () => {
    const result = await moderation.evaluate('che figa questa cosa');
    assert.equal(result.verdict, ModerationVerdict.NEEDS_REVIEW);
    assert.ok(result.reasons.includes('ambiguous_language'));
  });

  it('flags a slur that collides with an ordinary word', async () => {
    assert.equal(await verdictOf('sei un finocchio'), ModerationVerdict.NEEDS_REVIEW);
  });

  /**
   * The accepted cost of that choice: a genuine shopping list also reaches the queue.
   * Preferable to the alternative, which is auto-approving the slur.
   */
  it('sends the vegetable to the admin too, and that is fine', async () => {
    assert.equal(
      await verdictOf('Ho comprato un finocchio e due carote'),
      ModerationVerdict.NEEDS_REVIEW
    );
  });
});

describe('handles', () => {
  /** @param {string} handle */
  async function handleVerdict(handle) {
    return (await moderation.evaluateHandle(handle)).verdict;
  }

  it('accepts an ordinary handle', async () => {
    assert.equal(await handleVerdict('ricky.dev'), ModerationVerdict.AUTO_APPROVE);
    assert.equal(await handleVerdict('marco_1988'), ModerationVerdict.AUTO_APPROVE);
  });

  // A handle has no spaces, so the word sits inside the token and the bounded
  // matcher used for free text would walk straight past it.
  it('finds a slur buried inside the token', async () => {
    assert.equal(await handleVerdict('ilterronedelsud'), ModerationVerdict.NEEDS_REVIEW);
  });

  it('finds blasphemy written as one word', async () => {
    assert.equal(await handleVerdict('dioporco90'), ModerationVerdict.NEEDS_REVIEW);
    assert.equal(await handleVerdict('porcodio_official'), ModerationVerdict.NEEDS_REVIEW);
  });

  it('finds profanity buried inside the token', async () => {
    assert.equal(await handleVerdict('sonouncoglione'), ModerationVerdict.NEEDS_REVIEW);
  });

  it('sees through leetspeak in a handle', async () => {
    assert.equal(await handleVerdict('d10p0rc0'), ModerationVerdict.NEEDS_REVIEW);
  });

  /**
   * Deliberate asymmetry with the message body: substring matching on a 30-character
   * token is blunt enough to hit real surnames, and the handle is the one field the
   * admin can simply rewrite. So it escalates, never rejects.
   */
  it('never rejects, however bad it looks', async () => {
    for (const handle of ['ilterronedelsud', 'dioporco90', 'sonouncoglione', 'd10p0rc0']) {
      assert.notEqual(await handleVerdict(handle), ModerationVerdict.REJECT);
    }
  });

  it('sends an ambiguous handle to a human rather than binning it', async () => {
    assert.equal(await handleVerdict('figadilegno'), ModerationVerdict.NEEDS_REVIEW);
  });

  // Substring matching is blunt by design, but it only sees whole dictionary entries:
  // "cazzeggio" shares a prefix with "cazzo" and is left alone.
  it('does not fire on a handle that merely shares a prefix', async () => {
    assert.equal(await handleVerdict('cazzeggio.official'), ModerationVerdict.AUTO_APPROVE);
  });

  it('reports which layer fired', async () => {
    const result = await moderation.evaluateHandle('porcodio');
    assert.deepEqual(result.reasons, ['handle_blasphemy']);
  });
});

describe('spam and contact details', () => {
  it('rejects links', async () => {
    assert.equal(await verdictOf('vieni su https://spam.example'), ModerationVerdict.REJECT);
    assert.equal(await verdictOf('scrivimi su spam.xyz'), ModerationVerdict.REJECT);
  });

  it('flags an email for a human to look at', async () => {
    const result = await moderation.evaluate('scrivimi a mario.rossi@example.com');
    assert.equal(result.verdict, ModerationVerdict.NEEDS_REVIEW);
    assert.deepEqual(result.reasons, ['contact_details']);
  });

  it('flags shouting', async () => {
    const result = await moderation.evaluate('QUESTO MESSAGGIO E TUTTO URLATO DAVVERO');
    assert.equal(result.verdict, ModerationVerdict.NEEDS_REVIEW);
    assert.ok(result.reasons.includes('shouting'));
  });

  it('flags character flooding', async () => {
    const result = await moderation.evaluate('ciaoooooooo a tutti');
    assert.ok(result.reasons.includes('character_flood'));
  });
});
