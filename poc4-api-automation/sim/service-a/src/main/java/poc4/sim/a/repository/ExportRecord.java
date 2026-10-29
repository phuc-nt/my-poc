package poc4.sim.a.repository;

import java.time.LocalDate;
import java.time.OffsetDateTime;

public class ExportRecord {
    public String requestId;
    public String kind;
    public LocalDate dateFrom;
    public LocalDate dateTo;
    public String notifyEmail;
    public String status;
    public Integer rowCount;
    public String fileName;
    public String baseUrl;
    public String oneTimeUuid;
    public OffsetDateTime requestedAt;
    public OffsetDateTime completedAt;
}
