package poc4.sim.b.dto;

import java.time.OffsetDateTime;
import poc4.sim.b.repository.OwnershipRecord;

public class Ownership {
    public String ownershipId;
    public String vin;
    public String nickname;
    /** ACTIVE or ENDED. */
    public String status;
    public OffsetDateTime createdAt;
    public OffsetDateTime endedAt;

    public static Ownership of(OwnershipRecord r) {
        Ownership o = new Ownership();
        o.ownershipId = r.ownershipId;
        o.vin = r.vin;
        o.nickname = r.nickname;
        o.status = r.status;
        o.createdAt = r.createdAt;
        o.endedAt = r.endedAt;
        return o;
    }
}
