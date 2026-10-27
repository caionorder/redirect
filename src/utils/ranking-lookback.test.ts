import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFirstUsableDay } from './ranking-lookback';

type Row = { impressions: number };
const usable = (rows: Row[]) => rows.some(r => r.impressions >= 100);
const DATES = ['2026-10-27', '2026-10-26', '2026-10-25', '2026-10-24'];

function fakeFetch(byDate: Record<string, Row[]>) {
    const calls: string[] = [];
    return { calls, fetch: async (d: string) => { calls.push(d); return byDate[d] ?? []; } };
}

test('hoje utilizável: lookbackDays 0 e uma única consulta', async () => {
    const { calls, fetch } = fakeFetch({ '2026-10-27': [{ impressions: 500 }] });
    const r = await pickFirstUsableDay(DATES, fetch, usable);
    assert.deepEqual(r, { date: '2026-10-27', rows: [{ impressions: 500 }], lookbackDays: 0 });
    assert.deepEqual(calls, ['2026-10-27']);
});

test('hoje vazio -> ontem: para no primeiro utilizável e não consulta os dias seguintes', async () => {
    const { calls, fetch } = fakeFetch({ '2026-10-26': [{ impressions: 200 }], '2026-10-25': [{ impressions: 999 }] });
    const r = await pickFirstUsableDay(DATES, fetch, usable);
    assert.equal(r?.date, '2026-10-26');
    assert.equal(r?.lookbackDays, 1);
    assert.deepEqual(calls, ['2026-10-27', '2026-10-26']);
});

test('dia com linhas mas nenhuma utilizável (<100 imp.) é pulado', async () => {
    const { calls, fetch } = fakeFetch({ '2026-10-27': [{ impressions: 10 }], '2026-10-26': [{ impressions: 300 }] });
    const r = await pickFirstUsableDay(DATES, fetch, usable);
    assert.equal(r?.date, '2026-10-26');
    assert.deepEqual(calls, ['2026-10-27', '2026-10-26']);
});

test('3 dias atrás (último candidato) ainda vence: lookbackDays 3', async () => {
    const { fetch } = fakeFetch({ '2026-10-24': [{ impressions: 150 }] });
    const r = await pickFirstUsableDay(DATES, fetch, usable);
    assert.equal(r?.lookbackDays, 3);
});

test('4 dias vazios -> null, consultando exatamente os 4 candidatos', async () => {
    const { calls, fetch } = fakeFetch({});
    assert.equal(await pickFirstUsableDay(DATES, fetch, usable), null);
    assert.deepEqual(calls, DATES);
});

test('sem candidatos -> null sem consultar', async () => {
    const { calls, fetch } = fakeFetch({});
    assert.equal(await pickFirstUsableDay([], fetch, usable), null);
    assert.deepEqual(calls, []);
});

test('erro do fetch propaga e interrompe o lookback (comportamento atual)', async () => {
    const calls: string[] = [];
    const fetch = async (d: string): Promise<Row[]> => {
        calls.push(d);
        if (d === '2026-10-26') throw new Error('mongo down');
        return [];
    };
    await assert.rejects(() => pickFirstUsableDay(DATES, fetch, usable), /mongo down/);
    assert.deepEqual(calls, ['2026-10-27', '2026-10-26']);
});
