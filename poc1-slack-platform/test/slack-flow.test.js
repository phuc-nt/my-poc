// Drives the Slack handlers with the payload shapes Slack sends, using a fake Web API
// client. Covers everything except the network hop to Slack itself.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSlackHandlers } from '../src/slack/slack-handlers.js';
import { readModalValues, registrationModal } from '../src/slack/registration-modal.js';
import { FIELDS } from '../src/core/registration-fields.js';
import { sampleRegistration, startStack } from './test-helpers.js';

/** `emails`: Slack user ID -> the email users.info returns (absent = no email, as without users:read.email). */
export function fakeClient(emails = {}) {
  const calls = [];
  let ts = 0;
  const record = (name, result = () => ({})) => async (args) => {
    calls.push({ name, args });
    return result(args);
  };
  return {
    calls,
    emails,
    views: { open: record('views.open', () => ({ view: { id: 'V1' } })), update: record('views.update') },
    conversations: { open: record('conversations.open', ({ users }) => ({ channel: { id: `D-${users}` } })) },
    chat: { postMessage: record('chat.postMessage', () => ({ ts: String(++ts) })), update: record('chat.update') },
    files: { uploadV2: record('files.uploadV2') },
    users: {
      info: record('users.info', ({ user }) => ({ ok: true, user: { id: user, profile: emails[user] ? { email: emails[user] } : {} } })),
    },
  };
}

/** Builds view.state.values the way Slack reports each input type. */
export function submittedView(registration) {
  const values = {};
  for (const { key, type, options } of FIELDS) {
    const value = registration[key];
    const picked = (value || '').split(',').filter(Boolean).map((v) => ({ value: v }));
    const state = {
      date: { selected_date: value || null },
      time: { selected_time: value || null },
      choice: { selected_option: value ? { value } : null },
      multi: { selected_options: picked },
      flag: { selected_options: picked },
    }[type] ?? { value: value || null };
    values[key] = { value: { type: options ? 'select' : 'input', ...state } };
  }
  return { state: { values } };
}

export const acker = () => {
  const acks = [];
  return { acks, ack: async (payload) => acks.push(payload) };
};

test('slash command with text pre-fills the modal from the parser', async () => {
  const client = fakeClient();
  const handlers = createSlackHandlers({ service: {}, parseRequest: async () => ({ visitorName: 'Tran Thi Mai', building: 'tower-a' }) });
  await handlers.onCommand({ ...acker(), command: { text: 'register Mai at tower A', trigger_id: 'T1' }, client });

  const update = client.calls.find((c) => c.name === 'views.update');
  assert.equal(update.args.view_id, 'V1');
  const blocks = update.args.view.blocks;
  assert.equal(blocks.find((b) => b.block_id === 'visitorName').element.initial_value, 'Tran Thi Mai');
  assert.equal(blocks.find((b) => b.block_id === 'building').element.initial_option.value, 'tower-a');
});

test('every field type is pre-filled and read back from the modal unchanged', () => {
  const registration = sampleRegistration();
  const element = (key) => registrationModal(registration).blocks.find((b) => b.block_id === key).element;
  assert.equal(element('visitorType').type, 'radio_buttons');
  assert.equal(element('visitorType').initial_option.value, 'contractor');
  assert.deepEqual(element('equipment').initial_options.map((o) => o.value), ['laptop', 'tools']);
  assert.equal(element('parking').initial_options.length, 1);
  assert.equal(element('floor').initial_value, '12');
  assert.equal(registrationModal().blocks.find((b) => b.block_id === 'equipment').element.initial_options, undefined);
  assert.deepEqual(readModalValues(submittedView(registration)), registration);
});

test('slash command without text opens an empty modal', async () => {
  const client = fakeClient();
  await createSlackHandlers({ service: {} }).onCommand({ ...acker(), command: { text: '', trigger_id: 'T1' }, client });
  assert.deepEqual(client.calls[0].args.view, registrationModal());
});

