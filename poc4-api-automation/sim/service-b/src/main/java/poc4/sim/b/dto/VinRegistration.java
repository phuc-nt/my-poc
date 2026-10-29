package poc4.sim.b.dto;

import java.time.OffsetDateTime;
import poc4.sim.b.repository.VinRegistrationRecord;

public class VinRegistration {
    public String vin;
    public String modelCode;
    /** REQUESTED, REGISTERED or REJECTED. */
    public String status;
    public String executionId;
    public String reason;
    public OffsetDateTime requestedAt;
    public OffsetDateTime updatedAt;

    public static VinRegistration of(VinRegistrationRecord r) {
        VinRegistration v = new VinRegistration();
        v.vin = r.vin;
        v.modelCode = r.modelCode;
        v.status = r.status;
        v.executionId = r.executionId;
        v.reason = r.reason;
        v.requestedAt = r.requestedAt;
        v.updatedAt = r.updatedAt;
        return v;
    }
}
