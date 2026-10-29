package poc4.sim.a.dto;

import java.time.OffsetDateTime;

public class PinChangeResult {
    public OffsetDateTime changedAt;

    public PinChangeResult(OffsetDateTime changedAt) {
        this.changedAt = changedAt;
    }
}
