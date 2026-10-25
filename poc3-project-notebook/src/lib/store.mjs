// The one DynamoDB table. Keys:
//   USER#<email>   PROFILE | GRANT#<source id> | NB#<notebook id> | PAT#<token hash>
//   NB#<id>        MSG#<time> | NOTE#<time>
//   PAT#<hash>     PAT                      (token -> user)
//   SOURCE#<id>    JOB#<started at>         (sync history, written by the monitor)
//   DOC#<hash>     GUIDE                    (cached source guide of one document)
//   USAGE#<yyyy-mm> <yyyy-mm-dd>            (counters for the cost page)
// gsi1 lists the users (gsi1pk USERS).

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, UpdateCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { config } from './config.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }), { marshallOptions: { removeUndefinedValues: true } });
const TableName = () => config.table;

export const get = async (pk, sk) => (await db.send(new GetCommand({ TableName: TableName(), Key: { pk, sk } }))).Item || null;
export const put = (item) => db.send(new PutCommand({ TableName: TableName(), Item: item }));
export const del = (pk, sk) => db.send(new DeleteCommand({ TableName: TableName(), Key: { pk, sk } }));

export async function query(pk, prefix = '', { limit, forward = true, index } = {}) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const keyPk = index ? 'gsi1pk' : 'pk';
    const keySk = index ? 'gsi1sk' : 'sk';
    const page = await db.send(new QueryCommand({
      TableName: TableName(),
      IndexName: index,
      KeyConditionExpression: prefix ? `${keyPk} = :pk AND begins_with(${keySk}, :sk)` : `${keyPk} = :pk`,
      ExpressionAttributeValues: prefix ? { ':pk': pk, ':sk': prefix } : { ':pk': pk },
      ScanIndexForward: forward,
      Limit: limit,
      ExclusiveStartKey,
    }));
    out.push(...page.Items);
    ExclusiveStartKey = limit && out.length >= limit ? undefined : page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return limit ? out.slice(0, limit) : out;
}

export async function deleteAll(pk, prefix = '') {
  const items = await query(pk, prefix);
  for (let i = 0; i < items.length; i += 25) {
    await db.send(new BatchWriteCommand({
      RequestItems: { [TableName()]: items.slice(i, i + 25).map((x) => ({ DeleteRequest: { Key: { pk: x.pk, sk: x.sk } } })) },
    }));
  }
  return items.length;
}

// Adds numbers to a counter item: add('USAGE#2026-10', '2026-10-25', { retrieve: 1 }).
export function add(pk, sk, counters) {
  const names = {};
  const values = {};
  const parts = Object.entries(counters).filter(([, v]) => v).map(([k, v], i) => {
    names[`#k${i}`] = k;
    values[`:v${i}`] = v;
    return `#k${i} :v${i}`;
  });
  if (!parts.length) return Promise.resolve();
  return db.send(new UpdateCommand({
    TableName: TableName(),
    Key: { pk, sk },
    UpdateExpression: `ADD ${parts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

export const now = () => new Date().toISOString();
export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
