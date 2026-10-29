package poc4.sim.b.repository;

import java.time.OffsetDateTime;

public class OwnershipRecord {
    public String ownershipId;
    public String userId;
    public String vin;
    public String nickname;
    public String status;
    public OffsetDateTime createdAt;
    public OffsetDateTime endedAt;
}
