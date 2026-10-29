package poc4.sim.a.repository;

import java.time.OffsetDateTime;

public class ConsentRecord {
    public String userId;
    public String consentType;
    public String version;
    public boolean agreed;
    public OffsetDateTime updatedAt;
}
