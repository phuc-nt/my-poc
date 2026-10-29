package poc4.sim.a.dto;

import java.time.OffsetDateTime;
import poc4.sim.a.repository.DeviceRecord;

public class Device {
    public String deviceId;
    public Platform platform;
    public String pushToken;
    public OffsetDateTime registeredAt;

    public static Device of(DeviceRecord r) {
        Device d = new Device();
        d.deviceId = r.deviceId;
        d.platform = Platform.valueOf(r.platform);
        d.pushToken = r.pushToken;
        d.registeredAt = r.registeredAt;
        return d;
    }
}
