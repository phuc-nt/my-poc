#!/usr/bin/env bash
# AIPF POC: deploy, run and measure. Every resource is named aipf-poc... and tagged Project=aipf-poc.
#
#   infra/aipf.sh up                 deploy the stack, push the sample repository, create the AgentCore
#                                    Gateway with its targets and the policy engine (log-only first)
#   infra/aipf.sh build              build and push the harness image, then the session snapshot
#   infra/aipf.sh snapshot           rebuild the session snapshot from main now
#   infra/aipf.sh token              store the Claude subscription token (from `claude setup-token`)
#   infra/aipf.sh run KEY [claude-code|opencode] [model]
#                                    start the work item workflow for a Jira work item
#   infra/aipf.sh reset KEY [why]    stop the work item's runs, close its pull requests, delete agent/KEY,
#                                    move it back to To Do (before running it again, e.g. with the other CLI)
#   infra/aipf.sh answer KEY [TEXT]  show what waits for a person on KEY, or send TEXT as the Slack link's form would
#   infra/aipf.sh policy log|enforce switch the gateway's policy engine mode
#   infra/aipf.sh webhook            register the Jira webhook (needs a Jira administrator)
#   infra/aipf.sh items              create the test set's Jira work items (label aipf-test) and list their keys
#   infra/aipf.sh status             stack, gateway, policy mode, snapshot, latest runs
#   infra/aipf.sh sessions [--csv]   every agent session: time, turns, tokens, cost, refusals
#   infra/aipf.sh cost [FROM] [TO]   actual AWS cost by service (Cost Explorer, dates YYYY-MM-DD)
#   infra/aipf.sh logs NAME [SINCE]  tail sessions | ci | snapshot | orchestrator | tools | workflow | gateway
#   infra/aipf.sh decisions [SINCE]  every policy decision of the gateway, with totals by role
#   infra/aipf.sh down               delete everything this script created
#
# Needs: aws CLI v2 signed in, node, git, docker with buildx. Jira and Slack values come from ../.env
# (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY, SLACK_BOT_TOKEN, REPORT_POST_CHANNEL
# or AIPF_SLACK_CHANNEL); they go to Secrets Manager and are never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

LOCAL=../infra/local.env
if [ -f "$LOCAL" ]; then set -a; . "$LOCAL"; set +a; fi
APP=aipf-poc
STACK="$APP"
ENGINE=aipf_poc
KB_NAME="${KB_NAME:-slack-web-automation-poc-kb}"
export AWS_REGION="${AWS_REGION:-$(aws configure get region || true)}"
export AWS_PAGER=""
[ -n "$AWS_REGION" ] || { echo "Set AWS_REGION to the project's selected Region." >&2; exit 1; }

say() { printf '\n== %s\n' "$*"; }
none() { [ -z "$1" ] || [ "$1" = "None" ]; }
account() { aws sts get-caller-identity --query Account --output text; }
tmp_json() { local file; file="$(mktemp)"; chmod 600 "$file"; cat > "$file"; echo "$file"; }
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text; }
deploy_bucket() { echo "$APP-deploy-$(account)-$AWS_REGION"; }

wait_for() { # wait_for <description> <wanted> <failed regex> <command...>; TRIES x 5 s
  local what="$1" wanted="$2" failed="$3" status; shift 3
  for _ in $(seq 1 "${TRIES:-90}"); do
    status="$("$@")"
    [ "$status" = "$wanted" ] && { echo "$what: $status"; return 0; }
    [[ "$status" =~ $failed ]] && { echo "$what: $status" >&2; return 1; }
    sleep 5
  done
  echo "$what: still $status" >&2; return 1
}

# --- Stack ---

deploy() { # deploy <gateway URL or empty>
  local bucket packaged
  bucket="$(deploy_bucket)"
  if ! aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    aws s3api create-bucket --bucket "$bucket" --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
    aws s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    aws s3api put-bucket-tagging --bucket "$bucket" --tagging "TagSet=[{Key=Project,Value=$APP}]"
  fi
  if [ "$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null)" = ROLLBACK_COMPLETE ]; then
    echo "the first creation of $STACK failed and rolled back; deleting it before trying again"
    aws cloudformation delete-stack --stack-name "$STACK"
    aws cloudformation wait stack-delete-complete --stack-name "$STACK"
  fi
  packaged="$(mktemp)"
  aws cloudformation package --template-file infra/stack.yaml --s3-bucket "$bucket" --s3-prefix stack \
    --output-template-file "$packaged" >/dev/null
  aws cloudformation deploy --stack-name "$STACK" --template-file "$packaged" --s3-bucket "$bucket" --s3-prefix stack \
    --capabilities CAPABILITY_NAMED_IAM --tags "Project=$APP" --no-fail-on-empty-changeset \
    --parameter-overrides "GatewayUrl=$1"
  rm -f "$packaged"
}

