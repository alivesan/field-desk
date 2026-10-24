import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  }
});

for (const [filename, provider, credentialType] of [
  ['gmail-mailbox.json', 'gmail', 'gmailOAuth2'],
  ['outlook-mailbox.json', 'outlook', 'microsoftOutlookOAuth2Api'],
]) {
  test(`${provider} template polls, pages, processes, and marks only accepted messages`, () => {
    const workflow = workflows[filename];
    assert.equal(byName(workflow, 'Every 15 seconds').parameters.rule.interval[0].secondsInterval, 15);
    assert.equal(byName(workflow, 'MAILBOX ID').parameters.assignments.assignments[0].name, 'mailbox');
    const due = byName(workflow, 'Ask worker if due');
    assert.equal(due.parameters.genericAuthType, 'httpHeaderAuth');
    assert.equal(due.credentials.httpHeaderAuth.name, 'OTP Worker');
    assert.match(JSON.stringify(due.parameters), /\/due/);
    assert.match(JSON.stringify(due.parameters), /mailbox/);
    const list = byName(workflow, 'List recent messages');
    assert.equal(list.parameters.nodeCredentialType, credentialType);
    assert.equal(list.parameters.authentication, 'predefinedCredentialType');
    assert.equal(list.parameters.options.pagination.pagination.paginationCompleteWhen, 'other');
    assert.match(JSON.stringify(list.parameters), /600000/);
    assert.match(JSON.stringify(list.parameters), /noreply@steampowered\.com/);
    if (provider === 'outlook') assert.match(JSON.stringify(list.parameters), /from\/emailAddress\/address eq/);
    assert.doesNotMatch(JSON.stringify(list.parameters), /UNREAD|isRead eq false/);
    const full = byName(workflow, 'Get full message');
    assert.equal(full.parameters.nodeCredentialType, credentialType);
    assert.match(JSON.stringify(full.parameters), provider === 'gmail' ? /format.*full/ : /internetMessageHeaders/);
    const process = byName(workflow, 'Process in worker');
    assert.match(process.parameters.jsonBody, new RegExp(`provider: '${provider}'`));
    assert.match(process.parameters.jsonBody, /message: \$json/);
    assert.equal(process.credentials.httpHeaderAuth.name, 'OTP Worker');
    const mark = byName(workflow, 'Mark message read');
    assert.equal(mark.parameters.nodeCredentialType, credentialType);
    assert.match(mark.parameters.jsonBody, provider === 'gmail' ? /removeLabelIds.*UNREAD/ : /isRead.*true/);
    assert.deepEqual(workflow.connections['Mark processed?'].main[0].map((edge) => edge.node), ['Mark message read']);
  });
}

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
  for (const expected of ['gmail-1', 'login-alpha@example.invalid', 'store_alpha', 'A1B2C', 'dmarc=pass', 'Date.now()']) {
    assert.ok(process.parameters.jsonBody.includes(expected) || (expected === 'store_alpha' || expected === 'A1B2C') && Buffer.from(process.parameters.jsonBody.match(/"data":"([^"]+)"/)[1], 'base64url').toString().includes(expected), expected);
  }
  assert.equal(workflow.nodes.some((node) => node.credentials?.gmailOAuth2), false);
});
