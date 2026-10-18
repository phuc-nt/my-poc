// Tools both agent roles may call. {{GATEWAY_ARN}} is filled in by infra/aipf.sh.
permit(
  principal is AgentCore::IamEntity,
  action in [
    AgentCore::Action::"jira___get_issue",
    AgentCore::Action::"jira___add_comment",
    AgentCore::Action::"codecommit___get_pull_request",
    AgentCore::Action::"codecommit___post_comment",
    AgentCore::Action::"memory___read",
    AgentCore::Action::"slack___ask_human"
  ],
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
)
when {
  principal.id like "arn:aws:sts::*:assumed-role/aipf-poc-developer*" ||
  principal.id like "arn:aws:sts::*:assumed-role/aipf-poc-reviewer*"
};
