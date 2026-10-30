import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { workflows } from '../scripts/generate-workflows.mjs';

const directory = fileURLToPath(new URL('../workflows/', import.meta.url));
const byName = (workflow, name) => {
  const found = workflow.nodes.find((node) => node.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
};

test('checked-in exports match the deterministic generator', async () => {
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.json')).sort(), Object.keys(workflows).sort());
  for (const [filename, workflow] of Object.entries(workflows)) {
    const actual = await readFile(resolve(directory, filename), 'utf8');
    assert.equal(actual, `${JSON.stringify(workflow, null, 2)}\n`);
  }
});

test('every workflow imports inactive without saved execution or pinned mail data', () => {
  for (const workflow of Object.values(workflows)) {
    assert.equal(workflow.active, false);
    assert.equal(workflow.settings.saveDataErrorExecution, 'none');
    assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
    assert.equal(workflow.settings.saveManualExecutions, false);
    assert.equal(workflow.settings.saveExecutionProgress, false);
    assert.equal(workflow.pinData, undefined);
    assert.ok(workflow.nodes.every((node) => node.type !== 'n8n-nodes-base.code'));
    assert.ok(workflow.nodes.every((node) => node.parameters.credentials === undefined));
    for (const request of workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest')) {
      assert.equal(request.parameters.options.timeout, request.parameters.url === 'http://otp-worker:8787/process' ? 30000 : 10000);
    }
  }
});

test('central Gmail template uses worker query, pages, processes, and marks accepted messages', () => {
    const workflow = workflows['C-central-gmail.json'];
    assert.equal(byName(workflow, 'Every 15 seconds').parameters.rule.interval[0].secondsInterval, 15);
    assert.deepEqual(byName(workflow, 'MAILBOX ID').parameters.assignments.assignments.map(({ name, value }) => ({ name, value })), [{ name: 'mailbox', value: 'central-gmail' }]);
    const due = byName(workflow, 'Ask worker if due');
    assert.equal(due.parameters.genericAuthType, 'httpHeaderAuth');
    assert.equal(due.credentials.httpHeaderAuth.name, 'OTP Worker');
    assert.match(JSON.stringify(due.parameters), /\/due/);
    assert.match(JSON.stringify(due.parameters), /mailbox/);
    assert.match(byName(workflow, 'Due?').parameters.conditions.conditions[0].leftValue, /query\.length > 0/);
    const list = byName(workflow, 'List recent messages');
    assert.equal(list.parameters.nodeCredentialType, 'gmailOAuth2');
    assert.equal(list.parameters.authentication, 'predefinedCredentialType');
    assert.equal(list.parameters.options.pagination.pagination.paginationCompleteWhen, 'other');
    assert.equal(list.parameters.queryParameters.parameters.find((parameter) => parameter.name === 'q').value, "={{ $('Ask worker if due').first().json.query }}");
    assert.equal(list.parameters.queryParameters.parameters.find((parameter) => parameter.name === 'includeSpamTrash').value, 'true');
    assert.ok(!list.parameters.queryParameters.parameters.some(parameter => parameter.name.startsWith('labelIds')));
    assert.doesNotMatch(JSON.stringify(list.parameters), /UNREAD|isRead eq false/);
    const full = byName(workflow, 'Get full message');
    assert.equal(full.parameters.nodeCredentialType, 'gmailOAuth2');
    assert.match(JSON.stringify(full.parameters), /format.*full/);
    const process = byName(workflow, 'Process in worker');
    assert.equal(process.parameters.options.timeout, 30000);
    assert.equal(process.parameters.options.batching, undefined);
    assert.match(process.parameters.jsonBody, /provider: 'gmail'/);
    assert.match(process.parameters.jsonBody, /message: \$json/);
    assert.equal(process.credentials.httpHeaderAuth.name, 'OTP Worker');
    const mark = byName(workflow, 'Mark message read');
    assert.equal(mark.parameters.nodeCredentialType, 'gmailOAuth2');
    assert.match(mark.parameters.jsonBody, /removeLabelIds.*UNREAD/);
    assert.deepEqual(workflow.connections['Mark processed?'].main[0].map((edge) => edge.node), ['Mark message read']);
    assert.deepEqual(new Set(workflow.nodes.flatMap((node) => Object.keys(node.credentials ?? {}))), new Set(['httpHeaderAuth', 'gmailOAuth2']));
});

test('central Gmail completes each message before advancing on either processing outcome', () => {
  const workflow = workflows['C-central-gmail.json'];
  const loop = byName(workflow, 'Process messages one at a time');
  assert.equal(loop.type, 'n8n-nodes-base.splitInBatches');
  assert.equal(loop.typeVersion, 3);
  assert.deepEqual(loop.parameters, { batchSize: 1, options: {} });
  const destinations = (name, output = 0) => (workflow.connections[name]?.main[output] ?? []).map(edge => edge.node);
  assert.deepEqual(destinations('One message per item'), [loop.name]);
  assert.deepEqual(destinations(loop.name, 0), []);
  assert.deepEqual(destinations(loop.name, 1), ['Get full message']);
  assert.deepEqual(destinations('Get full message'), ['Process in worker']);
  assert.deepEqual(destinations('Process in worker'), ['Mark processed?']);
  assert.deepEqual(destinations('Mark processed?', 0), ['Mark message read']);
  assert.deepEqual(destinations('Mark message read'), [loop.name]);
  assert.deepEqual(destinations('Mark processed?', 1), [loop.name]);
});

test('webhook forwards binary raw body and signature to worker', () => {
  const workflow = workflows['steam-request-webhook.json'];
  assert.equal(byName(workflow, 'Steam request webhook').parameters.options.rawBody, true);
  const forward = byName(workflow, 'Forward raw signed request');
  assert.equal(forward.parameters.contentType, 'binaryData');
  assert.equal(forward.parameters.inputDataFieldName, 'data');
  assert.equal(forward.parameters.headerParameters.parameters[0].name, 'X-FieldDesk-Signature');
  assert.equal(forward.credentials.httpHeaderAuth.name, 'OTP Worker');
  assert.match(forward.parameters.url, /\/webhook$/);
  assert.equal(forward.parameters.jsonBody, undefined);
});

test('mock-only manual demo posts a fresh synthetic Gmail message without real mail credentials', () => {
  const workflow = workflows['C-demo-mock.json'];
  assert.match(workflow.name, /^MOCK ONLY/);
  assert.equal(byName(workflow, 'MOCK ONLY - manual trigger').type, 'n8n-nodes-base.manualTrigger');
  const process = byName(workflow, 'MOCK ONLY - process synthetic mail');
  assert.equal(process.credentials.httpHeaderAuth.name, 'OTP Worker');
  assert.equal(process.parameters.url, 'http://otp-worker:8787/process');
  for (const expected of ['central-gmail', 'login-alpha@example.invalid', 'store_alpha', 'A1B2C', 'mx.google.com', 'dmarc=pass', '{{ Date.now() }}', '{{ new Date().toUTCString() }}']) {
    assert.ok(process.parameters.jsonBody.includes(expected) || (expected === 'store_alpha' || expected === 'A1B2C') && Buffer.from(process.parameters.jsonBody.match(/"data":"([^"]+)"/)[1], 'base64url').toString().includes(expected), expected);
  }
  const renderedBody = process.parameters.jsonBody.slice(1)
    .replace('{{ Date.now() }}', '1700000000000')
    .replace('{{ String(Date.now()) }}', '1700000000000')
    .replace('{{ new Date().toUTCString() }}', 'Tue, 14 Nov 2023 22:13:20 GMT');
  const input = JSON.parse(renderedBody);
  assert.equal(input.mailbox, 'central-gmail');
  assert.equal(input.provider, 'gmail');
  assert.equal(input.message.id, 'mock-demo-1700000000000');
  assert.equal(input.message.internalDate, '1700000000000');
  assert.equal(input.message.payload.headers.find((header) => header.name === 'Date').value, 'Tue, 14 Nov 2023 22:13:20 GMT');
  assert.match(Buffer.from(input.message.payload.body.data, 'base64url').toString(), /Dear store_alpha,\nSteam Guard code is: A1B2C/);
  assert.equal(workflow.nodes.some((node) => node.credentials?.gmailOAuth2), false);
});
