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

test('Gmail header preflight is manual, read-only, limited, and excludes mail content', () => {
  const workflow = workflows['C-gmail-header-check.json'];
  assert.equal(workflow.name, 'CHECK ONLY - Gmail forwarding headers');
  assert.equal(workflow.active, false);
  assert.equal(workflow.nodes.filter(n => n.type.endsWith('.manualTrigger')).length, 1);
  assert.ok(workflow.nodes.every(n => ['manualTrigger', 'httpRequest', 'if', 'splitOut', 'set'].some(type => n.type === `n8n-nodes-base.${type}`)));
  const requests = workflow.nodes.filter(n => n.type.endsWith('.httpRequest'));
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.parameters.method, 'GET');
    assert.match(request.parameters.url, /https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages/);
    assert.doesNotMatch(request.parameters.url, /\/modify|\/steam|otp-worker/);
    assert.equal(request.parameters.sendBody, undefined);
    assert.equal(request.credentials.gmailOAuth2.name, 'Central Gmail mailbox');
    assert.deepEqual(Object.keys(request.credentials), ['gmailOAuth2']);
  }
  const params = request => Object.fromEntries(request.parameters.queryParameters.parameters.map(p => [p.name, p.value]));
  assert.deepEqual(params(requests[0]), { q: 'newer_than:1d -in:trash from:noreply@steampowered.com', maxResults: '5', includeSpamTrash: 'true', fields: 'messages/id' });
  assert.equal(requests[0].parameters.options.pagination, undefined);
  assert.deepEqual(params(requests[1]), { format: 'metadata', fields: 'labelIds,payload/headers' });
  const metadataUrl = new URL(Function('$json', `return (${requests[1].parameters.url.slice(3, -2)});`)({ id: 'synthetic/id' }));
  assert.equal(metadataUrl.hostname, 'gmail.googleapis.com');
  assert.deepEqual([...metadataUrl.searchParams.keys()], Array(7).fill('metadataHeaders'));
  assert.deepEqual(metadataUrl.searchParams.getAll('metadataHeaders'), ['Authentication-Results', 'ARC-Seal', 'ARC-Authentication-Results', 'ARC-Message-Signature', 'To', 'Date', 'From']);
  assert.doesNotMatch(JSON.stringify(requests[1].parameters), /Subject|snippet|format.*full|payload\/body/i);
  const safe = byName(workflow, 'Safe forwarding header flags');
  assert.equal(safe.parameters.includeOtherFields, false);
  const fields = safe.parameters.assignments.assignments;
  assert.deepEqual(fields.map(f => [f.name, f.type]), ['inSpam', 'gmailVerifier', 'dmarcPass', 'dmarcAlignedToSteam', 'dkimPass', 'spfPass', 'arcPass', 'authHeaderCount'].map(name => [name, name === 'authHeaderCount' ? 'number' : 'boolean']));
  const evaluate = data => Object.fromEntries(fields.map(f => [f.name, Function('$json', `return (${f.value.slice(3, -2)});`)(data)]));
  assert.deepEqual(evaluate({ labelIds: ['SPAM'], payload: { headers: [{ name: 'Authentication-Results', value: 'mx.google.com; dkim=pass; spf=pass; dmarc=pass header.from=steampowered.com; arc=pass' }] } }), {
    inSpam: true, gmailVerifier: true, dmarcPass: true, dmarcAlignedToSteam: true, dkimPass: true, spfPass: true, arcPass: true, authHeaderCount: 1,
  });
  assert.equal(evaluate({ payload: { headers: [{ name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=steampowered.com.evil.test' }] } }).dmarcAlignedToSteam, false);
  const foreignPass = { name: 'Authentication-Results', value: 'mx.microsoft.com; dmarc=pass header.from=steampowered.com; spf=pass; dkim=pass; arc=pass' };
  const googlePass = { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=steampowered.com; spf=pass; dkim=pass; arc=pass' };
  const googleFail = { name: 'Authentication-Results', value: 'mx.google.com; dmarc=fail header.from=steampowered.com; spf=pass; dkim=pass; arc=pass' };
  assert.deepEqual(evaluate({ payload: { headers: [foreignPass, googleFail] } }), {
    inSpam: false, gmailVerifier: true, dmarcPass: false, dmarcAlignedToSteam: false, dkimPass: true, spfPass: true, arcPass: true, authHeaderCount: 2,
  });
  for (const headers of [[foreignPass], [googlePass, googlePass]]) {
    assert.deepEqual(evaluate({ payload: { headers } }), { inSpam: false, gmailVerifier: false, dmarcPass: false, dmarcAlignedToSteam: false, dkimPass: false, spfPass: false, arcPass: false, authHeaderCount: headers.length });
  }
  assert.deepEqual(evaluate({}), { inSpam: false, gmailVerifier: false, dmarcPass: false, dmarcAlignedToSteam: false, dkimPass: false, spfPass: false, arcPass: false, authHeaderCount: 0 });
  assert.equal(workflow.connections[safe.name], undefined);
});
