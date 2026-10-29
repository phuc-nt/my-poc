package poc4.sim.a.dto;

import java.time.OffsetDateTime;
import poc4.sim.a.repository.UserRecord;

public class UserProfile {
    public String userId;
    public String email;
    public String displayName;
    public boolean locked;
    public OffsetDateTime createdAt;

    public static UserProfile of(UserRecord u) {
        UserProfile p = new UserProfile();
        p.userId = u.userId;
        p.email = u.email;
        p.displayName = u.displayName;
        p.locked = u.locked;
        p.createdAt = u.createdAt;
        return p;
    }
}