test('invalid modal input is returned to Slack as field errors', async () => {
  const client = fakeClient();
  const { acks, ack } = acker();
  await createSlackHandlers({ service: {} }).onModalSubmit({
    ack, client, body: { user: { id: 'U1' } }, view: submittedView(sampleRegistration({ hostName: '', endTime: '13:00' })),
  });
  assert.equal(acks[0].response_action, 'errors');
  assert.deepEqual(Object.keys(acks[0].errors).sort(), ['endTime', 'hostName']);
  assert.equal(client.calls.length, 0);
});


// ---- Two paths, chosen by the requester's email domain ----

import { RequestFlow } from '../src/core/request-flow.js';
import { createUserClassifier } from '../src/slack/user-classifier.js';
import { createLogger } from '../src/core/logger.js';

const INTERNAL = 'U-IN';
const EXTERNAL = 'U-EX';
const APPROVER = 'U-AP';
const NO_EMAIL = 'U-NOMAIL';
const EMAILS = { [INTERNAL]: 'staff@corp.example', [EXTERNAL]: 'partner@vendor.example', [APPROVER]: 'boss@corp.example' };
const TEST_CHANNEL = 'C-TEST';

/** A stack, a flow with one approver, handlers with classification on, and the log lines. */
async function twoPathStack({ approvalTtlMs } = {}) {
  const stack = await startStack();
  const lines = [];
  const logger = createLogger((line) => lines.push(line));
  const client = fakeClient({ ...EMAILS });
  const channelReplies = [];
  let handlers;
  const flow = new RequestFlow({
    service: stack.service, approvers: [APPROVER], approvalTtlMs, logger, onExpire: (r) => handlers.onRequestExpired(r, client),
  });
  handlers = createSlackHandlers({
    service: stack.service, flow, logger, allowedChannels: [TEST_CHANNEL],
    classifyUser: createUserClassifier({ internalDomains: ['corp.example'] }),
    replyInChannel: async (url, text) => channelReplies.push(text),
  });
  return { ...stack, flow, handlers, client, lines, channelReplies, stop: async () => { flow.shutdown(); await stack.stop(); } };
}

const posts = (client, channel) => client.calls.filter((c) => c.name === 'chat.postMessage' && (!channel || c.args.channel === channel));
const buttonsOf = (message) => Object.fromEntries(message.args.blocks.at(-1).elements.map((e) => [e.action_id, e.value]));
const click = (user, value, replies = []) => ({
  ...acker(), respond: async (m) => replies.push(m), body: { user: { id: user }, trigger_id: 'T9' }, action: { value },
});
const command = (user, channel = TEST_CHANNEL) => ({ ...acker(), command: { user_id: user, channel_id: channel, text: '', trigger_id: 'T1', response_url: 'https://hooks.example/r' } });

async function submitForm(t, user, registration = sampleRegistration(), metadata) {
  await t.handlers.onModalSubmit({
    ...acker(), client: t.client, body: { user: { id: user } },
    view: { ...submittedView(registration), ...(metadata && { private_metadata: metadata }) },
  });
}

