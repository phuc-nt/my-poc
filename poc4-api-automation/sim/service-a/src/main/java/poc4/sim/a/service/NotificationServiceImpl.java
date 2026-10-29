package poc4.sim.a.service;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import poc4.sim.a.repository.DeviceRecord;
import poc4.sim.a.repository.DeviceRepository;
import poc4.sim.a.repository.UserRepository;
import poc4.sim.a.dto.PushRequest;
import poc4.sim.a.dto.PushResult;
import poc4.sim.common.ApiException;
import poc4.sim.common.DownstreamClient;
import poc4.sim.common.ErrorCode;
import poc4.sim.common.SimProperties;

@Service
public class NotificationServiceImpl implements NotificationService {
    private final UserRepository users;
    private final DeviceRepository devices;
    private final DownstreamClient client;
    private final SimProperties sim;

    public NotificationServiceImpl(UserRepository users, DeviceRepository devices, DownstreamClient client, SimProperties sim) {
        this.users = users;
        this.devices = devices;
        this.client = client;
        this.sim = sim;
    }

    @Override
    public PushResult push(String userId, PushRequest request) {
        if (users.findById(userId) == null) {
            throw new ApiException(ErrorCode.E243, "userId", "The user was not found");
        }
        List<DeviceRecord> targets = devices.findByUser(userId);
        for (DeviceRecord device : targets) {
            ResponseEntity<JsonNode> response = client.call("push", HttpMethod.POST, sim.getThirdPartyUrl() + "/push/v1/send",
                    Map.of("pushToken", device.pushToken, "title", request.title, "body", request.body), null);
            if (!response.getStatusCode().is2xxSuccessful()) {
                throw new ApiException(ErrorCode.E611, null, "push refused the message (" + response.getStatusCodeValue() + ")");
            }
        }
        return new PushResult(targets.size());
    }
}
