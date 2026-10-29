package poc4.sim.a.repository;

import java.time.OffsetDateTime;

public class UserRecord {
    public String userId;
    public String email;
    public String displayName;
    public String pinHash;
    public int failedPinAttempts;
    public boolean locked;
    public OffsetDateTime createdAt;
}
