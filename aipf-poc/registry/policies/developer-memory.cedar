// The developer may propose memory changes; a person reviews them.
permit(
  principal is AgentCore::IamEntity,
  action == AgentCore::Action::"memory___propose",
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
)
when {
  principal.id like "arn:aws:sts::*:assumed-role/aipf-poc-developer*"
};
