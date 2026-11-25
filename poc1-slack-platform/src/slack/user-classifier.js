// Sorts a Slack user into internal, external or unknown by the domain of the email Slack
// returns for them. The email is read, compared and dropped: it is never returned,
// logged or stored.
//
// Slack returns profile.email only when the app has the users:read.email scope. Without
// it, users.info still answers ok: true, just without the email, so a missing email is
// a normal answer here, not an error, and it ends in "unknown" (nothing is submitted).

export function createUserClassifier({ internalDomains }) {
  const domains = internalDomains.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (!domains.length) throw new Error('createUserClassifier needs at least one internal domain');

  /** Resolves { userClass: 'internal' | 'external' | 'unknown', reason, guest }. */
  return async function classifyUser(client, userId) {
    let user;
    try {
      ({ user } = await client.users.info({ user: userId }));
    } catch (error) {
      return { userClass: 'unknown', reason: `users.info failed: ${error.data?.error ?? error.message}` };
    }
    if (!user || user.deleted || user.is_bot || user.is_app_user) {
      return { userClass: 'unknown', reason: 'not an active person' };
    }
    const email = (user.profile?.email || '').trim().toLowerCase();
    const at = email.lastIndexOf('@');
    if (at < 1 || at === email.length - 1) {
      return { userClass: 'unknown', reason: 'Slack returned no email (scope users:read.email missing, or not visible for this user)' };
    }
    if (user.is_email_confirmed === false) {
      return { userClass: 'unknown', reason: 'the email address is not confirmed' };
    }
    // Exact match on the whole domain: "corp.example" does not cover "corp.example.evil"
    // or "sub.corp.example". List subdomains explicitly if they count as internal.
    const domain = email.slice(at + 1);
    return {
      userClass: domains.includes(domain) ? 'internal' : 'external',
      reason: domains.includes(domain) ? 'internal domain' : 'other domain',
      guest: Boolean(user.is_restricted || user.is_ultra_restricted),
    };
  };
}
