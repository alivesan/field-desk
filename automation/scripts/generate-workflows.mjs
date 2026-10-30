import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const output = resolve(fileURLToPath(new URL('../workflows/', import.meta.url)));
const worker = 'http://otp-worker:8787';
const settings = {
  executionOrder: 'v1',
  saveDataErrorExecution: 'none',
  saveDataSuccessExecution: 'none',
  saveManualExecutions: false,
  saveExecutionProgress: false,
};
const credential = (type, name) => ({ [type]: { name } });
const workerAuth = { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', credentials: credential('httpHeaderAuth', 'OTP Worker') };
const gmailAuth = { authentication: 'predefinedCredentialType', nodeCredentialType: 'gmailOAuth2', credentials: credential('gmailOAuth2', 'Central Gmail mailbox') };
const node = (name, type, x, y, parameters, extra = {}) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type: `n8n-nodes-base.${type}`, typeVersion: { manualTrigger: 1, scheduleTrigger: 1.2, set: 3.4, if: 2.2, splitOut: 1, webhook: 2.1, respondToWebhook: 1.4, httpRequest: 4.2 }[type], position: [x, y], parameters, ...extra });
const connect = (connections, from, to, outputIndex = 0) => {
  const main = connections[from]?.main ?? [];
  while (main.length <= outputIndex) main.push([]);
  main[outputIndex].push({ node: to, type: 'main', index: 0 });
  connections[from] = { main };
};
const condition = (expression) => ({
  conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'boolean-check', leftValue: expression, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' },
  options: {},
});
const http = (name, x, y, parameters, auth) => {
  const { credentials: _credentialBinding, ...request } = parameters;
  return node(name, 'httpRequest', x, y, { ...request, options: { ...request.options, timeout: 10000 } }, auth ? { credentials: auth.credentials } : {});
};
const query = (pairs) => ({ sendQuery: true, queryParameters: { parameters: pairs.map(([name, value]) => ({ name, value })) } });
const pagination = (mode, next, complete) => ({ pagination: { pagination: { paginationMode: mode, ...(mode === 'responseContainsNextURL' ? { nextURL: next } : { parameters: { parameters: [{ type: 'qs', name: 'pageToken', value: next }] } }), paginationCompleteWhen: 'other', completeExpression: complete, requestInterval: 100 } } });

function centralGmailWorkflow() {
  const auth = gmailAuth;
  const nodes = [
    node('Every 15 seconds', 'scheduleTrigger', 0, 0, { rule: { interval: [{ field: 'seconds', secondsInterval: 15 }] } }),
    node('MAILBOX ID', 'set', 220, 0, { assignments: { assignments: [{ id: 'mailbox-id', name: 'mailbox', value: 'central-gmail', type: 'string' }] }, options: {} }),
    http('Ask worker if due', 440, 0, { method: 'GET', url: `${worker}/due`, ...workerAuth, ...query([['mailbox', '={{ $json.mailbox }}']]) }, workerAuth),
    node('Due?', 'if', 660, 0, condition('={{ $json.due === true && typeof $json.query === "string" && $json.query.length > 0 }}')),
    http('List recent messages', 880, 0, {
      method: 'GET', url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages', ...auth,
      ...query([['q', "={{ $('Ask worker if due').first().json.query }}"], ['maxResults', '100']]),
      options: pagination('updateAParameterInEachRequest', '={{ $response.body.nextPageToken }}', '={{ !$response.body.nextPageToken }}'),
    }, auth),
    node('Page has messages?', 'if', 1100, 0, condition('={{ Array.isArray($json.messages) && $json.messages.length > 0 }}')),
    node('One message per item', 'splitOut', 1320, 0, { fieldToSplitOut: 'messages', include: 'noOtherFields', options: {} }),
    http('Get full message', 1540, 0, {
      method: 'GET', url: '={{ "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent($json.id) }}', ...auth,
      ...query([['format', 'full']]),
    }, auth),
    http('Process in worker', 1760, 0, {
      method: 'POST', url: `${worker}/process`, ...workerAuth, sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ mailbox: $('MAILBOX ID').first().json.mailbox, provider: 'gmail', message: $json }) }}",
    }, workerAuth),
    node('Mark processed?', 'if', 1980, 0, condition('={{ $json.markProcessed === true }}')),
    http('Mark message read', 2200, 0, {
      method: 'POST', url: '={{ "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent($json.messageId) + "/modify" }}', ...auth,
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '{"removeLabelIds":["UNREAD"]}',
    }, auth),
  ];
  const connections = {};
  for (const [from, to] of [['Every 15 seconds', 'MAILBOX ID'], ['MAILBOX ID', 'Ask worker if due'], ['Ask worker if due', 'Due?'], ['Due?', 'List recent messages'], ['List recent messages', 'Page has messages?'], ['Page has messages?', 'One message per item'], ['One message per item', 'Get full message'], ['Get full message', 'Process in worker'], ['Process in worker', 'Mark processed?'], ['Mark processed?', 'Mark message read']]) connect(connections, from, to);
  return { name: 'Steam OTP - central Gmail mailbox', active: false, nodes, connections, settings };
}

