package poc4.sim.a.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import poc4.sim.a.dto.Device;
import poc4.sim.a.dto.RegisterDeviceRequest;
import poc4.sim.a.repository.DeviceRecord;
import poc4.sim.a.repository.DeviceRepository;
import poc4.sim.a.repository.UserRepository;
import poc4.sim.common.ApiException;
import poc4.sim.common.ErrorCode;

@Service
public class DeviceServiceImpl implements DeviceService {
    static final int MAX_DEVICES = 5;

    private final DeviceRepository devices;
    private final UserRepository users;

    public DeviceServiceImpl(DeviceRepository devices, UserRepository users) {
        this.devices = devices;
        this.users = users;
    }

    @Override
    public List<Device> list(String userId) {
        return devices.findByUser(userId).stream().map(Device::of).collect(Collectors.toList());
    }

    @Override
    public Device register(String userId, RegisterDeviceRequest request) {
        if (users.findById(userId) == null) {
            throw new ApiException(ErrorCode.E243, "userId", "The user was not found");
        }
        if (devices.countByUser(userId) >= MAX_DEVICES) {
            throw new ApiException(ErrorCode.E250, null, "A user may register at most " + MAX_DEVICES + " devices");
        }
        DeviceRecord record = new DeviceRecord();
        record.deviceId = UUID.randomUUID().toString();
        record.userId = userId;
        record.platform = request.platform.name();
        record.pushToken = request.pushToken;
        record.registeredAt = OffsetDateTime.now();
        devices.insert(record);
        return Device.of(record);
    }

    @Override
    public void remove(String userId, String deviceId) {
        if (devices.delete(userId, deviceId) == 0) {
            throw new ApiException(ErrorCode.E243, "deviceId", "The device was not found");
        }
    }
}
