# Environment snapshot of one repository: the harness image, the repository checked out in
# /workspace, its dependencies installed and its unit tests passed. Build context: a directory
# holding the clone in repo/ (with its .git).
ARG HARNESS_IMAGE
FROM ${HARNESS_IMAGE}
USER root
COPY repo /workspace
RUN chown -R agent:agent /workspace
USER agent
RUN node /opt/aipf/runner/session.mjs setup
