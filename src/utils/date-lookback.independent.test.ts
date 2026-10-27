import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDateInTz, subtractDays, previousDates, lookbackDates, MAX_LOOKBACK_DAYS } from './date-lookback';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Argus — validação independente (não depende da suíte da implementação)

test('formatDateInTz: janela 21h-03h UTC — BRT atrás de UTC por 3h (sem DST desde 2019)', () => {
    assert.equal(formatDateInTz(new Date('2026-10-27T02:30:00Z')), '2026-10-26');
    assert.equal(formatDateInTz(new Date('2026-10-27T03:30:00Z')), '2026-10-27');
    assert.equal(formatDateInTz(new Date('2026-10-27T02:59:59.999Z')), '2026-10-26');
    assert.equal(formatDateInTz(new Date('2026-10-27T03:00:00.000Z')), '2026-10-27');
    // 21h UTC == 18h BRT: mesmo dia nos dois fusos
    assert.equal(formatDateInTz(new Date('2026-10-26T21:00:00Z')), '2026-10-26');
    // UTC já virou, BRT não
    assert.equal(formatDateInTz(new Date('2026-10-27T00:00:00Z')), '2026-10-26');
    assert.equal(formatDateInTz(new Date('2026-10-27T00:00:00Z'), 'UTC'), '2026-10-27');
});

test('formatDateInTz: virada de mês/ano em BRT', () => {
    assert.equal(formatDateInTz(new Date('2027-01-01T02:59:00Z')), '2026-12-31');
    assert.equal(formatDateInTz(new Date('2027-01-01T03:00:00Z')), '2027-01-01');
    assert.equal(formatDateInTz(new Date('2028-03-01T02:00:00Z')), '2028-02-29');
});

test('subtractDays: 01/03 em ano bissexto vs não bissexto', () => {
    assert.equal(subtractDays('2028-03-01', 1), '2028-02-29');
    assert.equal(subtractDays('2027-03-01', 1), '2027-02-28');
    assert.equal(subtractDays('2100-03-01', 1), '2100-02-28'); // 2100 não é bissexto
    assert.equal(subtractDays('2000-03-01', 1), '2000-02-29'); // 2000 é
});

test('subtractDays: virada de ano e n=0', () => {
    assert.equal(subtractDays('2026-01-01', 1), '2025-12-31');
    assert.equal(subtractDays('2026-01-01', 0), '2026-01-01');
    assert.equal(subtractDays('2026-01-03', 3), '2025-12-31');
});

test('previousDates / lookbackDates: formato, ordem decrescente, sem duplicatas, tamanho exato', () => {
    for (const today of ['2026-10-27', '2028-03-01', '2027-01-01', '2026-03-01']) {
        for (const n of [0, 1, 3, 7]) {
            const prev = previousDates(today, n);
            assert.equal(prev.length, n);
            assert.ok(prev.every(d => ISO.test(d)));
            assert.ok(!prev.includes(today));
            assert.equal(new Set(prev).size, n);
            const all = lookbackDates(today, n);
            assert.equal(all.length, n + 1);
            assert.equal(all[0], today);
            assert.equal(new Set(all).size, n + 1);
            for (let i = 1; i < all.length; i++) assert.ok(all[i] < all[i - 1], `${all[i]} < ${all[i - 1]}`);
        }
    }
});

test('lookbackDates: default = hoje + 3 anteriores; n=0 devolve só hoje', () => {
    assert.equal(lookbackDates('2026-10-27').length, MAX_LOOKBACK_DAYS + 1);
    assert.deepEqual(lookbackDates('2026-10-27', 0), ['2026-10-27']);
    assert.deepEqual(lookbackDates('2028-03-02'), ['2028-03-02', '2028-03-01', '2028-02-29', '2028-02-28']);
});

test('propriedade (fuzz 300 datas 2020-2030): cada data é exatamente 1 dia antes da anterior', () => {
    // PRNG determinístico (mulberry32) — sem flakiness
    let s = 123456789;
    const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const min = Date.UTC(2020, 0, 1), max = Date.UTC(2030, 11, 31);
    for (let i = 0; i < 300; i++) {
        const ms = min + Math.floor(rnd() * (max - min));
        const today = new Date(ms).toISOString().slice(0, 10);
        const seq = lookbackDates(today);
        assert.equal(seq.length, 4);
        for (let j = 1; j < seq.length; j++) {
            const diff = (Date.parse(seq[j - 1] + 'T00:00:00Z') - Date.parse(seq[j] + 'T00:00:00Z')) / 86400000;
            assert.equal(diff, 1, `${seq[j - 1]} -> ${seq[j]}`);
        }
        assert.equal(subtractDays(today, 3), seq[3]);
    }
});

test('formatDateInTz ∘ lookbackDates: o 1º candidato é o dia BRT, não o dia UTC (cenário do incidente 00:11 BRT)', () => {
    const now = new Date('2026-10-27T03:11:00Z'); // 00:11 BRT
    assert.deepEqual(lookbackDates(formatDateInTz(now)).slice(0, 2), ['2026-10-27', '2026-10-26']);
    const before = new Date('2026-10-27T02:30:00Z'); // 23:30 BRT do dia 26
    assert.deepEqual(lookbackDates(formatDateInTz(before)).slice(0, 2), ['2026-10-26', '2026-10-25']);
});
