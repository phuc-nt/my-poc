// Builds the Slack modal and reads it back. block_id of every input is the field key,
// so validation errors can be returned to Slack keyed the same way.

import { displayValue, FIELDS } from '../core/registration-fields.js';

export const MODAL_CALLBACK_ID = 'visitor_registration';
const plain = (text) => ({ type: 'plain_text', text });

const option = (o) => ({ text: plain(o.label), value: o.value });
const FLAG_OPTION = { text: plain('Yes'), value: 'yes' };

/** One Slack input element per field type, with the pre-filled value when there is one. */
function element({ type, options }, value) {
  const base = { action_id: 'value' };
  const chosen = (value || '').split(',').filter(Boolean);
  switch (type) {
    case 'date':
      return { ...base, type: 'datepicker', ...(value && { initial_date: value }) };
    case 'time':
      return { ...base, type: 'timepicker', ...(value && { initial_time: value }) };
    case 'choice':
      return {
        ...base,
        type: options.length <= 4 && options[0].floors === undefined ? 'radio_buttons' : 'static_select',
        options: options.map(option),
        ...(value && { initial_option: option(options.find((o) => o.value === value)) }),
      };
    case 'multi':
      return {
        ...base,
        type: 'checkboxes',
        options: options.map(option),
        ...(chosen.length && { initial_options: options.filter((o) => chosen.includes(o.value)).map(option) }),
      };
    case 'flag':
      return { ...base, type: 'checkboxes', options: [FLAG_OPTION], ...(value && { initial_options: [FLAG_OPTION] }) };
    case 'number':
      return { ...base, type: 'number_input', is_decimal_allowed: false, min_value: '1', ...(value && { initial_value: value }) };
    default:
      return { ...base, type: 'plain_text_input', multiline: type !== 'text', ...(value && { initial_value: value }) };
  }
}

/**
 * `context` rides along in the modal and comes back on submit:
 *   responseUrl - the slash command's reply address, to answer in the same channel
 *   replaces    - { requestId } of the open request this modal edits
 */
export function registrationModal(prefill = {}, note = '', context = {}) {
  const metadata = JSON.stringify(context);
  return {
    type: 'modal',
    callback_id: MODAL_CALLBACK_ID,
    ...(metadata !== '{}' && { private_metadata: metadata }),
    title: plain('Visitor registration'),
    submit: plain('Fill the form'),
    close: plain('Cancel'),
    blocks: [
      ...(note ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: note }] }] : []),
      ...FIELDS.map((field) => ({
        type: 'input',
        block_id: field.key,
        optional: !field.required,
        label: plain(field.label),
        ...(field.hint && { hint: plain(field.hint) }),
        element: element(field, prefill[field.key]),
      })),
    ],
  };
}

export function loadingModal() {
  return {
    type: 'modal',
    title: plain('Visitor registration'),
    close: plain('Cancel'),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Reading your request…' } }],
  };
}

export function readModalContext(view) {
  return view.private_metadata ? JSON.parse(view.private_metadata) : {};
}

export function readModalValues(view) {
  const out = {};
  for (const { key } of FIELDS) {
    const state = view.state.values[key]?.value ?? {};
    out[key] = state.value ?? state.selected_date ?? state.selected_time ?? state.selected_option?.value
      ?? state.selected_options?.map((o) => o.value).join(',') ?? '';
  }
  return out;
}

export function summaryText(registration) {
  return FIELDS.map(({ key, label }) => `*${label}:* ${displayValue(key, registration) || '—'}`).join('\n');
}

/** Value carried by every request button: which request, and which version of it was shown. */
export const buttonValue = (request) => `${request.id}:${request.version}`;
export function readButtonValue(value) {
  const [id, version] = String(value).split(':');
  return { id, version: Number(version) };
}

const button = (action_id, text, request, style) => ({
  type: 'button', action_id, text: plain(text), value: buttonValue(request), ...(style && { style }),
});
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const versionNote = (request) => (request.version > 1 ? ` (version ${request.version})` : '');

/** Internal requester: the text summary and the final Send. Nothing has reached the portal yet. */
export function confirmationBlocks(request) {
  return [
    section(`Check the request${versionNote(request)}. It is *not sent yet*; it goes to the portal only when you press *Send*.\n\n${summaryText(request.registration)}`),
    { type: 'actions', elements: [
      button('confirm_request', 'Send', request, 'primary'),
      button('edit_request', 'Edit', request),
      button('cancel_request', 'Cancel', request, 'danger'),
    ] },
  ];
}

/** External requester: the request waits for an approver; the requester can still edit or cancel. */
export function waitingBlocks(request) {
  return [
    section(`Your request${versionNote(request)} is *waiting for approval*. Nothing is sent to the portal until an approver approves it.\n\n${summaryText(request.registration)}`),
    { type: 'actions', elements: [button('edit_request', 'Edit', request), button('cancel_request', 'Cancel', request, 'danger')] },
  ];
}

/** Approver: the request, who made it and when, and Approve / Reject. */
export function approverBlocks(request) {
  return [
    section(`*Approval needed*${versionNote(request)}\nRequested by <@${request.requestedBy}> (outside the internal domain) at ${request.createdAt}.\n\n${summaryText(request.registration)}`),
    { type: 'actions', elements: [
      button('approve_request', 'Approve', request, 'primary'),
      button('reject_request', 'Reject', request, 'danger'),
    ] },
  ];
}

export const REJECT_CALLBACK_ID = 'reject_request_reason';

/** Asks the approver for a reason; `context` comes back on submit. */
export function rejectReasonModal(context) {
  return {
    type: 'modal',
    callback_id: REJECT_CALLBACK_ID,
    private_metadata: JSON.stringify(context),
    title: plain('Reject request'),
    submit: plain('Reject'),
    close: plain('Back'),
    blocks: [{
      type: 'input', block_id: 'reason', optional: true, label: plain('Reason, sent to the requester'),
      element: { type: 'plain_text_input', action_id: 'value', multiline: true },
    }],
  };
}

/** Shown instead of the form when the command cannot be used. */
export function noticeModal(text) {
  return { type: 'modal', title: plain('Visitor registration'), close: plain('Close'), blocks: [section(text)] };
}