settings() { # Lambda settings from ../.env; WEBHOOK_SECRET is generated once and kept
  local secret file
  secret="$(out SettingsSecret)"
  file="$(mktemp)"; chmod 600 "$file"
  aws secretsmanager get-secret-value --secret-id "$secret" --query SecretString --output text \
    | node --env-file-if-exists=../.env -e '
      const fs = require("fs");
      let old = {};
      try { old = JSON.parse(fs.readFileSync(0, "utf8")); } catch {}
      const e = process.env;
      const v = {
        JIRA_BASE_URL: e.JIRA_BASE_URL, JIRA_EMAIL: e.JIRA_EMAIL, JIRA_API_TOKEN: e.JIRA_API_TOKEN,
        JIRA_PROJECT_KEY: e.AIPF_JIRA_PROJECT_KEY || e.JIRA_PROJECT_KEY,
        SLACK_BOT_TOKEN: e.SLACK_BOT_TOKEN, SLACK_CHANNEL: e.AIPF_SLACK_CHANNEL || e.REPORT_POST_CHANNEL,
        WEBHOOK_SECRET: old.WEBHOOK_SECRET || require("crypto").randomBytes(24).toString("hex"),
      };
      const missing = Object.keys(v).filter((k) => !v[k]);
      if (missing.length) { console.error("missing in .env: " + missing.join(", ")); process.exit(1); }
      fs.writeFileSync(process.argv[1], JSON.stringify(v));
    ' "$file"
  aws secretsmanager put-secret-value --secret-id "$secret" --secret-string "file://$file" >/dev/null
  rm -f "$file"
  echo "settings secret written (JIRA_*, SLACK_BOT_TOKEN, SLACK_CHANNEL, WEBHOOK_SECRET)"
}

git_codecommit() { git -c credential.helper= -c 'credential.helper=!aws codecommit credential-helper $@' -c credential.UseHttpPath=true "$@"; }

push_repo() { # the sample repository goes to CodeCommit once; later changes go through pull requests
  local repo dir
  repo="$(out RepositoryName)"
  if aws codecommit get-branch --repository-name "$repo" --branch-name main >/dev/null 2>&1; then
    echo "main is already in $repo"; return
  fi
  dir="$(mktemp -d)"
  rsync -a --exclude node_modules --exclude .git sample-repo/ "$dir/"
  git -C "$dir" init -q -b main
  git -C "$dir" add -A
  git -C "$dir" -c user.name="AIPF POC" -c user.email="aipf-poc@example.invalid" commit -qm "Service desk API: AI-ready sample repository"
  git_codecommit -C "$dir" push -q "$(out RepositoryCloneUrl)" main
  rm -rf "$dir"
  echo "pushed main to $repo"
}

approval_rule() { # pull requests into main need one approval from a person signed in with the caller's role
  local name="$APP-human-approval" pool content
  pool="$(aws sts get-caller-identity --query Arn --output text \
    | sed -E 's#^arn:aws:sts::([0-9]+):assumed-role/([^/]+)/.*#arn:aws:sts::\1:assumed-role/\2/*#')"
  content="{\"Version\":\"2018-11-08\",\"DestinationReferences\":[\"refs/heads/main\"],\"Statements\":[{\"Type\":\"Approvers\",\"NumberOfApprovalsNeeded\":1,\"ApprovalPoolMembers\":[\"$pool\"]}]}"
  if aws codecommit get-approval-rule-template --approval-rule-template-name "$name" >/dev/null 2>&1; then
    aws codecommit update-approval-rule-template-content --approval-rule-template-name "$name" --new-rule-content "$content" >/dev/null
  else
    aws codecommit create-approval-rule-template --approval-rule-template-name "$name" \
      --approval-rule-template-description "AIPF POC: a person approves every pull request into main" \
      --approval-rule-template-content "$content" >/dev/null
  fi
  aws codecommit associate-approval-rule-template-with-repository --approval-rule-template-name "$name" \
    --repository-name "$(out RepositoryName)" >/dev/null
  echo "approval rule $name (1 approval, people signed in with your role)"
}

# --- AgentCore Gateway and Policy ---

gateway_id() { aws bedrock-agentcore-control list-gateways --query "items[?name=='$APP'].gatewayId | [0]" --output text; }
gateway_url() { local id; id="$(gateway_id)"; none "$id" && echo "" || aws bedrock-agentcore-control get-gateway --gateway-identifier "$id" --query gatewayUrl --output text; }
target_id() { aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$1" --query "items[?name=='$2'].targetId | [0]" --output text; }
engine_id() { aws bedrock-agentcore-control list-policy-engines --query "policyEngines[?name=='$ENGINE'].policyEngineId | [0]" --output text; }
policy_id() { aws bedrock-agentcore-control list-policies --policy-engine-id "$1" --query "policies[?name=='$2'].policyId | [0]" --output text; }
kb_id() { aws bedrock-agent list-knowledge-bases --query "knowledgeBaseSummaries[?name=='$KB_NAME'].knowledgeBaseId | [0]" --output text; }

put_target() { # put_target <gateway id> <name> <configuration file>
  local id="$1" name="$2" target
  target="$(target_id "$id" "$name")"
  if none "$target"; then
    target="$(aws bedrock-agentcore-control create-gateway-target --gateway-identifier "$id" --name "$name" \
      --target-configuration "file://$3" --credential-provider-configurations '[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]' \
      --query targetId --output text)"
  else
    aws bedrock-agentcore-control update-gateway-target --gateway-identifier "$id" --target-id "$target" --name "$name" \
      --target-configuration "file://$3" --credential-provider-configurations '[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]' >/dev/null
  fi
  rm -f "$3"
  wait_for "target $name" READY "FAILED|UNSUCCESSFUL" \
    aws bedrock-agentcore-control get-gateway-target --gateway-identifier "$id" --target-id "$target" --query status --output text
}

update_gateway() { # update_gateway <id> [policy engine configuration]
  local id="$1"; shift
  aws bedrock-agentcore-control update-gateway --gateway-identifier "$id" --name "$APP" --role-arn "$(out GatewayRoleArn)" \
    --protocol-type MCP --authorizer-type AWS_IAM --exception-level DEBUG "$@" >/dev/null
  wait_for "gateway" READY "FAILED" aws bedrock-agentcore-control get-gateway --gateway-identifier "$id" --query status --output text
}

