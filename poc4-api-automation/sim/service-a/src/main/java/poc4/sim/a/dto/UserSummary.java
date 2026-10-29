package poc4.sim.a.dto;

import poc4.sim.a.repository.UserRecord;

public class UserSummary {
    public String userId;
    public String email;
    public String displayName;
    public boolean locked;

    public static UserSummary of(UserRecord u) {
        UserSummary s = new UserSummary();
        s.userId = u.userId;
        s.email = u.email;
        s.displayName = u.displayName;
        s.locked = u.locked;
        return s;
    }
}
