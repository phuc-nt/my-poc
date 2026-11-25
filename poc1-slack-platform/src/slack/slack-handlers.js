// Slack listeners. Each handler takes Bolt's argument object, which keeps them callable
// from tests with a fake client.
//
// Visitor registration follows two paths (see src/core/request-flow.js):
//   internal requester -> text summary -> Send -> portal
//   external requester -> designated approver -> Approve -> portal
// Who is internal is decided from the email domain Slack returns for the user, checked
// again at every step that can lead to a submit. Requests start only from the slash
// command, typed in one of the allowed channels.

import { validate } from '../core/registration-fields.js';
import { silentLogger } from '../core/logger.js';
import { RequestFlow } from '../core/request-flow.js';
import {
  approverBlocks, confirmationBlocks, loadingModal, MODAL_CALLBACK_ID, noticeModal, readButtonValue, readModalContext,
  readModalValues, registrationModal, REJECT_CALLBACK_ID, rejectReasonModal, summaryText, waitingBlocks,
} from './registration-modal.js';

/** Answers in the channel where the slash command was typed, visible to the requester only. */
async function postEphemeralReply(responseUrl, text) {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
  });
}

const NOT_CLASSIFIED = 'I could not confirm which group your Slack account belongs to (no email address was available), '
  + 'so this request cannot go further. Nothing was sent. Contact the bot owner if this looks wrong.';

/**
 * classifyUser    - (client, userId) => { userClass: internal | external | unknown }; null = everyone is internal
 * allowedChannels - channel IDs where the command works; empty = any channel
 */
