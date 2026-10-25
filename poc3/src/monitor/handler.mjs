// Every 15 minutes (EventBridge): the sync jobs of every source into DynamoDB for the sync page, CloudWatch metrics
// per source for the dashboard and alarms, and once a day the permission import from Confluence and SharePoint.
// When a source's latest job changes, it also refreshes the source's document list (from Confluence or SharePoint)
// and reads the documents that job failed to index, with the reason, from the knowledge base's application logs.

import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { config } from '../lib/config.mjs';
import { listSources, jobs, documents } from '../lib/kb.mjs';
import { get, put, now } from '../lib/store.mjs';
import { importPermissions } from '../lib/permissions.mjs';

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

export async function handler() {
  const at = now();
  const sources = await listSources({ fresh: true });
  const metrics = [];
  const summary = [];
  for (const s of sources) {
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
    await put({ pk: `SOURCE#${s.id}`, sk: 'LATEST', job: latest, lastSuccessAt, documents: count, failedDocuments, at });
    const ageHours = lastSuccessAt ? (Date.now() - new Date(lastSuccessAt).getTime()) / 3600_000 : 9999;
    // Each custom metric costs about 0.30 USD a month: per source only what the dashboard draws; failures per
    // source are on the app's sync page, and the alarms use the totals.
    const dims = [{ Name: 'Source', Value: s.name }];
    metrics.push(
      { MetricName: 'SyncAgeHours', Dimensions: dims, Value: Math.round(ageHours * 10) / 10, Unit: 'None' },
      { MetricName: 'DocumentsIndexed', Dimensions: dims, Value: count || 0, Unit: 'Count' },
    );
    summary.push({ source: s.name, status: latest?.status, ageHours: Math.round(ageHours), documents: count, failed: lastSuccess?.failed ?? failedDocuments.length });
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
