package poc4.sim.a.service;

import java.util.List;
import poc4.sim.a.dto.Device;
import poc4.sim.a.dto.RegisterDeviceRequest;

public interface DeviceService {
    List<Device> list(String userId);

    Device register(String userId, RegisterDeviceRequest request);

    void remove(String userId, String deviceId);
}