export function createSlackHandlers({
  service, flow = new RequestFlow({ service }), classifyUser = null, allowedChannels = [],
  parseRequest = null, reporter = null, reportChannel = '', logger = silentLogger, replyInChannel = postEphemeralReply,
}) {
  const messages = new Map(); // requestId -> { requester: {channel, ts}, approvers: [{channel, ts}] }
  const commandOnly = Boolean(classifyUser) || allowedChannels.length > 0;

  async function userClassOf(client, userId) {
    if (!classifyUser) return 'internal';
    const result = await classifyUser(client, userId);
    if (result.userClass === 'unknown') logger.warn('user_unclassified', { user: userId, reason: result.reason });
    return result.userClass;
  }

  async function dm(client, userId) {
    const { channel } = await client.conversations.open({ users: userId });
    return channel.id;
  }

  /** Replaces a posted message's text and removes its buttons. Failing to do so is not fatal. */
  async function retire(client, message, text) {
    if (!message) return;
    await client.chat.update({ channel: message.channel, ts: message.ts, text, blocks: [] })
      .catch((error) => logger.warn('message_update_failed', { message: error.message }));
  }

  /** Sends the request to its requester (and, when it needs approval, to every approver). */
  async function announce(client, request) {
    const requesterChannel = await dm(client, request.requestedBy);
    const internal = request.userClass === 'internal';
    const posted = await client.chat.postMessage({
      channel: requesterChannel,
      text: internal ? 'Check your request and press Send.' : 'Your request is waiting for approval.',
      blocks: internal ? confirmationBlocks(request) : waitingBlocks(request),
    });
    const record = { requester: { channel: requesterChannel, ts: posted.ts }, approvers: [] };
    if (!internal) {
      for (const approver of flow.approvers) {
        const channel = await dm(client, approver);
        const sent = await client.chat.postMessage({ channel, text: 'A visitor registration needs your approval.', blocks: approverBlocks(request) });
        record.approvers.push({ channel, ts: sent.ts });
      }
    }
    messages.set(request.id, record);
  }

  async function retireApproverMessages(client, requestId, text) {
    for (const message of messages.get(requestId)?.approvers ?? []) await retire(client, message, text);
  }

  async function notifyRequester(client, request, text) {
    const channel = messages.get(request.id)?.requester.channel ?? await dm(client, request.requestedBy);
    await client.chat.postMessage({ channel, text });
  }

  /** `/visitor` opens the form; `/visitor <free text>` pre-fills it with the LLM's reading. */
  async function onCommand({ ack, command, client }) {
    await ack();
    if (allowedChannels.length && !allowedChannels.includes(command.channel_id)) {
      await replyInChannel(command.response_url, `This command works only in ${allowedChannels.map((c) => `<#${c}>`).join(', ')}.`);
      return;
    }
    // The trigger_id below is valid for 3 seconds; users.info usually answers well within it.
    if (await userClassOf(client, command.user_id) === 'unknown') {
      await replyInChannel(command.response_url, NOT_CLASSIFIED);
      return;
    }
    const text = (command.text || '').trim();
    const context = { responseUrl: command.response_url };
    if (!text || !parseRequest) {
      await client.views.open({ trigger_id: command.trigger_id, view: registrationModal({}, '', context) });
      return;
    }
    // trigger_id expires in 3 seconds, so open first and fill in after the LLM answers.
    const opened = await client.views.open({ trigger_id: command.trigger_id, view: loadingModal() });
    let prefill = {};
    let note = 'Pre-filled from your message. Check every field before continuing.';
    try {
      prefill = await parseRequest(text);
    } catch (error) {
      logger.warn('prefill_failed', { message: error.message });
      note = 'Could not read your message automatically. Please fill in the form.';
    }
    await client.views.update({ view_id: opened.view.id, view: registrationModal(prefill, note, context) });
  }

  async function onShortcut({ ack, shortcut, client }) {
    await ack();
    const view = commandOnly ? noticeModal('Start a registration with the `/visitor` command in the agreed channel.') : registrationModal();
    await client.views.open({ trigger_id: shortcut.trigger_id, view });
  }

  async function onModalSubmit({ ack, body, view, client }) {
    const registration = readModalValues(view);
    const errors = validate(registration);
    if (Object.keys(errors).length) {
      await ack({ response_action: 'errors', errors });
      return;
    }
    await ack();

    const user = body.user.id;
    const { responseUrl, replaces } = readModalContext(view);
    const userClass = await userClassOf(client, user);
    if (userClass === 'unknown') {
      await client.chat.postMessage({ channel: await dm(client, user), text: NOT_CLASSIFIED });
      return;
    }
    let request;
    try {
      if (replaces) {
        // A new version of the same request. Buttons on the earlier version stop working.
        request = flow.edit(replaces.requestId, user, registration);
        const previous = messages.get(request.id);
        await retire(client, previous?.requester, `Replaced by version ${request.version} of this request. Nothing was sent from this one.`);
        await retireApproverMessages(client, request.id, `The requester edited this request; version ${request.version} follows. This one can no longer be approved.`);
      } else {
        request = flow.create({ requestedBy: user, userClass, registration });
      }
      await announce(client, request);
    } catch (error) {
      logger.warn('request_not_created', { code: error.code, message: error.message });
      await client.chat.postMessage({ channel: await dm(client, user), text: `Your request was not saved: ${error.message}` });
      return;
    }
    // Visitor details stay in direct messages; the channel only gets a pointer.
    if (responseUrl) {
      const where = request.userClass === 'internal' ? 'Check it in our direct message and press Send' : 'It is waiting for approval; I will tell you the result by direct message';
      await replyInChannel(responseUrl, `Request received. ${where}.`)
        .catch((error) => logger.warn('channel_reply_failed', { message: error.message }));
    }
  }

  /** Internal path, step 5A: the requester's Send. */
  async function onConfirm({ ack, body, action, respond, client }) {
    await ack();
    const { id, version } = readButtonValue(action.value);
    try {
      // Checked again at the moment of sending: the account may have changed since the form.
      if (await userClassOf(client, body.user.id) !== 'internal') {
        throw new Error('your account is no longer recognised as internal, so this request cannot be sent');
      }
      const sending = flow.confirm(id, version, body.user.id);
      await respond({ replace_original: true, text: 'Sending to the portal…' });
      const request = await sending;
      await respond({ replace_original: true, text: `Registration submitted. Reference code: *${request.referenceCode}*\n\n${summaryText(request.registration)}` });
    } catch (error) {
      const request = flow.get(id);
      const text = request?.state === 'failed' ? `Could not submit: ${error.message}. Nothing was registered; start again with /visitor.` : `Could not send: ${error.message}`;
      await respond({ replace_original: request?.state === 'failed', text });
    }
  }

  /** Reopens the form with the open request's data; saving it makes a new version. */
  async function onEdit({ ack, body, action, client, respond }) {
    await ack();
    const { id } = readButtonValue(action.value);
    try {
      const request = flow.view(id, body.user.id);
      if (request.requestedBy !== body.user.id) throw new Error('Only the person who made the request can edit it');
      const note = request.userClass === 'internal'
        ? 'Editing your request. Saving makes a new version for you to check and send.'
        : 'Editing your request. Saving makes a new version, and it needs approval again.';
      await client.views.open({ trigger_id: body.trigger_id, view: registrationModal(request.registration, note, { replaces: { requestId: id } }) });
    } catch (error) {
      await respond({ replace_original: false, text: `Could not edit: ${error.message}` });
    }
  }

  async function onCancel({ ack, body, action, respond, client }) {
    await ack();
    const { id } = readButtonValue(action.value);
    try {
      flow.cancel(id, body.user.id);
      await respond({ replace_original: true, text: 'Request cancelled. Nothing was submitted.' });
      await retireApproverMessages(client, id, 'The requester cancelled this request. Nothing was submitted.');
    } catch (error) {
      await respond({ replace_original: false, text: `Could not cancel: ${error.message}` });
    }
  }

  /** External path, step 4A: a designated approver's Approve. */
  async function onApprove({ ack, body, action, respond, client }) {
    await ack();
    const { id, version } = readButtonValue(action.value);
    const approver = body.user.id;
    try {
      const approving = flow.approve(id, version, approver);
      await respond({ replace_original: true, text: 'Approved. Sending to the portal…' });
      const request = await approving;
      const done = `Approved by <@${approver}> and submitted. Reference code: *${request.referenceCode}*`;
      await retireApproverMessages(client, id, done);
      await retire(client, messages.get(id)?.requester, `Your request was approved by <@${approver}> and submitted. Reference code: *${request.referenceCode}*\n\n${summaryText(request.registration)}`);
    } catch (error) {
      const request = flow.get(id);
      if (request?.state === 'failed') {
        const text = `Approved by <@${approver}>, but the portal did not accept it: ${error.message}. Nothing was registered.`;
        await retireApproverMessages(client, id, text);
        await notifyRequester(client, request, text);
        return;
      }
      await respond({ replace_original: false, text: `Could not approve: ${error.message}` });
    }
  }

  /** External path, step 4B: Reject asks for a reason first. */
  async function onReject({ ack, body, action, respond, client }) {
    await ack();
    const { id, version } = readButtonValue(action.value);
    try {
      const request = flow.view(id, body.user.id);
      if (!flow.isApprover(body.user.id)) throw new Error('Only a designated approver can reject this request');
      if (request.version !== version) throw new Error(`This button belongs to version ${version}; the request has been edited since`);
      await client.views.open({ trigger_id: body.trigger_id, view: rejectReasonModal({ id, version }) });
    } catch (error) {
      await respond({ replace_original: false, text: `Could not reject: ${error.message}` });
    }
  }

  async function onRejectSubmit({ ack, body, view, client }) {
    await ack();
    const { id, version } = readModalContext(view);
    const reason = view.state.values.reason?.value?.value || '';
    try {
      const request = flow.reject(id, version, body.user.id, reason);
      const why = reason ? ` Reason: ${reason}` : '';
      await retireApproverMessages(client, id, `Rejected by <@${body.user.id}>. Nothing was submitted.${why}`);
      await retire(client, messages.get(id)?.requester, `Your request was rejected by <@${body.user.id}>. Nothing was submitted.${why}`);
      if (!messages.get(id)) await notifyRequester(client, request, `Your request was rejected. Nothing was submitted.${why}`);
    } catch (error) {
      await client.chat.postMessage({ channel: await dm(client, body.user.id), text: `Could not reject: ${error.message}` });
    }
  }

  /** Called by the flow when a request waited too long: no submit, and both sides are told. */
  async function onRequestExpired(request, client) {
    const text = request.userClass === 'internal'
      ? 'This request expired before it was sent. Nothing was submitted.'
      : 'No approver answered in time, so this request expired. Nothing was submitted.';
    await retire(client, messages.get(request.id)?.requester, text);
    await retireApproverMessages(client, request.id, 'This request expired without a decision. Nothing was submitted.');
  }

  /** `/daily-report [YYYY-MM-DD]`: the report goes to the report channel; the requester only gets a pointer. */
  async function onReportCommand({ ack, command, respond }) {
    await ack();
    const reply = (text) => respond({ response_type: 'ephemeral', text });
    if (!reporter) {
      await reply('The daily report is not configured on this app.');
      return;
    }
    const date = (command.text || '').trim() || undefined;
    await reply(`Writing the daily report${date ? ` for ${date}` : ''}…`);
    try {
      const report = await reporter.post(date);
      await reply(`Daily report for ${report.date} posted in <#${reportChannel}>.`);
    } catch (error) {
      logger.error('daily_report_failed', { message: error.message });
      await reply(`Could not write the daily report: ${error.message}`);
    }
  }

  return {
    onCommand, onShortcut, onModalSubmit, onConfirm, onEdit, onCancel, onApprove, onReject, onRejectSubmit, onRequestExpired, onReportCommand,
  };
}

export function registerSlackHandlers(app, handlers) {
  app.command('/visitor', handlers.onCommand);
  app.command('/daily-report', handlers.onReportCommand);
  app.shortcut('register_visitor', handlers.onShortcut);
  app.view(MODAL_CALLBACK_ID, handlers.onModalSubmit);
  app.view(REJECT_CALLBACK_ID, handlers.onRejectSubmit);
  app.action('confirm_request', handlers.onConfirm);
  app.action('edit_request', handlers.onEdit);
  app.action('cancel_request', handlers.onCancel);
  app.action('approve_request', handlers.onApprove);
  app.action('reject_request', handlers.onReject);
}
