package poc4.sim.a.dto;

import java.time.OffsetDateTime;
import poc4.sim.a.repository.ConsentRecord;

public class Consent {
    public ConsentType consentType;
    public String version;
    public boolean agreed;
    public OffsetDateTime updatedAt;

    public static Consent of(ConsentRecord r) {
        Consent c = new Consent();
        c.consentType = ConsentType.valueOf(r.consentType);
        c.version = r.version;
        c.agreed = r.agreed;
        c.updatedAt = r.updatedAt;
        return c;
    }
}
