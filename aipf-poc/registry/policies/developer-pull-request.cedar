// The developer may open pull requests only from agent/* branches.
permit(
  principal is AgentCore::IamEntity,
  action == AgentCore::Action::"codecommit___create_pull_request",
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
)
when {
  principal.id like "arn:aws:sts::*:assumed-role/aipf-poc-developer*" &&
  context.input.source_branch like "agent/*"
};
