# Runs one service from the jar Maven built on the host (mvn -DskipTests package in sim/).
# The real project builds with Jib or an nginx Dockerfile; this image only needs to run the jar.
FROM eclipse-temurin:11-jre
ARG JAR
RUN useradd --system --uid 10001 app && mkdir -p /tmp/sim-exports && chown app /tmp/sim-exports
COPY ${JAR} /app/app.jar
USER app
EXPOSE 8080
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=70", "-jar", "/app/app.jar"]
