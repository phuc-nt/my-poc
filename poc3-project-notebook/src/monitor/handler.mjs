// Every 15 minutes (EventBridge): the sync jobs of every source into DynamoDB for the sync page, CloudWatch metrics
// per source for the dashboard and alarms, and once a day the permission import from Confluence and SharePoint.
// When a source's latest job changes, it also refreshes the source's document list (from Confluence or SharePoint)
// and reads the documents that job failed to index, with the reason, from the knowledge base's application logs.
// A Jira source has no sync job of the knowledge base: every run reads Jira and sends what changed (lib/jira.mjs).
// The API starts the same run for one Jira source with the event { jira: <source id>, full: true }.
// A Confluence source with a text data source next to it (lib/confluence-text.mjs) gets the text documents of
// its new and changed attachments every run.
// Every run also reads which pages and issues are restricted to some people (lib/restrictions.mjs).
// The event { acl: true } does only that.

import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { config } from '../lib/config.mjs';
import { listSources, sourceDetail, jobs, documents } from '../lib/kb.mjs';
import { get, put, del, now } from '../lib/store.mjs';
import { syncJira, jiraDocuments } from '../lib/jira.mjs';
import { syncConfluenceText } from '../lib/confluence-text.mjs';
import { importPermissions } from '../lib/permissions.mjs';
import { buildAcl } from '../lib/restrictions.mjs';

const cw = new CloudWatchClient({ region: config.region });
const logs = new CloudWatchLogsClient({ region: config.region });
const TTL_DAYS = 90;
const IMPORT_EVERY_HOURS = Number(process.env.IMPORT_EVERY_HOURS || 24);

// The documents one ingestion job failed to index: { uri, title, reason }, from its ERROR log lines.
export async function failedIn(s, job) {
  if (!job?.failed) return [];
  const out = new Map();
  let nextToken;
  do {
    const page = await logs.send(new FilterLogEventsCommand({
      logGroupName: config.kbLogGroup, startTime: new Date(job.startedAt).getTime() - 60_000, nextToken,
      filterPattern: `{ $.level = "ERROR" && $.event.ingestion_job_id = "${job.jobId}" }`,
    }));
    for (const e of page.events || []) {
      try {
        const { event } = JSON.parse(e.message);
        if (event?.source_uri) out.set(event.source_uri, { uri: event.source_uri, title: event.document_title, reason: event.error_message });
      } catch { /* not a document line */ }
    }
    nextToken = page.nextToken;
  } while (nextToken && out.size < 200);
  return [...out.values()];
}

// One run of a Jira source: the sync, then its job, counts and failed documents, where the other sources keep theirs.
async function jiraRun(s, { at, deadline, full = false }) {
  const pk = `SOURCE#${s.id}`;
  const previous = await get(pk, 'LATEST');
  const ttl = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
  const lock = await get(pk, 'LOCK');
  let job = previous?.job || null;
  // One run at a time: a manual sync and the schedule can meet. A lock older than the function's timeout is stale.
  if (!lock || Date.now() - new Date(lock.at).getTime() > 660_000) {
    await put({ pk, sk: 'LOCK', at, ttl: Math.floor(Date.now() / 1000) + 3600 });
    try {
      job = await syncJira(s, { deadline, full });
    } catch (error) {
      console.error(`jira ${s.name}`, error.message);
      job = { jobId: `jira-${at}`, status: 'FAILED', startedAt: at, updatedAt: now(), scanned: 0, indexed: 0, deleted: 0, failed: 0, metadataIndexed: 0, errors: [String(error.message).slice(0, 300)] };
    } finally {
      await del(pk, 'LOCK');
    }
    // The history keeps the runs that did something, not the 96 a day that found nothing new.
    if (job.indexed || job.deleted || job.failed || job.status !== 'COMPLETE' || !previous?.job) await put({ pk, sk: `JOB#${job.startedAt}`, job, ttl });
    if (job.errors?.length) console.error(`jira ${s.name}`, JSON.stringify(job.errors));
    if (job.warnings?.length) console.warn(`jira ${s.name}`, JSON.stringify(job.warnings));
  }
  let { documents: count = null, failedDocuments = [] } = previous || {};
  try {
    const docs = await jiraDocuments(s);
    count = docs.filter((d) => d.status === 'INDEXED').length;
    failedDocuments = docs.filter((d) => d.status === 'FAILED').slice(0, 200).map((d) => ({ uri: d.uri, title: d.title, reason: d.reason }));
  } catch (error) {
    console.error(`documents ${s.name}`, error.message);
  }
  const lastSuccessAt = job?.status === 'COMPLETE' && !job.partial ? job.updatedAt : previous?.lastSuccessAt || null;
  await put({ pk, sk: 'LATEST', job, lastSuccessAt, documents: count, failedDocuments, at });
  const ageHours = lastSuccessAt ? (Date.now() - new Date(lastSuccessAt).getTime()) / 3600_000 : 9999;
  return { source: s.name, status: job?.status, ageHours, documents: count, failed: failedDocuments.length };
}

