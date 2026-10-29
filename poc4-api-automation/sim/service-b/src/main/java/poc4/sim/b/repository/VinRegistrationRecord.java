package poc4.sim.b.repository;

import java.time.OffsetDateTime;

public class VinRegistrationRecord {
    public String vin;
    public String modelCode;
    public String status;
    public String executionId;
    public String reason;
    public OffsetDateTime requestedAt;
    public OffsetDateTime updatedAt;
}
