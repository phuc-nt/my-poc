// Two paths to the portal, chosen by who makes the request:
//   internal requester: fills the form -> reads the text summary -> presses Send -> submit
//   external requester: fills the form -> a designated approver presses Approve -> submit
// Nothing reaches the portal before that last step. The browser then fills the form,
// checks the confirmation screen against the request and submits, all in one go, so no
// browser is held open while a person decides (an approval can take hours).

import crypto from 'node:crypto';
import { normalize, validate } from './registration-fields.js';
import { silentLogger } from './logger.js';
import { RegistrationError } from './registration-service.js';

export const OPEN_STATES = ['awaiting_confirmation', 'awaiting_approval'];

export class RequestFlow {
  /**
   * service       - RegistrationService: fills, checks and submits the portal form
   * approvers     - Slack user IDs allowed to approve external requests
   * confirmTtlMs  - how long an internal request waits for its requester's Send
   * approvalTtlMs - how long an external request waits for an approver
   * onExpire      - called with the request when it expires unanswered
   */
  constructor({ service, approvers = [], confirmTtlMs = 600_000, approvalTtlMs = 86_400_000, logger = silentLogger, onExpire = async () => {} }) {
    Object.assign(this, { service, approvers, confirmTtlMs, approvalTtlMs, logger, onExpire });
    this.requests = new Map(); // requestId -> request (kept after it closes, for the log and late button presses)
  }

  create({ requestedBy, userClass, registration: input }) {
    if (!['internal', 'external'].includes(userClass)) {
      throw new RegistrationError('forbidden', 'The requester could not be classified, so the request cannot go further');
    }
    if (userClass === 'external' && !this.approvers.length) {
      throw new RegistrationError('forbidden', 'No approver is configured, so requests from outside the internal domain cannot go further');
    }
    const registration = RequestFlow.#checked(input);
    const request = {
      id: crypto.randomUUID(),
      version: 1,
      requestedBy,
      userClass,
      registration,
      state: userClass === 'internal' ? 'awaiting_confirmation' : 'awaiting_approval',
      createdAt: new Date().toISOString(),
    };
    this.#arm(request);
    this.requests.set(request.id, request);
    this.#log('request_created', request);
    return { ...request };
  }

  /** A new version of an open request. An approval given for an earlier version no longer counts. */
  edit(requestId, actor, input) {
    const request = this.#open(requestId);
    RequestFlow.#mustBe(actor === request.requestedBy, 'Only the person who made the request can edit it');
    request.registration = RequestFlow.#checked(input);
    request.version += 1;
    request.state = request.userClass === 'internal' ? 'awaiting_confirmation' : 'awaiting_approval';
    this.#arm(request);
    this.#log('request_edited', request);
    return { ...request };
  }

  /** The request's data, for its requester (to edit) or an approver (to decide). */
  view(requestId, actor) {
    const request = this.#open(requestId);
    RequestFlow.#mustBe(actor === request.requestedBy || this.isApprover(actor), 'Only the requester or an approver can open this request');
    return { ...request };
  }

  get(requestId) {
    const request = this.requests.get(requestId);
    return request && { ...request };
  }

  isApprover(userId) {
    return this.approvers.includes(userId);
  }

  cancel(requestId, actor) {
    const request = this.#open(requestId);
    RequestFlow.#mustBe(actor === request.requestedBy, 'Only the person who made the request can cancel it');
    this.#close(request, 'cancelled', { decidedBy: actor });
    return { ...request };
  }

  // confirm and approve throw at once when the request cannot be sent, and otherwise
  // return the promise of the submit, so a caller can say "sending…" only when it is true.

  /** Internal path: the requester's Send on the version they were shown. */
  confirm(requestId, version, actor) {
    const request = this.#open(requestId, version);
    RequestFlow.#mustBe(request.userClass === 'internal', 'This request needs an approver, not the requester, to send it');
    RequestFlow.#mustBe(actor === request.requestedBy, 'Only the person who made the request can send it');
    return this.#submit(request, { decidedBy: actor });
  }