function webhookWorkflow() {
  const nodes = [
    node('Steam request webhook', 'webhook', 0, 0, { httpMethod: 'POST', path: 'steam-request', responseMode: 'responseNode', options: { rawBody: true } }, { webhookId: 'fielddesk-steam-request' }),
    http('Forward raw signed request', 260, 0, {
      method: 'POST', url: `${worker}/webhook`, ...workerAuth,
      sendHeaders: true, headerParameters: { parameters: [{ name: 'X-FieldDesk-Signature', value: '={{ $("Steam request webhook").item.json.headers["x-fielddesk-signature"] }}' }] },
      sendBody: true, contentType: 'binaryData', inputDataFieldName: 'data',
      options: { response: { response: { fullResponse: true, neverError: true } } },
    }, workerAuth),
    node('Return worker response', 'respondToWebhook', 520, 0, { respondWith: 'json', responseBody: '={{ JSON.stringify($json.body) }}', options: { responseCode: '={{ $json.statusCode }}' } }),
  ];
  const connections = {};
  connect(connections, 'Steam request webhook', 'Forward raw signed request');
  connect(connections, 'Forward raw signed request', 'Return worker response');
  return { name: 'Steam OTP - signed request webhook', active: false, nodes, connections, settings };
}

function mockDemoWorkflow() {
  const payload = { mimeType: 'text/plain', headers: [
    { name: 'From', value: 'Steam <noreply@steampowered.com>' },
    { name: 'To', value: 'login-alpha@example.invalid' },
    { name: 'Subject', value: 'Your Steam Guard code' },
    { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=steampowered.com' },
    { name: 'Date', value: '{{ new Date().toUTCString() }}' },
  ], body: { data: Buffer.from('Dear store_alpha,\nSteam Guard code is: A1B2C\n').toString('base64url') } };
  const nodes = [
    node('MOCK ONLY - manual trigger', 'manualTrigger', 0, 0, {}, { notes: 'Synthetic demo only. Remove this workflow before production.', notesInFlow: true }),
    http('MOCK ONLY - process synthetic mail', 260, 0, {
      method: 'POST', url: `${worker}/process`, ...workerAuth, sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: '=' + JSON.stringify({ mockOnly: true, mailbox: 'central-gmail', provider: 'gmail', message: {
        id: 'mock-demo-{{ Date.now() }}', internalDate: '{{ String(Date.now()) }}', payload,
      } }),
    }, workerAuth),
  ];
  const connections = {};
  connect(connections, 'MOCK ONLY - manual trigger', 'MOCK ONLY - process synthetic mail');
  return { name: 'MOCK ONLY - Steam OTP synthetic Gmail demo', active: false, nodes, connections, settings };
}

export const workflows = {
  'C-central-gmail.json': centralGmailWorkflow(),
  'steam-request-webhook.json': webhookWorkflow(),
  'C-demo-mock.json': mockDemoWorkflow(),
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(output, { recursive: true });
  for (const legacy of ['gmail-mailbox.json', 'outlook-mailbox.json']) await rm(resolve(output, legacy), { force: true });
  for (const [filename, workflow] of Object.entries(workflows)) await writeFile(resolve(output, filename), `${JSON.stringify(workflow, null, 2)}\n`);
}
