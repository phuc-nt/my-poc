package poc4.sim.a.dto;

import java.time.OffsetDateTime;

public class ExportStatus {
    public String requestId;
    public ExportKind kind;
    /** QUEUED, PROCESSING, DONE or FAILED. */
    public String status;
    public OffsetDateTime requestedAt;
    public OffsetDateTime completedAt;
    public Integer rowCount;
    public String downloadUrl;
    public OffsetDateTime expiresAt;
}
