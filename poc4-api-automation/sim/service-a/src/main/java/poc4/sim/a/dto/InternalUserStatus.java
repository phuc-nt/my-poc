package poc4.sim.a.dto;

public class InternalUserStatus {
    public String userId;
    public boolean locked;

    public InternalUserStatus(String userId, boolean locked) {
        this.userId = userId;
        this.locked = locked;
    }
}