export async function handler(event = {}, context) {
  const at = now();
  const sources = await listSources({ fresh: true });
  // Leaves two minutes of the function's time for the rest of the run.
  const deadline = Date.now() + Math.max(60_000, (context?.getRemainingTimeInMillis?.() ?? 540_000) - 120_000);
  if (event.acl) {
    const rows = [];
    for (const s of sources) rows.push({ source: s.name, ...(await buildAcl(s)) });
    console.log(JSON.stringify(rows));
    return rows;
  }
  if (event.jira) {
    const s = sources.find((x) => x.id === event.jira && x.type === 'JIRA');
    if (!s) throw new Error('No such Jira source');
    const row = await jiraRun(s, { at, deadline, full: event.full !== false });
    row.restricted = (await buildAcl(s)).restricted;
    console.log(JSON.stringify(row));
    return row;
  }
  const metrics = [];
  const summary = [];
  for (const s of sources) {
    if (s.type === 'JIRA') {
      const row = await jiraRun(s, { at, deadline });
      const dims = [{ Name: 'Source', Value: s.name }];
      metrics.push(
        { MetricName: 'SyncAgeHours', Dimensions: dims, Value: Math.round(row.ageHours * 10) / 10, Unit: 'None' },
        { MetricName: 'DocumentsIndexed', Dimensions: dims, Value: row.documents || 0, Unit: 'Count' },
      );
      summary.push({ ...row, ageHours: Math.round(row.ageHours) });
      continue;
    }
    const recent = await jobs(s, 20);
    const ttl = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
    for (const job of recent) await put({ pk: `SOURCE#${s.id}`, sk: `JOB#${job.startedAt}`, job, ttl });
    const latest = recent[0] || null;
    const previous = await get(`SOURCE#${s.id}`, 'LATEST');
    const lastSuccess = recent.find((j) => j.status === 'COMPLETE');
    const lastSuccessAt = lastSuccess?.updatedAt || previous?.lastSuccessAt || null;
    // The document list and the failures only change when a job finishes.
    let { documents: count = null, failedDocuments = [] } = previous || {};
    if (!previous || previous.job?.jobId !== latest?.jobId || previous.job?.status !== latest?.status || count === null) {
      try {
        const docs = await documents(s);
        await put({ pk: `SOURCE#${s.id}`, sk: 'CATALOG', at, documents: docs.slice(0, 2000) });
      } catch (error) {
        console.error(`catalog ${s.name}`, error.message);
      }
      if (lastSuccess) {
        failedDocuments = await failedIn(s, lastSuccess).catch((error) => (console.error(`logs ${s.name}`, error.message), failedDocuments));
        count = Math.max(0, lastSuccess.scanned - lastSuccess.failed);
      }
    }
    // The text documents of the source's attachments: the last run that did something stays on record.
    let text = previous?.text || null;
    if (s.textId) {
      try {
        const run = await syncConfluenceText(s, (await sourceDetail(s)).spaces, { deadline });
        if (run.indexed || run.deleted || run.failed || run.warnings.length || !text) text = run;
        else text = { ...text, at: run.at, scanned: run.scanned };
        if (run.warnings.length) console.warn(`text ${s.name}`, JSON.stringify(run.warnings));
      } catch (error) {
        console.error(`text ${s.name}`, error.message);
      }
    }
    await put({ pk: `SOURCE#${s.id}`, sk: 'LATEST', job: latest, lastSuccessAt, documents: count, failedDocuments, text, at });
    const ageHours = lastSuccessAt ? (Date.now() - new Date(lastSuccessAt).getTime()) / 3600_000 : 9999;
    // Each custom metric costs about 0.30 USD a month: per source only what the dashboard draws; failures per
    // source are on the app's sync page, and the alarms use the totals.
    const dims = [{ Name: 'Source', Value: s.name }];
    metrics.push(
      { MetricName: 'SyncAgeHours', Dimensions: dims, Value: Math.round(ageHours * 10) / 10, Unit: 'None' },
      { MetricName: 'DocumentsIndexed', Dimensions: dims, Value: count || 0, Unit: 'Count' },
    );
    summary.push({ source: s.name, status: latest?.status, ageHours: Math.round(ageHours), documents: count, failed: lastSuccess?.failed ?? failedDocuments.length,
      ...(s.textId && text ? { text: { scanned: text.scanned, indexed: text.indexed, deleted: text.deleted, failed: text.failed, partial: text.partial, warnings: text.warnings?.length || 0 } } : {}) });
  }
  const worstAge = Math.max(0, ...summary.map((x) => x.ageHours));
  metrics.push(
    { MetricName: 'SyncAgeHoursMax', Value: worstAge, Unit: 'None' },
    { MetricName: 'JobFailedTotal', Value: summary.filter((x) => x.status === 'FAILED').length, Unit: 'Count' },
    { MetricName: 'DocumentsFailedTotal', Value: summary.reduce((n, x) => n + x.failed, 0), Unit: 'Count' },
  );
  for (let i = 0; i < metrics.length; i += 500) {
    await cw.send(new PutMetricDataCommand({ Namespace: config.metricNamespace, MetricData: metrics.slice(i, i + 500).map((m) => ({ ...m, Timestamp: new Date() })) }));
  }
  // Which documents are restricted to some people, read again on every run (lib/restrictions.mjs): a restriction
  // set in Confluence or Jira reaches the app within one run.
  for (const s of sources) {
    const acl = await buildAcl(s);
    if (acl.note) console.error(`restrictions ${s.name}`, acl.note);
    const row = summary.find((x) => x.source === s.name);
    if (row) row.restricted = acl.restricted;
  }
  await put({ pk: 'MONITOR', sk: 'LAST', at, summary });

  const lastImport = (await get('IMPORT', 'LAST'))?.report?.at;
  if (!lastImport || Date.now() - new Date(lastImport).getTime() > IMPORT_EVERY_HOURS * 3600_000) {
    try {
      const report = await importPermissions();
      console.log('permission import', JSON.stringify({ granted: report.granted, waiting: report.waiting, notes: report.notes.length }));
    } catch (error) {
      console.error('permission import failed', error.message);
    }
  }
  console.log(JSON.stringify(summary));
  return summary;
}
