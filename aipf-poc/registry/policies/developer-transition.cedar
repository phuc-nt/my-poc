// The developer may move a work item only to "In Review"; the platform moves it to Done.
permit(
  principal is AgentCore::IamEntity,
  action == AgentCore::Action::"jira___transition",
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
)
when {
  principal.id like "arn:aws:sts::*:assumed-role/aipf-poc-developer*" &&
  context.input.to == "In Review"
};
