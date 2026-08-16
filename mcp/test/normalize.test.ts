import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildBusRouteTags,
  buildBusStopTags,
  cleanName,
  defaultMemberRole,
  normalizeFullWidth,
  normalizeTags
} from '../src/normalize.js';

test('cleanName trims and collapses whitespace', () => {
  assert.equal(cleanName('  东河路  站  '), '东河路 站');
});

test('normalizeFullWidth converts IME ASCII to half-width', () => {
  assert.equal(normalizeFullWidth('１２３路'), '123路');
});

test('normalizeTags removes empty values and fixes refs', () => {
  const result = normalizeTags({
    '': 'ignored',
    name: ' 东河路 ',
    ref: '１路',
    empty: '  ',
    highway: 'bus_stop'
  });
  assert.deepEqual(result, {
    tags: { name: '东河路', ref: '1路', highway: 'bus_stop' },
    removed: ['', 'empty']
  });
});

test('defaultMemberRole uses stop for nodes', () => {
  assert.equal(defaultMemberRole('node'), 'stop');
  assert.equal(defaultMemberRole('way'), '');
  assert.equal(defaultMemberRole('relation'), '');
});

test('buildBusRouteTags produces standard route tags', () => {
  const tags = buildBusRouteTags({
    name: '东河路公交线',
    ref: '3路',
    from: '东站',
    to: '西站',
    operator: '示例公交',
    colour: '#ff0000',
    extraTags: { network: '示例网络' }
  });
  assert.deepEqual(tags, {
    type: 'route',
    route: 'bus',
    name: '东河路公交线',
    ref: '3路',
    from: '东站',
    to: '西站',
    operator: '示例公交',
    colour: '#ff0000',
    network: '示例网络'
  });
});

test('buildBusStopTags creates a highway=bus_stop node', () => {
  const tags = buildBusStopTags(' 人民广场 ', 'Ａ站', { public_transport: 'stop_position' });
  assert.deepEqual(tags, {
    highway: 'bus_stop',
    name: '人民广场',
    ref: 'A站',
    public_transport: 'stop_position'
  });
});
