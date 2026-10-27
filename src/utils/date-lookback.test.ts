import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDateInTz, subtractDays, previousDates, lookbackDates, MAX_LOOKBACK_DAYS } from './date-lookback';

test('formatDateInTz: 21h-00h BRT ainda é o dia de São Paulo (UTC já virou)', () => {
    // 2026-10-27T01:30Z = 26/10 22:30 BRT (UTC-3)
    assert.equal(formatDateInTz(new Date('2026-10-27T01:30:00Z')), '2026-10-26');
    // 2026-10-27T02:59:59Z = 26/10 23:59:59 BRT
    assert.equal(formatDateInTz(new Date('2026-10-27T02:59:59Z')), '2026-10-26');
});

test('formatDateInTz: a partir de 00:00 BRT vira o dia (deploy das 00:11 BRT = 03:11 UTC)', () => {
    assert.equal(formatDateInTz(new Date('2026-10-27T03:00:00Z')), '2026-10-27');
    assert.equal(formatDateInTz(new Date('2026-10-27T03:11:00Z')), '2026-10-27');
});

test('formatDateInTz: fuso explícito diferente de São Paulo', () => {
    const d = new Date('2026-10-27T01:30:00Z');
    assert.equal(formatDateInTz(d, 'UTC'), '2026-10-27');
    assert.equal(formatDateInTz(d, 'America/Sao_Paulo'), '2026-10-26');
});

test('subtractDays: dentro do mês', () => {
    assert.equal(subtractDays('2026-10-27', 1), '2026-10-26');
    assert.equal(subtractDays('2026-10-27', 0), '2026-10-27');
});

test('subtractDays: virada de mês (inclui mês de 30/31 dias e fevereiro)', () => {
    assert.equal(subtractDays('2026-11-01', 1), '2026-10-31');
    assert.equal(subtractDays('2026-05-01', 1), '2026-04-30');
    assert.equal(subtractDays('2026-03-01', 1), '2026-02-28');
});

test('subtractDays: ano bissexto', () => {
    assert.equal(subtractDays('2028-03-01', 1), '2028-02-29');
    assert.equal(subtractDays('2028-03-01', 2), '2028-02-28');
});

test('subtractDays: virada de ano', () => {
    assert.equal(subtractDays('2027-01-01', 1), '2026-12-31');
    assert.equal(subtractDays('2027-01-02', 3), '2026-12-30');
});

test('subtractDays: rejeita formato inválido', () => {
    assert.throws(() => subtractDays('27/10/2026', 1));
    assert.throws(() => subtractDays('2026-1-5', 1));
    assert.throws(() => subtractDays('', 1));
});

test('previousDates: ordem ontem -> mais antigo, virada de mês e ano', () => {
    assert.deepEqual(previousDates('2026-10-27', 3), ['2026-10-26', '2026-10-25', '2026-10-24']);
    assert.deepEqual(previousDates('2026-11-02', 3), ['2026-11-01', '2026-10-31', '2026-10-30']);
    assert.deepEqual(previousDates('2027-01-01', 3), ['2026-12-31', '2026-12-30', '2026-12-29']);
    assert.deepEqual(previousDates('2026-10-27', 0), []);
});

test('lookbackDates: hoje primeiro, depois até MAX_LOOKBACK_DAYS dias atrás (3)', () => {
    assert.equal(MAX_LOOKBACK_DAYS, 3);
    assert.deepEqual(lookbackDates('2026-10-27'), ['2026-10-27', '2026-10-26', '2026-10-25', '2026-10-24']);
    assert.deepEqual(lookbackDates('2027-01-01', 1), ['2027-01-01', '2026-12-31']);
});

test('integração: cenário do deploy (03:11 UTC) -> hoje BRT e fallback para ontem BRT', () => {
    const today = formatDateInTz(new Date('2026-10-27T03:11:00Z'));
    assert.deepEqual(lookbackDates(today).slice(0, 2), ['2026-10-27', '2026-10-26']);
});
