package poc4.sim.a.service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Service;
import poc4.sim.a.ServiceAProperties;
import poc4.sim.a.dto.ExportKind;
import poc4.sim.a.dto.ExportRequest;
import poc4.sim.a.dto.ExportStatus;
import poc4.sim.a.repository.ConsentRepository;
import poc4.sim.a.repository.ExportRecord;
import poc4.sim.a.repository.ExportRepository;
import poc4.sim.a.repository.UserRepository;
import poc4.sim.common.ApiException;
import poc4.sim.common.Correlation;
import poc4.sim.common.Digests;
import poc4.sim.common.DownstreamClient;
import poc4.sim.common.ErrorCode;
import poc4.sim.common.SimProperties;

@Service
public class ExportServiceImpl implements ExportService {
    private static final Logger log = LoggerFactory.getLogger(ExportServiceImpl.class);

    private final ExportRepository exports;
    private final UserRepository users;
    private final ConsentRepository consents;
    private final DownstreamClient client;
    private final SimProperties sim;
    private final ServiceAProperties props;

    public ExportServiceImpl(ExportRepository exports, UserRepository users, ConsentRepository consents,
                             DownstreamClient client, SimProperties sim, ServiceAProperties props) {
        this.exports = exports;
        this.users = users;
        this.consents = consents;
        this.client = client;
        this.sim = sim;
        this.props = props;
    }

    @Override
    public ExportStatus request(ExportRequest request, String baseUrl) {
        ExportRecord record = new ExportRecord();
        record.requestId = UUID.randomUUID().toString();
        record.kind = request.kind.name();
        record.dateFrom = request.from;
        record.dateTo = request.to;
        record.notifyEmail = request.notifyEmail;
        record.status = "QUEUED";
        record.baseUrl = baseUrl;
        record.oneTimeUuid = Correlation.get();
        record.requestedAt = OffsetDateTime.now();
        exports.insert(record);
        return toStatus(record);
    }

    @Override
    public ExportStatus status(String requestId) {
        ExportRecord record = exports.findById(requestId);
        if (record == null) {
            throw new ApiException(ErrorCode.E243, "requestId", "The export request was not found");
        }
        return toStatus(record);
    }

    @Override
    public boolean processNext() {
        ExportRecord job = exports.claimNext(OffsetDateTime.now().minusNanos(props.getExportDelayMs() * 1_000_000));
        if (job == null) {
            return false;
        }
        Correlation.with(job.oneTimeUuid, () -> {
            try {
                List<String> lines = ExportKind.USERS.name().equals(job.kind) ? userLines(job) : consentLines(job);
                String fileName = job.kind.toLowerCase() + "-" + job.requestId + ".csv";
                Path dir = Paths.get(props.getExportDir());
                Files.createDirectories(dir);
                Files.write(dir.resolve(fileName), lines, StandardCharsets.UTF_8);
                exports.complete(job.requestId, "DONE", lines.size() - 1, fileName);
                log.info("export {} done, {} rows", job.requestId, lines.size() - 1);
                notifyRequester(job);
            } catch (IOException | RuntimeException e) {
                log.error("export {} failed", job.requestId, e);
                exports.complete(job.requestId, "FAILED", null, null);
            }
            return null;
        });
        return true;
    }

    @Override
    public byte[] download(String fileName, long expires, String signature) {
        if (!fileName.matches("^[a-z]+-[0-9a-f-]{36}\\.csv$") || Instant.now().getEpochSecond() > expires
                || !Digests.equal(sign(fileName, expires), signature)) {
            return null;
        }
        try {
            return Files.readAllBytes(Paths.get(props.getExportDir()).resolve(fileName));
        } catch (IOException e) {
            return null;
        }
    }

    private List<String> userLines(ExportRecord job) {
        List<String> lines = users.findCreatedBetween(job.dateFrom, job.dateTo).stream()
                .map(u -> String.join(",", csv(u.userId), csv(u.email), csv(u.displayName), String.valueOf(u.locked),
                        u.createdAt.toInstant().toString()))
                .collect(Collectors.toList());
        lines.add(0, "user_id,email,display_name,locked,created_at");
        return lines;
    }

    private List<String> consentLines(ExportRecord job) {
        List<String> lines = consents.findUpdatedBetween(job.dateFrom, job.dateTo).stream()
                .map(c -> String.join(",", csv(c.userId), c.consentType, c.version, String.valueOf(c.agreed),
                        c.updatedAt.toInstant().toString()))
                .collect(Collectors.toList());
        lines.add(0, "user_id,consent_type,version,agreed,updated_at");
        return lines;
    }

    private void notifyRequester(ExportRecord job) {
        if (job.notifyEmail == null) {
            return;
        }
        try {
            client.call("mail", HttpMethod.POST, sim.getThirdPartyUrl() + "/mail/v1/send",
                    Map.of("to", job.notifyEmail, "subject", "Your export is ready", "requestId", job.requestId), null);
        } catch (ApiException e) {
            log.warn("export {}: the notification mail was not sent", job.requestId);
        }
    }

    private ExportStatus toStatus(ExportRecord record) {
        ExportStatus status = new ExportStatus();
        status.requestId = record.requestId;
        status.kind = ExportKind.valueOf(record.kind);
        status.status = record.status;
        status.requestedAt = record.requestedAt;
        status.completedAt = record.completedAt;
        status.rowCount = record.rowCount;
        if ("DONE".equals(record.status)) {
            long expires = Instant.now().getEpochSecond() + props.getDownloadTtlSeconds();
            status.downloadUrl = record.baseUrl + "/files/" + record.fileName + "?expires=" + expires
                    + "&signature=" + sign(record.fileName, expires);
            status.expiresAt = OffsetDateTime.ofInstant(Instant.ofEpochSecond(expires), ZoneOffset.UTC);
        }
        return status;
    }

    private String sign(String fileName, long expires) {
        return Digests.hmacSha256(props.getFileSigningKey(), fileName + ":" + expires);
    }

    private static String csv(String value) {
        return value.matches(".*[,\"\\n].*") ? "\"" + value.replace("\"", "\"\"") + "\"" : value;
    }
}