gateway() {
  local id arn tools kb engine engine_arn mode name file pid def
  id="$(gateway_id)"
  if none "$id"; then
    # AWS_IAM: only requests signed by identities allowed to call InvokeGateway get in.
    # DEBUG: tool errors and policy refusals reach the agent in full (POC only).
    id="$(aws bedrock-agentcore-control create-gateway --name "$APP" --protocol-type MCP --authorizer-type AWS_IAM \
      --role-arn "$(out GatewayRoleArn)" --exception-level DEBUG --description "Tools of the AIPF agents" \
      --tags "Project=$APP" --query gatewayId --output text)"
  fi
  wait_for "gateway" READY "FAILED" aws bedrock-agentcore-control get-gateway --gateway-identifier "$id" --query status --output text
  arn="$(aws bedrock-agentcore-control get-gateway --gateway-identifier "$id" --query gatewayArn --output text)"

  tools="$(out ToolsFunctionArn)"
  for name in $(node -e 'console.log(Object.keys(require("./registry/tools.json")).join(" "))'); do
    file="$(TARGET="$name" LAMBDA="$tools" node -e '
      const tools = require("./registry/tools.json")[process.env.TARGET];
      process.stdout.write(JSON.stringify({ mcp: { lambda: { lambdaArn: process.env.LAMBDA, toolSchema: { inlinePayload: tools } } } }));
    ' | tmp_json)"
    put_target "$id" "$name" "$file"
  done

  kb="$(kb_id)"
  if ! none "$kb"; then
    file="$(KB_ID="$kb" node -e '
      process.stdout.write(JSON.stringify({ mcp: { connector: { source: { connectorId: "bedrock-knowledge-bases" }, configurations: [{
        name: "Retrieve",
        description: "Search the company knowledge base (Confluence, SharePoint): business rules, product data, policies, manuals, procedures. Returns the most relevant passages with their source.",
        parameterValues: { knowledgeBaseId: process.env.KB_ID, retrievalConfiguration: { managedSearchConfiguration: { numberOfResults: 8 } } },
        parameterOverrides: [{ path: "$.retrievalQuery.text", description: "What to look for, as a question or keywords.", visible: true }],
      }] } } }));
    ' | tmp_json)"
    put_target "$id" kb "$file"
  else
    echo "knowledge base $KB_NAME not found: no kb target (create it with ../infra/kb.sh up)"
  fi

  engine="$(engine_id)"
  if none "$engine"; then
    engine="$(aws bedrock-agentcore-control create-policy-engine --name "$ENGINE" \
      --description "Tool rules per AIPF agent role" --query policyEngineId --output text)"
  fi
  wait_for "policy engine" ACTIVE "FAILED" aws bedrock-agentcore-control get-policy-engine --policy-engine-id "$engine" --query status --output text
  engine_arn="$(aws bedrock-agentcore-control get-policy-engine --policy-engine-id "$engine" --query policyEngineArn --output text)"
  for file in registry/policies/*.cedar; do
    name="$(basename "$file" .cedar | tr '-' '_')"
    if [ "$name" = kb ] && none "$kb"; then continue; fi
    def="$(GATEWAY_ARN="$arn" node -e '
      const fs = require("fs");
      const statement = fs.readFileSync(process.argv[1], "utf8").replace(/^\/\/.*\n/gm, "").replaceAll("{{GATEWAY_ARN}}", process.env.GATEWAY_ARN).trim();
      process.stdout.write(JSON.stringify({ cedar: { statement } }));
    ' "$file" | tmp_json)"
    pid="$(policy_id "$engine" "$name")"
    if none "$pid"; then
      pid="$(aws bedrock-agentcore-control create-policy --policy-engine-id "$engine" --name "$name" \
        --definition "file://$def" --validation-mode FAIL_ON_ANY_FINDINGS --query policyId --output text)"
    else
      aws bedrock-agentcore-control update-policy --policy-engine-id "$engine" --policy-id "$pid" \
        --definition "file://$def" --validation-mode FAIL_ON_ANY_FINDINGS >/dev/null
    fi
    rm -f "$def"
    if ! wait_for "policy $name" ACTIVE "FAILED" aws bedrock-agentcore-control get-policy --policy-engine-id "$engine" --policy-id "$pid" --query status --output text; then
      aws bedrock-agentcore-control get-policy --policy-engine-id "$engine" --policy-id "$pid" --query statusReasons --output json | sed -E 's/[0-9]{12}/<acct>/g' >&2
      return 1
    fi
  done
  mode="$(aws bedrock-agentcore-control get-gateway --gateway-identifier "$id" --query policyEngineConfiguration.mode --output text)"
  if none "$mode"; then
    update_gateway "$id" --policy-engine-configuration "arn=$engine_arn,mode=LOG_ONLY"
    mode=LOG_ONLY
  fi
  echo "policy engine $ENGINE: $mode"
  gateway_logs "$arn"
}

gateway_logs() { # the gateway's application logs go to CloudWatch Logs
  local arn="$1" group="/aws/vendedlogs/bedrock-agentcore/gateway/$APP" group_arn dest
  if ! aws logs describe-log-groups --log-group-name-prefix "$group" --query "logGroups[?logGroupName=='$group'] | [0].arn" --output text | grep -q arn; then
    aws logs create-log-group --log-group-name "$group" --tags "Project=$APP"
    aws logs put-retention-policy --log-group-name "$group" --retention-in-days 30
  fi
  group_arn="$(aws logs describe-log-groups --log-group-name-prefix "$group" --query "logGroups[?logGroupName=='$group'] | [0].arn" --output text)"
  group_arn="${group_arn%:\*}"
  aws logs put-delivery-source --name "$APP-gateway" --log-type APPLICATION_LOGS --resource-arn "$arn" >/dev/null
  dest="$(aws logs put-delivery-destination --name "$APP-gateway" \
    --delivery-destination-configuration "destinationResourceArn=$group_arn" --query deliveryDestination.arn --output text)"
  if [ -z "$(aws logs describe-deliveries --query "deliveries[?deliverySourceName=='$APP-gateway'].id | [0]" --output text | grep -v None || true)" ]; then
    aws logs create-delivery --delivery-source-name "$APP-gateway" --delivery-destination-arn "$dest" >/dev/null
  fi
  echo "gateway logs: $group"
}

activate_cost_tag() {
  if aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=Project,Status=Active >/dev/null 2>&1; then
    echo "cost allocation tag Project: active (Cost Explorer shows tagged cost from now on, about 24 h behind)"
  else
    echo "cost allocation tag Project not visible to Billing yet; run infra/aipf.sh up again tomorrow to activate it"
  fi
}

up() {
  say "Stack $STACK (first pass)"
  deploy "$(gateway_url)"
  say "Settings secret"
  settings
  say "Sample repository and approval rule"
  push_repo
  approval_rule
  say "Project memory"
  aws s3 sync memory-seed/ "s3://$(out Bucket)/memory/" --only-show-errors
  say "AgentCore Gateway, targets and policy engine"
  gateway
  say "Stack $STACK with the gateway URL"
  deploy "$(gateway_url)"
  say "Cost tracking"
  activate_cost_tag
  echo
  echo "Next: infra/aipf.sh build, then infra/aipf.sh token"
}

# --- Images ---

build() {
  local harness tag
  harness="$(out HarnessRepositoryUri)"
  tag="$(date +%Y%m%d%H%M%S)"
  aws ecr get-login-password | docker login --username AWS --password-stdin "${harness%%/*}" >/dev/null
  docker buildx build --platform linux/arm64 -f harness/Dockerfile -t "$harness:latest" -t "$harness:$tag" --push --quiet . >/dev/null
  echo "harness image pushed ($tag)"
  snapshot
}

snapshot() {
  local id
  id="$(aws codebuild start-build --project-name "$(out SnapshotProject)" --query build.id --output text)"
  echo "snapshot build ${id#*:}"
  TRIES=240 wait_for "snapshot" SUCCEEDED "FAILED|FAULT|STOPPED|TIMED_OUT" \
    aws codebuild batch-get-builds --ids "$id" --query 'builds[0].buildStatus' --output text
}

# --- Secrets ---

token() { # the token is read without echo, written through a private temporary file, never printed
  local value file
  printf 'Paste the token printed by `claude setup-token` (input hidden): ' >&2
  IFS= read -rs value; echo >&2
  value="$(printf '%s' "$value" | tr -d '[:space:]')"
  [ -n "$value" ] || { echo "No token given." >&2; exit 1; }
  file="$(mktemp)"; chmod 600 "$file"
  printf '%s' "$value" > "$file"; value=""
  aws secretsmanager put-secret-value --secret-id "$(out ClaudeTokenSecret)" --secret-string "file://$file" >/dev/null
  rm -f "$file"
  echo "Claude subscription token stored in Secrets Manager ($APP/claude-token)."
}

# --- Runs ---

run() {
  local key="${1:-}" harness="${2:-claude-code}" model="${3:-}" name input
  [[ "$key" =~ ^[A-Z][A-Z0-9_]+-[0-9]+$ ]] || { echo "usage: infra/aipf.sh run KEY [claude-code|opencode] [model]" >&2; exit 1; }
  name="$key-$(date +%s)"
  input="$(KEY="$key" HARNESS="$harness" MODEL="$model" node -e 'const e = process.env; process.stdout.write(JSON.stringify({ issueKey: e.KEY, harness: e.HARNESS, model: e.MODEL }))')"
  aws stepfunctions start-execution --state-machine-arn "$(out StateMachineArn)" --name "$name" --input "$input" >/dev/null
  echo "started run $name ($harness${model:+, $model})"
}

reset() { # reset KEY [why]: stop its runs, close its pull requests, delete agent/KEY, move the work item to To Do; for a fresh run
  local key="${1:-}" why="${2:-reset}" repo arn pr
  [[ "$key" =~ ^[A-Z][A-Z0-9_]+-[0-9]+$ ]] || { echo "usage: infra/aipf.sh reset KEY [why]" >&2; exit 1; }
  repo="$(out RepositoryName)"
  for arn in $(aws stepfunctions list-executions --state-machine-arn "$(out StateMachineArn)" --status-filter RUNNING \
      --query "executions[?starts_with(name, '$key-')].executionArn" --output text); do
    aws stepfunctions stop-execution --execution-arn "$arn" --error Reset --cause "$why" >/dev/null
    echo "stopped ${arn##*:}"
  done
  for pr in $(aws codecommit list-pull-requests --repository-name "$repo" --pull-request-status OPEN --query pullRequestIds --output text); do
    if [ "$(aws codecommit get-pull-request --pull-request-id "$pr" --query 'pullRequest.pullRequestTargets[0].sourceReference' --output text)" = "refs/heads/agent/$key" ]; then
      aws codecommit update-pull-request-status --pull-request-id "$pr" --pull-request-status CLOSED >/dev/null
      echo "closed pull request $pr"
    fi
  done
  if aws codecommit get-branch --repository-name "$repo" --branch-name "agent/$key" >/dev/null 2>&1; then
    aws codecommit delete-branch --repository-name "$repo" --branch-name "agent/$key" >/dev/null
    echo "deleted agent/$key"
  fi
  local run_id
  run_id="$(aws dynamodb get-item --table-name "$(out Table)" --key "{\"pk\":{\"S\":\"ISSUE#$key\"},\"sk\":{\"S\":\"ACTIVE\"}}" --query Item.runId.S --output text)"
  if ! none "$run_id"; then
    aws dynamodb update-item --table-name "$(out Table)" --key "{\"pk\":{\"S\":\"RUN#$run_id\"},\"sk\":{\"S\":\"RUN\"}}" \
      --condition-expression '#s = :running' --update-expression 'SET #s = :reset, resetReason = :why' \
      --expression-attribute-names '{"#s":"status"}' \
      --expression-attribute-values "$(WHY="$why" node -e 'process.stdout.write(JSON.stringify({":running":{S:"running"},":reset":{S:"reset"},":why":{S:process.env.WHY}}))')" \
      >/dev/null 2>&1 && echo "marked $run_id reset"
  fi
  for sk in ACTIVE APPROVAL; do
    aws dynamodb delete-item --table-name "$(out Table)" --key "{\"pk\":{\"S\":\"ISSUE#$key\"},\"sk\":{\"S\":\"$sk\"}}"
  done
  KEY="$key" node --env-file-if-exists=../.env -e '
    const e = process.env, base = e.JIRA_BASE_URL.replace(/\/$/, "");
    const auth = "Basic " + Buffer.from(`${e.JIRA_EMAIL}:${e.JIRA_API_TOKEN}`).toString("base64");
    const call = async (method, path, body) => {
      const r = await fetch(base + path, { method, headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
      if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
      return r.status === 204 ? {} : r.json();
    };
    (async () => {
      const { transitions } = await call("GET", `/rest/api/3/issue/${e.KEY}/transitions`);
      const t = transitions.find((t) => t.to.name === "To Do");
      const { fields } = await call("GET", `/rest/api/3/issue/${e.KEY}?fields=status`);
      if (fields.status.name === "To Do") return console.log(`${e.KEY} is in To Do`);
      if (!t) throw new Error(`no transition to To Do from ${fields.status.name}`);
      await call("POST", `/rest/api/3/issue/${e.KEY}/transitions`, { transition: { id: t.id } });
      console.log(`${e.KEY} moved from ${fields.status.name} to To Do`);
    })().catch((err) => { console.error(err.message); process.exit(1); });'
}

answer() { # answer KEY [TEXT]: without TEXT, show what waits for a person on KEY; with TEXT, send it as the Slack link's form would (never prints the link)
  local key="${1:-}"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]+-[0-9]+$ ]] || { echo "usage: infra/aipf.sh answer KEY [TEXT]" >&2; exit 1; }
  aws dynamodb scan --table-name "$(out Table)" --filter-expression 'begins_with(pk, :h) AND issueKey = :k AND attribute_not_exists(answeredAt)' \
    --expression-attribute-values "{\":h\":{\"S\":\"HUMAN#\"},\":k\":{\"S\":\"$key\"}}" --output json \
    | API_URL="$(out ApiUrl)" TEXT="${2:-}" node -e '
      const items = JSON.parse(require("fs").readFileSync(0, "utf8")).Items.map((i) => ({ id: i.pk.S.slice(6), kind: i.kind.S, question: i.question?.S, prId: i.prId?.S ?? i.prId?.N, createdAt: i.createdAt.S }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const item = items.pop();
      if (!item) { console.log("nothing waits for a person on this work item"); process.exit(0); }
      if (!process.env.TEXT) {
        console.log(item.kind === "question" ? `question (${item.createdAt}):\n${item.question}` : `pull request ${item.prId} waits for review (${item.createdAt}); merge it in CodeCommit, or send the changes you want`);
        process.exit(0);
      }
      fetch(`${process.env.API_URL}/human/${item.id}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ text: process.env.TEXT }) })
        .then((r) => { console.log(r.ok ? `sent the ${item.kind === "question" ? "answer" : "changes"}` : `the form answered ${r.status}`); if (!r.ok) process.exit(1); });'
}

policy() {
  local id engine_arn mode
  case "${1:-}" in log) mode=LOG_ONLY ;; enforce) mode=ENFORCE ;; *) echo "usage: infra/aipf.sh policy log|enforce" >&2; exit 1 ;; esac
  id="$(gateway_id)"
  engine_arn="$(aws bedrock-agentcore-control get-policy-engine --policy-engine-id "$(engine_id)" --query policyEngineArn --output text)"
  update_gateway "$id" --policy-engine-configuration "arn=$engine_arn,mode=$mode"
  echo "policy engine $ENGINE: $mode"
}

webhook() { # Jira Cloud webhook; the URL carries the shared secret, so it is never printed
  aws secretsmanager get-secret-value --secret-id "$(out SettingsSecret)" --query SecretString --output text \
    | API="$(out ApiUrl)" node -e '
      const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const url = `${s.JIRA_BASE_URL.replace(/\/$/, "")}/rest/webhooks/1.0/webhook`;
      const auth = "Basic " + Buffer.from(`${s.JIRA_EMAIL}:${s.JIRA_API_TOKEN}`).toString("base64");
      (async () => {
        const list = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
        if (!list.ok) { console.error(`Jira webhooks: ${list.status} (registering a webhook needs a Jira administrator)`); process.exit(1); }
        if ((await list.json()).some((w) => w.name === "aipf-poc")) { console.log("Jira webhook aipf-poc already registered"); return; }
        const res = await fetch(url, { method: "POST", headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ name: "aipf-poc", url: `${process.env.API}/jira/${s.WEBHOOK_SECRET}`, events: ["jira:issue_created", "jira:issue_updated"],
            filters: { "issue-related-events-section": `project = ${s.JIRA_PROJECT_KEY} AND labels = aipf` }, excludeBody: false }) });
        if (!res.ok) { console.error(`Jira webhook: ${res.status} ${(await res.text()).slice(0, 200)}`); process.exit(1); }
        console.log("Jira webhook aipf-poc registered: label a work item aipf to start a run (add aipf-opencode for OpenCode)");
      })();
    '
}

items() { # the test set (test-set/work-items.json) as Jira work items labelled aipf-test; created once each
  node --env-file-if-exists=../.env -e '
    const e = process.env, base = e.JIRA_BASE_URL.replace(/\/$/, ""), project = e.AIPF_JIRA_PROJECT_KEY || e.JIRA_PROJECT_KEY;
    const auth = "Basic " + Buffer.from(`${e.JIRA_EMAIL}:${e.JIRA_API_TOKEN}`).toString("base64");
    const call = async (method, path, body) => {
      const r = await fetch(base + path, { method, headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
      if (!r.ok) throw new Error(`${method} ${path.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return r.status === 204 ? {} : r.json();
    };
    const doc = (text) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    (async () => {
      const jql = encodeURIComponent(`project = ${project} AND labels = aipf-test`);
      const found = await call("GET", `/rest/api/3/search/jql?jql=${jql}&fields=summary,status&maxResults=100`);
      const byTitle = Object.fromEntries(found.issues.map((i) => [i.fields.summary, i]));
      for (const item of require("./test-set/work-items.json").items) {
        let issue = byTitle[item.summary];
        if (!issue) {
          issue = await call("POST", "/rest/api/3/issue", { fields: { project: { key: project }, summary: item.summary, description: doc(item.description),
            issuetype: { name: item.id.startsWith("fix-") ? "Bug" : "Task" }, labels: ["aipf-test", `aipf-test-${item.id}`] } });
        }
        console.log(`${issue.key}\t${item.id}\t${item.kind}`);
      }
    })().catch((err) => { console.error(err.message); process.exit(1); });
  '
}

status() {
  local id
  say "Stack"
  aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text
  say "Gateway and policy"
  id="$(gateway_id)"
  if ! none "$id"; then
    aws bedrock-agentcore-control get-gateway --gateway-identifier "$id" --query '{status: status, policyMode: policyEngineConfiguration.mode}' --output table
    aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$id" --query 'items[].[name, status]' --output text
    aws bedrock-agentcore-control list-policies --policy-engine-id "$(engine_id)" --query 'policies[].[name, status]' --output text
  fi
  say "Session snapshot"
  aws ecr describe-images --repository-name "$APP/session" --query 'reverse(sort_by(imageDetails, &imagePushedAt))[:3].[imageTags[0], imagePushedAt]' --output text 2>/dev/null || echo "none yet"
  say "Latest runs"
  aws stepfunctions list-executions --state-machine-arn "$(out StateMachineArn)" --max-results 10 \
    --query 'executions[].[name, status, startDate, stopDate]' --output text
}

sessions() { # one line per agent session, from the table (the transcripts are in S3)
  aws dynamodb scan --table-name "$(out Table)" --filter-expression "begins_with(sk, :s)" \
    --expression-attribute-values '{":s":{"S":"SESSION#"}}' --output json \
    | CSV="${1:-}" node -e '
      const un = (v) => v.S ?? (v.N !== undefined ? Number(v.N) : v.BOOL ?? (v.NULL ? null : v.M ? Object.fromEntries(Object.entries(v.M).map(([k, x]) => [k, un(x)])) : v.L ? v.L.map(un) : v.SS || v.NS));
      const rows = JSON.parse(require("fs").readFileSync(0, "utf8")).Items.map((i) => Object.fromEntries(Object.entries(i).map(([k, v]) => [k, un(v)])))
        .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      const cols = ["startedAt", "issueKey", "runId", "role", "attempt", "harness", "model", "durationSec", "environmentSec", "agentSec", "turns",
        "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "toolCallCount", "toolErrors", "refusalCount", "timedOut", "stopped", "prepareFailed", "exitCode", "verdict", "error"];
      const cell = (r, c) => { const v = r[c]; return v === undefined || v === null ? "" : typeof v === "number" && c === "costUsd" ? v.toFixed(4) : String(v).replace(/[\t\n,]/g, " "); };
      const sep = process.env.CSV === "--csv" ? "," : "\t";
      console.log(cols.join(sep));
      for (const r of rows) console.log(cols.map((c) => cell(r, c)).join(sep));
      if (sep === "\t") {
        const by = {};
        for (const r of rows) { const k = `${r.harness} ${r.role}`; const t = (by[k] ||= { sessions: 0, sec: 0, input: 0, output: 0, cacheRead: 0, cost: 0 });
          t.sessions++; t.sec += r.durationSec || 0; t.input += r.inputTokens || 0; t.output += r.outputTokens || 0; t.cacheRead += r.cacheReadTokens || 0; t.cost += r.costUsd || 0; }
        console.log("\nTotals by harness and role (cost = the CLI estimate at list prices; the Claude subscription itself is a flat fee):");
        for (const [k, t] of Object.entries(by)) console.log(`${k}: ${t.sessions} sessions, ${Math.round(t.sec / 60)} min, ${t.input} input + ${t.cacheRead} cache-read + ${t.output} output tokens, $${t.cost.toFixed(2)}`);
      }
    '
}

cost() { # actual cost from Cost Explorer: the whole project by service, and what is tagged Project=aipf-poc
  local from="${1:-$(date -v-30d +%F 2>/dev/null || date -d '30 days ago' +%F)}"
  local to="${2:-$(date -v+1d +%F 2>/dev/null || date -d tomorrow +%F)}" filter
  local format='
    const r = JSON.parse(require("fs").readFileSync(0, "utf8")).ResultsByTime;
    const sum = {};
    for (const p of r) for (const g of p.Groups) sum[g.Keys[0]] = (sum[g.Keys[0]] || 0) + Number(g.Metrics.UnblendedCost.Amount);
    const rows = Object.entries(sum).filter(([, v]) => Math.abs(v) >= 0.005).sort((a, b) => b[1] - a[1]);
    for (const [k, v] of rows) console.log(`${v.toFixed(2).padStart(10)}  ${k}`);
    console.log(`${rows.reduce((t, [, v]) => t + v, 0).toFixed(2).padStart(10)}  TOTAL (USD)`);'
  # Usage only: the project's credits cancel the cost per service, and the estimate for production needs the cost before them.
  local usage='{"Dimensions":{"Key":"RECORD_TYPE","Values":["Usage"]}}'
  say "Whole project by service, $from to $to, before credits (includes resources outside the POC, for example the knowledge base)"
  aws ce get-cost-and-usage --time-period "Start=$from,End=$to" --granularity DAILY --metrics UnblendedCost \
    --filter "$usage" --group-by Type=DIMENSION,Key=SERVICE --output json | node -e "$format"
  say "Tagged Project=$APP by service, before credits (only cost after the tag was activated)"
  filter="{\"And\":[$usage,{\"Tags\":{\"Key\":\"Project\",\"Values\":[\"$APP\"]}}]}"
  aws ce get-cost-and-usage --time-period "Start=$from,End=$to" --granularity DAILY --metrics UnblendedCost \
    --filter "$filter" --group-by Type=DIMENSION,Key=SERVICE --output json | node -e "$format"
  say "Credits applied in the same period"
  aws ce get-cost-and-usage --time-period "Start=$from,End=$to" --granularity DAILY --metrics UnblendedCost \
    --filter '{"Dimensions":{"Key":"RECORD_TYPE","Values":["Credit"]}}' --group-by Type=DIMENSION,Key=RECORD_TYPE --output json | node -e "$format"
  echo
  echo "Model use per session (tokens and the CLI's cost estimate): infra/aipf.sh sessions"
}

logs() {
  local group
  case "${1:-}" in
    sessions|ci|snapshot) group="/$APP/$1" ;;
    orchestrator|tools) group="/aws/lambda/$APP-$1" ;;
    workflow) group="/aws/vendedlogs/states/$APP-work-item" ;;
    gateway) group="/aws/vendedlogs/bedrock-agentcore/gateway/$APP" ;;
    *) echo "usage: infra/aipf.sh logs sessions|ci|snapshot|orchestrator|tools|workflow|gateway [since, e.g. 2h]" >&2; exit 1 ;;
  esac
  aws logs tail "$group" --since "${2:-1h}" --format short
}

decisions() { # every policy decision of the gateway: time, role, tool, decision, deciding policies, latency; totals at the end
  local since="${1:-1d}" ms
  case "$since" in
    *m) ms=$(( ${since%m} * 60000 )) ;; *h) ms=$(( ${since%h} * 3600000 )) ;; *d) ms=$(( ${since%d} * 86400000 )) ;;
    *) echo "usage: infra/aipf.sh decisions [since, e.g. 30m, 2h, 1d]" >&2; exit 1 ;;
  esac
  aws logs filter-log-events --log-group-name "/aws/vendedlogs/bedrock-agentcore/gateway/$APP" \
    --start-time $(( $(date +%s) * 1000 - ms )) --filter-pattern '?"Executing tool" ?"Policy evaluation" ?"method=tools/call"' \
    --query 'events[].message' --output json | node -e '
    const events = JSON.parse(require("fs").readFileSync(0, "utf8") || "[]").map((m) => JSON.parse(m));
    const byRequest = new Map();
    for (const e of events) {
      const r = byRequest.get(e.request_id) || { time: new Date(Number(e.timeUnixNano) / 1e6).toISOString().slice(0, 19) };
      // A denied call never reaches "Executing tool"; its request body still names the tool.
      const tool = /^Executing tool (\S+)/.exec(e.body.log || "") || /method=tools\/call, params=\{name=([^,}]+)/.exec(e.body.requestBody || "");
      if (tool) r.tool = tool[1];
      if (e.body.policy) r.policy = e.body.policy;
      byRequest.set(e.request_id, r);
    }
    const totals = {};
    for (const r of [...byRequest.values()].filter((r) => r.policy).sort((a, b) => a.time.localeCompare(b.time))) {
      const role = String(r.policy.principal?.entityId || "").split("/").pop();
      const policies = (r.policy.determiningPolicies || []).map((p) => p.replace(/-[a-z0-9_]{10}$/, "")).join(",") || "-";
      console.log([r.time, role, r.tool || "?", r.policy.decision, r.policy.mode || "", policies, `${r.policy.latencyMs}ms`].join("\t"));
      const k = `${role}\t${r.policy.decision}`;
      totals[k] = (totals[k] || 0) + 1;
    }
    console.log("\nrole\tdecision\tcalls");
    for (const [k, n] of Object.entries(totals)) console.log(`${k}\t${n}`);'
}

# --- Clean-up ---

empty_bucket() { # every version and delete marker
  local objects
  while :; do
    objects="$(aws s3api list-object-versions --bucket "$1" --max-items 500 --output json | node -e '
      const o = JSON.parse(require("fs").readFileSync(0, "utf8") || "{}");
      const a = [...(o.Versions || []), ...(o.DeleteMarkers || [])].map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
      process.stdout.write(a.length ? JSON.stringify({ Objects: a, Quiet: true }) : "");')"
    [ -n "$objects" ] || break
    aws s3api delete-objects --bucket "$1" --delete "$objects" >/dev/null
  done
}

down() {
  local id engine pid target bucket repo rule ids
  say "Gateway, targets, policies and policy engine"
  id="$(gateway_id)"
  if ! none "$id"; then
    for target in $(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$id" --query 'items[].targetId' --output text); do
      aws bedrock-agentcore-control delete-gateway-target --gateway-identifier "$id" --target-id "$target" >/dev/null
    done
    for _ in $(seq 1 30); do [ -z "$(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$id" --query 'items[].targetId' --output text)" ] && break; sleep 4; done
    aws bedrock-agentcore-control delete-gateway --gateway-identifier "$id" >/dev/null
    for _ in $(seq 1 30); do none "$(gateway_id)" && break; sleep 4; done
  fi
  engine="$(engine_id)"
  if ! none "$engine"; then
    for pid in $(aws bedrock-agentcore-control list-policies --policy-engine-id "$engine" --query 'policies[].policyId' --output text); do
      aws bedrock-agentcore-control delete-policy --policy-engine-id "$engine" --policy-id "$pid" >/dev/null
    done
    for _ in $(seq 1 30); do [ -z "$(aws bedrock-agentcore-control list-policies --policy-engine-id "$engine" --query 'policies[].policyId' --output text)" ] && break; sleep 4; done
    aws bedrock-agentcore-control delete-policy-engine --policy-engine-id "$engine" >/dev/null
  fi
  say "Gateway log delivery"
  for id in $(aws logs describe-deliveries --query "deliveries[?deliverySourceName=='$APP-gateway'].id" --output text); do aws logs delete-delivery --id "$id"; done
  aws logs delete-delivery-source --name "$APP-gateway" 2>/dev/null || true
  aws logs delete-delivery-destination --name "$APP-gateway" 2>/dev/null || true
  aws logs delete-log-group --log-group-name "/aws/vendedlogs/bedrock-agentcore/gateway/$APP" 2>/dev/null || true
  say "Approval rule"
  repo="$(out RepositoryName 2>/dev/null || true)"
  if ! none "$repo"; then
    aws codecommit disassociate-approval-rule-template-from-repository --approval-rule-template-name "$APP-human-approval" --repository-name "$repo" 2>/dev/null || true
  fi
  aws codecommit delete-approval-rule-template --approval-rule-template-name "$APP-human-approval" >/dev/null 2>&1 || true
  say "Stack $STACK (the data bucket is emptied first; the sample repository and its history go with it)"
  bucket="$(out Bucket 2>/dev/null || true)"
  if ! none "$bucket"; then empty_bucket "$bucket"; fi
  aws cloudformation delete-stack --stack-name "$STACK"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK"
  # Step Functions created these managed rules for the .sync steps; remove them when no other workflow uses them
  if [ -z "$(aws stepfunctions list-state-machines --query 'stateMachines[].name' --output text)" ]; then
    for rule in StepFunctionsGetEventsForECSTaskRule StepFunctionsGetEventForCodeBuildStartBuildRule; do
      ids="$(aws events list-targets-by-rule --rule "$rule" --query 'Targets[].Id' --output text 2>/dev/null || true)"
      [ -z "$ids" ] || aws events remove-targets --rule "$rule" --ids $ids --force >/dev/null
      aws events delete-rule --name "$rule" --force 2>/dev/null || true
    done
  fi
  bucket="$(deploy_bucket)"
  if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then aws s3 rb "s3://$bucket" --force >/dev/null; fi
  echo "Done. Revoke the Claude subscription token at claude.ai (Settings) if you will not run the POC again."
  echo "The knowledge base belongs to ../infra/kb.sh (down removes it)."
}

case "${1:-}" in
  up) up ;;
  build) build ;;
  snapshot) snapshot ;;
  token) token ;;
  run) shift; run "$@" ;;
  reset) shift; reset "$@" ;;
  answer) shift; answer "$@" ;;
  policy) policy "${2:-}" ;;
  webhook) webhook ;;
  items) items ;;
  status) status ;;
  sessions) sessions "${2:-}" ;;
  cost) shift; cost "$@" ;;
  logs) shift; logs "$@" ;;
  decisions) decisions "${2:-}" ;;
  down) down ;;
  *) sed -n '2,25p' "$0"; exit 1 ;;
esac
