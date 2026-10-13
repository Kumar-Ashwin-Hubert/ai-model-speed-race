import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELDS,
  POOLS,
  RULES,
  RULE_IDS,
  SAMPLE_PAPERS,
  buildLlmMessages,
  buildSystemOneQuestions,
  dossierToText,
  generatePapers,
  validateDossier,
} from '../shared/rulebook.js';

const inPool = (value, ...pools) => pools.some((pool) => pool.includes(value));

/** Independent oracle: derives each violation from the dossier content itself. */
const ORACLE = {
  forged: (p) => inPool(p.dossier.passport, POOLS.passportForged) || inPool(p.dossier.entry_permit, POOLS.permitForged),
  expired: (p) => inPool(p.dossier.passport, POOLS.passportExpired) || inPool(p.dossier.entry_permit, POOLS.permitExpired),
  contraband: (p) => inPool(p.dossier.declared_goods, POOLS.goodsContraband),
  watchlist: (p) => inPool(p.dossier.security_check, POOLS.securityHit),
  unsponsored: (p) => p.dossier.purpose === 'Employment' && inPool(p.dossier.sponsor_letter, POOLS.sponsorMissing),
  contradiction: (p) => p.meta.statementKind !== p.meta.purposeKey,
};

test('generation is deterministic per seed and differs across seeds', () => {
  assert.deepEqual(generatePapers(42, 20), generatePapers(42, 20));
  assert.notDeepEqual(generatePapers(42, 20), generatePapers(43, 20));
});

test('queue has the requested size, sequential ids and a fixed reject share', () => {
  for (const count of [10, 20, 30, 50]) {
    const papers = generatePapers(7, count);
    assert.equal(papers.length, count);
    assert.deepEqual(papers.map((p) => p.id), Array.from({ length: count }, (_, i) => i + 1));
    assert.equal(papers.filter((p) => p.truth === 'reject').length, Math.round(count * 0.45));
  }
});

test('ground truth matches an independent oracle for every rule (no accidental violations)', () => {
  for (const seed of [1, 2, 3, 99, 2026, 31337]) {
    for (const paper of generatePapers(seed, 50)) {
      for (const rule of RULE_IDS) {
        assert.equal(
          ORACLE[rule](paper),
          paper.violations.includes(rule),
          `seed ${seed} paper ${paper.id}: rule "${rule}" disagrees with oracle\n${dossierToText(paper.dossier)}`,
        );
      }
      assert.equal(paper.truth, paper.violations.length > 0 ? 'reject' : 'approve');
    }
  }
});

test('every rule is exercised and some rejections carry two violations', () => {
  const papers = generatePapers(5, 50).concat(generatePapers(6, 50));
  const seen = new Set(papers.flatMap((p) => p.violations));
  assert.deepEqual([...seen].sort(), [...RULE_IDS].sort());
  assert.ok(papers.some((p) => p.violations.length === 2));
  assert.ok(papers.every((p) => p.violations.length <= 2));
});

test('hard negatives (decoys) exist and only on approvable fields', () => {
  const papers = generatePapers(11, 50).concat(generatePapers(12, 50));
  const decoyed = papers.filter((p) => p.decoys.length > 0);
  assert.ok(decoyed.length > 10);
  const decoyPools = {
    passport: POOLS.passportDecoy,
    entry_permit: POOLS.permitDecoy,
    declared_goods: POOLS.goodsDecoy,
    security_check: POOLS.securityDecoy,
  };
  for (const paper of decoyed) {
    for (const field of paper.decoys) assert.ok(decoyPools[field].includes(paper.dossier[field]), `${field} decoy value`);
  }
});

test('approved papers have a statement that is consistent with the purpose', () => {
  for (const paper of generatePapers(3, 50).filter((p) => p.truth === 'approve')) {
    assert.equal(paper.meta.statementKind, paper.meta.purposeKey);
  }
});

test('violation pools never share a value with ok or decoy pools', () => {
  const pairs = [
    [POOLS.passportForged, POOLS.passportOk, POOLS.passportDecoy, POOLS.passportExpired],
    [POOLS.permitForged, POOLS.permitOk, POOLS.permitDecoy, POOLS.permitExpired],
    [POOLS.goodsContraband, POOLS.goodsOk, POOLS.goodsDecoy],
    [POOLS.securityHit, POOLS.securityOk, POOLS.securityDecoy],
  ];
  for (const pools of pairs) {
    const all = pools.flat();
    assert.equal(new Set(all).size, all.length, 'pools must be pairwise disjoint');
  }
});

test('dossiers are well-formed and validateDossier rejects malformed input', () => {
  for (const paper of generatePapers(8, 30)) {
    assert.equal(validateDossier(paper.dossier), null);
    assert.deepEqual(Object.keys(paper.dossier).sort(), FIELDS.map(([key]) => key).sort());
  }
  assert.match(validateDossier(null), /object/);
  assert.match(validateDossier([]), /object/);
  assert.match(validateDossier({ ...SAMPLE_PAPERS.approve, passport: '' }), /passport/);
  assert.match(validateDossier({ ...SAMPLE_PAPERS.approve, name: 42 }), /name/);
  assert.match(validateDossier({ ...SAMPLE_PAPERS.approve, statement: 'x'.repeat(301) }), /too long/);
  const { origin, ...missing } = SAMPLE_PAPERS.approve;
  assert.match(validateDossier(missing), /origin/);
});

test('sample papers are valid and consistent with the oracle', () => {
  assert.equal(validateDossier(SAMPLE_PAPERS.approve), null);
  assert.equal(validateDossier(SAMPLE_PAPERS.reject), null);
  assert.ok(inPool(SAMPLE_PAPERS.reject.declared_goods, POOLS.goodsContraband));
});

test('prompt carries every rule and the dossier; JEV gets one Noul question per rule', () => {
  const dossier = SAMPLE_PAPERS.approve;
  const [system, user] = buildLlmMessages(dossier);
  assert.equal(system.role, 'system');
  assert.equal(user.role, 'user');
  for (const rule of RULES) assert.ok(system.content.includes(rule.text), rule.id);
  assert.match(system.content, /APPROVE or REJECT/);
  assert.equal(user.content, dossierToText(dossier));

  const questions = buildSystemOneQuestions();
  assert.deepEqual(Object.keys(questions), RULE_IDS);
  for (const rule of RULES) assert.deepEqual(questions[rule.id], { type: 'noul', instructions: rule.text });
});

test('the generated text never leaks the ground truth', () => {
  for (const paper of generatePapers(21, 30)) {
    const text = JSON.stringify(paper.dossier).toLowerCase();
    assert.ok(!text.includes('"truth"') && !text.includes('violation'));
  }
});
