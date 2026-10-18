// The knowledge base, for both agent roles. Created only when the gateway has the kb target.
permit(
  principal is AgentCore::IamEntity,
  action == AgentCore::Action::"kb___Retrieve",
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
)
when {
  principal.id like "arn:aws:sts::*:assumed-role/aipf-poc-developer*" ||
  principal.id like "arn:aws:sts::*:assumed-role/aipf-poc-reviewer*"
};
