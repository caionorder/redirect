import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGamDomain } from './domain-normalize';

test('sem underscore: retorna inalterado', () => {
    assert.equal(normalizeGamDomain('dopeaaps.com'), 'dopeaaps.com');
});

test('um underscore final: remove', () => {
    assert.equal(normalizeGamDomain('dopeaaps.com_'), 'dopeaaps.com');
});

test('múltiplos underscores finais: remove todos', () => {
    assert.equal(normalizeGamDomain('appcombos.com__'), 'appcombos.com');
    assert.equal(normalizeGamDomain('noticiasexclusivas.net___'), 'noticiasexclusivas.net');
});

test('string vazia: retorna vazia', () => {
    assert.equal(normalizeGamDomain(''), '');
});

test('string só de underscores: vira vazia', () => {
    assert.equal(normalizeGamDomain('___'), '');
});

test('underscore no meio do domínio: preservado, só o sufixo é removido', () => {
    assert.equal(normalizeGamDomain('meu_site.com'), 'meu_site.com');
    assert.equal(normalizeGamDomain('meu_site.com_'), 'meu_site.com');
});
