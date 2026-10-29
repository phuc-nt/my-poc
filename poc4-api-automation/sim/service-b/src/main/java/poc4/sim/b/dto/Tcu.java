package poc4.sim.b.dto;

import java.time.OffsetDateTime;
import poc4.sim.b.repository.TcuRecord;

/** A telematics control unit and the state of its SIM: INACTIVE, ACTIVATING, ACTIVE or FAILED. */
public class Tcu {
    public String tcuId;
    public String vin;
    public String iccid;
    public String simStatus;
    public String orderId;
    public OffsetDateTime updatedAt;

    public static Tcu of(TcuRecord r) {
        Tcu t = new Tcu();
        t.tcuId = r.tcuId;
        t.vin = r.vin;
        t.iccid = r.iccid;
        t.simStatus = r.simStatus;
        t.orderId = r.orderId;
        t.updatedAt = r.updatedAt;
        return t;
    }
}