  /** External path: a designated approver's Approve on the version they were shown. */
  approve(requestId, version, actor) {
    const request = this.#open(requestId, version);
    RequestFlow.#mustBe(request.userClass === 'external', 'This request is sent by its requester, not approved');
    RequestFlow.#mustBe(this.isApprover(actor), 'Only a designated approver can approve this request');
    return this.#submit(request, { decidedBy: actor });
  }

  reject(requestId, version, actor, reason = '') {
    const request = this.#open(requestId, version);
    RequestFlow.#mustBe(request.userClass === 'external', 'Only requests that wait for an approver can be rejected');
    RequestFlow.#mustBe(this.isApprover(actor), 'Only a designated approver can reject this request');
    this.#close(request, 'rejected', { decidedBy: actor, reason: reason.trim() });
    return { ...request };
  }

  shutdown() {
    for (const request of this.requests.values()) clearTimeout(request.timer);
  }

  async #submit(request, decision) {
    // Leave the open states before the first await: a second press, from the same or
    // another approver, finds the request no longer open and stops.
    request.state = 'submitting';
    Object.assign(request, decision);
    clearTimeout(request.timer);
    this.#log('request_submitting', request);
    try {
      const job = await this.service.prepare({ requestedBy: request.requestedBy, registration: request.registration });
      const { referenceCode } = await this.service.approve(job.jobId, request.requestedBy);
      request.state = 'submitted';
      request.referenceCode = referenceCode;
      request.closedAt = new Date().toISOString();
      this.#log('request_submitted', request);
      return { ...request };
    } catch (error) {
      request.state = 'failed';
      request.reason = `${error.code ?? 'unexpected'}: ${error.message}`;
      request.closedAt = new Date().toISOString();
      this.#log('request_failed', request, 'error');
      throw error;
    }
  }

  #open(requestId, version) {
    const request = this.requests.get(requestId);
    if (!request) throw new RegistrationError('not_found', 'This request is not known (the bot may have restarted)');
    if (!OPEN_STATES.includes(request.state)) {
      throw new RegistrationError('closed', `This request is no longer open (${request.state.replace('_', ' ')})`);
    }
    if (version !== undefined && version !== request.version) {
      throw new RegistrationError('stale', `This button belongs to version ${version}; the request has been edited since (now version ${request.version})`);
    }
    if (Date.now() >= request.expiresAtMs) {
      this.#expire(request);
      throw new RegistrationError('closed', 'This request has expired');
    }
    return request;
  }

  #arm(request) {
    clearTimeout(request.timer);
    const ttl = request.userClass === 'internal' ? this.confirmTtlMs : this.approvalTtlMs;
    request.expiresAtMs = Date.now() + ttl;
    request.expiresAt = new Date(request.expiresAtMs).toISOString();
    request.timer = setTimeout(() => this.#expire(request), ttl);
    request.timer.unref?.();
  }

  #expire(request) {
    if (!OPEN_STATES.includes(request.state)) return;
    this.#close(request, 'expired');
    Promise.resolve(this.onExpire({ ...request })).catch((error) => this.logger.warn('expire_notify_failed', { requestId: request.id, message: error.message }));
  }

  #close(request, state, fields = {}) {
    clearTimeout(request.timer);
    Object.assign(request, fields, { state, closedAt: new Date().toISOString() });
    this.#log(`request_${state}`, request, state === 'expired' ? 'warn' : 'info');
  }

  /** The minimum log: request ID, version, requester, deciding user, state, result. Never the email. */
  #log(event, request, level = 'info') {
    this.logger[level](event, {
      requestId: request.id,
      version: request.version,
      requestedBy: request.requestedBy,
      userClass: request.userClass,
      state: request.state,
      createdAt: request.createdAt,
      ...(request.decidedBy && { decidedBy: request.decidedBy }),
      ...(request.reason && { reason: request.reason }),
      ...(request.referenceCode && { referenceCode: request.referenceCode }),
    });
  }

  static #checked(input) {
    const registration = normalize(input);
    const errors = validate(registration);
    if (Object.keys(errors).length) throw new RegistrationError('invalid', 'Registration data is invalid', errors);
    return registration;
  }

  static #mustBe(condition, message) {
    if (!condition) throw new RegistrationError('forbidden', message);
  }
}