test('the command works only in the allowed channel', async () => {
  const t = await twoPathStack();
  try {
    await t.handlers.onCommand({ ...command(INTERNAL, 'C-OTHER'), client: t.client });
    assert.equal(t.client.calls.filter((c) => c.name === 'views.open').length, 0);
    assert.match(t.channelReplies[0], /only in <#C-TEST>/);
    await t.handlers.onCommand({ ...command(INTERNAL), client: t.client });
    assert.equal(t.client.calls.filter((c) => c.name === 'views.open').length, 1);
  } finally {
    await t.stop();
  }
});

test('a user without an email gets no form and nothing is created (fail-safe)', async () => {
  const t = await twoPathStack();
  try {
    await t.handlers.onCommand({ ...command(NO_EMAIL), client: t.client });
    assert.equal(t.client.calls.filter((c) => c.name === 'views.open').length, 0);
    assert.match(t.channelReplies[0], /could not confirm/);
    // Even a form submitted anyway (an old modal) does not become a request.
    await submitForm(t, NO_EMAIL);
    assert.equal(t.flow.requests.size, 0);
    assert.match(posts(t.client).at(-1).args.text, /could not confirm/);
    assert.ok(t.lines.some((l) => l.includes('user_unclassified')));
  } finally {
    await t.stop();
  }
});

test('path 1: an internal requester sees a text summary, and only their Send submits, once', async () => {
  const t = await twoPathStack();
  try {
    await submitForm(t, INTERNAL, sampleRegistration(), JSON.stringify({ responseUrl: 'https://hooks.example/r' }));
    const summary = posts(t.client, `D-${INTERNAL}`).at(-1);
    assert.match(summary.args.blocks[0].text.text, /not sent yet/);
    assert.equal(t.client.calls.filter((c) => c.name === 'files.uploadV2').length, 0, 'text only, no file');
    assert.equal(posts(t.client, `D-${APPROVER}`).length, 0, 'no approver involved');
    assert.equal(t.portal.submissions.length, 0, 'nothing reaches the portal before Send');
    assert.match(t.channelReplies.at(-1), /direct message/);
    assert.ok(!t.channelReplies.at(-1).includes(sampleRegistration().visitorName), 'the channel gets a pointer, not the details');
    const { confirm_request: send } = buttonsOf(summary);

    const replies = [];
    await t.handlers.onConfirm({ ...click(EXTERNAL, send, replies), client: t.client });
    await t.handlers.onConfirm({ ...click(APPROVER, send, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 0, 'nobody else can send it, not even an approver');

    await t.handlers.onConfirm({ ...click(INTERNAL, send, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 1);
    assert.match(replies.at(-1).text, new RegExp(t.portal.submissions[0].referenceCode));

    await t.handlers.onConfirm({ ...click(INTERNAL, send, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 1, 'a second press does not submit again');
    assert.match(replies.at(-1).text, /no longer open/);
  } finally {
    await t.stop();
  }
});

test('path 1: two presses at the same moment submit once', async () => {
  const t = await twoPathStack();
  try {
    await submitForm(t, INTERNAL);
    const { confirm_request: send } = buttonsOf(posts(t.client, `D-${INTERNAL}`).at(-1));
    await Promise.all([
      t.handlers.onConfirm({ ...click(INTERNAL, send), client: t.client }),
      t.handlers.onConfirm({ ...click(INTERNAL, send), client: t.client }),
    ]);
    assert.equal(t.portal.submissions.length, 1);
  } finally {
    await t.stop();
  }
});

test('path 1: Edit makes a new version; the old Send button no longer works', async () => {
  const t = await twoPathStack();
  try {
    const registration = sampleRegistration();
    await submitForm(t, INTERNAL, registration);
    const first = buttonsOf(posts(t.client, `D-${INTERNAL}`).at(-1));
    await t.handlers.onEdit({ ...click(INTERNAL, first.edit_request), client: t.client });
    const modal = t.client.calls.findLast((c) => c.name === 'views.open').args.view;
    assert.equal(modal.blocks.find((b) => b.block_id === 'visitorName').element.initial_value, registration.visitorName);

    await submitForm(t, INTERNAL, { ...registration, endTime: '16:45' }, modal.private_metadata);
    const second = buttonsOf(posts(t.client, `D-${INTERNAL}`).at(-1));
    assert.match(second.confirm_request, /:2$/);
    assert.ok(t.client.calls.some((c) => c.name === 'chat.update' && /Replaced by version 2/.test(c.args.text)));

    const replies = [];
    await t.handlers.onConfirm({ ...click(INTERNAL, first.confirm_request, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 0);
    assert.match(replies.at(-1).text, /version 1/);
    await t.handlers.onConfirm({ ...click(INTERNAL, second.confirm_request, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 1);
    assert.equal(t.portal.submissions[0].endTime, '16:45');
  } finally {
    await t.stop();
  }
});

test('path 1: Cancel stops the request and nothing is submitted', async () => {
  const t = await twoPathStack();
  try {
    await submitForm(t, INTERNAL);
    const buttons = buttonsOf(posts(t.client, `D-${INTERNAL}`).at(-1));
    const replies = [];
    await t.handlers.onCancel({ ...click(INTERNAL, buttons.cancel_request, replies), client: t.client });
    assert.match(replies[0].text, /cancelled/);
    await t.handlers.onConfirm({ ...click(INTERNAL, buttons.confirm_request, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 0);
  } finally {
    await t.stop();
  }
});

test('Send checks the requester again: a user no longer internal cannot send', async () => {
  const t = await twoPathStack();
  try {
    await submitForm(t, INTERNAL);
    const { confirm_request: send } = buttonsOf(posts(t.client, `D-${INTERNAL}`).at(-1));
    t.client.emails[INTERNAL] = 'staff@elsewhere.example';
    const replies = [];
    await t.handlers.onConfirm({ ...click(INTERNAL, send, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 0);
    assert.match(replies[0].text, /no longer recognised as internal/);
  } finally {
    await t.stop();
  }
});

test('path 2: an external request waits for the approver; only the approver can approve', async () => {
  const t = await twoPathStack();
  try {
    await submitForm(t, EXTERNAL);
    const waiting = posts(t.client, `D-${EXTERNAL}`).at(-1);
    assert.match(waiting.args.blocks[0].text.text, /waiting for approval/);
    assert.deepEqual(Object.keys(buttonsOf(waiting)).sort(), ['cancel_request', 'edit_request'], 'the requester cannot send it');
    const ask = posts(t.client, `D-${APPROVER}`).at(-1);
    assert.match(ask.args.blocks[0].text.text, new RegExp(`<@${EXTERNAL}>`));
    assert.match(ask.args.blocks[0].text.text, /\d{4}-\d{2}-\d{2}T/, 'shows when it was made');
    const { approve_request: approve } = buttonsOf(ask);

    const replies = [];
    await t.handlers.onApprove({ ...click(EXTERNAL, approve, replies), client: t.client });
    await t.handlers.onApprove({ ...click(INTERNAL, approve, replies), client: t.client });
    await t.handlers.onConfirm({ ...click(EXTERNAL, approve, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 0, 'not the requester, not another internal user, not via Send');

    await t.handlers.onApprove({ ...click(APPROVER, approve, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 1);
    const requesterUpdate = t.client.calls.findLast((c) => c.name === 'chat.update' && c.args.channel === `D-${EXTERNAL}`);
    assert.match(requesterUpdate.args.text, new RegExp(`approved by <@${APPROVER}>.*${t.portal.submissions[0].referenceCode}`));

    await t.handlers.onApprove({ ...click(APPROVER, approve, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 1, 'a second approval does not submit again');
    const submitted = t.lines.map((l) => JSON.parse(l)).find((l) => l.event === 'request_submitted');
    assert.equal(submitted.decidedBy, APPROVER);
    assert.equal(submitted.requestedBy, EXTERNAL);
  } finally {
    await t.stop();
  }
});

test('path 2: Reject asks for a reason, submits nothing and tells the requester why', async () => {
  const t = await twoPathStack();
  try {
    await submitForm(t, EXTERNAL);
    const { approve_request: approve, reject_request: reject } = buttonsOf(posts(t.client, `D-${APPROVER}`).at(-1));
    const replies = [];
    await t.handlers.onReject({ ...click(EXTERNAL, reject, replies), client: t.client });
    assert.match(replies[0].text, /Only a designated approver/);

    await t.handlers.onReject({ ...click(APPROVER, reject, replies), client: t.client });
    const modal = t.client.calls.findLast((c) => c.name === 'views.open').args.view;
    const view = { private_metadata: modal.private_metadata, state: { values: { reason: { value: { value: 'Visit date not agreed' } } } } };
    await t.handlers.onRejectSubmit({ ...acker(), client: t.client, body: { user: { id: APPROVER } }, view });

    const toRequester = t.client.calls.findLast((c) => c.name === 'chat.update' && c.args.channel === `D-${EXTERNAL}`);
    assert.match(toRequester.args.text, /rejected.*Reason: Visit date not agreed/);
    await t.handlers.onApprove({ ...click(APPROVER, approve, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 0);
    const rejected = t.lines.map((l) => JSON.parse(l)).find((l) => l.event === 'request_rejected');
    assert.equal(rejected.reason, 'Visit date not agreed');
  } finally {
    await t.stop();
  }
});

test('path 2: an edit while waiting voids the earlier approval request and asks again', async () => {
  const t = await twoPathStack();
  try {
    const registration = sampleRegistration();
    await submitForm(t, EXTERNAL, registration);
    const first = buttonsOf(posts(t.client, `D-${APPROVER}`).at(-1));
    const { edit_request: edit } = buttonsOf(posts(t.client, `D-${EXTERNAL}`).at(-1));
    await t.handlers.onEdit({ ...click(EXTERNAL, edit), client: t.client });
    const modal = t.client.calls.findLast((c) => c.name === 'views.open').args.view;
    await submitForm(t, EXTERNAL, { ...registration, purpose: 'Changed purpose' }, modal.private_metadata);

    assert.ok(t.client.calls.some((c) => c.name === 'chat.update' && c.args.channel === `D-${APPROVER}` && /can no longer be approved/.test(c.args.text)));
    const second = buttonsOf(posts(t.client, `D-${APPROVER}`).at(-1));
    const replies = [];
    await t.handlers.onApprove({ ...click(APPROVER, first.approve_request, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 0, 'approval of version 1 does not submit version 2');
    await t.handlers.onApprove({ ...click(APPROVER, second.approve_request, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 1);
    assert.equal(t.portal.submissions[0].purpose, 'Changed purpose');
  } finally {
    await t.stop();
  }
});

test('path 2: no answer in time expires the request; both sides are told and nothing is submitted', async () => {
  const t = await twoPathStack({ approvalTtlMs: 50 });
  try {
    await submitForm(t, EXTERNAL);
    const { approve_request: approve } = buttonsOf(posts(t.client, `D-${APPROVER}`).at(-1));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const updates = t.client.calls.filter((c) => c.name === 'chat.update').map((c) => c.args.text);
    assert.ok(updates.some((text) => /No approver answered in time/.test(text)));
    assert.ok(updates.some((text) => /expired without a decision/.test(text)));
    const replies = [];
    await t.handlers.onApprove({ ...click(APPROVER, approve, replies), client: t.client });
    assert.equal(t.portal.submissions.length, 0);
    assert.match(replies[0].text, /no longer open/);
  } finally {
    await t.stop();
  }
});

test('the email is used to classify, and never appears in the log', async () => {
  const t = await twoPathStack();
  try {
    await submitForm(t, EXTERNAL);
    const { approve_request: approve } = buttonsOf(posts(t.client, `D-${APPROVER}`).at(-1));
    await t.handlers.onApprove({ ...click(APPROVER, approve), client: t.client });
    await t.handlers.onCommand({ ...command(NO_EMAIL), client: t.client });
    assert.ok(t.lines.length > 3);
    for (const email of Object.values(EMAILS)) assert.ok(!t.lines.join('\n').includes(email), `log must not contain ${email}`);
    assert.ok(!t.lines.join('\n').includes('@corp.example') && !t.lines.join('\n').includes('vendor.example'));
  } finally {
    await t.stop();
  }
});

test('with classification on, the global shortcut points to the command instead of opening the form', async () => {
  const t = await twoPathStack();
  try {
    await t.handlers.onShortcut({ ...acker(), shortcut: { trigger_id: 'T1' }, client: t.client });
    const view = t.client.calls.at(-1).args.view;
    assert.equal(view.callback_id, undefined);
    assert.match(view.blocks[0].text.text, /\/visitor/);
  } finally {
    await t.stop();
  }
});
